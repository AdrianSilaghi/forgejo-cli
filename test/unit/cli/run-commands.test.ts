import { describe, expect, it } from "bun:test";
import { Command } from "commander";

import type { DownloadSource } from "../../../src/cli/download-file.js";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerRunCommands } from "../../../src/commands/run-commands.js";
import type {
  ListWorkflowRunsOptions,
  ReadJobLogOptions,
  WorkflowRunOperations,
} from "../../../src/forgejo/workflow-run-service.js";

const repository = Object.freeze({ owner: "octo", repository: "app" });
const runRef = Object.freeze({ id: 1580, number: 1499 });

function runProgram(
  workflowRuns: Partial<WorkflowRunOperations>,
  writes: Array<Readonly<{ path: string; source: DownloadSource }>> = [],
): Command {
  const program = new Command().name("forgejo").option("-R, --repo <slug>").option("--human");
  registerRunCommands(program, {
    files: {
      write: async (path, source) => {
        writes.push({ path, source });
        return { path: `/abs/${path}`, bytes: 42 };
      },
    },
    resolve: async () => ({
      origin: "https://code.example.test",
      repository,
      localBranch: null,
      services: { workflowRuns: workflowRuns as WorkflowRunOperations },
    }),
  });
  return program;
}

async function run(program: Command, argv: readonly string[]) {
  const stdout: string[] = [];
  const exitCode = await executeProgram(program, argv, {
    stdout: (value) => stdout.push(value),
    stderr: () => undefined,
  });
  return { exitCode, text: stdout.join("") };
}

async function runJson(program: Command, argv: readonly string[]) {
  const result = await run(program, argv);
  return { exitCode: result.exitCode, output: JSON.parse(result.text) };
}

