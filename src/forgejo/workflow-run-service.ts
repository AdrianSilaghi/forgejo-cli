import { z } from "zod";

import { CliError } from "../core/errors.js";
import { redactString } from "../core/redaction.js";
import type {
  ForgejoApi,
  ForgejoDownload,
  ForgejoDownloader,
  ForgejoTextReader,
} from "../http/forgejo-api.js";
import {
  actionsPath,
  DEFAULT_PAGE_SIZE,
  findRunByNumber,
  MAX_PAGE_SIZE,
  normalizeRun,
  runListResponseSchema,
  runRef,
  safeTextSchema,
  stableIdSchema,
  type WorkflowRun,
  type WorkflowRunRef,
} from "./actions-common.js";
import type { RepositoryRef } from "./repository-service.js";
import { parseInput, parseResponse } from "./validation.js";

export type { WorkflowRun, WorkflowRunRef } from "./actions-common.js";

export const WORKFLOW_RUN_STATUSES = Object.freeze([
  "unknown",
  "waiting",
  "running",
  "success",
  "failure",
  "cancelled",
  "skipped",
  "blocked",
] as const);

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

const workflowFileSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u, "Workflow must be a .yml or .yaml file name.");

const listOptionsSchema = z.strictObject({
  page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
  limit: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  statuses: z.array(z.enum(WORKFLOW_RUN_STATUSES)).min(1).optional(),
  events: z
    .array(z.string().regex(/^[a-z][a-z_]{0,63}$/u, "Events are lower-case names."))
    .min(1)
    .optional(),
  workflow: workflowFileSchema.optional(),
  ref: safeTextSchema.optional(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{4,64}$/u, "Commit SHAs are lower-case hex.")
    .optional(),
});

const readLogOptionsSchema = z.strictObject({
  job: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  attempt: stableIdSchema.optional(),
  tailBytes: stableIdSchema.optional(),
});

const dispatchInputSchema = z.strictObject({
  ref: safeTextSchema,
  inputs: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u, "Input names are identifiers."),
      z.string().max(65_536),
    )
    .refine((inputs) => Object.keys(inputs).length <= 100, "Too many workflow inputs.")
    .optional(),
});

const jobResponseSchema = z.object({
  id: stableIdSchema,
  name: z.string().default(""),
  status: z.string().min(1),
  attempt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  runs_on: z.array(z.string()).nullable().optional(),
  needs: z.array(z.string()).nullable().optional(),
  task_id: z.number().int().nonnegative().nullable().optional(),
});

const jobListResponseSchema = z.array(jobResponseSchema);

const dispatchResponseSchema = z.object({
  id: stableIdSchema,
  run_number: stableIdSchema,
  jobs: z.array(z.string()).nullable().optional(),
});

const emptyResponseSchema = z.null();

export type ListWorkflowRunsOptions = Readonly<{
  page?: number;
  limit?: number;
  statuses?: readonly WorkflowRunStatus[];
  events?: readonly string[];
  workflow?: string;
  /** A full ref: Forgejo matches `refs/heads/main`, not `main`. */
  ref?: string;
  headSha?: string;
}>;

export type WorkflowRunPage = Readonly<{
  items: readonly WorkflowRun[];
  pagination: Readonly<{
    page: number;
    limit: number;
    itemCount: number;
    hasNextPage: boolean;
  }>;
}>;

export type WorkflowJob = Readonly<{
  id: number;
  /** Position in the run: the `jobs/<index>` segment of web URLs. */
  index: number;
  name: string;
  status: string;
  attempt: number;
  runsOn: readonly string[];
  needs: readonly string[];
  /** False until a runner has picked the job up; such a job has no log yet. */
  started: boolean;
}>;

export type WorkflowRunJobs = Readonly<{
  run: WorkflowRunRef;
  jobs: readonly WorkflowJob[];
}>;

export type ReadJobLogOptions = Readonly<{
  /** 0-based job index; defaults to the first job. */
  job?: number;
  /** 1-based attempt; defaults to the latest. */
  attempt?: number;
  /** Return only the last N bytes of the log. */
  tailBytes?: number;
}>;

