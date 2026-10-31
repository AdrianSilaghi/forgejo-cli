import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { executeProgram } from "../../../src/cli/execute.js";
import type { PollingRuntime } from "../../../src/cli/polling.js";
import { registerPrChecksCommands } from "../../../src/commands/pr-checks-commands.js";
import { registerRunCommands } from "../../../src/commands/run-commands.js";
import type { PullRequestChecksOperations } from "../../../src/forgejo/pull-request-checks-service.js";

const repository = { owner: "acme", repository: "app" };
const sha = "a".repeat(40);
function setup(services: Record<string, unknown>, polling: PollingRuntime = {}) {
  const program = new Command().name("forgejo").option("--human").option("-R, --repo <slug>");
  program.command("pr");
  let resolves = 0;
  const progress: string[] = [];
  const runtime = {
    files: {} as never,
    polling,
    progress: (text: string) => progress.push(text),
    resolve: async () => {
      resolves++;
      return {
        origin: "https://git.example.com",
        repository,
        localBranch: null,
        services: services as never,
      };
    },
  };
  registerRunCommands(program, runtime);
  registerPrChecksCommands(program, runtime);
  return { program, progress, resolves: () => resolves };
}
async function run(program: Command, argv: string[]) {
  const output: string[] = [];
  const exitCode = await executeProgram(program, argv, {
    stdout: (value) => output.push(value),
    stderr: () => {},
  });
  return { exitCode, output: JSON.parse(output.join("")), writes: output.length };
}
describe("CI watch commands", () => {
  it("watches waiting -> running -> success with one resolved session and one final JSON document", async () => {
    let time = 0;
    const statuses = ["waiting", "running", "success"];
    const s = setup(
      { workflowRuns: { view: async () => ({ number: 1, status: statuses.shift() }) } },
      {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
    );
    const result = await run(s.program, [
      "run",
      "watch",
      "1",
      "--exit-status",
      "--interval",
      "1",
      "--timeout",
      "5",
    ]);
    expect(result).toMatchObject({
      exitCode: 0,
      output: { ok: true, data: { status: "success" } },
      writes: 1,
    });
    expect(s.resolves()).toBe(1);
    expect(s.progress).toHaveLength(3);
  });
  it("returns failure exit status only with --exit-status", async () => {
    for (const flag of [[], ["--exit-status"]]) {
      const s = setup({ workflowRuns: { view: async () => ({ number: 1, status: "failure" }) } });
      expect((await run(s.program, ["run", "watch", "1", ...flag])).exitCode).toBe(
        flag.length ? 10 : 0,
      );
    }
  });
  it("leaves waiting pending until timeout and supports cancellation", async () => {
    let time = 0;
    const s = setup(
      { workflowRuns: { view: async () => ({ status: "waiting" }) } },
      {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
    );
    expect(
      await run(s.program, ["run", "watch", "1", "--interval", "1", "--timeout", "1"]),
    ).toMatchObject({ exitCode: 8, output: { ok: false, error: { code: "timeout" } } });
    const c = new AbortController();
    c.abort();
    const cancelled = setup({ workflowRuns: {} }, { signal: c.signal });
    expect((await run(cancelled.program, ["run", "watch", "1"])).exitCode).toBe(130);
  });
  it("reads only failed logs, bounding tails, and rejects conflicting selection", async () => {
    const calls: unknown[] = [];
    const s = () =>
      setup({
        workflowRuns: {
          readFailedJobLogs: async (...args: unknown[]) => {
            calls.push(args);
            return { run: { number: 1 }, logs: [] };
          },
        },
      });
    expect((await run(s().program, ["run", "logs", "1", "--failed"])).exitCode).toBe(0);
    expect(calls).toEqual([[repository, 1, {}]]);
    expect((await run(s().program, ["run", "logs", "1", "--failed", "--job", "0"])).exitCode).toBe(
      2,
    );
    expect(
      (await run(s().program, ["run", "logs", "1", "--failed", "--attempt", "1"])).exitCode,
    ).toBe(2);
  });
  it("returns distinct pending and failure statuses for PR checks", async () => {
    for (const [state, code] of [
      ["pending", 11],
      ["failure", 10],
      ["success", 0],
    ] as const) {
      const s = setup({
        pullRequests: {},
        pullRequestChecks: {
          snapshot: async () => ({
            pull_request: 7,
            head_sha: sha,
            required_checks_evaluated: false,
            state,
            checks: [],
            workflows: [],
          }),
        } as PullRequestChecksOperations,
      });
      expect((await run(s.program, ["pr", "checks", "7"])).exitCode).toBe(code);
    }
  });
  it("pins watched checks to the first head and forwards the workflow filter", async () => {
    const calls: unknown[] = [];
    let time = 0;
    const s = setup(
      {
        pullRequests: {},
        pullRequestChecks: {
          snapshot: async (...args: unknown[]) => {
            calls.push(args.slice(0, 3));
            return {
              pull_request: 7,
              head_sha: sha,
              state: calls.length === 1 ? "pending" : "success",
              checks: [],
              workflows: [],
            };
          },
        },
      },
      {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
    );
    const result = await run(s.program, [
      "pr",
      "checks",
      "7",
      "--watch",
      "--workflow",
      "build.yml",
      "--interval",
      "1",
      "--timeout",
      "3",
    ]);
    expect(result.exitCode).toBe(0);
    expect(s.resolves()).toBe(1);
    expect(calls).toEqual([
      [repository, 7, { workflow: "build.yml" }],
      [repository, 7, { workflow: "build.yml", expectedHeadSha: sha }],
    ]);
  });
});
