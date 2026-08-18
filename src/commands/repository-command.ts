import type { Command } from "commander";

import { compactDefined, parseRepositorySlug } from "../cli/command-options.js";
import type { RepositorySelection } from "../cli/command-runtime.js";
import { assertDestructiveConfirmation } from "../core/confirmation.js";
import { CliError } from "../core/errors.js";
import type { RepositoryRef } from "../forgejo/repository-service.js";

type GlobalOptions = Readonly<{
  host?: string;
  repo?: string;
  remote?: string;
  account?: string;
  yes?: boolean;
  confirm?: string;
}>;

export function selectionFor(command: Command): RepositorySelection {
  const options = command.optsWithGlobals() as GlobalOptions;
  return compactDefined({
    host: options.host,
    repository: options.repo === undefined ? undefined : parseRepositorySlug(options.repo),
    remote: options.remote,
    username: options.account,
  });
}

export function explicitRepositoryForDestructiveCommand(command: Command): RepositoryRef {
  const options = command.optsWithGlobals() as GlobalOptions;
  if (options.repo === undefined) {
    throw new CliError(
      "confirmation_required",
      "Destructive operations require an explicit --repo owner/repository target.",
    );
  }
  return parseRepositorySlug(options.repo);
}

export function assertDestructiveCommand(
  command: Command,
  resource: string,
  id: number,
): RepositoryRef {
  const repository = explicitRepositoryForDestructiveCommand(command);
  const options = command.optsWithGlobals() as GlobalOptions;
  assertDestructiveConfirmation({
    repository: `${repository.owner}/${repository.repository}`,
    resource,
    id,
    yes: options.yes === true,
    confirm: options.confirm,
  });
  return repository;
}

export function withDestructiveOptions(command: Command): Command {
  return command
    .option("--yes", "Acknowledge this destructive operation")
    .option("--confirm <target>", "Confirm the exact owner/repository#resource:id target");
}
