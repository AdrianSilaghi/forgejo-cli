import { z } from "zod";

import { CliError } from "../core/errors.js";
import { hasControlCharacter } from "../core/text-validation.js";
import type { ForgejoApi, ForgejoAssetUploader } from "../http/forgejo-api.js";
import { parseInput, parseResponse } from "./validation.js";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

function isFreeOfAsciiControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
  });
}

const nonEmptySegmentSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Path segments cannot be blank.")
  .refine(isFreeOfAsciiControlCharacters, "Path segments cannot contain control characters.");

const repositorySchema = z.strictObject({
  owner: nonEmptySegmentSchema,
  repository: nonEmptySegmentSchema,
});

const stableIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const listOptionsSchema = z.strictObject({
  page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
  limit: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  query: z.string().optional(),
});

const releaseFieldsSchema = {
  tagName: nonEmptySegmentSchema,
  targetCommitish: nonEmptySegmentSchema.optional(),
  name: z.string().optional(),
  body: z.string().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  hideArchiveLinks: z.boolean().optional(),
} as const;

const createReleaseSchema = z.strictObject(releaseFieldsSchema);
const editReleaseSchema = z
  .strictObject({
    tagName: releaseFieldsSchema.tagName.optional(),
    targetCommitish: releaseFieldsSchema.targetCommitish,
    name: releaseFieldsSchema.name,
    body: releaseFieldsSchema.body,
    draft: releaseFieldsSchema.draft,
    prerelease: releaseFieldsSchema.prerelease,
    hideArchiveLinks: releaseFieldsSchema.hideArchiveLinks,
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    "At least one release field must be provided.",
  );

const safeAssetNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value, "Asset names cannot have outer whitespace.")
  .refine(
    (value) => !hasControlCharacter(value) && !value.includes("/") && !value.includes("\\"),
    "Asset names are invalid.",
  )
  .refine((value) => value !== "." && value !== "..", "Asset names are invalid.");

const uploadReleaseAssetSchema = z.strictObject({
  name: safeAssetNameSchema,
  filename: safeAssetNameSchema,
  content: z.instanceof(Blob).refine((value) => Number.isSafeInteger(value.size)),
  signal: z.instanceof(AbortSignal).optional(),
});

const optionalApiStringSchema = z.string().nullable().optional();

const attachmentResponseSchema = z.object({
  id: stableIdSchema,
  name: z.string().default(""),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  download_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  type: z.enum(["attachment", "external"]).nullable().optional(),
  browser_download_url: optionalApiStringSchema,
  created_at: optionalApiStringSchema,
});

const releaseResponseSchema = z.object({
  id: stableIdSchema,
  tag_name: z.string().min(1),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  target_commitish: z.string().nullable().optional(),
  draft: z.boolean().default(false),
  prerelease: z.boolean().default(false),
  hide_archive_links: z.boolean().default(false),
  created_at: optionalApiStringSchema,
  published_at: optionalApiStringSchema,
  html_url: optionalApiStringSchema,
  tarball_url: optionalApiStringSchema,
  zipball_url: optionalApiStringSchema,
  assets: z.array(attachmentResponseSchema).nullable().optional(),
});

const releaseListResponseSchema = z.array(releaseResponseSchema);
const deleteResponseSchema = z.null();

type ParsedReleaseFields = z.infer<typeof editReleaseSchema>;

export type RepositoryRef = Readonly<{
  owner: string;
  repository: string;
}>;

export type ListReleasesOptions = Readonly<{
  page?: number;
  limit?: number;
  draft?: boolean;
  prerelease?: boolean;
  query?: string;
}>;

export type CreateReleaseInput = Readonly<{
  tagName: string;
  targetCommitish?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  hideArchiveLinks?: boolean;
}>;

export type EditReleaseInput = Readonly<{
  tagName?: string;
  targetCommitish?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  hideArchiveLinks?: boolean;
}>;

export type UploadReleaseAssetInput = Readonly<{
  name: string;
  filename: string;
  content: Blob;
  signal?: AbortSignal;
}>;

export type ReleaseAsset = Readonly<{
  id: number;
  name: string;
  size: number;
  downloadCount: number;
  type: "attachment" | "external" | null;
  downloadUrl: string | null;
  createdAt: string | null;
}>;

export type Release = Readonly<{
  id: number;
  tagName: string;
  name: string;
  body: string;
  targetCommitish: string;
  draft: boolean;
  prerelease: boolean;
  hideArchiveLinks: boolean;
  createdAt: string | null;
  publishedAt: string | null;
  htmlUrl: string | null;
  tarballUrl: string | null;
  zipballUrl: string | null;
  assets: readonly ReleaseAsset[];
}>;

export type ReleasePage = Readonly<{
  items: readonly Release[];
  pagination: Readonly<{
    page: number;
    limit: number;
    itemCount: number;
    hasNextPage: boolean;
  }>;
}>;

export interface ReleaseOperations {
  list(repository: RepositoryRef, options?: ListReleasesOptions): Promise<ReleasePage>;
  viewById(repository: RepositoryRef, id: number): Promise<Release>;
  viewByTag(repository: RepositoryRef, tag: string): Promise<Release>;
  create(repository: RepositoryRef, input: CreateReleaseInput): Promise<Release>;
  edit(repository: RepositoryRef, id: number, input: EditReleaseInput): Promise<Release>;
  delete(repository: RepositoryRef, id: number): Promise<void>;
  upload(
    repository: RepositoryRef,
    id: number,
    input: UploadReleaseAssetInput,
  ): Promise<ReleaseAsset>;
}

function releasePath(repository: RepositoryRef): readonly string[] {
  const parsed = parseInput(repositorySchema, repository);
  return ["repos", parsed.owner, parsed.repository, "releases"];
}

