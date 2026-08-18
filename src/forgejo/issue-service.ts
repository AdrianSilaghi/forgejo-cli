import { z } from "zod";

import type { ForgejoApi, QueryValue } from "../http/forgejo-api.js";
import { parseInput, parseResponse } from "./validation.js";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

function isFreeOfAsciiControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && code > 31 && code !== 127;
  });
}

const nonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Values cannot be blank.")
  .refine(isFreeOfAsciiControlCharacters, "Values cannot contain control characters.");

const pathSegmentSchema = nonEmptyStringSchema
  .refine((value) => value !== "." && value !== "..", "Relative path segments are forbidden.")
  .refine(
    (value) => !value.includes("/") && !value.includes("\\"),
    "Path segments cannot contain separators.",
  );

const repositorySchema = z.strictObject({
  owner: pathSegmentSchema,
  repository: pathSegmentSchema,
});

const stableIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const issueStateSchema = z.enum(["open", "closed"]);
const listStateSchema = z.enum(["open", "closed", "all"]);
const issueSortSchema = z.enum([
  "relevance",
  "latest",
  "oldest",
  "recentupdate",
  "leastupdate",
  "mostcomment",
  "leastcomment",
  "nearduedate",
  "farduedate",
]);

const createIssueSchema = z.strictObject({
  title: nonEmptyStringSchema,
  body: z.string().optional(),
  assignees: z.array(nonEmptyStringSchema).optional(),
  labelIds: z.array(stableIdSchema).optional(),
  milestoneId: stableIdSchema.optional(),
  dueOn: z.string().min(1).optional(),
  ref: nonEmptyStringSchema.optional(),
});

