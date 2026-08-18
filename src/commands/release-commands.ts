import type { Readable } from "node:stream";

import type { Command } from "commander";

import type { AssetFileSource } from "../cli/asset-file.js";
import { compactDefined, parseBoolean, parsePositiveInteger } from "../cli/command-options.js";
import type { ReleaseServices, RepositoryCommandRuntime } from "../cli/command-runtime.js";
import { readContentInput, type ContentInput } from "../cli/content-input.js";
import { returnJson } from "../cli/execute.js";
import { collectPages } from "../cli/pagination.js";
import type {
  CreateReleaseInput,
  EditReleaseInput,
  ListReleasesOptions,
} from "../forgejo/release-service.js";
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

type ReleaseRuntime = RepositoryCommandRuntime<ReleaseServices> &
  Readonly<{ stdin: Readable; files: AssetFileSource }>;

type ReleaseOptions = ContentInput &
  Readonly<{
    tag?: string;
    target?: string;
    name?: string;
    draft?: string;
    prerelease?: string;
    hideArchiveLinks?: string;
  }>;

function withBodyOptions(command: Command): Command {
  return command
    .option("--body <text>", "Release notes")
    .option("--body-file <path>", "Read release notes from a bounded file")
    .option("--body-stdin", "Read release notes from stdin");
}

function withReleaseFields(command: Command, tagRequired: boolean): Command {
  const configured = withBodyOptions(command);
  const withTag = tagRequired
    ? configured.requiredOption("--tag <tag>", "Release tag")
    : configured.option("--tag <tag>", "Release tag");
  return withTag
    .option("--target <commitish>", "Target commit or branch")
    .option("--name <name>", "Release name")
    .option("--draft <boolean>", "Whether the release is a draft")
    .option("--prerelease <boolean>", "Whether the release is a prerelease")
    .option("--hide-archive-links <boolean>", "Whether Forgejo should hide archive links");
}

function hasBodyInput(options: ContentInput): boolean {
  return options.body !== undefined || options.bodyFile !== undefined || options.bodyStdin === true;
}

async function releaseInput(options: ReleaseOptions, stdin: Readable): Promise<EditReleaseInput> {
  const body = hasBodyInput(options) ? await readContentInput(options, stdin) : undefined;
  return compactDefined({
    tagName: options.tag,
    targetCommitish: options.target,
    name: options.name,
    body,
    draft: options.draft === undefined ? undefined : parseBoolean(options.draft, "draft"),
    prerelease:
      options.prerelease === undefined ? undefined : parseBoolean(options.prerelease, "prerelease"),
    hideArchiveLinks:
      options.hideArchiveLinks === undefined
        ? undefined
        : parseBoolean(options.hideArchiveLinks, "hide archive links"),
  });
}

export function registerReleaseCommands(program: Command, runtime: ReleaseRuntime): void {
  const release = program.command("release").description("Manage releases");

  withPaginationOptions(
    release
      .command("list")
      .description("List releases")
      .option("--draft <boolean>", "Filter draft releases")
      .option("--prerelease <boolean>", "Filter prereleases")
      .option("--query <text>", "Search releases"),
  ).action(
    async (
      options: RawPaginationOptions & {
        draft?: string;
        prerelease?: string;
        query?: string;
      },
      command: Command,
    ) => {
      const resolved = await runtime.resolve(selectionFor(command));
      const filters = compactDefined({
        draft: options.draft === undefined ? undefined : parseBoolean(options.draft, "draft"),
        prerelease:
          options.prerelease === undefined
            ? undefined
            : parseBoolean(options.prerelease, "prerelease"),
        query: options.query,
      });
      returnJson(
        await collectPages(
          async (page, limit) =>
            (
              await resolved.services.releases.list(resolved.repository, {
                ...filters,
                page,
                limit,
              } as ListReleasesOptions)
            ).items,
          paginationOptions(options),
        ),
      );
    },
  );

  release
    .command("view <release>")
    .description("View a release by numeric ID, or use --tag for an exact tag")
    .option("--tag", "Interpret the release argument as an exact tag")
    .action(async (value: string, options: { tag?: boolean }, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        options.tag === true
          ? await resolved.services.releases.viewByTag(resolved.repository, value)
          : await resolved.services.releases.viewById(
              resolved.repository,
              parsePositiveInteger(value, "release ID"),
            ),
      );
    });

  withReleaseFields(release.command("create").description("Create a release"), true).action(
    async (options: ReleaseOptions & { tag: string }, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.releases.create(
          resolved.repository,
          (await releaseInput(options, runtime.stdin)) as CreateReleaseInput,
        ),
      );
    },
  );

  withReleaseFields(release.command("edit <id>").description("Edit a release"), false).action(
    async (id: string, options: ReleaseOptions, command: Command) => {
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(
        await resolved.services.releases.edit(
          resolved.repository,
          parsePositiveInteger(id, "release ID"),
          (await releaseInput(options, runtime.stdin)) as EditReleaseInput,
        ),
      );
    },
  );

  withDestructiveOptions(release.command("delete <id>").description("Delete a release")).action(
    async (idInput: string, _options: unknown, command: Command) => {
      const id = parsePositiveInteger(idInput, "release ID");
      const repository = assertDestructiveCommand(command, "release", id);
      const resolved = await runtime.resolve(selectionFor(command));
      await resolved.services.releases.delete(repository, id);
      returnJson({ deleted: true, id, repository });
    },
  );

  release
    .command("upload <id> <path>")
    .description("Stream a regular file to a release asset")
    .option("--name <name>", "Asset display name; defaults to the file basename")
    .action(async (idInput: string, path: string, options: { name?: string }, command: Command) => {
      const id = parsePositiveInteger(idInput, "release ID");
      const file = await runtime.files.open(path);
      try {
        const resolved = await runtime.resolve(selectionFor(command));
        returnJson(
          await resolved.services.releases.upload(resolved.repository, id, {
            name: options.name ?? file.filename,
            filename: file.filename,
            content: file.content,
          }),
        );
      } finally {
        await file.close().catch(() => undefined);
      }
    });
}
