import { describe, expect, it } from "bun:test";

import { WorkflowRunService } from "../../../src/forgejo/workflow-run-service.js";
import type {
  ForgejoApi,
  ForgejoDownload,
  ForgejoDownloader,
  ForgejoDownloadRequest,
  ForgejoRequest,
  ForgejoText,
  ForgejoTextReader,
  ForgejoTextRequest,
} from "../../../src/http/forgejo-api.js";

const repository = Object.freeze({ owner: "acme", repository: "widget" });

function runResponse(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 1580,
    index_in_repo: 1499,
    title: "fix: keep parameters on one line",
    workflow_id: "build.yml",
    event: "push",
    trigger_event: "push",
    status: "success",
    prettyref: "master",
    commit_sha: "7006c6457f00000000000000000000000000abcd",
    html_url: "https://git.example.com/acme/widget/actions/runs/1499",
    need_approval: false,
    trigger_user: { login: "adrian", id: 1 },
    repository: { full_name: "acme/widget" },
    event_payload: '{"a very large":"webhook payload"}',
    created: "2026-09-22T18:46:12Z",
    started: "2026-09-22T18:46:14Z",
    stopped: "2026-09-22T18:46:19Z",
    updated: "2026-09-22T18:46:19Z",
    duration: 5_000_000_000,
    ...overrides,
  };
}

function jobResponse(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 1583,
    run_id: 1580,
    name: "build",
    status: "success",
    attempt: 1,
    runs_on: ["danubedata"],
    needs: null,
    task_id: 1600,
    handle: "ignored",
    ...overrides,
  };
}

const runLookup = (run = runResponse()) => ({ total_count: 1, workflow_runs: [run] });

class StubApi implements ForgejoApi {
  readonly calls: ForgejoRequest[] = [];
  readonly #responses: unknown[];

  public constructor(...responses: unknown[]) {
    this.#responses = [...responses];
  }

  public async request(request: ForgejoRequest): Promise<unknown> {
    this.calls.push(request);
    if (this.#responses.length === 0) throw new Error("Unexpected Forgejo API request");
    return this.#responses.shift();
  }
}

class StubTextReader implements ForgejoTextReader {
  readonly calls: ForgejoTextRequest[] = [];

  public constructor(readonly response: ForgejoText) {}

  public async readText(request: ForgejoTextRequest): Promise<ForgejoText> {
    this.calls.push(request);
    return this.response;
  }
}

class StubDownloader implements ForgejoDownloader {
  readonly calls: ForgejoDownloadRequest[] = [];

  public constructor(readonly response: ForgejoDownload) {}

