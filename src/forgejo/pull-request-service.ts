import { z } from "zod";

import type { ForgejoApi } from "../http/forgejo-api.js";
import { parseInput, parseResponse } from "./validation.js";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

function isFreeOfAsciiControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
  });
}

const nonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Value cannot be blank.")
  .refine(isFreeOfAsciiControlCharacters, "Value cannot contain control characters.");
const pathSegmentSchema = nonEmptyStringSchema
  .refine((value) => value !== "." && value !== "..", "Relative path segments are forbidden.")
  .refine(
    (value) => !value.includes("/") && !value.includes("\\"),
    "Path segments cannot contain separators.",
  );
const stableIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repositorySchema = z.strictObject({
  owner: pathSegmentSchema,
  repository: pathSegmentSchema,
});

export type PullRequestState = "open" | "closed";
export type PullRequestListState = PullRequestState | "all";
export type PullRequestSort =
  | "oldest"
  | "recentupdate"
  | "recentclose"
  | "leastupdate"
  | "mostcomment"
  | "leastcomment"
  | "priority";
export type PullRequestReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type RepositoryRef = Readonly<{
  owner: string;
  repository: string;
}>;

export type PullRequestCreateInput = Readonly<{
  title: string;
  head: string;
  base: string;
  body?: string;
  assignees?: readonly string[];
  labels?: readonly number[];
  milestone?: number;
  dueDate?: string;
}>;

export type PullRequestListOptions = Readonly<{
  state?: PullRequestListState;
  sort?: PullRequestSort;
  milestone?: number;
  poster?: string;
  base?: string;
  head?: string;
  page?: number;
  limit?: number;
}>;

export type PullRequestReviewInput = Readonly<{
  event: PullRequestReviewEvent;
  body?: string;
  commitId?: string;
}>;

export type PullRequestAuthor = Readonly<{
  id: number;
  login: string;
  fullName: string;
}>;

export type PullRequestBranch = Readonly<{
  label: string;
  ref: string;
  sha: string;
  repositoryId: number;
}>;

export type PullRequest = Readonly<{
  id: number;
  number: number;
  title: string;
  body: string;
  state: PullRequestState;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  htmlUrl: string;
  author: PullRequestAuthor;
  head: PullRequestBranch;
  base: PullRequestBranch;
  commentsCount: number;
  reviewCommentsCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}>;

export type PullRequestComment = Readonly<{
  id: number;
  body: string;
  htmlUrl: string;
  author: PullRequestAuthor;
  createdAt: string;
  updatedAt: string;
}>;

export type PullRequestReview = Readonly<{
  id: number;
  body: string;
  state: string;
  commitId: string;
  htmlUrl: string;
  author: PullRequestAuthor;
  commentsCount: number;
  dismissed: boolean;
  official: boolean;
  stale: boolean;
  submittedAt: string;
  updatedAt: string;
}>;

export interface PullRequestOperations {
  create(repository: RepositoryRef, input: PullRequestCreateInput): Promise<PullRequest>;
  list(
    repository: RepositoryRef,
    options?: PullRequestListOptions,
  ): Promise<readonly PullRequest[]>;
  view(repository: RepositoryRef, number: number): Promise<PullRequest>;
  comment(repository: RepositoryRef, number: number, body: string): Promise<PullRequestComment>;
  review(
    repository: RepositoryRef,
    number: number,
    input: PullRequestReviewInput,
  ): Promise<PullRequestReview>;
}

const createInputSchema = z.strictObject({
  title: nonEmptyStringSchema,
  head: nonEmptyStringSchema,
  base: nonEmptyStringSchema,
  body: z.string().optional(),
  assignees: z.array(nonEmptyStringSchema).optional(),
  labels: z.array(stableIdSchema).optional(),
  milestone: stableIdSchema.optional(),
  dueDate: nonEmptyStringSchema.optional(),
});