export type WorkflowJobLog = Readonly<{
  run: WorkflowRunRef;
  job: WorkflowJob;
  attempt: number;
  started: boolean;
  partial: boolean;
  totalBytes: number | null;
  text: string;
}>;

export type WorkflowRunLogArchive = Readonly<{
  run: WorkflowRunRef;
  download: ForgejoDownload;
}>;

export type DispatchWorkflowInput = Readonly<{
  ref: string;
  inputs?: Readonly<Record<string, string>>;
}>;

export type DispatchedWorkflowRun = Readonly<{
  id: number;
  number: number;
  jobs: readonly string[];
}>;

export interface WorkflowRunOperations {
  list(repository: RepositoryRef, options?: ListWorkflowRunsOptions): Promise<WorkflowRunPage>;
  view(repository: RepositoryRef, number: number): Promise<WorkflowRun>;
  jobs(repository: RepositoryRef, number: number): Promise<WorkflowRunJobs>;
  readJobLog(
    repository: RepositoryRef,
    number: number,
    options?: ReadJobLogOptions,
  ): Promise<WorkflowJobLog>;
  downloadLogs(repository: RepositoryRef, number: number): Promise<WorkflowRunLogArchive>;
  cancel(repository: RepositoryRef, number: number): Promise<WorkflowRunRef>;
  delete(repository: RepositoryRef, number: number): Promise<WorkflowRunRef>;
  dispatch(
    repository: RepositoryRef,
    workflow: string,
    input: DispatchWorkflowInput,
  ): Promise<DispatchedWorkflowRun>;
}

function normalizeJob(raw: z.infer<typeof jobResponseSchema>, index: number): WorkflowJob {
  return Object.freeze({
    id: raw.id,
    index,
    name: raw.name,
    status: raw.status,
    attempt: raw.attempt,
    runsOn: Object.freeze([...(raw.runs_on ?? [])]),
    needs: Object.freeze([...(raw.needs ?? [])]),
    started: (raw.task_id ?? 0) > 0,
  });
}

function missingTransport(capability: string): CliError {
  return new CliError("config_failed", `The Forgejo ${capability} transport is unavailable.`);
}

export class WorkflowRunService implements WorkflowRunOperations {
  readonly #api: ForgejoApi;
  readonly #text: ForgejoTextReader | undefined;
  readonly #downloader: ForgejoDownloader | undefined;

  public constructor(api: ForgejoApi, text?: ForgejoTextReader, downloader?: ForgejoDownloader) {
    this.#api = api;
    this.#text = text;
    this.#downloader = downloader;
  }

