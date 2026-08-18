import type { Command } from "commander";

import type {
  RepositoryCommandRuntime,
  RepositoryDetection,
  RepositorySelection,
  RepositoryServices,
} from "../cli/command-runtime.js";
import { returnJson } from "../cli/execute.js";
import { selectionFor } from "./repository-command.js";

export type RepositoryRuntime = RepositoryCommandRuntime<RepositoryServices> &
  Readonly<{
    detect(selection: RepositorySelection): Promise<RepositoryDetection>;
  }>;

export function registerRepositoryCommands(program: Command, runtime: RepositoryRuntime): void {
  const repository = program.command("repo").description("Inspect repository context");

  repository
    .command("detect")
    .description("Detect the normalized Forgejo origin and repository from local Git")
    .action(async (_options: unknown, command: Command) => {
      returnJson(await runtime.detect(selectionFor(command)));
    });

  repository
    .command("view")
    .description("View the selected Forgejo repository")
    .action(async (_options: unknown, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(await resolved.services.repositories.view(resolved.repository));
    });
}