const listOptionsSchema = z.strictObject({
  state: z.enum(["open", "closed", "all"]).default("open"),
  sort: z
    .enum([
      "oldest",
      "recentupdate",
      "recentclose",
      "leastupdate",
      "mostcomment",
      "leastcomment",
      "priority",
    ])
    .optional(),
  milestone: stableIdSchema.optional(),
  poster: nonEmptyStringSchema.optional(),
  base: nonEmptyStringSchema.optional(),
  head: nonEmptyStringSchema.optional(),
  page: stableIdSchema.default(1),
  limit: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const reviewInputSchema = z.strictObject({
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  body: z.string().optional(),
  commitId: nonEmptyStringSchema.optional(),
});

const userResponseSchema = z.object({
  id: z.number().int(),
  login: z.string(),
  full_name: z.string().optional().default(""),
});

const branchResponseSchema = z.object({
  label: z.string(),
  ref: z.string(),
  sha: z.string(),
  repo_id: z.number().int(),
});

const pullRequestResponseSchema = z.object({
  id: z.number().int(),
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  mergeable: z.boolean().nullable(),
  html_url: z.string(),
  user: userResponseSchema,
  head: branchResponseSchema,
  base: branchResponseSchema,
  comments: z.number().int(),
  review_comments: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable().optional(),
  merged_at: z.string().nullable().optional(),
});

const commentResponseSchema = z.object({
  id: z.number().int(),
  body: z.string(),
  html_url: z.string(),
  user: userResponseSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

const reviewResponseSchema = z.object({
  id: z.number().int(),
  body: z.string(),
  state: z.string(),
  commit_id: z.string(),
  html_url: z.string(),
  user: userResponseSchema,
  comments_count: z.number().int(),
  dismissed: z.boolean(),
  official: z.boolean(),
  stale: z.boolean(),
  submitted_at: z.string(),
  updated_at: z.string(),
});

function normalizeAuthor(user: z.infer<typeof userResponseSchema>): PullRequestAuthor {
  return Object.freeze({
    id: user.id,
    login: user.login,
    fullName: user.full_name,
  });
}

function normalizeBranch(branch: z.infer<typeof branchResponseSchema>): PullRequestBranch {
  return Object.freeze({
    label: branch.label,
    ref: branch.ref,
    sha: branch.sha,
    repositoryId: branch.repo_id,
  });
}

function normalizePullRequest(parsed: z.infer<typeof pullRequestResponseSchema>): PullRequest {
  return Object.freeze({
    id: parsed.id,
    number: parsed.number,
    title: parsed.title,
    body: parsed.body,
    state: parsed.state,
    draft: parsed.draft,
    merged: parsed.merged,
    mergeable: parsed.mergeable,
    htmlUrl: parsed.html_url,
    author: normalizeAuthor(parsed.user),
    head: normalizeBranch(parsed.head),
    base: normalizeBranch(parsed.base),
    commentsCount: parsed.comments,
    reviewCommentsCount: parsed.review_comments,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    closedAt: parsed.closed_at ?? null,
    mergedAt: parsed.merged_at ?? null,
  });
}

function normalizeComment(parsed: z.infer<typeof commentResponseSchema>): PullRequestComment {
  return Object.freeze({
    id: parsed.id,
    body: parsed.body,
    htmlUrl: parsed.html_url,
    author: normalizeAuthor(parsed.user),
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}

function normalizeReview(parsed: z.infer<typeof reviewResponseSchema>): PullRequestReview {
  return Object.freeze({
    id: parsed.id,
    body: parsed.body,
    state: parsed.state,
    commitId: parsed.commit_id,
    htmlUrl: parsed.html_url,
    author: normalizeAuthor(parsed.user),
    commentsCount: parsed.comments_count,
    dismissed: parsed.dismissed,
    official: parsed.official,
    stale: parsed.stale,
    submittedAt: parsed.submitted_at,
    updatedAt: parsed.updated_at,
  });
}

function pullRequestPath(repository: RepositoryRef): readonly string[] {
  const parsed = parseInput(repositorySchema, repository);
  return ["repos", parsed.owner, parsed.repository, "pulls"];
}

export class PullRequestService implements PullRequestOperations {
  readonly #api: ForgejoApi;

  public constructor(api: ForgejoApi) {
    this.#api = api;
  }

  public async create(
    repository: RepositoryRef,
    input: PullRequestCreateInput,
  ): Promise<PullRequest> {
    const path = pullRequestPath(repository);
    const parsed = parseInput(createInputSchema, input);
    const body = {
      title: parsed.title,
      head: parsed.head,
      base: parsed.base,
      ...(parsed.body === undefined ? {} : { body: parsed.body }),
      ...(parsed.assignees === undefined ? {} : { assignees: [...parsed.assignees] }),
      ...(parsed.labels === undefined ? {} : { labels: [...parsed.labels] }),
      ...(parsed.milestone === undefined ? {} : { milestone: parsed.milestone }),
      ...(parsed.dueDate === undefined ? {} : { due_date: parsed.dueDate }),
    };
    const response = await this.#api.request({
      method: "POST",
      path,
      body,
    });

    return normalizePullRequest(parseResponse(pullRequestResponseSchema, response));
  }

  public async list(
    repository: RepositoryRef,
    options: PullRequestListOptions = {},
  ): Promise<readonly PullRequest[]> {
    const path = pullRequestPath(repository);
    const parsedOptions = parseInput(listOptionsSchema, options);
    const response = await this.#api.request({
      method: "GET",
      path,
      query: {
        state: parsedOptions.state,
        ...(parsedOptions.sort === undefined ? {} : { sort: parsedOptions.sort }),
        ...(parsedOptions.milestone === undefined ? {} : { milestone: parsedOptions.milestone }),
        ...(parsedOptions.poster === undefined ? {} : { poster: parsedOptions.poster }),
        ...(parsedOptions.base === undefined ? {} : { base: parsedOptions.base }),
        ...(parsedOptions.head === undefined ? {} : { head: parsedOptions.head }),
        page: parsedOptions.page,
        limit: parsedOptions.limit,
      },
    });
    const parsed = parseResponse(z.array(pullRequestResponseSchema), response);

    return Object.freeze(parsed.map((pull) => normalizePullRequest(pull)));
  }

  public async view(repository: RepositoryRef, number: number): Promise<PullRequest> {
    const path = pullRequestPath(repository);
    const parsedNumber = parseInput(stableIdSchema, number);
    const response = await this.#api.request({
      method: "GET",
      path: [...path, String(parsedNumber)],
    });

    return normalizePullRequest(parseResponse(pullRequestResponseSchema, response));
  }

  public async comment(
    repository: RepositoryRef,
    number: number,
    body: string,
  ): Promise<PullRequestComment> {
    const parsedRepository = parseInput(repositorySchema, repository);
    const parsedNumber = parseInput(stableIdSchema, number);
    const parsedBody = parseInput(nonEmptyStringSchema, body);
    const response = await this.#api.request({
      method: "POST",
      path: [
        "repos",
        parsedRepository.owner,
        parsedRepository.repository,
        "issues",
        String(parsedNumber),
        "comments",
      ],
      body: { body: parsedBody },
    });

    return normalizeComment(parseResponse(commentResponseSchema, response));
  }

  public async review(
    repository: RepositoryRef,
    number: number,
    input: PullRequestReviewInput,
  ): Promise<PullRequestReview> {
    const path = pullRequestPath(repository);
    const parsedNumber = parseInput(stableIdSchema, number);
    const parsed = parseInput(reviewInputSchema, input);
    const body = {
      event: parsed.event,
      ...(parsed.body === undefined ? {} : { body: parsed.body }),
      ...(parsed.commitId === undefined ? {} : { commit_id: parsed.commitId }),
    };
    const response = await this.#api.request({
      method: "POST",
      path: [...path, String(parsedNumber), "reviews"],
      body,
    });

    return normalizeReview(parseResponse(reviewResponseSchema, response));
  }
}
