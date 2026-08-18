import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import { Command } from "commander";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerPullRequestCommands } from "../../../src/commands/pull-request-commands.js";
import type {
  PullRequestCreateInput,
  PullRequestListOptions,
  PullRequestOperations,
  PullRequestReviewInput,
} from "../../../src/forgejo/pull-request-service.js";
import type { RepositoryOperations } from "../../../src/forgejo/repository-service.js";

describe("pull request commands", () => {
  it("creates a pull request with explicit, deterministic repository and branches", async () => {
    let capturedInput: PullRequestCreateInput | undefined;
    const created = Object.freeze({ number: 17, title: "Agent-safe PR" });
    const pullRequests = {
      create: async (_repository: unknown, input: PullRequestCreateInput) => {
        capturedInput = input;
        return created;
      },
    } as unknown as PullRequestOperations;
    const repositories = {} as RepositoryOperations;
    const program = new Command()
      .name("forgejo")
      .option("--host <url>")
      .option("-R, --repo <slug>");
    registerPullRequestCommands(program, {
      stdin: Readable.from([]),
      resolve: async (selection) => {
        expect(selection).toEqual({
          host: "https://code.example.test",
          repository: { owner: "octo", repository: "app" },
        });
        return {
          origin: "https://code.example.test",
          repository: { owner: "octo", repository: "app" },
          localBranch: "ignored-local-branch",
          services: { pullRequests, repositories },
        };
      },
    });
    const stdout: string[] = [];

    const exitCode = await executeProgram(
      program,
      [
        "--host",
        "https://code.example.test",
        "--repo",
        "octo/app",
        "pr",
        "create",
        "--title",
        "Agent-safe PR",
        "--head",
        "feature",
        "--base",
        "main",
        "--body",
        "Ready for review",
      ],
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(capturedInput).toEqual({
      title: "Agent-safe PR",
      head: "feature",
      base: "main",
      body: "Ready for review",
    });
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      data: { number: 17, title: "Agent-safe PR" },
    });
  });

  it("derives the head from Git and the base from repository metadata", async () => {
    let capturedInput: PullRequestCreateInput | undefined;
    const pullRequests = {
      create: async (_repository: unknown, input: PullRequestCreateInput) => {
        capturedInput = input;
        return Object.freeze({ number: 18 });
      },
    } as unknown as PullRequestOperations;
    const repositories = {
      view: async () => Object.freeze({ defaultBranch: "trunk" }),
    } as unknown as RepositoryOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerPullRequestCommands(program, {
      stdin: Readable.from([]),
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: "feature/from-git",
        services: { pullRequests, repositories },
      }),
    });

    const exitCode = await executeProgram(
      program,
      ["--repo", "octo/app", "pr", "create", "--title", "Derived"],
      { stdout: () => undefined, stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(capturedInput).toEqual({ title: "Derived", head: "feature/from-git", base: "trunk" });
  });

  it("parses rich create options into a detached immutable service input", async () => {
    let capturedInput: PullRequestCreateInput | undefined;
    const pullRequests = {
      create: async (_repository: unknown, input: PullRequestCreateInput) => {
        capturedInput = input;
        return Object.freeze({ number: 19 });
      },
    } as unknown as PullRequestOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerPullRequestCommands(program, {
      stdin: Readable.from(["Body from stdin"]),
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: "unused",
        services: { pullRequests, repositories: {} as RepositoryOperations },
      }),
    });

    const exitCode = await executeProgram(
      program,
      [
        "--repo",
        "octo/app",
        "pr",
        "create",
        "--title",
        "Rich input",
        "--head",
        "feature",
        "--base",
        "main",
        "--body-stdin",
        "--assignees",
        "ada,grace",
        "--labels",
        "3,8",
        "--milestone",
        "5",
        "--due-date",
        "2026-09-01T00:00:00Z",
      ],
      { stdout: () => undefined, stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(capturedInput).toEqual({
      title: "Rich input",
      head: "feature",
      base: "main",
      body: "Body from stdin",
      assignees: ["ada", "grace"],
      labels: [3, 8],
      milestone: 5,
      dueDate: "2026-09-01T00:00:00Z",
    });
    expect(Object.isFrozen(capturedInput)).toBe(true);
    expect(Object.isFrozen(capturedInput?.assignees)).toBe(true);
    expect(Object.isFrozen(capturedInput?.labels)).toBe(true);
  });

  it("fails before repository metadata or mutation calls when Git has no head branch", async () => {
    let repositoryViews = 0;
    let creates = 0;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerPullRequestCommands(program, {
      stdin: Readable.from([]),
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: null,
        services: {
          repositories: {
            view: async () => {
              repositoryViews += 1;
              return Object.freeze({ defaultBranch: "main" });
            },
          } as unknown as RepositoryOperations,
          pullRequests: {
            create: async () => {
              creates += 1;
              return Object.freeze({});
            },
          } as unknown as PullRequestOperations,
        },
      }),
    });
    const stdout: string[] = [];

    const exitCode = await executeProgram(
      program,
      ["--repo", "octo/app", "pr", "create", "--title", "Detached"],
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(exitCode).toBe(2);
    expect(repositoryViews).toBe(0);
    expect(creates).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      error: { code: "validation_failed", message: expect.stringContaining("head branch") },
    });
  });

  it("lists pull requests with parsed filters and explicit pagination", async () => {
    const calls: PullRequestListOptions[] = [];
    const pullRequests = {
      list: async (_repository: unknown, options: PullRequestListOptions) => {
        calls.push(options);
        return Object.freeze([Object.freeze({ number: 20, state: "closed" })]);
      },
    } as unknown as PullRequestOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerPullRequestCommands(program, {
      stdin: Readable.from([]),
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: null,
        services: { pullRequests, repositories: {} as RepositoryOperations },
      }),
    });
    const stdout: string[] = [];

    const exitCode = await executeProgram(
      program,
      [
        "--repo",
        "octo/app",
        "pr",
        "list",
        "--state",
        "closed",
        "--sort",
        "oldest",
        "--milestone",
        "5",
        "--poster",
        "ada",
        "--base",
        "main",
        "--head",
        "feature",
        "--page",
        "2",
        "--limit",
        "3",
      ],
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        state: "closed",
        sort: "oldest",
        milestone: 5,
        poster: "ada",
        base: "main",
        head: "feature",
        page: 2,
        limit: 3,
      },
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      data: {
        items: [{ number: 20, state: "closed" }],
        pagination: { page: 2, limit: 3, itemCount: 1, hasNextPage: false },
      },
    });
  });

  it("views a pull request using a parsed stable number", async () => {
    const numbers: number[] = [];
    const pullRequests = {
      view: async (_repository: unknown, number: number) => {
        numbers.push(number);
        return Object.freeze({ number, title: "Viewed" });
      },
    } as unknown as PullRequestOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerPullRequestCommands(program, {
      stdin: Readable.from([]),
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: null,
        services: { pullRequests, repositories: {} as RepositoryOperations },
      }),
    });

    const exitCode = await executeProgram(program, ["--repo", "octo/app", "pr", "view", "27"], {
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(numbers).toEqual([27]);
  });

  it("posts a pull request conversation comment from a body option", async () => {
    const comments: Readonly<{ number: number; body: string }>[] = [];
    const pullRequests = {
      comment: async (_repository: unknown, number: number, body: string) => {
        comments.push(Object.freeze({ number, body }));
        return Object.freeze({ id: 51, body });
      },
    } as unknown as PullRequestOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerPullRequestCommands(program, {
      stdin: Readable.from([]),
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: null,
        services: { pullRequests, repositories: {} as RepositoryOperations },
      }),
    });

    const exitCode = await executeProgram(
      program,
      ["--repo", "octo/app", "pr", "comment", "28", "--body", "Please add a test."],
      { stdout: () => undefined, stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(comments).toEqual([{ number: 28, body: "Please add a test." }]);
  });

  it("submits exactly one review event with optional body and commit", async () => {
    let captured: Readonly<{ number: number; input: PullRequestReviewInput }> | undefined;
    const pullRequests = {
      review: async (_repository: unknown, number: number, input: PullRequestReviewInput) => {
        captured = Object.freeze({ number, input });
        return Object.freeze({ id: 61, state: "REQUEST_CHANGES" });
      },
    } as unknown as PullRequestOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerPullRequestCommands(program, {
      stdin: Readable.from([]),
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: null,
        services: { pullRequests, repositories: {} as RepositoryOperations },
      }),
    });

    const exitCode = await executeProgram(
      program,
      [
        "--repo",
        "octo/app",
        "pr",
        "review",
        "29",
        "--request-changes",
        "--body",
        "Please revise.",
        "--commit-id",
        "abc123",
      ],
      { stdout: () => undefined, stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(captured).toEqual({
      number: 29,
      input: { event: "REQUEST_CHANGES", body: "Please revise.", commitId: "abc123" },
    });
    expect(Object.isFrozen(captured?.input)).toBe(true);
  });

  it("rejects ambiguous review modes before resolving repository credentials", async () => {
    let resolutions = 0;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerPullRequestCommands(program, {
      stdin: Readable.from([]),
      resolve: async () => {
        resolutions += 1;
        throw new Error("resolve must not be called");
      },
    });
    const stdout: string[] = [];

    const exitCode = await executeProgram(
      program,
      ["--repo", "octo/app", "pr", "review", "29", "--approve", "--comment"],
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(exitCode).toBe(2);
    expect(resolutions).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      error: { code: "validation_failed", message: expect.stringContaining("Exactly one") },
    });
  });
});
