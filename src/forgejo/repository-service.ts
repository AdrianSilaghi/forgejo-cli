import { z } from "zod";

import type { ForgejoApi } from "../http/forgejo-api.js";
import { parseInput, parseResponse } from "./validation.js";

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
  .refine(isFreeOfAsciiControlCharacters, "Path segments cannot contain control characters.")
  .refine((value) => value !== "." && value !== "..", "Relative path segments are forbidden.")
  .refine(
    (value) => !value.includes("/") && !value.includes("\\"),
    "Path segments cannot contain separators.",
  );

const repositoryReferenceSchema = z.strictObject({
  owner: nonEmptySegmentSchema,
  repository: nonEmptySegmentSchema,
});

export type RepositoryRef = Readonly<{
  owner: string;
  repository: string;
}>;

export type RepositoryReference = RepositoryRef;

export type RepositoryOwner = Readonly<{
  id: number;
  login: string;
  fullName: string;
}>;

export type Repository = Readonly<{
  id: number;
  name: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  internal: boolean;
  fork: boolean;
  archived: boolean;
  htmlUrl: string;
  sshUrl: string;
  cloneUrl: string;
  owner: RepositoryOwner;
  starsCount: number;
  forksCount: number;
  openIssuesCount: number;
  openPullRequestsCount: number;
  createdAt: string;
  updatedAt: string;
}>;

export interface RepositoryOperations {
  view(reference: RepositoryReference): Promise<Repository>;
}

const repositoryResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  description: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  internal: z.boolean(),
  fork: z.boolean(),
  archived: z.boolean(),
  html_url: z.string(),
  ssh_url: z.string(),
  clone_url: z.string(),
  owner: z.object({
    id: z.number().int(),
    login: z.string(),
    full_name: z.string().optional().default(""),
  }),
  stars_count: z.number().int(),
  forks_count: z.number().int(),
  open_issues_count: z.number().int(),
  open_pr_counter: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

function normalizeRepository(response: unknown): Repository {
  const parsed = parseResponse(repositoryResponseSchema, response);
  const owner: RepositoryOwner = Object.freeze({
    id: parsed.owner.id,
    login: parsed.owner.login,
    fullName: parsed.owner.full_name,
  });

  return Object.freeze({
    id: parsed.id,
    name: parsed.name,
    fullName: parsed.full_name,
    description: parsed.description,
    defaultBranch: parsed.default_branch,
    private: parsed.private,
    internal: parsed.internal,
    fork: parsed.fork,
    archived: parsed.archived,
    htmlUrl: parsed.html_url,
    sshUrl: parsed.ssh_url,
    cloneUrl: parsed.clone_url,
    owner,
    starsCount: parsed.stars_count,
    forksCount: parsed.forks_count,
    openIssuesCount: parsed.open_issues_count,
    openPullRequestsCount: parsed.open_pr_counter,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}

export class RepositoryService implements RepositoryOperations {
  readonly #api: ForgejoApi;

  public constructor(api: ForgejoApi) {
    this.#api = api;
  }

  public async view(reference: RepositoryReference): Promise<Repository> {
    const parsedReference = parseInput(repositoryReferenceSchema, reference);
    const response = await this.#api.request({
      method: "GET",
      path: ["repos", parsedReference.owner, parsedReference.repository],
    });

    return normalizeRepository(response);
  }
}