  public async download(request: ForgejoDownloadRequest): Promise<ForgejoDownload> {
    this.calls.push(request);
    return this.response;
  }
}

describe("WorkflowRunService.list", () => {
  it("always sends page with limit, because Forgejo ignores limit without page and returns every run", async () => {
    const api = new StubApi({ total_count: 0, workflow_runs: [] });

    await new WorkflowRunService(api).list(repository);

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "actions", "runs"],
        query: { page: 1, limit: 30 },
      },
    ]);
  });

  it("maps every filter onto Forgejo's query names and normalizes runs to stable fields", async () => {
    const api = new StubApi({
      total_count: 2,
      workflow_runs: [
        runResponse(),
        runResponse({
          id: 1581,
          index_in_repo: 1500,
          event: "",
          trigger_event: "workflow_dispatch",
          status: "waiting",
          started: "1970-01-01T00:00:00Z",
          stopped: "1970-01-01T00:00:00Z",
          duration: null,
          trigger_user: null,
          html_url: null,
        }),
      ],
    });

    const page = await new WorkflowRunService(api).list(repository, {
      page: 2,
      limit: 2,
      statuses: ["failure", "cancelled"],
      events: ["push"],
      workflow: "build.yml",
      ref: "refs/heads/master",
      headSha: "7006c64",
    });

    expect(api.calls[0]?.query).toEqual({
      page: 2,
      limit: 2,
      status: ["failure", "cancelled"],
      event: ["push"],
      workflow_id: "build.yml",
      ref: "refs/heads/master",
      head_sha: "7006c64",
    });
    expect(page.pagination).toEqual({ page: 2, limit: 2, itemCount: 2, hasNextPage: true });
    expect(page.items[0]).toEqual({
      id: 1580,
      number: 1499,
      title: "fix: keep parameters on one line",
      workflow: "build.yml",
      event: "push",
      status: "success",
      ref: "master",
      commitSha: "7006c6457f00000000000000000000000000abcd",
      htmlUrl: "https://git.example.com/acme/widget/actions/runs/1499",
      needsApproval: false,
      triggeredBy: "adrian",
      createdAt: "2026-09-22T18:46:12Z",
      startedAt: "2026-09-22T18:46:14Z",
      stoppedAt: "2026-09-22T18:46:19Z",
      updatedAt: "2026-09-22T18:46:19Z",
      durationSeconds: 5,
    });
    expect(page.items[1]).toMatchObject({
      number: 1500,
      event: "workflow_dispatch",
      status: "waiting",
      startedAt: null,
      stoppedAt: null,
      durationSeconds: null,
      triggeredBy: null,
      htmlUrl: null,
    });
    expect(JSON.stringify(page)).not.toContain("webhook payload");
  });

  it("rejects unknown statuses, oversized pages, and unsafe workflow names before any request", async () => {
    const api = new StubApi();
    const service = new WorkflowRunService(api);

    await expect(
      service.list(repository, { statuses: ["exploded" as never] }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.list(repository, { limit: 101 })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.list(repository, { workflow: "../build.yml" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(api.calls).toHaveLength(0);
  });

  it("rejects a response that is not a run list", async () => {
    const api = new StubApi({ workflow_runs: [{ id: "not-a-number" }] });

    await expect(new WorkflowRunService(api).list(repository)).rejects.toMatchObject({
      code: "protocol_failed",
    });
  });
});

describe("WorkflowRunService.view", () => {
  it("resolves the run number shown in URLs through the run_number filter", async () => {
    const api = new StubApi(runLookup());

    const run = await new WorkflowRunService(api).view(repository, 1499);

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "actions", "runs"],
        query: { run_number: 1499, page: 1, limit: 1 },
      },
    ]);
    expect(run).toMatchObject({ id: 1580, number: 1499, status: "success" });
  });

  it("reports an unknown run number as not_found", async () => {
    const api = new StubApi({ total_count: 0, workflow_runs: [] });

    await expect(new WorkflowRunService(api).view(repository, 9999)).rejects.toMatchObject({
      code: "not_found",
      details: { run_number: 9999 },
    });
  });

  it("refuses a lookup that answered with a different run", async () => {
    const api = new StubApi(runLookup(runResponse({ index_in_repo: 12 })));

    await expect(new WorkflowRunService(api).view(repository, 1499)).rejects.toMatchObject({
      code: "protocol_failed",
    });
  });
});

describe("WorkflowRunService.jobs", () => {
  it("lists a run's jobs with their position, which is the job index in web URLs", async () => {
    const api = new StubApi(runLookup(), [
      jobResponse(),
      jobResponse({ id: 1584, name: "deploy", status: "waiting", task_id: 0, needs: ["build"] }),
    ]);

    const result = await new WorkflowRunService(api).jobs(repository, 1499);

    expect(api.calls[1]).toEqual({
      method: "GET",
      path: ["repos", "acme", "widget", "actions", "runs", "1580", "jobs"],
    });
    expect(result).toEqual({
      run: { id: 1580, number: 1499 },
      jobs: [
        {
          id: 1583,
          index: 0,
          name: "build",
          status: "success",
          attempt: 1,
          runsOn: ["danubedata"],
          needs: [],
          started: true,
        },
        {
          id: 1584,
          index: 1,
          name: "deploy",
          status: "waiting",
          attempt: 1,
          runsOn: ["danubedata"],
          needs: ["build"],
          started: false,
        },
      ],
    });
  });
});