  public async list(
    repository: RepositoryRef,
    options: ListWorkflowRunsOptions = {},
  ): Promise<WorkflowRunPage> {
    const path = actionsPath(repository);
    const parsed = parseInput(listOptionsSchema, options);
    const response = await this.#api.request({
      method: "GET",
      path: [...path, "runs"],
      query: {
        // Always send page: without it Forgejo ignores limit and returns every run.
        page: parsed.page,
        limit: parsed.limit,
        ...(parsed.statuses === undefined ? {} : { status: parsed.statuses }),
        ...(parsed.events === undefined ? {} : { event: parsed.events }),
        ...(parsed.workflow === undefined ? {} : { workflow_id: parsed.workflow }),
        ...(parsed.ref === undefined ? {} : { ref: parsed.ref }),
        ...(parsed.headSha === undefined ? {} : { head_sha: parsed.headSha }),
      },
    });
    const items = Object.freeze(
      (parseResponse(runListResponseSchema, response).workflow_runs ?? []).map(normalizeRun),
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

  public async view(repository: RepositoryRef, number: number): Promise<WorkflowRun> {
    return findRunByNumber(this.#api, repository, number);
  }

  public async jobs(repository: RepositoryRef, number: number): Promise<WorkflowRunJobs> {
    const run = await findRunByNumber(this.#api, repository, number);
    const response = await this.#api.request({
      method: "GET",
      path: [...actionsPath(repository), "runs", String(run.id), "jobs"],
    });
    return Object.freeze({
      run: runRef(run),
      jobs: Object.freeze(parseResponse(jobListResponseSchema, response).map(normalizeJob)),
    });
  }

  public async readJobLog(
    repository: RepositoryRef,
    number: number,
    options: ReadJobLogOptions = {},
  ): Promise<WorkflowJobLog> {
    const parsed = parseInput(readLogOptionsSchema, options);
    if (this.#text === undefined) throw missingTransport("log");

    const { run, jobs } = await this.jobs(repository, number);
    const job = jobs[parsed.job];
    if (job === undefined) {
      throw new CliError("validation_failed", `Run #${run.number} has no job ${parsed.job}.`, {
        details: { job_count: jobs.length },
      });
    }
    const attempt = parsed.attempt ?? job.attempt;
    if (attempt > job.attempt) {
      throw new CliError(
        "validation_failed",
        `Job ${job.index} of run #${run.number} has no attempt ${attempt}.`,
        { details: { latest_attempt: job.attempt } },
      );
    }
    // Forgejo answers 404 for a job no runner has picked up; say so plainly.
    if (!job.started && attempt === job.attempt) {
      return Object.freeze({
        run,
        job,
        attempt,
        started: false,
        partial: false,
        totalBytes: 0,
        text: "",
      });
    }

    const log = await this.#text.readText({
      path: [...actionsPath(repository), "jobs", String(job.id), "logs"],
      query: { attempt },
      ...(parsed.tailBytes === undefined ? {} : { tailBytes: parsed.tailBytes }),
    });
    return Object.freeze({
      run,
      job,
      attempt,
      started: true,
      partial: log.partial,
      totalBytes: log.totalBytes,
      text: redactString(log.text),
    });
  }

  public async downloadLogs(
    repository: RepositoryRef,
    number: number,
  ): Promise<WorkflowRunLogArchive> {
    if (this.#downloader === undefined) throw missingTransport("download");
    const run = await findRunByNumber(this.#api, repository, number);
    const download = await this.#downloader.download({
      path: [...actionsPath(repository), "runs", String(run.id), "logs"],
    });
    return Object.freeze({ run: runRef(run), download });
  }

  public async cancel(repository: RepositoryRef, number: number): Promise<WorkflowRunRef> {
    const run = await findRunByNumber(this.#api, repository, number);
    const response = await this.#api.request({
      method: "POST",
      path: [...actionsPath(repository), "runs", String(run.id), "cancel"],
    });
    parseResponse(emptyResponseSchema, response);
    return runRef(run);
  }

  public async delete(repository: RepositoryRef, number: number): Promise<WorkflowRunRef> {
    const run = await findRunByNumber(this.#api, repository, number);
    const response = await this.#api.request({
      method: "DELETE",
      path: [...actionsPath(repository), "runs", String(run.id)],
    });
    parseResponse(emptyResponseSchema, response);
    return runRef(run);
  }

  public async dispatch(
    repository: RepositoryRef,
    workflow: string,
    input: DispatchWorkflowInput,
  ): Promise<DispatchedWorkflowRun> {
    const path = actionsPath(repository);
    const workflowFile = parseInput(workflowFileSchema, workflow);
    const parsed = parseInput(dispatchInputSchema, input);
    const response = await this.#api.request({
      method: "POST",
      path: [...path, "workflows", workflowFile, "dispatches"],
      body: {
        ref: parsed.ref,
        ...(parsed.inputs === undefined ? {} : { inputs: parsed.inputs }),
        return_run_info: true,
      },
    });
    const dispatched = parseResponse(dispatchResponseSchema, response);
    return Object.freeze({
      id: dispatched.id,
      number: dispatched.run_number,
      jobs: Object.freeze([...(dispatched.jobs ?? [])]),
    });
  }
}
