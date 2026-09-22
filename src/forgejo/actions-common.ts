import { z } from "zod";

import { CliError } from "../core/errors.js";
import { hasControlCharacter } from "../core/text-validation.js";
import type { ForgejoApi } from "../http/forgejo-api.js";
import type { RepositoryRef } from "./repository-service.js";
import { parseInput, parseResponse } from "./validation.js";

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

export const stableIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const safeTextSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value, "Values cannot have outer whitespace.")
  .refine((value) => !hasControlCharacter(value), "Values cannot contain control characters.");

const repositorySchema = z.strictObject({
  owner: safeTextSchema,
  repository: safeTextSchema,
});

const optionalApiStringSchema = z.string().nullable().optional();

export const runResponseSchema = z.object({
  id: stableIdSchema,
  index_in_repo: stableIdSchema,
  title: z.string().default(""),
  workflow_id: z.string().default(""),
  event: optionalApiStringSchema,
  trigger_event: optionalApiStringSchema,
  status: z.string().min(1),
  prettyref: optionalApiStringSchema,
  commit_sha: z.string().default(""),
  html_url: optionalApiStringSchema,
  need_approval: z.boolean().default(false),
  trigger_user: z.object({ login: z.string() }).nullable().optional(),
  created: optionalApiStringSchema,
  started: optionalApiStringSchema,
  stopped: optionalApiStringSchema,
  updated: optionalApiStringSchema,
  duration: z.number().nullable().optional(),
});

export const runListResponseSchema = z.object({
  total_count: z.number().int().nonnegative().optional(),
  workflow_runs: z.array(runResponseSchema).nullable().optional(),
});

/** A run as it appears in the web UI (`number`) and in the API (`id`). */
export type WorkflowRunRef = Readonly<{
  id: number;
  number: number;
}>;

export type WorkflowRun = WorkflowRunRef &
  Readonly<{
    title: string;
    workflow: string;
    event: string;
    status: string;
    ref: string;
    commitSha: string;
    htmlUrl: string | null;
    needsApproval: boolean;
    triggeredBy: string | null;
    createdAt: string | null;
    startedAt: string | null;
    stoppedAt: string | null;
    updatedAt: string | null;
    durationSeconds: number | null;
  }>;

export function actionsPath(repository: RepositoryRef): readonly string[] {
  const parsed = parseInput(repositorySchema, repository);
  return ["repos", parsed.owner, parsed.repository, "actions"];
}

/** Forgejo reports "not yet" as the Unix epoch (or year 1); both mean "no time". */
function meaningfulTime(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) || time <= 0 ? null : value;
}

/** Forgejo serializes durations as nanoseconds. */
function secondsFromNanoseconds(value: number | null | undefined): number | null {
  if (value === null || value === undefined || value <= 0) return null;
  return Math.round(value / 1_000_000) / 1_000;
}

export function normalizeRun(raw: z.infer<typeof runResponseSchema>): WorkflowRun {
  return Object.freeze({
    id: raw.id,
    number: raw.index_in_repo,
    title: raw.title,
    workflow: raw.workflow_id,
    // `event` is empty on dispatched runs; `trigger_event` is always set.
    event: raw.trigger_event || raw.event || "",
    status: raw.status,
    ref: raw.prettyref ?? "",
    commitSha: raw.commit_sha,
    htmlUrl: raw.html_url ?? null,
    needsApproval: raw.need_approval,
    triggeredBy: raw.trigger_user?.login ?? null,
    createdAt: meaningfulTime(raw.created),
    startedAt: meaningfulTime(raw.started),
    stoppedAt: meaningfulTime(raw.stopped),
    updatedAt: meaningfulTime(raw.updated),
    durationSeconds: secondsFromNanoseconds(raw.duration),
  });
}

export function runRef(run: WorkflowRunRef): WorkflowRunRef {
  return Object.freeze({ id: run.id, number: run.number });
}

/**
 * Resolves the run number shown in the web UI to the run, whose API `id` every
 * other Actions endpoint needs. `page` is always sent: without it Forgejo
 * ignores `limit` and returns every run in the repository.
 */
export async function findRunByNumber(
  api: ForgejoApi,
  repository: RepositoryRef,
  number: number,
): Promise<WorkflowRun> {
  const path = actionsPath(repository);
  const runNumber = parseInput(stableIdSchema, number);
  const response = await api.request({
    method: "GET",
    path: [...path, "runs"],
    query: { run_number: runNumber, page: 1, limit: 1 },
  });
  const found = parseResponse(runListResponseSchema, response).workflow_runs?.[0];
  if (found === undefined) {
    throw new CliError("not_found", `Workflow run #${runNumber} was not found.`, {
      details: { run_number: runNumber },
    });
  }
  if (found.index_in_repo !== runNumber) {
    throw new CliError("protocol_failed", "Forgejo answered a run lookup with a different run.", {
      details: { run_number: runNumber, returned_run_number: found.index_in_repo },
    });
  }
  return normalizeRun(found);
}