describe("run commands", () => {
  it("lists runs, turning --branch into the full ref Forgejo matches on", async () => {
    const requests: ListWorkflowRunsOptions[] = [];
    const program = runProgram({
      list: async (_repository, options = {}) => {
        requests.push(options);
        return {
          items: [{ number: 1499 } as never],
          pagination: { page: 2, limit: 5, itemCount: 1, hasNextPage: false },
        };
      },
    });

    const result = await runJson(program, [
      "run",
      "list",
      "--status",
      "failure,cancelled",
      "--event",
      "push",
      "--workflow",
      "build.yml",
      "--branch",
      "master",
      "--sha",
      "7006c64",
      "--page",
      "2",
      "--limit",
      "5",
    ]);

    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([
      {
        statuses: ["failure", "cancelled"],
        events: ["push"],
        workflow: "build.yml",
        ref: "refs/heads/master",
        headSha: "7006c64",
        page: 2,
        limit: 5,
      },
    ]);
    expect(result.output).toMatchObject({
      ok: true,
      data: { items: [{ number: 1499 }], pagination: { itemCount: 1, truncated: false } },
    });
  });

  it("passes a full --ref through and refuses --branch together with --ref", async () => {
    const requests: ListWorkflowRunsOptions[] = [];
    const program = () =>
      runProgram({
        list: async (_repository, options = {}) => {
          requests.push(options);
          return {
            items: [],
            pagination: { page: 1, limit: 30, itemCount: 0, hasNextPage: false },
          };
        },
      });

    await runJson(program(), ["run", "list", "--ref", "refs/pull/7/head"]);
    const conflict = await runJson(program(), [
      "run",
      "list",
      "--branch",
      "main",
      "--ref",
      "refs/heads/main",
    ]);

    expect(requests).toEqual([{ ref: "refs/pull/7/head", page: 1, limit: 30 }]);
    expect(conflict.exitCode).toBe(2);
    expect(conflict.output).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  });

  it("views a run and lists its jobs by run number", async () => {
    const calls: Array<readonly [string, number]> = [];
    const program = runProgram({
      view: async (_repository, number) => {
        calls.push(["view", number]);
        return { ...runRef, status: "success" } as never;
      },
      jobs: async (_repository, number) => {
        calls.push(["jobs", number]);
        return { run: runRef, jobs: [] };
      },
    });

    const viewed = await runJson(program, ["run", "view", "1499"]);
    const jobs = await runJson(program, ["run", "jobs", "1499"]);

    expect(calls).toEqual([
      ["view", 1499],
      ["jobs", 1499],
    ]);
    expect(viewed.output).toMatchObject({ ok: true, data: { number: 1499, status: "success" } });
    expect(jobs.output).toMatchObject({ ok: true, data: { run: runRef, jobs: [] } });
  });

  it("rejects a run number that is not a positive integer", async () => {
    const result = await runJson(runProgram({}), ["run", "view", "abc"]);

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  });

  it("returns a job log as JSON and as raw text with --human", async () => {
    const requests: ReadJobLogOptions[] = [];
    const log = {
      run: runRef,
      job: { id: 1584, index: 1, name: "build", status: "failure" },
      attempt: 2,
      started: true,
      partial: true,
      totalBytes: 10_772,
      text: "FAILURES!\nTests: 3, Failures: 1\n",
    };
    const program = () =>
      runProgram({
        readJobLog: async (_repository, number, options = {}) => {
          expect(number).toBe(1499);
          requests.push(options);
          return log as never;
        },
      });

    const json = await runJson(program(), [
      "run",
      "logs",
      "1499",
      "--job",
      "1",
      "--attempt",
      "2",
      "--tail-bytes",
      "4096",
    ]);
    const human = await run(program(), ["--human", "run", "logs", "1499", "--job", "0"]);

    expect(requests).toEqual([{ job: 1, attempt: 2, tailBytes: 4096 }, { job: 0 }]);
    expect(json.output).toMatchObject({ ok: true, data: { partial: true, text: log.text } });
    // The log's own final newline is dropped so the output does not end in a blank line.
    expect(human.text).toBe(log.text);
  });

  it("tells a human reader that a job has not started instead of printing nothing", async () => {
    const program = runProgram({
      readJobLog: async () =>
        ({
          run: runRef,
          job: { id: 1585, index: 0, name: "deploy", status: "waiting" },
          attempt: 1,
          started: false,
          partial: false,
          totalBytes: 0,
          text: "",
        }) as never,
    });

    const human = await run(program, ["--human", "run", "logs", "1499"]);

    expect(human.text).toBe("Job 0 (deploy) of run #1499 has not started yet (waiting).\n");
  });

  it("rejects a negative or non-numeric job index", async () => {
    const result = await runJson(runProgram({}), ["run", "logs", "1499", "--job", "-1"]);

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  });

  it("writes the run's log archive to the requested file", async () => {
    const writes: Array<Readonly<{ path: string; source: DownloadSource }>> = [];
    const download = {
      body: new ReadableStream<Uint8Array>(),
      contentType: "application/zip",
      declaredBytes: 42,
    };
    const program = runProgram({ downloadLogs: async () => ({ run: runRef, download }) }, writes);

    const result = await runJson(program, ["run", "download-logs", "1499", "--output", "logs.zip"]);

    expect(writes).toEqual([{ path: "logs.zip", source: download }]);
    expect(result.output).toMatchObject({
      ok: true,
      data: { run: runRef, path: "/abs/logs.zip", bytes: 42 },
    });
  });

  it("cancels a run", async () => {
    const program = runProgram({ cancel: async () => runRef });

    const result = await runJson(program, ["run", "cancel", "1499"]);

    expect(result.output).toMatchObject({ ok: true, data: { cancelled: true, run: runRef } });
  });

  it("deletes a run only with an explicit repository and the derived confirmation", async () => {
    const deleted: number[] = [];
    const program = () =>
      runProgram({
        delete: async (_repository, number) => {
          deleted.push(number);
          return runRef;
        },
      });

    const confirmed = await runJson(program(), [
      "--repo",
      "octo/app",
      "run",
      "delete",
      "1499",
      "--yes",
      "--confirm",
      "octo/app#run:1499",
    ]);
    const implicit = await runJson(program(), [
      "run",
      "delete",
      "1499",
      "--yes",
      "--confirm",
      "octo/app#run:1499",
    ]);
    const mistyped = await runJson(program(), [
      "--repo",
      "octo/app",
      "run",
      "delete",
      "1499",
      "--yes",
      "--confirm",
      "octo/app#run:1500",
    ]);

    expect(deleted).toEqual([1499]);
    expect(confirmed.output).toMatchObject({
      ok: true,
      data: { deleted: true, run: runRef, repository },
    });
    expect(implicit.output).toMatchObject({ ok: false, error: { code: "confirmation_required" } });
    expect(mistyped.output).toMatchObject({
      ok: false,
      error: {
        code: "confirmation_required",
        details: { expected_confirmation: "octo/app#run:1499" },
      },
    });
  });
});