function releaseBody(input: ParsedReleaseFields): Readonly<Record<string, boolean | string>> {
  return Object.freeze({
    ...(input.tagName === undefined ? {} : { tag_name: input.tagName }),
    ...(input.targetCommitish === undefined ? {} : { target_commitish: input.targetCommitish }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.draft === undefined ? {} : { draft: input.draft }),
    ...(input.prerelease === undefined ? {} : { prerelease: input.prerelease }),
    ...(input.hideArchiveLinks === undefined ? {} : { hide_archive_links: input.hideArchiveLinks }),
  });
}

function normalizeAttachment(raw: z.infer<typeof attachmentResponseSchema>): ReleaseAsset {
  return Object.freeze({
    id: raw.id,
    name: raw.name,
    size: raw.size,
    downloadCount: raw.download_count,
    type: raw.type ?? null,
    downloadUrl: raw.browser_download_url ?? null,
    createdAt: raw.created_at ?? null,
  });
}

function normalizeRelease(raw: z.infer<typeof releaseResponseSchema>): Release {
  const assets = Object.freeze((raw.assets ?? []).map(normalizeAttachment));
  return Object.freeze({
    id: raw.id,
    tagName: raw.tag_name,
    name: raw.name ?? "",
    body: raw.body ?? "",
    targetCommitish: raw.target_commitish ?? "",
    draft: raw.draft,
    prerelease: raw.prerelease,
    hideArchiveLinks: raw.hide_archive_links,
    createdAt: raw.created_at ?? null,
    publishedAt: raw.published_at ?? null,
    htmlUrl: raw.html_url ?? null,
    tarballUrl: raw.tarball_url ?? null,
    zipballUrl: raw.zipball_url ?? null,
    assets,
  });
}

export class ReleaseService implements ReleaseOperations {
  readonly #api: ForgejoApi;
  readonly #assetUploader: ForgejoAssetUploader | undefined;

  public constructor(api: ForgejoApi, assetUploader?: ForgejoAssetUploader) {
    this.#api = api;
    this.#assetUploader = assetUploader;
  }

  public async list(
    repository: RepositoryRef,
    options: ListReleasesOptions = {},
  ): Promise<ReleasePage> {
    const path = releasePath(repository);
    const parsed = parseInput(listOptionsSchema, options);
    const response = await this.#api.request({
      method: "GET",
      path,
      query: {
        page: parsed.page,
        limit: parsed.limit,
        ...(parsed.draft === undefined ? {} : { draft: parsed.draft }),
        ...(parsed.prerelease === undefined ? {} : { "pre-release": parsed.prerelease }),
        ...(parsed.query === undefined ? {} : { q: parsed.query }),
      },
    });
    const items = Object.freeze(
      parseResponse(releaseListResponseSchema, response).map(normalizeRelease),
    );
    const pagination = Object.freeze({
      page: parsed.page,
      limit: parsed.limit,
      itemCount: items.length,
      hasNextPage: items.length === parsed.limit,
    });
    return Object.freeze({ items, pagination });
  }

  public async viewById(repository: RepositoryRef, id: number): Promise<Release> {
    const path = releasePath(repository);
    const parsedId = parseInput(stableIdSchema, id);
    const response = await this.#api.request({
      method: "GET",
      path: [...path, String(parsedId)],
    });
    return normalizeRelease(parseResponse(releaseResponseSchema, response));
  }

  public async viewByTag(repository: RepositoryRef, tag: string): Promise<Release> {
    const path = releasePath(repository);
    const parsedTag = parseInput(nonEmptySegmentSchema, tag);
    const response = await this.#api.request({
      method: "GET",
      path: [...path, "tags", parsedTag],
    });
    return normalizeRelease(parseResponse(releaseResponseSchema, response));
  }

  public async create(repository: RepositoryRef, input: CreateReleaseInput): Promise<Release> {
    const path = releasePath(repository);
    const parsed = parseInput(createReleaseSchema, input);
    const response = await this.#api.request({
      method: "POST",
      path,
      body: releaseBody(parsed),
    });
    return normalizeRelease(parseResponse(releaseResponseSchema, response));
  }

  public async edit(
    repository: RepositoryRef,
    id: number,
    input: EditReleaseInput,
  ): Promise<Release> {
    const path = releasePath(repository);
    const parsedId = parseInput(stableIdSchema, id);
    const parsed = parseInput(editReleaseSchema, input);
    const response = await this.#api.request({
      method: "PATCH",
      path: [...path, String(parsedId)],
      body: releaseBody(parsed),
    });
    return normalizeRelease(parseResponse(releaseResponseSchema, response));
  }

  public async delete(repository: RepositoryRef, id: number): Promise<void> {
    const path = releasePath(repository);
    const parsedId = parseInput(stableIdSchema, id);
    const response = await this.#api.request({
      method: "DELETE",
      path: [...path, String(parsedId)],
    });
    parseResponse(deleteResponseSchema, response);
  }

  public async upload(
    repository: RepositoryRef,
    id: number,
    input: UploadReleaseAssetInput,
  ): Promise<ReleaseAsset> {
    const path = releasePath(repository);
    const parsedId = parseInput(stableIdSchema, id);
    const parsed = parseInput(uploadReleaseAssetSchema, input);
    if (this.#assetUploader === undefined) {
      throw new CliError("config_failed", "Release asset upload transport is unavailable.");
    }
    const response = await this.#assetUploader.uploadAsset({
      path: [...path, String(parsedId), "assets"],
      name: parsed.name,
      filename: parsed.filename,
      content: parsed.content,
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
    });
    return normalizeAttachment(parseResponse(attachmentResponseSchema, response));
  }
}
