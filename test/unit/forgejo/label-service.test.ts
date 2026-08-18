import { describe, expect, it } from "bun:test";
import type { RepositoryRef } from "../../../src/forgejo/label-service.js";
import { LabelService } from "../../../src/forgejo/label-service.js";
import type { ForgejoApi, ForgejoRequest } from "../../../src/http/forgejo-api.js";

const repository = Object.freeze({
  owner: "acme",
  repository: "widget",
}) satisfies RepositoryRef;

function labelResponse(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: 7,
    name: "bug",
    color: "d73a4a",
    description: "Something is broken",
    exclusive: false,
    is_archived: false,
    url: "https://git.example.com/api/v1/repos/acme/widget/labels/7",
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

describe("LabelService", () => {
  it("lists labels with pagination query inputs", async () => {
    const api = new FakeApi([labelResponse()]);
    const service = new LabelService(api);

    const labels = await service.list(repository, {
      page: 3,
      limit: 40,
      sort: "reversealphabetically",
    });

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "labels"],
        query: { sort: "reversealphabetically", page: 3, limit: 40 },
      },
    ]);
    expect(labels).toEqual([
      {
        id: 7,
        name: "bug",
        color: "d73a4a",
        description: "Something is broken",
        exclusive: false,
        isArchived: false,
        url: "https://git.example.com/api/v1/repos/acme/widget/labels/7",
      },
    ]);
    expect(Object.isFrozen(labels)).toBe(true);
    expect(Object.isFrozen(labels[0])).toBe(true);
  });

  it("uses bounded first-page defaults when list options are omitted", async () => {
    const api = new FakeApi([]);

    await new LabelService(api).list(repository);

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "labels"],
        query: { page: 1, limit: 30 },
      },
    ]);
  });

  it("views and creates labels with exact paths and bodies", async () => {
    const api = new FakeApi(labelResponse(), labelResponse());
    const service = new LabelService(api);

    await service.view(repository, 7);
    const label = await service.create(repository, {
      name: "bug",
      color: "d73a4a",
      description: "Something is broken",
      exclusive: false,
      isArchived: false,
    });

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "labels", "7"],
      },
      {
        method: "POST",
        path: ["repos", "acme", "widget", "labels"],
        body: {
          name: "bug",
          color: "d73a4a",
          description: "Something is broken",
          exclusive: false,
          is_archived: false,
        },
      },
    ]);
    expect(label.name).toBe("bug");
    expect(Object.isFrozen(label)).toBe(true);
  });

  it("edits a label by immutable numeric ID without mutating the input", async () => {
    const api = new FakeApi(labelResponse({ name: "kind/bug", exclusive: true }));
    const service = new LabelService(api);
    const input = Object.freeze({
      name: "kind/bug",
      color: "ff0000",
      description: "Defect",
      exclusive: true,
      isArchived: true,
    });

    const label = await service.edit(repository, 7, input);

    expect(api.calls).toEqual([
      {
        method: "PATCH",
        path: ["repos", "acme", "widget", "labels", "7"],
        body: {
          name: "kind/bug",
          color: "ff0000",
          description: "Defect",
          exclusive: true,
          is_archived: true,
        },
      },
    ]);
    expect(label.name).toBe("kind/bug");
    expect(input).toEqual({
      name: "kind/bug",
      color: "ff0000",
      description: "Defect",
      exclusive: true,
      isArchived: true,
    });
  });

  it("deletes a label only by immutable numeric ID and validates the empty response", async () => {
    const api = new FakeApi(null);
    const service = new LabelService(api);

    await expect(service.delete(repository, 7)).resolves.toBeUndefined();

    expect(api.calls).toEqual([
      {
        method: "DELETE",
        path: ["repos", "acme", "widget", "labels", "7"],
      },
    ]);
  });

  it("rejects malformed Forgejo label responses at runtime", async () => {
    const api = new FakeApi([labelResponse({ color: 123 })]);
    const service = new LabelService(api);

    await expect(service.list(repository)).rejects.toMatchObject({ code: "protocol_failed" });
  });

  it("validates repository, numeric IDs, pagination, and mutation inputs before requesting", async () => {
    const api = new FakeApi();
    const service = new LabelService(api);

    await expect(service.list({ owner: " ", repository: "widget" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.view(repository, -1)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.list(repository, { limit: 0 })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      service.create(repository, { name: "bug", color: "not-a-color" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.edit(repository, 7, {})).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(api.calls).toHaveLength(0);
  });
});
