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
const colorSchema = z.string().regex(/^#?[0-9a-f]{6}$/iu, "Labels require a six-digit hex color.");

const listOptionsSchema = z.strictObject({
  sort: z.enum(["mostissues", "leastissues", "reversealphabetically"]).optional(),
  page: stableIdSchema.default(1),
  limit: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const labelFieldsSchema = {
  name: nonEmptyStringSchema,
  color: colorSchema,
  description: z.string().optional(),
  exclusive: z.boolean().optional(),
  isArchived: z.boolean().optional(),
} as const;

const createLabelSchema = z.strictObject(labelFieldsSchema);
const editLabelSchema = z
  .strictObject({
    name: labelFieldsSchema.name.optional(),
    color: labelFieldsSchema.color.optional(),
    description: labelFieldsSchema.description,
    exclusive: labelFieldsSchema.exclusive,
    isArchived: labelFieldsSchema.isArchived,
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    "At least one label field must be provided.",
  );

const labelResponseSchema = z.object({
  id: stableIdSchema,
  name: z.string(),
  color: z.string(),
  description: z.string().nullable().optional(),
  exclusive: z.boolean().default(false),
  is_archived: z.boolean().default(false),
  url: z.string().nullable().optional(),
});

const labelListResponseSchema = z.array(labelResponseSchema);
const deleteResponseSchema = z.null();

type ParsedLabelInput = z.infer<typeof editLabelSchema>;
type ParsedLabelResponse = z.infer<typeof labelResponseSchema>;

export type RepositoryRef = Readonly<{
  owner: string;
  repository: string;
}>;

export type LabelSort = "mostissues" | "leastissues" | "reversealphabetically";

export type ListLabelsOptions = Readonly<{
  sort?: LabelSort;
  page?: number;
  limit?: number;
}>;

export type CreateLabelInput = Readonly<{
  name: string;
  color: string;
  description?: string;
  exclusive?: boolean;
  isArchived?: boolean;
}>;

export type EditLabelInput = Readonly<{
  name?: string;
  color?: string;
  description?: string;
  exclusive?: boolean;
  isArchived?: boolean;
}>;

export type Label = Readonly<{
  id: number;
  name: string;
  color: string;
  description: string;
  exclusive: boolean;
  isArchived: boolean;
  url: string | null;
}>;

export interface LabelOperations {
  list(repository: RepositoryRef, options?: ListLabelsOptions): Promise<readonly Label[]>;
  view(repository: RepositoryRef, id: number): Promise<Label>;
  create(repository: RepositoryRef, input: CreateLabelInput): Promise<Label>;
  edit(repository: RepositoryRef, id: number, input: EditLabelInput): Promise<Label>;
  delete(repository: RepositoryRef, id: number): Promise<void>;
}

function labelPath(repository: RepositoryRef): readonly string[] {
  const parsed = parseInput(repositorySchema, repository);
  return ["repos", parsed.owner, parsed.repository, "labels"];
}

function labelBody(input: ParsedLabelInput): Readonly<Record<string, boolean | string>> {
  return Object.freeze({
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.color === undefined ? {} : { color: input.color }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.exclusive === undefined ? {} : { exclusive: input.exclusive }),
    ...(input.isArchived === undefined ? {} : { is_archived: input.isArchived }),
  });
}

function definedQuery(
  entries: readonly (readonly [string, QueryValue])[],
): Readonly<Record<string, QueryValue>> {
  return Object.freeze(Object.fromEntries(entries.filter(([, value]) => value !== undefined)));
}

function normalizeLabel(raw: ParsedLabelResponse): Label {
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

export class LabelService implements LabelOperations {
  readonly #api: ForgejoApi;

  public constructor(api: ForgejoApi) {
    this.#api = api;
  }

  public async list(
    repository: RepositoryRef,
    options: ListLabelsOptions = {},
  ): Promise<readonly Label[]> {
    const path = labelPath(repository);
    const parsed = parseInput(listOptionsSchema, options);
    const query = definedQuery([
      ["sort", parsed.sort],
      ["page", parsed.page],
      ["limit", parsed.limit],
    ]);
    const response = await this.#api.request({
      method: "GET",
      path,
      query,
    });
    const labels = parseResponse(labelListResponseSchema, response).map(normalizeLabel);
    return Object.freeze(labels);
  }

  public async view(repository: RepositoryRef, id: number): Promise<Label> {
    const path = labelPath(repository);
    const parsedId = parseInput(stableIdSchema, id);
    const response = await this.#api.request({
      method: "GET",
      path: [...path, String(parsedId)],
    });
    return normalizeLabel(parseResponse(labelResponseSchema, response));
  }

  public async create(repository: RepositoryRef, input: CreateLabelInput): Promise<Label> {
    const path = labelPath(repository);
    const parsed = parseInput(createLabelSchema, input);
    const response = await this.#api.request({
      method: "POST",
      path,
      body: labelBody(parsed),
    });
    return normalizeLabel(parseResponse(labelResponseSchema, response));
  }

  public async edit(repository: RepositoryRef, id: number, input: EditLabelInput): Promise<Label> {
    const path = labelPath(repository);
    const parsedId = parseInput(stableIdSchema, id);
    const parsed = parseInput(editLabelSchema, input);
    const response = await this.#api.request({
      method: "PATCH",
      path: [...path, String(parsedId)],
      body: labelBody(parsed),
    });
    return normalizeLabel(parseResponse(labelResponseSchema, response));
  }

  public async delete(repository: RepositoryRef, id: number): Promise<void> {
    const path = labelPath(repository);
    const parsedId = parseInput(stableIdSchema, id);
    const response = await this.#api.request({
      method: "DELETE",
      path: [...path, String(parsedId)],
    });
    parseResponse(deleteResponseSchema, response);
  }
}
