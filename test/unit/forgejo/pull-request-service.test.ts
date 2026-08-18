import { describe, expect, it } from "bun:test";

import {
  type PullRequest,
  PullRequestService,
  type RepositoryRef,
} from "../../../src/forgejo/pull-request-service.js";
import type { ForgejoApi, ForgejoRequest } from "../../../src/http/forgejo-api.js";

const repository = Object.freeze({
  owner: "acme",
  repository: "widget",
}) satisfies RepositoryRef;

class QueueApi implements ForgejoApi {
  public readonly requests: ForgejoRequest[] = [];
  readonly #responses: readonly unknown[];
  #responseIndex = 0;

  public constructor(...responses: readonly unknown[]) {
    this.#responses = responses;
  }

  public async request(request: ForgejoRequest): Promise<unknown> {
    this.requests.push(request);
    const response = this.#responses[this.#responseIndex];
    this.#responseIndex += 1;
    if (response === undefined) {
      throw new Error("Unexpected request");
    }
    return response;
  }
}

const pullResponse = {
  id: 87,
  number: 12,
  title: "Add JSON output",
  body: "Keeps automation stable.",
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  html_url: "https://git.example.com/acme/widget/pulls/12",
  user: { id: 5, login: "agent", full_name: "Automation Agent" },
  head: { label: "agent:json-output", ref: "json-output", sha: "abc123", repo_id: 42 },
  base: { label: "acme:main", ref: "main", sha: "def456", repo_id: 41 },
  comments: 3,
  review_comments: 1,
  created_at: "2026-08-17T10:00:00Z",
  updated_at: "2026-08-18T08:00:00Z",
  closed_at: null,
  merged_at: null,
  unknown_server_field: { secret: true },
};

const normalizedPull = {
  id: 87,
  number: 12,
  title: "Add JSON output",
  body: "Keeps automation stable.",
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  htmlUrl: "https://git.example.com/acme/widget/pulls/12",
  author: { id: 5, login: "agent", fullName: "Automation Agent" },
  head: { label: "agent:json-output", ref: "json-output", sha: "abc123", repositoryId: 42 },
  base: { label: "acme:main", ref: "main", sha: "def456", repositoryId: 41 },
  commentsCount: 3,
  reviewCommentsCount: 1,
  createdAt: "2026-08-17T10:00:00Z",
  updatedAt: "2026-08-18T08:00:00Z",
  closedAt: null,
  mergedAt: null,
} satisfies PullRequest;