describe("WorkflowRunService.readJobLog", () => {
  it("reads the selected job's log, passing attempt and tail through, and redacts credentials", async () => {
    const api = new StubApi(runLookup(), [jobResponse(), jobResponse({ id: 1584, attempt: 2 })]);
    const text = new StubTextReader({
      text: "cloning https://ci:s3cret@git.example.com/acme/widget.git\nok\n",
      partial: true,
      totalBytes: 10_772,
    });

    const log = await new WorkflowRunService(api, text).readJobLog(repository, 1499, {
      job: 1,
      attempt: 1,
      tailBytes: 4096,
    });

    expect(text.calls).toEqual([
      {
        path: ["repos", "acme", "widget", "actions", "jobs", "1584", "logs"],
        query: { attempt: 1 },
        tailBytes: 4096,
      },
    ]);
    expect(log).toMatchObject({
      run: { id: 1580, number: 1499 },
      job: { id: 1584, index: 1, name: "build" },
      attempt: 1,
      started: true,
      partial: true,
      totalBytes: 10_772,
    });
    expect(log.text).toBe("cloning https://[REDACTED]@git.example.com/acme/widget.git\nok\n");
  });

  it("defaults to the first job and its latest attempt", async () => {
    const api = new StubApi(runLookup(), [jobResponse({ attempt: 3 })]);
    const text = new StubTextReader({ text: "done\n", partial: false, totalBytes: 5 });

    const log = await new WorkflowRunService(api, text).readJobLog(repository, 1499);

    expect(text.calls[0]).toEqual({
      path: ["repos", "acme", "widget", "actions", "jobs", "1583", "logs"],
      query: { attempt: 3 },
    });
    expect(log).toMatchObject({ attempt: 3, partial: false, text: "done\n" });
  });

  it("returns an empty, not-started log for a job no runner has picked up, without asking Forgejo", async () => {
    const api = new StubApi(runLookup(), [jobResponse({ status: "waiting", task_id: 0 })]);
    const text = new StubTextReader({ text: "unused", partial: false, totalBytes: 6 });

    const log = await new WorkflowRunService(api, text).readJobLog(repository, 1499);

    expect(text.calls).toHaveLength(0);
    expect(log).toMatchObject({ started: false, text: "", partial: false, totalBytes: 0 });
  });

  it("rejects a job index or attempt the run does not have", async () => {
    const service = (attempt = 1) =>
      new WorkflowRunService(
        new StubApi(runLookup(), [jobResponse({ attempt })]),
        new StubTextReader({ text: "", partial: false, totalBytes: 0 }),
      );

    await expect(service().readJobLog(repository, 1499, { job: 1 })).rejects.toMatchObject({
      code: "validation_failed",
      details: { job_count: 1 },
    });
    await expect(service().readJobLog(repository, 1499, { attempt: 2 })).rejects.toMatchObject({
      code: "validation_failed",
      details: { latest_attempt: 1 },
    });
  });

  it("fails clearly when the text transport was not provided", async () => {
    const api = new StubApi(runLookup(), [jobResponse()]);

    await expect(new WorkflowRunService(api).readJobLog(repository, 1499)).rejects.toMatchObject({
      code: "config_failed",
    });
  });
});

describe("WorkflowRunService mutations and downloads", () => {
  it("downloads the run's log archive from the run's API id", async () => {
    const download: ForgejoDownload = {
      body: new ReadableStream(),
      contentType: "application/zip",
      declaredBytes: 42,
    };
    const downloader = new StubDownloader(download);
    const api = new StubApi(runLookup());

    const result = await new WorkflowRunService(api, undefined, downloader).downloadLogs(
      repository,
      1499,
    );

    expect(downloader.calls).toEqual([
      { path: ["repos", "acme", "widget", "actions", "runs", "1580", "logs"] },
    ]);
    expect(result).toEqual({ run: { id: 1580, number: 1499 }, download });
  });

  it("cancels and deletes by the resolved API id", async () => {
    const api = new StubApi(runLookup(), null, runLookup(), null);
    const service = new WorkflowRunService(api);

    await expect(service.cancel(repository, 1499)).resolves.toEqual({ id: 1580, number: 1499 });
    await expect(service.delete(repository, 1499)).resolves.toEqual({ id: 1580, number: 1499 });

    expect(api.calls[1]).toEqual({
      method: "POST",
      path: ["repos", "acme", "widget", "actions", "runs", "1580", "cancel"],
    });
    expect(api.calls[3]).toEqual({
      method: "DELETE",
      path: ["repos", "acme", "widget", "actions", "runs", "1580"],
    });
  });

  it("dispatches a workflow and asks Forgejo to return the run it created", async () => {
    const api = new StubApi({ id: 1561, run_number: 46, jobs: ["shell"] });

    const run = await new WorkflowRunService(api).dispatch(repository, "validate.yml", {
      ref: "master",
      inputs: { environment: "staging" },
    });

    expect(api.calls).toEqual([
      {
        method: "POST",
        path: ["repos", "acme", "widget", "actions", "workflows", "validate.yml", "dispatches"],
        body: { ref: "master", inputs: { environment: "staging" }, return_run_info: true },
      },
    ]);
    expect(run).toEqual({ id: 1561, number: 46, jobs: ["shell"] });
  });

  it("rejects unsafe workflow names, blank refs, and malformed input keys before dispatching", async () => {
    const api = new StubApi();
    const service = new WorkflowRunService(api);

    for (const [workflow, input] of [
      ["../../etc/passwd", { ref: "master" }],
      ["build.txt", { ref: "master" }],
      ["build.yml", { ref: " " }],
      ["build.yml", { ref: "master", inputs: { "bad key": "x" } }],
    ] as const) {
      await expect(service.dispatch(repository, workflow, input)).rejects.toMatchObject({
        code: "validation_failed",
      });
    }
    expect(api.calls).toHaveLength(0);
  });
});