const editIssueSchema = z
  .strictObject({
    title: nonEmptyStringSchema.optional(),
    body: z.string().optional(),
    assignees: z.array(nonEmptyStringSchema).optional(),
    milestoneId: stableIdSchema.optional(),
    dueOn: z.string().min(1).optional(),
    unsetDueDate: z.boolean().optional(),
    ref: nonEmptyStringSchema.optional(),
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    "At least one issue field must be provided.",
  )
  .refine(
    (input) => input.dueOn === undefined || input.unsetDueDate !== true,
    "An issue due date cannot be set and removed in the same request.",
  );

const listOptionsSchema = z.strictObject({
  state: listStateSchema.default("open"),
  labels: z.array(nonEmptyStringSchema).optional(),
  query: z.string().optional(),
  milestones: z.array(nonEmptyStringSchema).optional(),
  since: z.string().min(1).optional(),
  before: z.string().min(1).optional(),
  createdBy: nonEmptyStringSchema.optional(),
  assignedBy: nonEmptyStringSchema.optional(),
  mentionedBy: nonEmptyStringSchema.optional(),
  page: stableIdSchema.default(1),
  limit: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sort: issueSortSchema.optional(),
});

const userResponseSchema = z.object({
  id: stableIdSchema,
  login: z.string(),
  full_name: z.string().optional().default(""),
});

const labelResponseSchema = z.object({
  id: stableIdSchema,
  name: z.string(),
  color: z.string(),
  description: z.string().nullable().optional(),
  exclusive: z.boolean().default(false),
  is_archived: z.boolean().default(false),
  url: z.string().nullable().optional(),
});

const optionalApiStringSchema = z.string().nullable().optional();
const milestoneResponseSchema = z.object({
  id: stableIdSchema,
  title: z.string(),
  description: z.string().nullable().optional(),
  state: issueStateSchema,
  open_issues: z.number().int().nonnegative().default(0),
  closed_issues: z.number().int().nonnegative().default(0),
  due_on: optionalApiStringSchema,
  created_at: optionalApiStringSchema,
  updated_at: optionalApiStringSchema,
  closed_at: optionalApiStringSchema,
});

const issueResponseSchema = z.object({
  id: stableIdSchema,
  number: stableIdSchema,
  title: z.string(),
  body: z.string().nullable().optional(),
  state: issueStateSchema,
  html_url: z.string(),
  user: userResponseSchema,
  assignees: z.array(userResponseSchema).nullable().optional(),
  labels: z.array(labelResponseSchema).nullable().optional(),
  milestone: milestoneResponseSchema.nullable().optional(),
  comments: z.number().int().nonnegative().default(0),
  is_locked: z.boolean().default(false),
  due_date: optionalApiStringSchema,
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: optionalApiStringSchema,
});

const commentResponseSchema = z.object({
  id: stableIdSchema,
  body: z.string(),
  html_url: z.string(),
  user: userResponseSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

const issueListResponseSchema = z.array(issueResponseSchema);
const commentBodySchema = z.string().min(1);

type ParsedUser = z.infer<typeof userResponseSchema>;
type ParsedLabel = z.infer<typeof labelResponseSchema>;
type ParsedMilestone = z.infer<typeof milestoneResponseSchema>;
type ParsedIssue = z.infer<typeof issueResponseSchema>;
type ParsedCreateIssue = z.infer<typeof createIssueSchema>;
type ParsedEditIssue = z.infer<typeof editIssueSchema>;

export type RepositoryRef = Readonly<{
  owner: string;
  repository: string;
}>;

export type IssueState = "open" | "closed";
export type IssueListState = IssueState | "all";
export type IssueSort =
  | "relevance"
  | "latest"
  | "oldest"
  | "recentupdate"
  | "leastupdate"
  | "mostcomment"
  | "leastcomment"
  | "nearduedate"
  | "farduedate";

export type CreateIssueInput = Readonly<{
  title: string;
  body?: string;
  assignees?: readonly string[];
  labelIds?: readonly number[];
  milestoneId?: number;
  dueOn?: string;
  ref?: string;
}>;

export type EditIssueInput = Readonly<{
  title?: string;
  body?: string;
  assignees?: readonly string[];
  milestoneId?: number;
  dueOn?: string;
  unsetDueDate?: boolean;
  ref?: string;
}>;

export type ListIssuesOptions = Readonly<{
  state?: IssueListState;
  labels?: readonly string[];
  query?: string;
  milestones?: readonly string[];
  since?: string;
  before?: string;
  createdBy?: string;
  assignedBy?: string;
  mentionedBy?: string;
  page?: number;
  limit?: number;
  sort?: IssueSort;
}>;

export type IssueAuthor = Readonly<{
  id: number;
  login: string;
  fullName: string;
}>;

export type IssueLabel = Readonly<{
  id: number;
  name: string;
  color: string;
  description: string;
  exclusive: boolean;
  isArchived: boolean;
  url: string | null;
}>;

export type IssueMilestone = Readonly<{
  id: number;
  title: string;
  description: string;
  state: IssueState;
  openIssues: number;
  closedIssues: number;
  dueOn: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
}>;

export type Issue = Readonly<{
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  htmlUrl: string;
  author: IssueAuthor;
  assignees: readonly IssueAuthor[];
  labels: readonly IssueLabel[];
  milestone: IssueMilestone | null;
  commentsCount: number;
  isLocked: boolean;
  dueOn: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}>;

export type IssueComment = Readonly<{
  id: number;
  body: string;
  htmlUrl: string;
  author: IssueAuthor;
  createdAt: string;
  updatedAt: string;
}>;

export interface IssueOperations {
  create(repository: RepositoryRef, input: CreateIssueInput): Promise<Issue>;
  list(repository: RepositoryRef, options?: ListIssuesOptions): Promise<readonly Issue[]>;
  view(repository: RepositoryRef, number: number): Promise<Issue>;
  edit(repository: RepositoryRef, number: number, input: EditIssueInput): Promise<Issue>;
  setState(repository: RepositoryRef, number: number, state: IssueState): Promise<Issue>;
  close(repository: RepositoryRef, number: number): Promise<Issue>;
  reopen(repository: RepositoryRef, number: number): Promise<Issue>;
  comment(repository: RepositoryRef, number: number, body: string): Promise<IssueComment>;
}

function issuePath(repository: RepositoryRef): readonly string[] {
  const parsed = parseInput(repositorySchema, repository);
  return ["repos", parsed.owner, parsed.repository, "issues"];
}

function definedQuery(
  entries: readonly (readonly [string, QueryValue])[],
): Readonly<Record<string, QueryValue>> {
  return Object.freeze(Object.fromEntries(entries.filter(([, value]) => value !== undefined)));
}

function createIssueBody(input: ParsedCreateIssue): Readonly<Record<string, unknown>> {
  return Object.freeze({
    title: input.title,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.assignees === undefined ? {} : { assignees: Object.freeze([...input.assignees]) }),
    ...(input.labelIds === undefined ? {} : { labels: Object.freeze([...input.labelIds]) }),
    ...(input.milestoneId === undefined ? {} : { milestone: input.milestoneId }),
    ...(input.dueOn === undefined ? {} : { due_date: input.dueOn }),
    ...(input.ref === undefined ? {} : { ref: input.ref }),
  });
}

function editIssueBody(input: ParsedEditIssue): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.assignees === undefined ? {} : { assignees: Object.freeze([...input.assignees]) }),
    ...(input.milestoneId === undefined ? {} : { milestone: input.milestoneId }),
    ...(input.dueOn === undefined ? {} : { due_date: input.dueOn }),
    ...(input.unsetDueDate === undefined ? {} : { unset_due_date: input.unsetDueDate }),
    ...(input.ref === undefined ? {} : { ref: input.ref }),
  });
}

function normalizeAuthor(raw: ParsedUser): IssueAuthor {
  return Object.freeze({ id: raw.id, login: raw.login, fullName: raw.full_name });
}

function normalizeLabel(raw: ParsedLabel): IssueLabel {
  return Object.freeze({
    id: raw.id,
    name: raw.name,
    color: raw.color,
    description: raw.description ?? "",
    exclusive: raw.exclusive,
    isArchived: raw.is_archived,
    url: raw.url ?? null,
  });
}

