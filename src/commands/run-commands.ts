import type { Command } from "commander";

import { compactDefined, parseCsv, parsePositiveInteger } from "../cli/command-options.js";
import type { RepositoryCommandRuntime, WorkflowRunServices } from "../cli/command-runtime.js";
import type { DownloadFileTarget } from "../cli/download-file.js";
import { returnJson, returnResult } from "../cli/execute.js";
import { collectPages } from "../cli/pagination.js";
import { CliError } from "../core/errors.js";
import {
  type ListWorkflowRunsOptions,
  WORKFLOW_RUN_STATUSES,
  type WorkflowJobLog,
  type WorkflowRunStatus,
} from "../forgejo/workflow-run-service.js";
import {
  paginationOptions,
  type RawPaginationOptions,
  withPaginationOptions,
} from "./pagination-options.js";
import {
  assertDestructiveCommand,
  selectionFor,
  withDestructiveOptions,
} from "./repository-command.js";

type RunRuntime = RepositoryCommandRuntime<WorkflowRunServices> &
  Readonly<{ files: DownloadFileTarget }>;

type RunListOptions = RawPaginationOptions &
  Readonly<{
    status?: string;
    event?: string;
    workflow?: string;
    branch?: string;
    ref?: string;
    sha?: string;
  }>;

type RunLogOptions = Readonly<{
  job: string;
  attempt?: string;
  tailBytes?: string;
}>;

const NEEDS_FORGEJO_16 = "(Forgejo 16+)";

function runNumber(value: string): number {
  return parsePositiveInteger(value, "run number");
}

function jobIndex(value: string): number {
  return value === "0" ? 0 : parsePositiveInteger(value, "job index");
}

function refFilter(options: RunListOptions): string | undefined {
  if (options.branch !== undefined && options.ref !== undefined) {
    throw new CliError("validation_failed", "Use either --branch or --ref, not both.");
  }
  // Forgejo matches full refs only: `refs/heads/main`, never `main`.
  return options.branch === undefined ? options.ref : `refs/heads/${options.branch}`;
}

function listFilters(options: RunListOptions): ListWorkflowRunsOptions {
  return compactDefined({
    statuses:
      options.status === undefined
        ? undefined
        : (parseCsv(options.status) as readonly WorkflowRunStatus[]),
    events: options.event === undefined ? undefined : parseCsv(options.event),
    workflow: options.workflow,
    ref: refFilter(options),
    headSha: options.sha,
  });
}

function humanLog(log: WorkflowJobLog): string {
  if (!log.started) {
    return `Job ${log.job.index} (${log.job.name}) of run #${log.run.number} has not started yet (${log.job.status}).`;
  }
  return log.text.endsWith("\n") ? log.text.slice(0, -1) : log.text;
}

export function registerRunCommands(program: Command, runtime: RunRuntime): void {
  const run = program
    .command("run")
    .description("Follow Forgejo Actions runs by the number shown in their web URL");

  withPaginationOptions(
    run
      .command("list")
      .description("List workflow runs, newest first")
      .option("--status <statuses>", `Comma-separated: ${WORKFLOW_RUN_STATUSES.join(", ")}`)
      .option("--event <events>", "Comma-separated trigger events, e.g. push,pull_request")
      .option("--workflow <file>", "Workflow file name, e.g. build.yml")
      .option("--branch <name>", "Branch name, sent as refs/heads/<name>")
      .option("--ref <ref>", "Full ref, e.g. refs/pull/7/head")
      .option("--sha <sha>", "Head commit SHA"),
  ).action(async (options: RunListOptions, command: Command) => {
    const filters = listFilters(options);
    const pagination = paginationOptions(options);
    const resolved = await runtime.resolve(selectionFor(command));
    returnJson(
      await collectPages(
        async (page, limit) =>
          (
            await resolved.services.workflowRuns.list(resolved.repository, {
              ...filters,
              page,
              limit,
            })
          ).items,
        pagination,
      ),
    );
  });

  run
    .command("view <number>")
    .description("View a run")
    .action(async (value: string, _options: unknown, command: Command) => {
      const number = runNumber(value);
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(await resolved.services.workflowRuns.view(resolved.repository, number));
    });

  run
    .command("jobs <number>")
    .description(`List a run's jobs with their indexes ${NEEDS_FORGEJO_16}`)
    .action(async (value: string, _options: unknown, command: Command) => {
      const number = runNumber(value);
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(await resolved.services.workflowRuns.jobs(resolved.repository, number));
    });

  run
    .command("logs <number>")
    .description(`Print one job's log; --human prints the raw text ${NEEDS_FORGEJO_16}`)
    .option("--job <index>", "0-based job index, as in …/runs/<number>/jobs/<index>", "0")
    .option("--attempt <number>", "Attempt to read; defaults to the latest")
    .option("--tail-bytes <bytes>", "Return only the last N bytes, where failures usually are")
    .action(async (value: string, options: RunLogOptions, command: Command) => {
      const number = runNumber(value);
      const logOptions = compactDefined({
        job: jobIndex(options.job),
        attempt:
          options.attempt === undefined
            ? undefined
            : parsePositiveInteger(options.attempt, "attempt"),
        tailBytes:
          options.tailBytes === undefined
            ? undefined
            : parsePositiveInteger(options.tailBytes, "tail bytes"),
      });
      const resolved = await runtime.resolve(selectionFor(command));
      const log = await resolved.services.workflowRuns.readJobLog(
        resolved.repository,
        number,
        logOptions,
      );
      returnResult(log, humanLog(log));
    });

  run
    .command("download-logs <number>")
    .description(`Download every job's log as one zip ${NEEDS_FORGEJO_16}`)
    .requiredOption("--output <path>", "New file to write; an existing file is never replaced")
    .action(async (value: string, options: { output: string }, command: Command) => {
      const number = runNumber(value);
      const resolved = await runtime.resolve(selectionFor(command));
      const archive = await resolved.services.workflowRuns.downloadLogs(
        resolved.repository,
        number,
      );
      const written = await runtime.files.write(options.output, archive.download);
      returnJson({ run: archive.run, path: written.path, bytes: written.bytes });
    });

  run
    .command("cancel <number>")
    .description(`Cancel a queued or running run ${NEEDS_FORGEJO_16}`)
    .action(async (value: string, _options: unknown, command: Command) => {
      const number = runNumber(value);
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson({
        cancelled: true,
        run: await resolved.services.workflowRuns.cancel(resolved.repository, number),
      });
    });

  withDestructiveOptions(
    run
      .command("delete <number>")
      .description(`Delete a run with its logs and artifacts ${NEEDS_FORGEJO_16}`),
  ).action(async (value: string, _options: unknown, command: Command) => {
    const number = runNumber(value);
    const repository = assertDestructiveCommand(command, "run", number);
    const resolved = await runtime.resolve(selectionFor(command));
    const deleted = await resolved.services.workflowRuns.delete(repository, number);
    returnJson({ deleted: true, run: deleted, repository });
  });
}
