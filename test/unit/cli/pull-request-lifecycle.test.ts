import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import { Command } from "commander";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerPullRequestCommands } from "../../../src/commands/pull-request-commands.js";
import {
  type PullRequestOperations,
  PullRequestService,
} from "../../../src/forgejo/pull-request-service.js";
import type { RepositoryOperations } from "../../../src/forgejo/repository-service.js";

function harness() {
  const calls: unknown[] = [];
  const lists: { page: number; state: string }[] = [];
  let resolutions = 0;
  const service = Object.fromEntries(
    ["view", "edit", "close", "reopen", "comment", "review", "merge"].map((method) => [
      method,
      async (...args: unknown[]) => {
        calls.push([method, ...args]);
        return { number: 7 };
      },
    ]),
  );
  const program = new Command().name("forgejo").option("--repo <slug>");
  registerPullRequestCommands(program, {
    stdin: Readable.from(["New\nbody"]),
    resolve: async () => {
      resolutions += 1;
      return {
        origin: "https://git.example.test",
        repository: { owner: "acme", repository: "app" },
        localBranch: "topic",
        services: {
          repositories: {} as RepositoryOperations,
          pullRequests: {
            ...service,
            list: async (_repo: unknown, options: { page: number; state: string }) => {
              lists.push(options);
              return options.page === 1
                ? [{ number: 7, head: { ref: "topic", label: "acme:topic" } }]
                : [];
            },
            diff: async (...args: unknown[]) => {
              calls.push(["diff", ...args]);
              return { text: "diff --git a/a b/a\n", partial: false, totalBytes: 22 };
            },
          } as unknown as PullRequestOperations,
        },
      };
    },
  });
  const stdout: string[] = [];
  return {
    calls,
    lists,
    get resolutions() {
      return resolutions;
    },
    async run(args: readonly string[]) {
      const code = await executeProgram(program, args, {
        stdout: (s) => stdout.push(s),
        stderr: () => undefined,
      });
      return { code, result: JSON.parse(stdout.join("")) };
    },
  };
}

describe("pull request lifecycle commands", () => {
  it("uses current-branch selectors for view, edit, comment, review, close and reopen", async () => {
    for (const args of [
      ["view"],
      [
        "edit",
        "--title",
        "New title",
        "--body-stdin",
        "--base",
        "stable",
        "--labels",
        "3,4",
        "--assignees",
        "ada,grace",
      ],
      ["comment", "--body", "Review\ntext"],
      ["review", "--approve"],
      ["close"],
      ["reopen"],
    ]) {
      const h = harness();
      expect((await h.run(["pr", ...args])).code).toBe(0);
      expect(h.lists[0]?.state).toBe(args[0] === "reopen" ? "closed" : "open");
      expect(h.calls[0]).toEqual([
        args[0],
        { owner: "acme", repository: "app" },
        7,
        ...(args[0] === "edit"
          ? [
              {
                title: "New title",
                body: "New\nbody",
                base: "stable",
                labels: [3, 4],
                assignees: ["ada", "grace"],
              },
            ]
          : args[0] === "comment"
            ? ["Review\ntext"]
            : args[0] === "review"
              ? [{ event: "APPROVE" }]
              : []),
      ]);
    }
  });

  it("reads diffs and accepts an exact repository PR URL", async () => {
    const h = harness();
    const { code, result } = await h.run([
      "pr",
      "diff",
      "https://git.example.test/acme/app/pulls/7",
    ]);
    expect(code).toBe(0);
    expect(result.data.text).toBe("diff --git a/a b/a\n");
    expect(h.calls).toEqual([["diff", { owner: "acme", repository: "app" }, 7]]);
  });

  it("requires explicit repo, numeric index, yes, confirmation and full head before merge resolution", async () => {
    const sha = "a".repeat(40);
    const valid = [
      "--repo",
      "acme/app",
      "pr",
      "merge",
      "7",
      "--head-sha",
      sha,
      "--squash",
      "--yes",
      "--confirm",
      "acme/app#pr:7",
    ];
    const h = harness();
    expect((await h.run(valid)).code).toBe(0);
    expect(h.calls).toEqual([
      ["merge", { owner: "acme", repository: "app" }, 7, { method: "squash", headSha: sha }],
    ]);
    for (const args of [
      valid.slice(2),
      valid.filter((x) => x !== "--yes"),
      valid.map((x) => (x === "acme/app#pr:7" ? "acme/app#pr:8" : x)),
      valid.map((x) => (x === sha ? "abc123" : x)),
      valid.map((x) => (x === "7" ? "topic" : x)),
      [...valid, "--rebase"],
    ]) {
      const invalid = harness();
      expect((await invalid.run(args)).code).toBe(2);
      expect(invalid.resolutions).toBe(0);
      expect(invalid.calls).toHaveLength(0);
    }
  });

  it("rejects empty edits before resolving credentials and clears explicit empty lists", async () => {
    const empty = harness();
    expect((await empty.run(["pr", "edit", "7"])).code).toBe(2);
    expect(empty.resolutions).toBe(0);
    const clear = harness();
    expect((await clear.run(["pr", "edit", "7", "--labels", "", "--assignees", ""])).code).toBe(0);
    expect(clear.calls).toEqual([
      ["edit", { owner: "acme", repository: "app" }, 7, { labels: [], assignees: [] }],
    ]);
  });
  it("redacts raw diff credentials in both JSON and human output", async () => {
    for (const human of [false, true]) {
      const service = new PullRequestService(
        { request: async () => null },
        {
          readText: async () => ({
            text: "+Authorization: Bearer diff-secret\n+https://user:pass@host/path\n",
            partial: false,
            totalBytes: 99,
          }),
        },
      );
      const program = new Command().name("forgejo").option("--human");
      registerPullRequestCommands(program, {
        stdin: Readable.from([]),
        resolve: async () => ({
          origin: "https://git.example.test",
          repository: { owner: "acme", repository: "app" },
          localBranch: null,
          services: { pullRequests: service, repositories: {} as RepositoryOperations },
        }),
      });
      const output: string[] = [];
      const code = await executeProgram(
        program,
        [...(human ? ["--human"] : []), "pr", "diff", "7"],
        { stdout: (value) => output.push(value), stderr: () => undefined },
      );
      expect(code).toBe(0);
      expect(output.join("")).not.toContain("diff-secret");
      expect(output.join("")).not.toContain("user:pass");
      expect(output.join("")).toContain("[REDACTED]");
    }
  });
});
