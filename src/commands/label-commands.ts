import type { Command } from "commander";

import { compactDefined, parseBoolean, parsePositiveInteger } from "../cli/command-options.js";
import type { LabelServices, RepositoryCommandRuntime } from "../cli/command-runtime.js";
import { returnJson } from "../cli/execute.js";
import { collectPages } from "../cli/pagination.js";
import type {
  CreateLabelInput,
  EditLabelInput,
  ListLabelsOptions,
} from "../forgejo/label-service.js";
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

type LabelOptions = Readonly<{
  name?: string;
  color?: string;
  description?: string;
  exclusive?: string;
  archived?: string;
}>;

function labelInput(options: LabelOptions): EditLabelInput {
  return compactDefined({
    name: options.name,
    color: options.color,
    description: options.description,
    exclusive:
      options.exclusive === undefined ? undefined : parseBoolean(options.exclusive, "exclusive"),
    isArchived:
      options.archived === undefined ? undefined : parseBoolean(options.archived, "archived"),
  });
}

function withLabelFields(command: Command, required: boolean): Command {
  const configured = required
    ? command
        .requiredOption("--name <name>", "Label name")
        .requiredOption("--color <hex>", "Six-character hex color, without #")
    : command
        .option("--name <name>", "Label name")
        .option("--color <hex>", "Six-character hex color, without #");
  return configured
    .option("--description <text>", "Label description")
    .option("--exclusive <boolean>", "Whether the label is exclusive")
    .option("--archived <boolean>", "Whether the label is archived");
}

export function registerLabelCommands(
  program: Command,
  runtime: RepositoryCommandRuntime<LabelServices>,
): void {
  const label = program.command("label").description("Manage repository labels");

  withPaginationOptions(
    label.command("list").description("List labels").option("--sort <sort>", "Forgejo label sort"),
  ).action(async (options: RawPaginationOptions & { sort?: string }, command: Command) => {
    const resolved = await runtime.resolve(selectionFor(command));
    const pagination = paginationOptions(options);
    returnJson(
      await collectPages(
        (page, limit) =>
          resolved.services.labels.list(
            resolved.repository,
            compactDefined({ sort: options.sort, page, limit }) as ListLabelsOptions,
          ),
        pagination,
      ),
    );
  });

  withLabelFields(label.command("create").description("Create a label"), true).action(
    async (options: LabelOptions & { name: string; color: string }, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.labels.create(
          resolved.repository,
          labelInput(options) as CreateLabelInput,
        ),
      );
    },
  );

  withLabelFields(label.command("edit <id>").description("Edit a label"), false).action(
    async (id: string, options: LabelOptions, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.labels.edit(
          resolved.repository,
          parsePositiveInteger(id, "label ID"),
          labelInput(options),
        ),
      );
    },
  );

  withDestructiveOptions(label.command("delete <id>").description("Delete a label")).action(
    async (idInput: string, _options: unknown, command: Command) => {
      const id = parsePositiveInteger(idInput, "label ID");
      const repository = assertDestructiveCommand(command, "label", id);
      const resolved = await runtime.resolve(selectionFor(command));
      await resolved.services.labels.delete(repository, id);
      returnJson({ deleted: true, id, repository });
    },
  );
}