function normalizeMilestone(raw: ParsedMilestone): IssueMilestone {
  return Object.freeze({
    id: raw.id,
    title: raw.title,
    description: raw.description ?? "",
    state: raw.state,
    openIssues: raw.open_issues,
    closedIssues: raw.closed_issues,
    dueOn: raw.due_on ?? null,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
    closedAt: raw.closed_at ?? null,
  });
}

function normalizeIssue(raw: ParsedIssue): Issue {
  const assignees = Object.freeze((raw.assignees ?? []).map(normalizeAuthor));
  const labels = Object.freeze((raw.labels ?? []).map(normalizeLabel));

  return Object.freeze({
    id: raw.id,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    htmlUrl: raw.html_url,
    author: normalizeAuthor(raw.user),
    assignees,
    labels,
    milestone:
      raw.milestone === null || raw.milestone === undefined
        ? null
        : normalizeMilestone(raw.milestone),
    commentsCount: raw.comments,
    isLocked: raw.is_locked,
    dueOn: raw.due_date ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
  });
}

function normalizeComment(response: unknown): IssueComment {
  const raw = parseResponse(commentResponseSchema, response);
  return Object.freeze({
    id: raw.id,
    body: raw.body,
    htmlUrl: raw.html_url,
    author: normalizeAuthor(raw.user),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  });
}

export class IssueService implements IssueOperations {
  readonly #api: ForgejoApi;

  public constructor(api: ForgejoApi) {
    this.#api = api;
  }

  public async create(repository: RepositoryRef, input: CreateIssueInput): Promise<Issue> {
    const path = issuePath(repository);
    const parsed = parseInput(createIssueSchema, input);
    const response = await this.#api.request({
      method: "POST",
      path,
      body: createIssueBody(parsed),
    });
    return normalizeIssue(parseResponse(issueResponseSchema, response));
  }

  public async list(
    repository: RepositoryRef,
    options: ListIssuesOptions = {},
  ): Promise<readonly Issue[]> {
    const path = issuePath(repository);
    const parsed = parseInput(listOptionsSchema, options);
    const query = definedQuery([
      ["state", parsed.state],
      ["labels", parsed.labels?.length === 0 ? undefined : parsed.labels?.join(",")],
      ["q", parsed.query],
      ["type", "issues"],
      ["milestones", parsed.milestones?.length === 0 ? undefined : parsed.milestones?.join(",")],
      ["since", parsed.since],
      ["before", parsed.before],
      ["created_by", parsed.createdBy],
      ["assigned_by", parsed.assignedBy],
      ["mentioned_by", parsed.mentionedBy],
      ["page", parsed.page],
      ["limit", parsed.limit],
      ["sort", parsed.sort],
    ]);
    const response = await this.#api.request({ method: "GET", path, query });
    const issues = parseResponse(issueListResponseSchema, response).map(normalizeIssue);
    return Object.freeze(issues);
  }

  public async view(repository: RepositoryRef, number: number): Promise<Issue> {
    const path = issuePath(repository);
    const parsedNumber = parseInput(stableIdSchema, number);
    const response = await this.#api.request({
      method: "GET",
      path: [...path, String(parsedNumber)],
    });
    return normalizeIssue(parseResponse(issueResponseSchema, response));
  }

  public async edit(
    repository: RepositoryRef,
    number: number,
    input: EditIssueInput,
  ): Promise<Issue> {
    const path = issuePath(repository);
    const parsedNumber = parseInput(stableIdSchema, number);
    const parsed = parseInput(editIssueSchema, input);
    const response = await this.#api.request({
      method: "PATCH",
      path: [...path, String(parsedNumber)],
      body: editIssueBody(parsed),
    });
    return normalizeIssue(parseResponse(issueResponseSchema, response));
  }

  public async setState(
    repository: RepositoryRef,
    number: number,
    state: IssueState,
  ): Promise<Issue> {
    const path = issuePath(repository);
    const parsedNumber = parseInput(stableIdSchema, number);
    const parsedState = parseInput(issueStateSchema, state);
    const response = await this.#api.request({
      method: "PATCH",
      path: [...path, String(parsedNumber)],
      body: { state: parsedState },
    });
    return normalizeIssue(parseResponse(issueResponseSchema, response));
  }

  public async close(repository: RepositoryRef, number: number): Promise<Issue> {
    return this.setState(repository, number, "closed");
  }

  public async reopen(repository: RepositoryRef, number: number): Promise<Issue> {
    return this.setState(repository, number, "open");
  }

  public async comment(
    repository: RepositoryRef,
    number: number,
    body: string,
  ): Promise<IssueComment> {
    const path = issuePath(repository);
    const parsedNumber = parseInput(stableIdSchema, number);
    const parsedBody = parseInput(commentBodySchema, body);
    const response = await this.#api.request({
      method: "POST",
      path: [...path, String(parsedNumber), "comments"],
      body: { body: parsedBody },
    });
    return normalizeComment(response);
  }
}