describe("PullRequestService", () => {
  it("creates a pull request with the exact Forgejo body and normalizes the response", async () => {
    const api = new QueueApi(pullResponse);

    const pull = await new PullRequestService(api).create(repository, {
      title: "Add JSON output",
      head: "agent:json-output",
      base: "main",
      body: "Keeps automation stable.",
      assignees: ["reviewer"],
      labels: [4, 9],
      milestone: 2,
      dueDate: "2026-08-31T00:00:00Z",
    });

    expect(api.requests).toEqual([
      {
        method: "POST",
        path: ["repos", "acme", "widget", "pulls"],
        body: {
          title: "Add JSON output",
          head: "agent:json-output",
          base: "main",
          body: "Keeps automation stable.",
          assignees: ["reviewer"],
          labels: [4, 9],
          milestone: 2,
          due_date: "2026-08-31T00:00:00Z",
        },
      },
    ]);
    expect(pull).toEqual(normalizedPull);
    expect(pull).not.toBe(pullResponse);
    expect(Object.isFrozen(pull)).toBe(true);
    expect(Object.isFrozen(pull.author)).toBe(true);
    expect(Object.isFrozen(pull.head)).toBe(true);
  });

  it("omits absent optional create fields instead of sending undefined values", async () => {
    const api = new QueueApi(pullResponse);

    await new PullRequestService(api).create(repository, {
      title: "Add JSON output",
      head: "json-output",
      base: "main",
    });

    expect(api.requests[0]?.body).toEqual({
      title: "Add JSON output",
      head: "json-output",
      base: "main",
    });
  });

  it("lists one page with the exact supported pagination and filter query", async () => {
    const api = new QueueApi([pullResponse]);

    const pulls = await new PullRequestService(api).list(repository, {
      state: "all",
      sort: "recentupdate",
      milestone: 3,
      poster: "agent",
      base: "main",
      head: "json-output",
      page: 2,
      limit: 25,
    });

    expect(api.requests).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "pulls"],
        query: {
          state: "all",
          sort: "recentupdate",
          milestone: 3,
          poster: "agent",
          base: "main",
          head: "json-output",
          page: 2,
          limit: 25,
        },
      },
    ]);
    expect(pulls).toEqual([normalizedPull]);
    expect(Object.isFrozen(pulls)).toBe(true);
    expect(Object.isFrozen(pulls[0])).toBe(true);
  });

  it("uses an explicit bounded first page when list options are omitted", async () => {
    const api = new QueueApi([pullResponse]);

    await new PullRequestService(api).list(repository);

    expect(api.requests).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "pulls"],
        query: { state: "open", page: 1, limit: 30 },
      },
    ]);
  });

  it("views a pull request through its repository-scoped index", async () => {
    const api = new QueueApi(pullResponse);

    await expect(new PullRequestService(api).view(repository, 12)).resolves.toEqual(normalizedPull);
    expect(api.requests).toEqual([
      { method: "GET", path: ["repos", "acme", "widget", "pulls", "12"] },
    ]);
  });

  it("comments through the pull request's issue endpoint and normalizes the comment", async () => {
    const api = new QueueApi({
      id: 501,
      body: "Please add a regression test.",
      html_url: "https://git.example.com/acme/widget/pulls/12#issuecomment-501",
      user: { id: 6, login: "reviewer", full_name: "Code Reviewer" },
      created_at: "2026-08-18T09:00:00Z",
      updated_at: "2026-08-18T09:00:00Z",
    });

    const comment = await new PullRequestService(api).comment(
      repository,
      12,
      "Please add a regression test.",
    );

    expect(api.requests).toEqual([
      {
        method: "POST",
        path: ["repos", "acme", "widget", "issues", "12", "comments"],
        body: { body: "Please add a regression test." },
      },
    ]);
    expect(comment).toEqual({
      id: 501,
      body: "Please add a regression test.",
      htmlUrl: "https://git.example.com/acme/widget/pulls/12#issuecomment-501",
      author: { id: 6, login: "reviewer", fullName: "Code Reviewer" },
      createdAt: "2026-08-18T09:00:00Z",
      updatedAt: "2026-08-18T09:00:00Z",
    });
    expect(Object.isFrozen(comment)).toBe(true);
  });

  it("submits a review using Forgejo's event and commit_id body fields", async () => {
    const api = new QueueApi({
      id: 701,
      body: "The contract looks good.",
      state: "APPROVED",
      commit_id: "abc123",
      html_url: "https://git.example.com/acme/widget/pulls/12#pullreview-701",
      user: { id: 6, login: "reviewer", full_name: "Code Reviewer" },
      comments_count: 0,
      dismissed: false,
      official: true,
      stale: false,
      submitted_at: "2026-08-18T09:15:00Z",
      updated_at: "2026-08-18T09:15:00Z",
    });

    const review = await new PullRequestService(api).review(repository, 12, {
      event: "APPROVE",
      body: "The contract looks good.",
      commitId: "abc123",
    });

    expect(api.requests).toEqual([
      {
        method: "POST",
        path: ["repos", "acme", "widget", "pulls", "12", "reviews"],
        body: {
          event: "APPROVE",
          body: "The contract looks good.",
          commit_id: "abc123",
        },
      },
    ]);
    expect(review).toEqual({
      id: 701,
      body: "The contract looks good.",
      state: "APPROVED",
      commitId: "abc123",
      htmlUrl: "https://git.example.com/acme/widget/pulls/12#pullreview-701",
      author: { id: 6, login: "reviewer", fullName: "Code Reviewer" },
      commentsCount: 0,
      dismissed: false,
      official: true,
      stale: false,
      submittedAt: "2026-08-18T09:15:00Z",
      updatedAt: "2026-08-18T09:15:00Z",
    });
    expect(Object.isFrozen(review)).toBe(true);
  });

  it("rejects malformed list and mutation responses at runtime", async () => {
    const api = new QueueApi([{ ...pullResponse, number: "12" }], { id: "bad" });
    const service = new PullRequestService(api);

    await expect(service.list(repository)).rejects.toMatchObject({ code: "protocol_failed" });
    await expect(service.comment(repository, 12, "hello")).rejects.toMatchObject({
      code: "protocol_failed",
    });
  });

  it("validates repository, pull number, pagination, and mutation inputs before requesting", async () => {
    const api = new QueueApi();
    const service = new PullRequestService(api);

    await expect(service.list({ owner: " ", repository: "widget" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.list({ owner: "acme", repository: "../admin" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.list(repository, { limit: 0 })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.view(repository, 0)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      service.create(repository, { title: " ", head: "feature", base: "main" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.comment(repository, 12, "")).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(api.requests).toHaveLength(0);
  });
});
