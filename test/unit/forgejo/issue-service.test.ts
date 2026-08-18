import { describe, expect, it } from "bun:test";

import { IssueService, type RepositoryRef } from "../../../src/forgejo/issue-service.js";
import type { ForgejoApi, ForgejoRequest } from "../../../src/http/forgejo-api.js";

const repository = Object.freeze({
  owner: "acme",
  repository: "widget",
}) satisfies RepositoryRef;

const labelResponse = {
  id: 7,
  name: "bug",
  color: "d73a4a",
  description: "Something is broken",
  exclusive: false,
  is_archived: false,
  url: "https://git.example.com/api/v1/repos/acme/widget/labels/7",
};

const milestoneResponse = {
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
};

const userResponse = {
  id: 2,
  login: "ada",
  full_name: "Ada Lovelace",
  avatar_url: "https://git.example.com/avatars/2",
  html_url: "https://git.example.com/ada",
};

function issueResponse(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: 101,
    number: 12,
    title: "Broken widget",
    body: "Steps to reproduce",
    state: "open",
    html_url: "https://git.example.com/acme/widget/issues/12",
    user: userResponse,
    assignees: [userResponse],
    labels: [labelResponse],
    milestone: milestoneResponse,
    comments: 1,
    is_locked: false,
    due_date: null,
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

describe("IssueService", () => {
  it("creates an issue with the exact Forgejo body and returns a normalized immutable issue", async () => {
    const response = issueResponse();
    const api = new FakeApi(response);
    const service = new IssueService(api);
    const input = Object.freeze({
      title: "Broken widget",
      body: "Steps to reproduce",
      assignees: Object.freeze(["ada"]),
      labelIds: Object.freeze([7]),
      milestoneId: 4,
      dueOn: "2026-09-01T00:00:00Z",
      ref: "main",
    });

    const issue = await service.create(repository, input);

    expect(api.calls).toEqual([
      {
        method: "POST",
        path: ["repos", "acme", "widget", "issues"],
        body: {
          title: "Broken widget",
          body: "Steps to reproduce",
          assignees: ["ada"],
          labels: [7],
          milestone: 4,
          due_date: "2026-09-01T00:00:00Z",
          ref: "main",
        },
      },
    ]);
    expect(issue).toEqual({
      id: 101,
      number: 12,
      title: "Broken widget",
      body: "Steps to reproduce",
      state: "open",
      htmlUrl: "https://git.example.com/acme/widget/issues/12",
      author: {
        id: 2,
        login: "ada",
        fullName: "Ada Lovelace",
      },
      assignees: [
        {
          id: 2,
          login: "ada",
          fullName: "Ada Lovelace",
        },
      ],
      labels: [
        {
          id: 7,
          name: "bug",
          color: "d73a4a",
          description: "Something is broken",
          exclusive: false,
          isArchived: false,
          url: "https://git.example.com/api/v1/repos/acme/widget/labels/7",
        },
      ],
      milestone: {
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
      commentsCount: 1,
      isLocked: false,
      dueOn: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
      closedAt: null,
    });
    expect(Object.isFrozen(issue)).toBe(true);
    expect(Object.isFrozen(issue.labels)).toBe(true);
    expect(Object.isFrozen(issue.labels[0])).toBe(true);
    expect(Object.isFrozen(issue.author)).toBe(true);
    expect(input.labelIds).toEqual([7]);
  });

  it("lists issues with issue-only filters and pagination query inputs", async () => {
    const api = new FakeApi([issueResponse()]);
    const service = new IssueService(api);

    const issues = await service.list(repository, {
      state: "closed",
      labels: ["bug", "priority/high"],
      query: "crash",
      milestones: ["v1.0", "4"],
      page: 2,
      limit: 25,
      sort: "recentupdate",
    });

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "issues"],
        query: {
          state: "closed",
          labels: "bug,priority/high",
          q: "crash",
          type: "issues",
          milestones: "v1.0,4",
          page: 2,
          limit: 25,
          sort: "recentupdate",
        },
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(Object.isFrozen(issues)).toBe(true);
  });

  it("uses bounded first-page issue defaults when list options are omitted", async () => {
    const api = new FakeApi([]);

    await new IssueService(api).list(repository);

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "issues"],
        query: { state: "open", type: "issues", page: 1, limit: 30 },
      },
    ]);
  });

  it("views and edits an issue by immutable numeric issue number", async () => {
    const api = new FakeApi(issueResponse(), issueResponse({ title: "Fixed title" }));
    const service = new IssueService(api);

    await service.view(repository, 12);
    const issue = await service.edit(repository, 12, {
      title: "Fixed title",
      body: "Updated body",
      assignees: ["ada", "grace"],
      milestoneId: 4,
      dueOn: "2026-10-01T00:00:00Z",
      ref: "develop",
    });

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "issues", "12"],
      },
      {
        method: "PATCH",
        path: ["repos", "acme", "widget", "issues", "12"],
        body: {
          title: "Fixed title",
          body: "Updated body",
          assignees: ["ada", "grace"],
          milestone: 4,
          due_date: "2026-10-01T00:00:00Z",
          ref: "develop",
        },
      },
    ]);
    expect(issue.title).toBe("Fixed title");
  });

  it("changes issue state with the minimal exact body", async () => {
    const api = new FakeApi(issueResponse({ state: "closed" }), issueResponse({ state: "open" }));
    const service = new IssueService(api);

    await service.close(repository, 12);
    await service.reopen(repository, 12);

    expect(api.calls).toEqual([
      {
        method: "PATCH",
        path: ["repos", "acme", "widget", "issues", "12"],
        body: { state: "closed" },
      },
      {
        method: "PATCH",
        path: ["repos", "acme", "widget", "issues", "12"],
        body: { state: "open" },
      },
    ]);
  });

  it("posts an issue comment and normalizes its response", async () => {
    const api = new FakeApi({
      id: 55,
      body: "I can reproduce this.",
      html_url: "https://git.example.com/acme/widget/issues/12#issuecomment-55",
      user: userResponse,
      created_at: "2026-08-03T00:00:00Z",
      updated_at: "2026-08-03T00:00:00Z",
    });
    const service = new IssueService(api);

    const comment = await service.comment(repository, 12, "I can reproduce this.");

    expect(api.calls).toEqual([
      {
        method: "POST",
        path: ["repos", "acme", "widget", "issues", "12", "comments"],
        body: { body: "I can reproduce this." },
      },
    ]);
    expect(comment).toEqual({
      id: 55,
      body: "I can reproduce this.",
      htmlUrl: "https://git.example.com/acme/widget/issues/12#issuecomment-55",
      author: {
        id: 2,
        login: "ada",
        fullName: "Ada Lovelace",
      },
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
    });
    expect(Object.isFrozen(comment)).toBe(true);
  });

  it("rejects malformed Forgejo issue responses at runtime", async () => {
    const api = new FakeApi(issueResponse({ id: "not-a-number" }));
    const service = new IssueService(api);

    await expect(service.view(repository, 12)).rejects.toMatchObject({ code: "protocol_failed" });
  });

  it("validates repository, numeric IDs, pagination, and edit inputs before requesting", async () => {
    const api = new FakeApi();
    const service = new IssueService(api);

    await expect(service.view({ owner: "", repository: "widget" }, 12)).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.view(repository, 0)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.list(repository, { page: 0 })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.edit(repository, 12, {})).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(api.calls).toHaveLength(0);
  });
});
