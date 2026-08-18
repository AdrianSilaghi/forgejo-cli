import type { Readable } from "node:stream";

import type { Command } from "commander";

import { compactDefined, parseCsv, parsePositiveInteger } from "../cli/command-options.js";
import type { PullRequestServices, RepositoryCommandRuntime } from "../cli/command-runtime.js";
import { type ContentInput, readContentInput } from "../cli/content-input.js";
import { returnJson } from "../cli/execute.js";
import { collectPages } from "../cli/pagination.js";
import { CliError } from "../core/errors.js";
import type {
  PullRequestCreateInput,
  PullRequestListOptions,
  PullRequestReviewEvent,
} from "../forgejo/pull-request-service.js";
import {
  paginationOptions,
  type RawPaginationOptions,
  withPaginationOptions,
} from "./pagination-options.js";
import { selectionFor } from "./repository-command.js";

type PullRequestRuntime = RepositoryCommandRuntime<PullRequestServices> &
  Readonly<{ stdin: Readable }>;

type CreateOptions = ContentInput &
  Readonly<{
    title: string;
    head?: string;
    base?: string;
    assignees?: string;
    labels?: string;
    milestone?: string;
    dueDate?: string;
  }>;

function withBodyOptions(command: Command): Command {
  return command
    .option("--body <text>", "Body text")
    .option("--body-file <path>", "Read body text from a bounded file")
    .option("--body-stdin", "Read body text from stdin");
}

function hasBodyInput(options: ContentInput): boolean {
  return options.body !== undefined || options.bodyFile !== undefined || options.bodyStdin === true;
}

async function optionalBody(options: ContentInput, stdin: Readable): Promise<string | undefined> {
  return hasBodyInput(options) ? readContentInput(options, stdin) : undefined;
}

function createInput(
  options: CreateOptions,
  head: string,
  base: string,
  body: string | undefined,
): PullRequestCreateInput {
  return compactDefined({
    title: options.title,
    head,
    base,
    body,
    assignees: options.assignees === undefined ? undefined : parseCsv(options.assignees),
    labels:
      options.labels === undefined
        ? undefined
        : Object.freeze(
            parseCsv(options.labels).map((value) => parsePositiveInteger(value, "label ID")),
          ),
    milestone:
      options.milestone === undefined
        ? undefined
        : parsePositiveInteger(options.milestone, "milestone ID"),
    dueDate: options.dueDate,
  }) as PullRequestCreateInput;
}

export function registerPullRequestCommands(program: Command, runtime: PullRequestRuntime): void {
  const pullRequest = program.command("pr").description("Manage pull requests");

  withBodyOptions(
    pullRequest
      .command("create")
      .description("Create a pull request")
      .requiredOption("--title <title>", "Pull request title")
      .option("--head <branch>", "Head branch; defaults to the current local branch")
      .option("--base <branch>", "Base branch; defaults to the repository default branch")
      .option("--assignees <logins>", "Comma-separated assignee logins")
      .option("--labels <ids>", "Comma-separated numeric label IDs")
      .option("--milestone <id>", "Numeric milestone ID")
      .option("--due-date <date>", "Due date accepted by Forgejo"),
  ).action(async (options: CreateOptions, command: Command) => {
    const resolved = await runtime.resolve(selectionFor(command));
    const head = options.head ?? resolved.localBranch;
    if (head === null) {
      throw new CliError(
        "validation_failed",
        "A head branch is required when Git has no current branch.",
      );
    }
    const base =
      options.base ??
      (await resolved.services.repositories.view(resolved.repository)).defaultBranch;
    const body = await optionalBody(options, runtime.stdin);
    returnJson(
      await resolved.services.pullRequests.create(
        resolved.repository,
        createInput(options, head, base, body),
      ),
    );
  });

  withPaginationOptions(
    pullRequest
      .command("list")
      .description("List pull requests")
      .option("--state <state>", "open, closed, or all")
      .option("--sort <sort>", "Forgejo pull request sort")
      .option("--milestone <id>", "Numeric milestone ID")
      .option("--poster <login>", "Filter by author")
      .option("--base <branch>", "Filter by base branch")
      .option("--head <branch>", "Filter by head branch"),
  ).action(
    async (
      options: RawPaginationOptions & {
        state?: string;
        sort?: string;
        milestone?: string;
        poster?: string;
        base?: string;
        head?: string;
      },
      command: Command,
    ) => {
      const resolved = await runtime.resolve(selectionFor(command));
      const filters = compactDefined({
        state: options.state,
        sort: options.sort,
        milestone:
          options.milestone === undefined
            ? undefined
            : parsePositiveInteger(options.milestone, "milestone ID"),
        poster: options.poster,
        base: options.base,
        head: options.head,
      });
      returnJson(
        await collectPages(
          (page, limit) =>
            resolved.services.pullRequests.list(resolved.repository, {
              ...filters,
              page,
              limit,
            } as PullRequestListOptions),
          paginationOptions(options),
        ),
      );
    },
  );

  pullRequest
    .command("view <number>")
    .description("View a pull request")
    .action(async (number: string, _options: unknown, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.pullRequests.view(
          resolved.repository,
          parsePositiveInteger(number, "pull request number"),
        ),
      );
    });

  withBodyOptions(
    pullRequest.command("comment <number>").description("Comment on a pull request"),
  ).action(async (number: string, options: ContentInput, command: Command) => {
    const resolved = await runtime.resolve(selectionFor(command));
    const body = await readContentInput(options, runtime.stdin);
    returnJson(
      await resolved.services.pullRequests.comment(
        resolved.repository,
        parsePositiveInteger(number, "pull request number"),
        body,
      ),
    );
  });

  withBodyOptions(
    pullRequest
      .command("review <number>")
      .description("Submit a pull request review")
      .option("--approve", "Approve the pull request")
      .option("--request-changes", "Request changes")
      .option("--comment", "Submit a non-state-changing review")
      .option("--commit-id <sha>", "Review a specific commit"),
  ).action(
    async (
      number: string,
      options: ContentInput & {
        approve?: boolean;
        requestChanges?: boolean;
        comment?: boolean;
        commitId?: string;
      },
      command: Command,
    ) => {
      const selected: readonly [boolean, PullRequestReviewEvent][] = [
        [options.approve === true, "APPROVE"],
        [options.requestChanges === true, "REQUEST_CHANGES"],
        [options.comment === true, "COMMENT"],
      ];
      const events = selected.filter(([enabled]) => enabled).map(([, event]) => event);
      if (events.length !== 1) {
        throw new CliError(
          "validation_failed",
          "Exactly one of --approve, --request-changes, or --comment is required.",
        );
      }
      const resolved = await runtime.resolve(selectionFor(command));
      const body = await optionalBody(options, runtime.stdin);
      returnJson(
        await resolved.services.pullRequests.review(
          resolved.repository,
          parsePositiveInteger(number, "pull request number"),
          compactDefined({ event: events[0], body, commitId: options.commitId }) as {
            event: PullRequestReviewEvent;
            body?: string;
            commitId?: string;
          },
        ),
      );
    },
  );
}
