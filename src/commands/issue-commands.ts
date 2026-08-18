import type { Readable } from "node:stream";

import type { Command } from "commander";

import { compactDefined, parseCsv, parsePositiveInteger } from "../cli/command-options.js";
import type { IssueServices, RepositoryCommandRuntime } from "../cli/command-runtime.js";
import { readContentInput, type ContentInput } from "../cli/content-input.js";
import { returnJson } from "../cli/execute.js";
import { collectPages } from "../cli/pagination.js";
import type {
  CreateIssueInput,
  EditIssueInput,
  ListIssuesOptions,
} from "../forgejo/issue-service.js";
import { selectionFor } from "./repository-command.js";
import {
  paginationOptions,
  type RawPaginationOptions,
  withPaginationOptions,
} from "./pagination-options.js";

type IssueRuntime = RepositoryCommandRuntime<IssueServices> & Readonly<{ stdin: Readable }>;

type IssueFields = ContentInput &
  Readonly<{
    title?: string;
    assignees?: string;
    labels?: string;
    milestone?: string;
    dueOn?: string;
    unsetDueDate?: boolean;
    ref?: string;
  }>;

function withBodyOptions(command: Command): Command {
  return command
    .option("--body <text>", "Issue body")
    .option("--body-file <path>", "Read the issue body from a bounded file")
    .option("--body-stdin", "Read the issue body from stdin");
}

function withIssueFields(
  command: Command,
  options: { titleRequired: boolean; includeLabels: boolean; includeUnsetDueDate: boolean },
): Command {
  const withTitle = options.titleRequired
    ? command.requiredOption("--title <title>", "Issue title")
    : command.option("--title <title>", "Issue title");
  let configured = withBodyOptions(withTitle).option(
    "--assignees <logins>",
    "Comma-separated assignee logins",
  );
  if (options.includeLabels) {
    configured = configured.option("--labels <ids>", "Comma-separated numeric label IDs");
  }
  configured = configured
    .option("--milestone <id>", "Numeric milestone ID")
    .option("--due-on <date>", "Due date accepted by Forgejo")
    .option("--ref <reference>", "Issue reference metadata");
  return options.includeUnsetDueDate
    ? configured.option("--unset-due-date", "Remove the issue due date")
    : configured;
}

function hasBodyInput(options: ContentInput): boolean {
  return options.body !== undefined || options.bodyFile !== undefined || options.bodyStdin === true;
}

async function issueFields(
  options: IssueFields,
  stdin: Readable,
): Promise<EditIssueInput & Readonly<{ labelIds?: readonly number[] }>> {
  const body = hasBodyInput(options) ? await readContentInput(options, stdin) : undefined;
  return compactDefined({
    title: options.title,
    body,
    assignees: options.assignees === undefined ? undefined : parseCsv(options.assignees),
    labelIds:
      options.labels === undefined
        ? undefined
        : parseCsv(options.labels).map((value) => parsePositiveInteger(value, "label ID")),
    milestoneId:
      options.milestone === undefined
        ? undefined
        : parsePositiveInteger(options.milestone, "milestone ID"),
    dueOn: options.dueOn,
    unsetDueDate: options.unsetDueDate === true ? true : undefined,
    ref: options.ref,
  });
}

export function registerIssueCommands(program: Command, runtime: IssueRuntime): void {
  const issue = program.command("issue").description("Manage issues");

  withIssueFields(issue.command("create").description("Create an issue"), {
    titleRequired: true,
    includeLabels: true,
    includeUnsetDueDate: false,
  }).action(async (options: IssueFields & { title: string }, command: Command) => {
    const resolved = await runtime.resolve(selectionFor(command));
    returnJson(
      await resolved.services.issues.create(
        resolved.repository,
        (await issueFields(options, runtime.stdin)) as CreateIssueInput,
      ),
    );
  });

  withPaginationOptions(
    issue
      .command("list")
      .description("List issues")
      .option("--state <state>", "open, closed, or all")
      .option("--labels <names>", "Comma-separated label names")
      .option("--query <text>", "Search issues")
      .option("--milestones <names>", "Comma-separated milestone names")
      .option("--since <date>", "Only issues updated since this date")
      .option("--before <date>", "Only issues updated before this date")
      .option("--created-by <login>", "Filter by creator")
      .option("--assigned-by <login>", "Filter by assignee")
      .option("--mentioned-by <login>", "Filter by mention")
      .option("--sort <sort>", "Forgejo issue sort"),
  ).action(
    async (
      options: RawPaginationOptions & {
        state?: string;
        labels?: string;
        query?: string;
        milestones?: string;
        since?: string;
        before?: string;
        createdBy?: string;
        assignedBy?: string;
        mentionedBy?: string;
        sort?: string;
      },
      command: Command,
    ) => {
      const resolved = await runtime.resolve(selectionFor(command));
      const filters = compactDefined({
        state: options.state,
        labels: options.labels === undefined ? undefined : parseCsv(options.labels),
        query: options.query,
        milestones: options.milestones === undefined ? undefined : parseCsv(options.milestones),
        since: options.since,
        before: options.before,
        createdBy: options.createdBy,
        assignedBy: options.assignedBy,
        mentionedBy: options.mentionedBy,
        sort: options.sort,
      });
      returnJson(
        await collectPages(
          (page, limit) =>
            resolved.services.issues.list(resolved.repository, {
              ...filters,
              page,
              limit,
            } as ListIssuesOptions),
          paginationOptions(options),
        ),
      );
    },
  );

  issue
    .command("view <number>")
    .description("View an issue")
    .action(async (number: string, _options: unknown, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.issues.view(
          resolved.repository,
          parsePositiveInteger(number, "issue number"),
        ),
      );
    });

  withIssueFields(issue.command("edit <number>").description("Edit an issue"), {
    titleRequired: false,
    includeLabels: false,
    includeUnsetDueDate: true,
  }).action(async (number: string, options: IssueFields, command: Command) => {
    const resolved = await runtime.resolve(selectionFor(command));
    const editFields = await issueFields(options, runtime.stdin);
    returnJson(
      await resolved.services.issues.edit(
        resolved.repository,
        parsePositiveInteger(number, "issue number"),
        editFields,
      ),
    );
  });

  for (const operation of ["close", "reopen"] as const) {
    issue
      .command(`${operation} <number>`)
      .description(`${operation === "close" ? "Close" : "Reopen"} an issue`)
      .action(async (number: string, _options: unknown, command: Command) => {
        const resolved = await runtime.resolve(selectionFor(command));
        const parsedNumber = parsePositiveInteger(number, "issue number");
        returnJson(
          operation === "close"
            ? await resolved.services.issues.close(resolved.repository, parsedNumber)
            : await resolved.services.issues.reopen(resolved.repository, parsedNumber),
        );
      });
  }

  withBodyOptions(issue.command("comment <number>").description("Comment on an issue")).action(
    async (number: string, options: ContentInput, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.issues.comment(
          resolved.repository,
          parsePositiveInteger(number, "issue number"),
          await readContentInput(options, runtime.stdin),
        ),
      );
    },
  );
}
