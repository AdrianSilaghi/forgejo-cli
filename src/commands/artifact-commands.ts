import type { Command } from "commander";

import { compactDefined, parsePositiveInteger } from "../cli/command-options.js";
import type { ArtifactServices, RepositoryCommandRuntime } from "../cli/command-runtime.js";
import type { DownloadFileTarget } from "../cli/download-file.js";
import { returnJson } from "../cli/execute.js";
import { collectPages } from "../cli/pagination.js";
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

type ArtifactRuntime = RepositoryCommandRuntime<ArtifactServices> &
  Readonly<{ files: DownloadFileTarget }>;

type ArtifactListOptions = RawPaginationOptions &
  Readonly<{
    run?: string;
    name?: string;
  }>;

function artifactId(value: string): number {
  return parsePositiveInteger(value, "artifact ID");
}

export function registerArtifactCommands(program: Command, runtime: ArtifactRuntime): void {
  const artifact = program
    .command("artifact")
    .description("Manage Forgejo Actions artifacts (Forgejo 16+)");

  withPaginationOptions(
    artifact
      .command("list")
      .description("List artifacts, optionally for one run")
      .option("--run <number>", "Run number, as shown in the run's web URL")
      .option("--name <name>", "Exact artifact name"),
  ).action(async (options: ArtifactListOptions, command: Command) => {
    const filters = compactDefined({
      run: options.run === undefined ? undefined : parsePositiveInteger(options.run, "run number"),
      name: options.name,
    });
    const pagination = paginationOptions(options);
    const resolved = await runtime.resolve(selectionFor(command));
    returnJson(
      await collectPages(
        async (page, limit) =>
          (
            await resolved.services.artifacts.list(resolved.repository, {
              ...filters,
              page,
              limit,
            })
          ).items,
        pagination,
      ),
    );
  });

  artifact
    .command("view <id>")
    .description("View an artifact")
    .action(async (value: string, _options: unknown, command: Command) => {
      const id = artifactId(value);
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(await resolved.services.artifacts.view(resolved.repository, id));
    });

  artifact
    .command("download <id>")
    .description("Download an artifact as a zip")
    .requiredOption("--output <path>", "New file to write; an existing file is never replaced")
    .action(async (value: string, options: { output: string }, command: Command) => {
      const id = artifactId(value);
      const resolved = await runtime.resolve(selectionFor(command));
      const archive = await resolved.services.artifacts.download(resolved.repository, id);
      const written = await runtime.files.write(options.output, archive.download);
      returnJson({ id: archive.id, path: written.path, bytes: written.bytes });
    });

  withDestructiveOptions(artifact.command("delete <id>").description("Delete an artifact")).action(
    async (value: string, _options: unknown, command: Command) => {
      const id = artifactId(value);
      const repository = assertDestructiveCommand(command, "artifact", id);
      const resolved = await runtime.resolve(selectionFor(command));
      await resolved.services.artifacts.delete(repository, id);
      returnJson({ deleted: true, id, repository });
    },
  );
}
