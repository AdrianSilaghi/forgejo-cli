import { z } from "zod";

import { CliError } from "../core/errors.js";
import type { ForgejoApi, ForgejoDownload, ForgejoDownloader } from "../http/forgejo-api.js";
import {
  actionsPath,
  DEFAULT_PAGE_SIZE,
  findRunByNumber,
  MAX_PAGE_SIZE,
  safeTextSchema,
  stableIdSchema,
} from "./actions-common.js";
import type { RepositoryRef } from "./repository-service.js";
import { parseInput, parseResponse } from "./validation.js";

const listOptionsSchema = z.strictObject({
  page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
  limit: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  name: safeTextSchema.optional(),
  run: stableIdSchema.optional(),
});

const optionalApiStringSchema = z.string().nullable().optional();

const artifactResponseSchema = z.object({
  id: stableIdSchema,
  name: z.string().default(""),
  run_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  size_in_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  expired: z.boolean().default(false),
  created_at: optionalApiStringSchema,
  updated_at: optionalApiStringSchema,
  expires_at: optionalApiStringSchema,
  archive_download_url: optionalApiStringSchema,
});

const artifactListResponseSchema = z.array(artifactResponseSchema);
const emptyResponseSchema = z.null();

export type ListArtifactsOptions = Readonly<{
  page?: number;
  limit?: number;
  name?: string;
  /** Run number (as in web URLs); restricts the list to that run. */
  run?: number;
}>;

export type Artifact = Readonly<{
  id: number;
  name: string;
  runId: number | null;
  sizeBytes: number;
  expired: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  downloadUrl: string | null;
}>;

export type ArtifactPage = Readonly<{
  items: readonly Artifact[];
  pagination: Readonly<{
    page: number;
    limit: number;
    itemCount: number;
    hasNextPage: boolean;
  }>;
}>;

export type ArtifactArchive = Readonly<{
  id: number;
  download: ForgejoDownload;
}>;

export interface ArtifactOperations {
  list(repository: RepositoryRef, options?: ListArtifactsOptions): Promise<ArtifactPage>;
  view(repository: RepositoryRef, id: number): Promise<Artifact>;
  download(repository: RepositoryRef, id: number): Promise<ArtifactArchive>;
  delete(repository: RepositoryRef, id: number): Promise<void>;
}

function normalizeArtifact(raw: z.infer<typeof artifactResponseSchema>): Artifact {
  return Object.freeze({
    id: raw.id,
    name: raw.name,
    runId: raw.run_id === null || raw.run_id === undefined || raw.run_id === 0 ? null : raw.run_id,
    sizeBytes: raw.size_in_bytes,
    expired: raw.expired,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
    expiresAt: raw.expires_at ?? null,
    downloadUrl: raw.archive_download_url ?? null,
  });
}

export class ArtifactService implements ArtifactOperations {
  readonly #api: ForgejoApi;
  readonly #downloader: ForgejoDownloader | undefined;

  public constructor(api: ForgejoApi, downloader?: ForgejoDownloader) {
    this.#api = api;
    this.#downloader = downloader;
  }

  public async list(
    repository: RepositoryRef,
    options: ListArtifactsOptions = {},
  ): Promise<ArtifactPage> {
    const path = actionsPath(repository);
    const parsed = parseInput(listOptionsSchema, options);
    const scope =
      parsed.run === undefined
        ? path
        : [...path, "runs", String((await findRunByNumber(this.#api, repository, parsed.run)).id)];
    const response = await this.#api.request({
      method: "GET",
      path: [...scope, "artifacts"],
      query: {
        page: parsed.page,
        limit: parsed.limit,
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
      },
    });
    const items = Object.freeze(
      parseResponse(artifactListResponseSchema, response).map(normalizeArtifact),
    );
    return Object.freeze({
      items,
      pagination: Object.freeze({
        page: parsed.page,
        limit: parsed.limit,
        itemCount: items.length,
        hasNextPage: items.length === parsed.limit,
      }),
    });
  }

  public async view(repository: RepositoryRef, id: number): Promise<Artifact> {
    const path = actionsPath(repository);
    const artifactId = parseInput(stableIdSchema, id);
    const response = await this.#api.request({
      method: "GET",
      path: [...path, "artifacts", String(artifactId)],
    });
    return normalizeArtifact(parseResponse(artifactResponseSchema, response));
  }

  public async download(repository: RepositoryRef, id: number): Promise<ArtifactArchive> {
    const path = actionsPath(repository);
    const artifactId = parseInput(stableIdSchema, id);
    if (this.#downloader === undefined) {
      throw new CliError("config_failed", "The Forgejo download transport is unavailable.");
    }
    const download = await this.#downloader.download({
      path: [...path, "artifacts", String(artifactId), "zip"],
    });
    return Object.freeze({ id: artifactId, download });
  }

  public async delete(repository: RepositoryRef, id: number): Promise<void> {
    const path = actionsPath(repository);
    const artifactId = parseInput(stableIdSchema, id);
    const response = await this.#api.request({
      method: "DELETE",
      path: [...path, "artifacts", String(artifactId)],
    });
    parseResponse(emptyResponseSchema, response);
  }
}
