import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import { Command } from "commander";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerIssueCommands } from "../../../src/commands/issue-commands.js";
import type {
  CreateIssueInput,
  EditIssueInput,
  IssueOperations,
  ListIssuesOptions,
} from "../../../src/forgejo/issue-service.js";

const repository = Object.freeze({ owner: "octo", repository: "app" });

async function executeIssueCommand(
  issues: IssueOperations,
  argv: readonly string[],
  stdin = Readable.from([]),
): Promise<number> {
  const program = new Command().name("forgejo").option("-R, --repo <slug>");
  registerIssueCommands(program, {
    stdin,
    resolve: async () => ({
      origin: "https://code.example.test",
      repository,
      localBranch: null,
      services: { issues },
    }),
  });
  return executeProgram(program, ["--repo", "octo/app", ...argv], {
    stdout: () => undefined,
    stderr: () => undefined,
  });
}

describe("issue commands", () => {
  it("creates an issue using bounded stdin content and numeric label IDs", async () => {
    let captured: CreateIssueInput | undefined;
    const issues = {
      create: async (_repository: unknown, input: CreateIssueInput) => {
        captured = input;
        return Object.freeze({ number: 5, title: input.title });
      },
    } as unknown as IssueOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerIssueCommands(program, {
      stdin: Readable.from(["Reproduction details"]),
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: null,
        services: { issues },
      }),
    });

    const exitCode = await executeProgram(
      program,
      [
        "--repo",
        "octo/app",
        "issue",
        "create",
        "--title",
        "Bug",
        "--body-stdin",
        "--labels",
        "2,8",
        "--assignees",
        "ada,grace",
        "--milestone",
        "3",
        "--due-on",
        "2026-09-01T00:00:00Z",
        "--ref",
        "main",
      ],
      { stdout: () => undefined, stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(captured).toEqual({
      title: "Bug",
      body: "Reproduction details",
      assignees: ["ada", "grace"],
      labelIds: [2, 8],
      milestoneId: 3,
      dueOn: "2026-09-01T00:00:00Z",
      ref: "main",
    });
  });

  it("lists issues with every supported filter and explicit pagination", async () => {
    const calls: ListIssuesOptions[] = [];
    const issues = {
      list: async (_repository: unknown, options: ListIssuesOptions) => {
        calls.push(options);
        return Object.freeze([{ number: 12 }]);
      },
    } as unknown as IssueOperations;

    const exitCode = await executeIssueCommand(issues, [
      "issue",
      "list",
      "--state",
      "all",
      "--labels",
      "bug,urgent",
      "--query",
      "crash",
      "--milestones",
      "v1,v2",
      "--since",
      "2026-08-01T00:00:00Z",
      "--before",
      "2026-09-01T00:00:00Z",
      "--created-by",
      "ada",
      "--assigned-by",
      "grace",
      "--mentioned-by",
      "linus",
      "--sort",
      "recentupdate",
      "--page",
      "2",
      "--limit",
      "5",
    ]);

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        state: "all",
        labels: ["bug", "urgent"],
        query: "crash",
        milestones: ["v1", "v2"],
        since: "2026-08-01T00:00:00Z",
        before: "2026-09-01T00:00:00Z",
        createdBy: "ada",
        assignedBy: "grace",
        mentionedBy: "linus",
        sort: "recentupdate",
        page: 2,
        limit: 5,
      },
    ]);
  });

  it("views, edits, reopens, and comments through stable issue numbers", async () => {
    const calls: unknown[] = [];
    const viewIssues = {
      view: async (target: unknown, number: number) => {
        calls.push(["view", target, number]);
        return Object.freeze({ number });
      },
    } as unknown as IssueOperations;
    const editIssues = {
      edit: async (target: unknown, number: number, input: EditIssueInput) => {
        calls.push(["edit", target, number, input]);
        return Object.freeze({ number });
      },
    } as unknown as IssueOperations;
    const reopenIssues = {
      reopen: async (target: unknown, number: number) => {
        calls.push(["reopen", target, number]);
        return Object.freeze({ number, state: "open" });
      },
    } as unknown as IssueOperations;
    const commentIssues = {
      comment: async (target: unknown, number: number, body: string) => {
        calls.push(["comment", target, number, body]);
        return Object.freeze({ id: 99, body });
      },
    } as unknown as IssueOperations;

    expect(await executeIssueCommand(viewIssues, ["issue", "view", "12"])).toBe(0);
    expect(
      await executeIssueCommand(editIssues, [
        "issue",
        "edit",
        "13",
        "--title",
        "Updated",
        "--assignees",
        "ada,grace",
        "--milestone",
        "5",
        "--unset-due-date",
        "--ref",
        "main",
      ]),
    ).toBe(0);
    expect(await executeIssueCommand(reopenIssues, ["issue", "reopen", "14"])).toBe(0);
    expect(
      await executeIssueCommand(commentIssues, ["issue", "comment", "15", "--body", "Hello"]),
    ).toBe(0);
    expect(calls).toEqual([
      ["view", repository, 12],
      [
        "edit",
        repository,
        13,
        {
          title: "Updated",
          assignees: ["ada", "grace"],
          milestoneId: 5,
          unsetDueDate: true,
          ref: "main",
        },
      ],
      ["reopen", repository, 14],
      ["comment", repository, 15, "Hello"],
    ]);
  });

  it("uses the explicit close operation and stable issue number", async () => {
    const closed: number[] = [];
    const issues = {
      close: async (_repository: unknown, number: number) => {
        closed.push(number);
        return Object.freeze({ number, state: "closed" });
      },
    } as unknown as IssueOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerIssueCommands(program, {
      stdin: Readable.from([]),
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: null,
        services: { issues },
      }),
    });

    const exitCode = await executeProgram(program, ["--repo", "octo/app", "issue", "close", "11"], {
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(closed).toEqual([11]);
  });
});
