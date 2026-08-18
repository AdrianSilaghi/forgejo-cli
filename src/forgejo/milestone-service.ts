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
const milestoneStateSchema = z.enum(["open", "closed"]);

const listOptionsSchema = z.strictObject({
  state: z.enum(["open", "closed", "all"]).default("open"),
  name: z.string().optional(),
  page: stableIdSchema.default(1),
  limit: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const milestoneFieldsSchema = {
  title: nonEmptyStringSchema,
  description: z.string().optional(),
  dueOn: z.string().min(1).optional(),
  state: milestoneStateSchema.optional(),
} as const;

const createMilestoneSchema = z.strictObject(milestoneFieldsSchema);
const editMilestoneSchema = z
  .strictObject({
    title: milestoneFieldsSchema.title.optional(),
    description: milestoneFieldsSchema.description,
    dueOn: milestoneFieldsSchema.dueOn,
    state: milestoneFieldsSchema.state,
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    "At least one milestone field must be provided.",
  );

const optionalApiStringSchema = z.string().nullable().optional();
const milestoneResponseSchema = z.object({
  id: stableIdSchema,
  title: z.string(),
  description: z.string().nullable().optional(),
  state: milestoneStateSchema,
  open_issues: z.number().int().nonnegative().default(0),
  closed_issues: z.number().int().nonnegative().default(0),
  due_on: optionalApiStringSchema,
  created_at: optionalApiStringSchema,
  updated_at: optionalApiStringSchema,
  closed_at: optionalApiStringSchema,
});

const milestoneListResponseSchema = z.array(milestoneResponseSchema);
const deleteResponseSchema = z.null();

type ParsedMilestoneInput = z.infer<typeof editMilestoneSchema>;
type ParsedMilestoneResponse = z.infer<typeof milestoneResponseSchema>;

export type RepositoryRef = Readonly<{
  owner: string;
  repository: string;
}>;

export type MilestoneState = "open" | "closed";
export type MilestoneListState = MilestoneState | "all";

export type ListMilestonesOptions = Readonly<{
  state?: MilestoneListState;
  name?: string;
  page?: number;
  limit?: number;
}>;

export type CreateMilestoneInput = Readonly<{
  title: string;
  description?: string;
  dueOn?: string;
  state?: MilestoneState;
}>;

export type EditMilestoneInput = Readonly<{
  title?: string;
  description?: string;
  dueOn?: string;
  state?: MilestoneState;
}>;

export type Milestone = Readonly<{
  id: number;
  title: string;
  description: string;
  state: MilestoneState;
  openIssues: number;
  closedIssues: number;
  dueOn: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
}>;

export interface MilestoneOperations {
  list(repository: RepositoryRef, options?: ListMilestonesOptions): Promise<readonly Milestone[]>;
  view(repository: RepositoryRef, id: number): Promise<Milestone>;
  create(repository: RepositoryRef, input: CreateMilestoneInput): Promise<Milestone>;
  edit(repository: RepositoryRef, id: number, input: EditMilestoneInput): Promise<Milestone>;
  close(repository: RepositoryRef, id: number): Promise<Milestone>;
  delete(repository: RepositoryRef, id: number): Promise<void>;
}

function milestonePath(repository: RepositoryRef): readonly string[] {
  const parsed = parseInput(repositorySchema, repository);
  return ["repos", parsed.owner, parsed.repository, "milestones"];
}

function milestoneBody(input: ParsedMilestoneInput): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.dueOn === undefined ? {} : { due_on: input.dueOn }),
    ...(input.state === undefined ? {} : { state: input.state }),
  });
}

function definedQuery(
  entries: readonly (readonly [string, QueryValue])[],
): Readonly<Record<string, QueryValue>> {
  return Object.freeze(Object.fromEntries(entries.filter(([, value]) => value !== undefined)));
}

function normalizeMilestone(raw: ParsedMilestoneResponse): Milestone {
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

export class MilestoneService implements MilestoneOperations {
  readonly #api: ForgejoApi;

  public constructor(api: ForgejoApi) {
    this.#api = api;
  }

  public async list(
    repository: RepositoryRef,
    options: ListMilestonesOptions = {},
  ): Promise<readonly Milestone[]> {
    const path = milestonePath(repository);
    const parsed = parseInput(listOptionsSchema, options);
    const query = definedQuery([
      ["state", parsed.state],
      ["name", parsed.name],
      ["page", parsed.page],
      ["limit", parsed.limit],
    ]);
    const response = await this.#api.request({
      method: "GET",
      path,
      query,
    });
    const milestones = parseResponse(milestoneListResponseSchema, response).map(normalizeMilestone);
    return Object.freeze(milestones);
  }

  public async view(repository: RepositoryRef, id: number): Promise<Milestone> {
    const path = milestonePath(repository);
    const parsedId = parseInput(stableIdSchema, id);
    const response = await this.#api.request({
      method: "GET",
      path: [...path, String(parsedId)],
    });
    return normalizeMilestone(parseResponse(milestoneResponseSchema, response));
  }

  public async create(repository: RepositoryRef, input: CreateMilestoneInput): Promise<Milestone> {
    const path = milestonePath(repository);
    const parsed = parseInput(createMilestoneSchema, input);
    const response = await this.#api.request({
      method: "POST",
      path,
      body: milestoneBody(parsed),
    });
    return normalizeMilestone(parseResponse(milestoneResponseSchema, response));
  }

  public async edit(
    repository: RepositoryRef,
    id: number,
    input: EditMilestoneInput,
  ): Promise<Milestone> {
    const path = milestonePath(repository);
    const parsedId = parseInput(stableIdSchema, id);
    const parsed = parseInput(editMilestoneSchema, input);
    const response = await this.#api.request({
      method: "PATCH",
      path: [...path, String(parsedId)],
      body: milestoneBody(parsed),
    });
    return normalizeMilestone(parseResponse(milestoneResponseSchema, response));
  }

  public async close(repository: RepositoryRef, id: number): Promise<Milestone> {
    return this.edit(repository, id, { state: "closed" });
  }

  public async delete(repository: RepositoryRef, id: number): Promise<void> {
    const path = milestonePath(repository);
    const parsedId = parseInput(stableIdSchema, id);
    const response = await this.#api.request({
      method: "DELETE",
      path: [...path, String(parsedId)],
    });
    parseResponse(deleteResponseSchema, response);
  }
}
