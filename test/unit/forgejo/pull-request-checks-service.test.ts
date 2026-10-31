import { describe, expect, it } from "bun:test";
import {
  checkState,
  PullRequestChecksService,
} from "../../../src/forgejo/pull-request-checks-service.js";
import type { ForgejoApi, ForgejoRequest } from "../../../src/http/forgejo-api.js";

const repository = { owner: "acme", repository: "app" };
const sha = "a".repeat(40);
const pull = (head = sha) => ({ number: 7, head: { sha: head } });
const run = (id: number, status: string, extra = {}) => ({
  id,
  index_in_repo: id,
  workflow_id: "build.yml",
  commit_sha: sha,
  status,
  ...extra,
});
const status = (id: number, state: string, context = "tests") => ({ id, status: state, context });
class Api implements ForgejoApi {
  readonly calls: ForgejoRequest[] = [];
  constructor(readonly responses: unknown[]) {}
  async request(request: ForgejoRequest) {
    this.calls.push(request);
    if (!this.responses.length) throw new Error("unexpected request");
    return this.responses.shift();
  }
}
describe("PullRequestChecksService", () => {
  it("pins statuses and workflows to the exact head and uses the latest per context and workflow", async () => {
    const api = new Api([
      pull(),
      [status(1, "failure"), status(2, "success")],
      [],
      { workflow_runs: [run(3, "success"), run(2, "failure")] },
      { workflow_runs: [] },
      pull(),
    ]);
    const result = await new PullRequestChecksService(api).snapshot(repository, 7);
    expect(result).toMatchObject({
      pull_request: 7,
      head_sha: sha,
      state: "success",
      checks: [{ id: 2, state: "success" }],
      workflows: [{ number: 3, status: "success" }],
    });
    expect(api.calls[1]).toMatchObject({
      path: ["repos", "acme", "app", "statuses", sha],
      query: { sort: "highestindex", page: 1, limit: 50 },
    });
    expect(api.calls[3]?.query).toMatchObject({ head_sha: sha, page: 1, limit: 50 });
  });
  it("never treats no checks or waiting checks as green", async () => {
    for (const runs of [[], [run(3, "waiting")], [run(3, "running")]]) {
      const api = new Api([
        pull(),
        [],
        { workflow_runs: runs },
        ...(runs.length ? [{ workflow_runs: [] }] : []),
        pull(),
      ]);
      expect((await new PullRequestChecksService(api).snapshot(repository, 7)).state).toBe(
        "pending",
      );
    }
  });
  it("filters workflow runs locally and cannot use a success from another SHA", async () => {
    const api = new Api([
      pull(),
      {
        workflow_runs: [
          run(3, "success", { commit_sha: "b".repeat(40) }),
          run(2, "success", { workflow_id: "other.yml" }),
        ],
      },
      { workflow_runs: [] },
      pull(),
    ]);
    const result = await new PullRequestChecksService(api).snapshot(repository, 7, {
      workflow: "build.yml",
    });
    expect(result.state).toBe("pending");
    expect(result.workflows).toEqual([]);
    expect(api.calls[1]?.query).toMatchObject({ workflow_id: "build.yml", head_sha: sha });
  });
  it("rejects a changed head during collection and between polls", async () => {
    const api = new Api([
      pull(),
      [],
      { workflow_runs: [run(1, "success")] },
      { workflow_runs: [] },
      pull("b".repeat(40)),
    ]);
    await expect(new PullRequestChecksService(api).snapshot(repository, 7)).rejects.toMatchObject({
      code: "conflict",
    });
    const changed = new Api([pull("b".repeat(40))]);
    await expect(
      new PullRequestChecksService(changed).snapshot(repository, 7, { expectedHeadSha: sha }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(changed.calls).toHaveLength(1);
  });
  it("collects every status page before selecting the latest and preserves failure", async () => {
    const api = new Api([
      pull(),
      Array.from({ length: 50 }, (_, i) => status(i + 1, "success", `check-${i}`)),
      [status(51, "failure", "check-0")],
      [],
      { workflow_runs: [] },
      pull(),
    ]);
    const result = await new PullRequestChecksService(api).snapshot(repository, 7);
    expect(result.state).toBe("failure");
    expect(result.checks).toHaveLength(50);
    expect(api.calls[2]?.query).toMatchObject({ page: 2 });
  });

  it("does not infer completion from server-capped short pages", async () => {
    const api = new Api([
      pull(),
      [status(1, "success")],
      [status(2, "failure", "lint")],
      [],
      { workflow_runs: [run(1, "success")] },
      { workflow_runs: [run(2, "waiting", { workflow_id: "deploy.yml" })] },
      { workflow_runs: [] },
      pull(),
    ]);
    const result = await new PullRequestChecksService(api).snapshot(repository, 7);
    expect(result.state).toBe("failure");
    expect(result.checks).toHaveLength(2);
    expect(result.workflows).toHaveLength(2);
  });
  it("stops between requests on cancellation and sends the signal to the transport", async () => {
    const controller = new AbortController();
    let calls = 0;
    const api: ForgejoApi = {
      request: async (request) => {
        expect(request.signal).toBe(controller.signal);
        calls++;
        controller.abort();
        return pull();
      },
    };
    await expect(
      new PullRequestChecksService(api).snapshot(repository, 7, {}, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(1);
  });
  it("fails closed if pagination never finishes", async () => {
    let calls = 0;
    const api: ForgejoApi = {
      request: async (request) => {
        calls++;
        return request.path.includes("pulls") ? pull() : [status(calls, "success")];
      },
    };
    await expect(new PullRequestChecksService(api).snapshot(repository, 7)).rejects.toMatchObject({
      code: "protocol_failed",
    });
    expect(calls).toBe(101);
  });
  it("validates head SHA and external status responses", async () => {
    await expect(
      new PullRequestChecksService(new Api([pull("main")])).snapshot(repository, 7),
    ).rejects.toMatchObject({ code: "protocol_failed" });
    await expect(
      new PullRequestChecksService(new Api([pull(), [{ id: 1, status: null }]])).snapshot(
        repository,
        7,
      ),
    ).rejects.toMatchObject({ code: "protocol_failed" });
  });
});

it("classifies every Forgejo v17 commit status and keeps unknown statuses pending", () => {
  for (const state of ["error", "failure", "warning", "skipped"])
    expect(checkState(state)).toBe("failure");
  expect(checkState("success")).toBe("success");
  for (const state of ["pending", "waiting", "running", "unknown", "future-status"])
    expect(checkState(state)).toBe("pending");
});
