import type { Command } from "commander";

import { compactDefined, parsePositiveInteger } from "../cli/command-options.js";
import type { MilestoneServices, RepositoryCommandRuntime } from "../cli/command-runtime.js";
import { returnJson } from "../cli/execute.js";
import { collectPages } from "../cli/pagination.js";
import type {
  CreateMilestoneInput,
  EditMilestoneInput,
  ListMilestonesOptions,
} from "../forgejo/milestone-service.js";
import {
  assertDestructiveCommand,
  selectionFor,
  withDestructiveOptions,
} from "./repository-command.js";
import {
  paginationOptions,
  type RawPaginationOptions,
  withPaginationOptions,
} from "./pagination-options.js";

type MilestoneFields = Readonly<{
  title?: string;
  description?: string;
  dueOn?: string;
  state?: string;
}>;

function withMilestoneFields(command: Command, titleRequired: boolean): Command {
  const configured = titleRequired
    ? command.requiredOption("--title <title>", "Milestone title")
    : command.option("--title <title>", "Milestone title");
  return configured
    .option("--description <text>", "Milestone description")
    .option("--due-on <date>", "Due date accepted by Forgejo")
    .option("--state <state>", "open or closed");
}

function milestoneFields(options: MilestoneFields): EditMilestoneInput {
  return compactDefined({
    title: options.title,
    description: options.description,
    dueOn: options.dueOn,
    state: options.state,
  }) as EditMilestoneInput;
}

export function registerMilestoneCommands(
  program: Command,
  runtime: RepositoryCommandRuntime<MilestoneServices>,
): void {
  const milestone = program.command("milestone").description("Manage milestones");

  withPaginationOptions(
    milestone
      .command("list")
      .description("List milestones")
      .option("--state <state>", "open, closed, or all")
      .option("--name <name>", "Filter by name"),
  ).action(
    async (options: RawPaginationOptions & { state?: string; name?: string }, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      const filters = compactDefined({
        state: options.state,
        name: options.name,
      });
      returnJson(
        await collectPages(
          (page, limit) =>
            resolved.services.milestones.list(resolved.repository, {
              ...filters,
              page,
              limit,
            } as ListMilestonesOptions),
          paginationOptions(options),
        ),
      );
    },
  );

  withMilestoneFields(milestone.command("create").description("Create a milestone"), true).action(
    async (options: MilestoneFields & { title: string }, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.milestones.create(
          resolved.repository,
          milestoneFields(options) as CreateMilestoneInput,
        ),
      );
    },
  );

  withMilestoneFields(milestone.command("edit <id>").description("Edit a milestone"), false).action(
    async (id: string, options: MilestoneFields, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.milestones.edit(
          resolved.repository,
          parsePositiveInteger(id, "milestone ID"),
          milestoneFields(options),
        ),
      );
    },
  );

  milestone
    .command("close <id>")
    .description("Close a milestone")
    .action(async (id: string, _options: unknown, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.milestones.close(
          resolved.repository,
          parsePositiveInteger(id, "milestone ID"),
        ),
      );
    });

  withDestructiveOptions(milestone.command("delete <id>").description("Delete a milestone")).action(
    async (idInput: string, _options: unknown, command: Command) => {
      const id = parsePositiveInteger(idInput, "milestone ID");
      const repository = assertDestructiveCommand(command, "milestone", id);
      const resolved = await runtime.resolve(selectionFor(command));
      await resolved.services.milestones.delete(repository, id);
      returnJson({ deleted: true, id, repository });
    },
  );
}
