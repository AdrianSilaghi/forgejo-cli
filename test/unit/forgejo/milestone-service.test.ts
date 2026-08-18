import { describe, expect, it } from "bun:test";

import { MilestoneService, type RepositoryRef } from "../../../src/forgejo/milestone-service.js";
import type { ForgejoApi, ForgejoRequest } from "../../../src/http/forgejo-api.js";

const repository = Object.freeze({
  owner: "acme",
  repository: "widget",
}) satisfies RepositoryRef;

function milestoneResponse(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: 4,
    title: "v1.0",
    description: "First release",
    state: "open",
    open_issues: 3,
    closed_issues: 2,
    due_on: "2026-09-01T00:00:00Z",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    closed_at: null,
    ...overrides,
  };
}

class FakeApi implements ForgejoApi {
  public readonly calls: ForgejoRequest[] = [];
  readonly #responses: readonly unknown[];
  #responseIndex = 0;

  public constructor(...responses: readonly unknown[]) {
    this.#responses = responses;
  }

  public async request(request: ForgejoRequest): Promise<unknown> {
    this.calls.push(request);
    const response = this.#responses[this.#responseIndex];
    this.#responseIndex += 1;
    return response;
  }
}

describe("MilestoneService", () => {
  it("lists milestones with state, name, and pagination query inputs", async () => {
    const api = new FakeApi([milestoneResponse()]);
    const service = new MilestoneService(api);

    const milestones = await service.list(repository, {
      state: "all",
      name: "v1.0",
      page: 2,
      limit: 20,
    });

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "milestones"],
        query: { state: "all", name: "v1.0", page: 2, limit: 20 },
      },
    ]);
    expect(milestones).toEqual([
      {
        id: 4,
        title: "v1.0",
        description: "First release",
        state: "open",
        openIssues: 3,
        closedIssues: 2,
        dueOn: "2026-09-01T00:00:00Z",
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-02T00:00:00Z",
        closedAt: null,
      },
    ]);
    expect(Object.isFrozen(milestones)).toBe(true);
    expect(Object.isFrozen(milestones[0])).toBe(true);
  });

  it("uses bounded first-page milestone defaults when list options are omitted", async () => {
    const api = new FakeApi([]);

    await new MilestoneService(api).list(repository);

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "milestones"],
        query: { state: "open", page: 1, limit: 30 },
      },
    ]);
  });

  it("views and creates milestones with exact paths and bodies", async () => {
    const api = new FakeApi(milestoneResponse(), milestoneResponse());
    const service = new MilestoneService(api);

    await service.view(repository, 4);
    const milestone = await service.create(repository, {
      title: "v1.0",
      description: "First release",
      dueOn: "2026-09-01T00:00:00Z",
    });

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "milestones", "4"],
      },
      {
        method: "POST",
        path: ["repos", "acme", "widget", "milestones"],
        body: {
          title: "v1.0",
          description: "First release",
          due_on: "2026-09-01T00:00:00Z",
        },
      },
    ]);
    expect(milestone.title).toBe("v1.0");
    expect(Object.isFrozen(milestone)).toBe(true);
  });

  it("edits and closes a milestone by immutable numeric ID", async () => {
    const api = new FakeApi(
      milestoneResponse({ title: "v1.1" }),
      milestoneResponse({ title: "v1.1", state: "closed" }),
    );
    const service = new MilestoneService(api);

    await service.edit(repository, 4, {
      title: "v1.1",
      description: "Updated scope",
      dueOn: "2026-10-01T00:00:00Z",
    });
    const closed = await service.close(repository, 4);

    expect(api.calls).toEqual([
      {
        method: "PATCH",
        path: ["repos", "acme", "widget", "milestones", "4"],
        body: {
          title: "v1.1",
          description: "Updated scope",
          due_on: "2026-10-01T00:00:00Z",
        },
      },
      {
        method: "PATCH",
        path: ["repos", "acme", "widget", "milestones", "4"],
        body: { state: "closed" },
      },
    ]);
    expect(closed.state).toBe("closed");
  });

  it("deletes a milestone only by immutable numeric ID and validates the empty response", async () => {
    const api = new FakeApi(null);
    const service = new MilestoneService(api);

    await expect(service.delete(repository, 4)).resolves.toBeUndefined();

    expect(api.calls).toEqual([
      {
        method: "DELETE",
        path: ["repos", "acme", "widget", "milestones", "4"],
      },
    ]);
  });

  it("rejects malformed Forgejo milestone responses at runtime", async () => {
    const api = new FakeApi(milestoneResponse({ state: "pending" }));
    const service = new MilestoneService(api);

    await expect(service.view(repository, 4)).rejects.toMatchObject({ code: "protocol_failed" });
  });

  it("validates repository, numeric IDs, pagination, and mutation inputs before requesting", async () => {
    const api = new FakeApi();
    const service = new MilestoneService(api);

    await expect(service.list({ owner: "acme", repository: "" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.view(repository, Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.list(repository, { page: -1 })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.create(repository, { title: "" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.edit(repository, 4, {})).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(api.calls).toHaveLength(0);
  });
});
