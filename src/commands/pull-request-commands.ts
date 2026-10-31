import type { Readable } from "node:stream";

import type { Command } from "commander";

import { compactDefined, parseCsv, parsePositiveInteger } from "../cli/command-options.js";
import type { PullRequestServices, RepositoryCommandRuntime } from "../cli/command-runtime.js";
import { type ContentInput, readContentInput } from "../cli/content-input.js";
import { returnJson, returnResult } from "../cli/execute.js";
import { collectPages } from "../cli/pagination.js";
import { CliError } from "../core/errors.js";
import {
  type PullRequestCreateInput,
  type PullRequestListOptions,
  type PullRequestReviewEvent,
  parsePullRequestEditInput,
  parsePullRequestMergeInput,
} from "../forgejo/pull-request-service.js";
import {
  paginationOptions,
  type RawPaginationOptions,
  withPaginationOptions,
} from "./pagination-options.js";
import { resolvePullRequestSelector } from "./pull-request-selector.js";
import {
  assertDestructiveCommand,
  selectionFor,
  withDestructiveOptions,
} from "./repository-command.js";

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
    .command("view [selector]")
    .description("View a pull request")
    .action(async (number: string | undefined, _options: unknown, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.pullRequests.view(
          resolved.repository,
          await resolvePullRequestSelector(number, resolved),
        ),
      );
    });

  withBodyOptions(
    pullRequest
      .command("edit [selector]")
      .description("Edit a pull request")
      .option("--title <title>", "Pull request title")
      .option("--base <branch>", "Base branch")
      .option("--labels <ids>", "Replace labels with comma-separated numeric IDs; empty clears")
      .option(
        "--assignees <logins>",
        "Replace assignees with comma-separated logins; empty clears",
      ),
  ).action(
    async (
      value: string | undefined,
      options: ContentInput & {
        title?: string;
        base?: string;
        labels?: string;
        assignees?: string;
      },
      command: Command,
    ) => {
      const body = await optionalBody(options, runtime.stdin);
      const input = parsePullRequestEditInput(
        compactDefined({
          title: options.title,
          body,
          base: options.base,
          labels:
            options.labels === undefined
              ? undefined
              : (options.labels === "" ? [] : parseCsv(options.labels)).map((id) =>
                  parsePositiveInteger(id, "label ID"),
                ),
          assignees:
            options.assignees === undefined
              ? undefined
              : options.assignees === ""
                ? []
                : parseCsv(options.assignees),
        }),
      );
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.pullRequests.edit(
          resolved.repository,
          await resolvePullRequestSelector(value, resolved),
          input,
        ),
      );
    },
  );

  pullRequest
    .command("diff [selector]")
    .description("Read a pull request diff")
    .action(async (value: string | undefined, _options: unknown, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      const diff = await resolved.services.pullRequests.diff(
        resolved.repository,
        await resolvePullRequestSelector(value, resolved),
      );
      returnResult(diff, diff.text);
    });

  for (const action of ["close", "reopen"] as const) {
    pullRequest
      .command(`${action} [selector]`)
      .description(`${action === "close" ? "Close" : "Reopen"} a pull request`)
      .action(async (value: string | undefined, _options: unknown, command: Command) => {
        const resolved = await runtime.resolve(selectionFor(command));
        returnJson(
          await resolved.services.pullRequests[action](
            resolved.repository,
            await resolvePullRequestSelector(value, resolved, {
              state: action === "reopen" ? "closed" : "open",
            }),
          ),
        );
      });
  }

  withDestructiveOptions(
    pullRequest
      .command("merge <number>")
      .description("Merge the exact expected pull request head")
      .requiredOption("--head-sha <sha>", "Expected full head commit SHA")
      .option("--method <method>", "merge, rebase, rebase-merge, squash, or fast-forward-only")
      .option("--merge", "Create a merge commit")
      .option("--squash", "Squash the pull request")
      .option("--rebase", "Rebase the pull request"),
  ).action(
    async (
      value: string,
      options: {
        headSha: string;
        method?: string;
        merge?: boolean;
        squash?: boolean;
        rebase?: boolean;
      },
      command: Command,
    ) => {
      const number = parsePositiveInteger(value, "pull request number");
      const repository = assertDestructiveCommand(command, "pr", number);
      const methods = [
        options.method,
        options.merge ? "merge" : undefined,
        options.squash ? "squash" : undefined,
        options.rebase ? "rebase" : undefined,
      ].filter((method) => method !== undefined);
      if (methods.length > 1)
        throw new CliError("validation_failed", "Choose only one merge method.");
      const input = parsePullRequestMergeInput({
        method: methods[0] ?? "merge",
        headSha: options.headSha,
      });
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(await resolved.services.pullRequests.merge(repository, number, input));
    },
  );

  withBodyOptions(
    pullRequest.command("comment [selector]").description("Comment on a pull request"),
  ).action(async (number: string | undefined, options: ContentInput, command: Command) => {
    const resolved = await runtime.resolve(selectionFor(command));
    const body = await readContentInput(options, runtime.stdin);
    returnJson(
      await resolved.services.pullRequests.comment(
        resolved.repository,
        await resolvePullRequestSelector(number, resolved),
        body,
      ),
    );
  });

  withBodyOptions(
    pullRequest
      .command("review [selector]")
      .description("Submit a pull request review")
      .option("--approve", "Approve the pull request")
      .option("--request-changes", "Request changes")
      .option("--comment", "Submit a non-state-changing review")
      .option("--commit-id <sha>", "Review a specific commit"),
  ).action(
    async (
      number: string | undefined,
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
          await resolvePullRequestSelector(number, resolved),
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
