import { z } from "zod";
import { CliError } from "../core/errors.js";
import type { ForgejoApi, ForgejoRequest } from "../http/forgejo-api.js";
import { actionsPath, stableIdSchema, type WorkflowRun } from "./actions-common.js";
import type { RepositoryRef } from "./repository-service.js";
import { parseInput, parseResponse } from "./validation.js";
import { WorkflowRunService } from "./workflow-run-service.js";

const shaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const optionsSchema = z.strictObject({
  workflow: z
    .string()
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u)
    .optional(),
  expectedHeadSha: shaSchema.optional(),
});
const pullSchema = z.object({ number: stableIdSchema, head: z.object({ sha: shaSchema }) });
const statusSchema = z.object({
  id: stableIdSchema,
  context: z.string().min(1),
  status: z.string().min(1),
  description: z.string().default(""),
  target_url: z.string().nullable().optional(),
});
export type CheckState = "success" | "failure" | "pending";
export type CommitCheck = Readonly<{
  id: number;
  context: string;
  state: string;
  description: string;
  target_url: string | null;
}>;
export type PullRequestChecks = Readonly<{
  pull_request: number;
  head_sha: string;
  state: CheckState;
  required_checks_evaluated: false;
  checks: readonly CommitCheck[];
  workflows: readonly WorkflowRun[];
}>;
export type PullRequestChecksOptions = Readonly<{ workflow?: string; expectedHeadSha?: string }>;
export interface PullRequestChecksOperations {
  snapshot(
    repository: RepositoryRef,
    number: number,
    options?: PullRequestChecksOptions,
    signal?: AbortSignal,
  ): Promise<PullRequestChecks>;
}

export function checkState(status: string): CheckState {
  if (status === "success") return "success";
  return ["failure", "error", "warning", "cancelled", "skipped", "blocked"].includes(status)
    ? "failure"
    : "pending";
}

function assertHead(expected: string, actual: string): void {
  if (expected !== actual)
    throw new CliError(
      "conflict",
      "The pull request head changed while checking CI; run checks again for the new head.",
      { details: { expected_head_sha: expected, actual_head_sha: actual } },
    );
}
function incomplete(): never {
  throw new CliError(
    "protocol_failed",
    "Too many CI results to determine a complete check snapshot.",
  );
}

export class PullRequestChecksService implements PullRequestChecksOperations {
  constructor(readonly api: ForgejoApi) {}

  public async snapshot(
    repository: RepositoryRef,
    number: number,
    options: PullRequestChecksOptions = {},
    signal?: AbortSignal,
  ): Promise<PullRequestChecks> {
    const path = actionsPath(repository).slice(0, -1);
    const parsedNumber = parseInput(stableIdSchema, number);
    const parsed = parseInput(optionsSchema, options);
    const request = async (input: ForgejoRequest) => {
      if (signal?.aborted) throw new CliError("cancelled", "Checking CI was cancelled.");
      return this.api.request({ ...input, ...(signal === undefined ? {} : { signal }) });
    };
    const readPull = async () => {
      const pull = parseResponse(
        pullSchema,
        await request({ method: "GET", path: [...path, "pulls", String(parsedNumber)] }),
      );
      if (pull.number !== parsedNumber)
        throw new CliError("protocol_failed", "Forgejo returned a different pull request.");
      return pull;
    };
    const pull = await readPull();
    const sha = pull.head.sha;
    if (parsed.expectedHeadSha !== undefined) assertHead(parsed.expectedHeadSha, sha);
    const checks = parsed.workflow === undefined ? await this.statuses(path, sha, request) : [];
    const workflows = await this.workflows(repository, sha, parsed.workflow, request);
    assertHead(sha, (await readPull()).head.sha);
    const states = [
      ...checks.map((check) => checkState(check.state)),
      ...workflows.map((run) => checkState(run.status)),
    ];
    const state = states.includes("failure")
      ? "failure"
      : states.length > 0 && states.every((value) => value === "success")
        ? "success"
        : "pending";
    return Object.freeze({
      pull_request: parsedNumber,
      head_sha: sha,
      state,
      required_checks_evaluated: false,
      checks: Object.freeze(checks),
      workflows: Object.freeze(workflows),
    });
  }

  private async statuses(
    path: readonly string[],
    sha: string,
    request: ForgejoApi["request"],
  ): Promise<readonly CommitCheck[]> {
    const latest = new Map<string, CommitCheck>();
    for (let page = 1; page <= 100; page++) {
      const items = parseResponse(
        z.array(statusSchema),
        await request({
          method: "GET",
          path: [...path, "statuses", sha],
          query: { sort: "highestindex", page, limit: 50 },
        }),
      );
      for (const item of items) {
        if ((latest.get(item.context)?.id ?? 0) < item.id)
          latest.set(
            item.context,
            Object.freeze({
              id: item.id,
              context: item.context,
              state: item.status,
              description: item.description,
              target_url: item.target_url ?? null,
            }),
          );
      }
      if (items.length === 0) return [...latest.values()];
    }
    return incomplete();
  }

  private async workflows(
    repository: RepositoryRef,
    sha: string,
    workflow: string | undefined,
    request: ForgejoApi["request"],
  ): Promise<readonly WorkflowRun[]> {
    const latest = new Map<string, WorkflowRun>();
    const service = new WorkflowRunService({ request });
    for (let page = 1; page <= 100; page++) {
      const result = await service.list(repository, {
        headSha: sha,
        ...(workflow === undefined ? {} : { workflow }),
        page,
        limit: 50,
      });
      for (const run of result.items) {
        if (run.workflow.length === 0)
          throw new CliError("protocol_failed", "A CI run did not identify its workflow.");
        if (run.commitSha !== sha || (workflow !== undefined && run.workflow !== workflow))
          continue;
        if ((latest.get(run.workflow)?.id ?? 0) < run.id) latest.set(run.workflow, run);
      }
      if (result.items.length === 0) return [...latest.values()];
    }
    return incomplete();
  }
}
