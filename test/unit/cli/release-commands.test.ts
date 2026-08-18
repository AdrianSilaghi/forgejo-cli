import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import { Command } from "commander";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerReleaseCommands } from "../../../src/commands/release-commands.js";
import type {
  CreateReleaseInput,
  EditReleaseInput,
  ListReleasesOptions,
  ReleaseOperations,
  UploadReleaseAssetInput,
} from "../../../src/forgejo/release-service.js";

const repository = Object.freeze({ owner: "octo", repository: "app" });

function releaseProgram(
  releases: ReleaseOperations,
  options: Readonly<{
    stdin?: Readable;
    open?: (path: string) => Promise<{
      content: Blob;
      filename: string;
      size: number;
      close(): Promise<void>;
    }>;
  }> = {},
): Command {
  const program = new Command().name("forgejo").option("-R, --repo <slug>");
  registerReleaseCommands(program, {
    stdin: options.stdin ?? Readable.from([]),
    files: {
      open:
        options.open ??
        (async () => {
          throw new Error("asset file must not be opened");
        }),
    },
    resolve: async () => ({
      origin: "https://code.example.test",
      repository,
      localBranch: null,
      services: { releases },
    }),
  });
  return program;
}

async function run(
  program: Command,
  argv: readonly string[],
): Promise<{
  exitCode: number;
  output: unknown;
}> {
  const stdout: string[] = [];
  const exitCode = await executeProgram(program, argv, {
    stdout: (value) => stdout.push(value),
    stderr: () => undefined,
  });
  return { exitCode, output: JSON.parse(stdout.join("")) };
}

describe("release commands", () => {
  it("lists a selected page with normalized boolean and query filters", async () => {
    const requests: ListReleasesOptions[] = [];
    const releases = {
      list: async (_repository: unknown, options: ListReleasesOptions) => {
        requests.push(options);
        return Object.freeze({
          items: Object.freeze([Object.freeze({ id: 3, tagName: "v1.0.0" })]),
          pagination: Object.freeze({ page: 2, limit: 5, itemCount: 1, hasNextPage: false }),
        });
      },
    } as unknown as ReleaseOperations;

    const result = await run(releaseProgram(releases), [
      "--repo",
      "octo/app",
      "release",
      "list",
      "--page",
      "2",
      "--limit",
      "5",
      "--draft",
      "false",
      "--prerelease",
      "true",
      "--query",
      "stable",
    ]);

    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([
      { page: 2, limit: 5, draft: false, prerelease: true, query: "stable" },
    ]);
    expect(result.output).toMatchObject({
      ok: true,
      data: {
        items: [{ id: 3, tagName: "v1.0.0" }],
        pagination: { page: 2, limit: 5, itemCount: 1 },
      },
    });
  });

  it("views releases by numeric ID or exact tag", async () => {
    const requests: string[] = [];
    const releases = {
      viewById: async (_repository: unknown, id: number) => {
        requests.push(`id:${id}`);
        return Object.freeze({ id, tagName: "v7" });
      },
      viewByTag: async (_repository: unknown, tag: string) => {
        requests.push(`tag:${tag}`);
        return Object.freeze({ id: 8, tagName: tag });
      },
    } as unknown as ReleaseOperations;

    const byId = await run(releaseProgram(releases), [
      "--repo",
      "octo/app",
      "release",
      "view",
      "7",
    ]);
    const byTag = await run(releaseProgram(releases), [
      "--repo",
      "octo/app",
      "release",
      "view",
      "v8.0.0",
      "--tag",
    ]);

    expect(byId.exitCode).toBe(0);
    expect(byTag.exitCode).toBe(0);
    expect(requests).toEqual(["id:7", "tag:v8.0.0"]);
    expect(byTag.output).toMatchObject({ ok: true, data: { id: 8, tagName: "v8.0.0" } });
  });

  it("creates a release from stdin with every supported release field", async () => {
    let captured: CreateReleaseInput | undefined;
    const releases = {
      create: async (_repository: unknown, input: CreateReleaseInput) => {
        captured = input;
        return Object.freeze({ id: 9, tagName: input.tagName });
      },
    } as unknown as ReleaseOperations;

    const result = await run(
      releaseProgram(releases, { stdin: Readable.from(["Release notes"]) }),
      [
        "--repo",
        "octo/app",
        "release",
        "create",
        "--tag",
        "v9.0.0",
        "--target",
        "main",
        "--name",
        "Version 9",
        "--body-stdin",
        "--draft",
        "true",
        "--prerelease",
        "false",
        "--hide-archive-links",
        "true",
      ],
    );

    expect(result.exitCode).toBe(0);
    expect(captured).toEqual({
      tagName: "v9.0.0",
      targetCommitish: "main",
      name: "Version 9",
      body: "Release notes",
      draft: true,
      prerelease: false,
      hideArchiveLinks: true,
    });
  });

  it("edits only the explicitly supplied release fields", async () => {
    let captured: Readonly<{ id: number; input: EditReleaseInput }> | undefined;
    const releases = {
      edit: async (_repository: unknown, id: number, input: EditReleaseInput) => {
        captured = Object.freeze({ id, input });
        return Object.freeze({ id, tagName: "v10.0.1", name: input.name });
      },
    } as unknown as ReleaseOperations;

    const result = await run(releaseProgram(releases), [
      "--repo",
      "octo/app",
      "release",
      "edit",
      "10",
      "--name",
      "Renamed",
    ]);

    expect(result.exitCode).toBe(0);
    expect(captured).toEqual({ id: 10, input: { name: "Renamed" } });
  });

  it("deletes a release after exact destructive confirmation", async () => {
    const deleted: number[] = [];
    const releases = {
      delete: async (_repository: unknown, id: number) => {
        deleted.push(id);
      },
    } as unknown as ReleaseOperations;

    const result = await run(releaseProgram(releases), [
      "--repo",
      "octo/app",
      "release",
      "delete",
      "11",
      "--yes",
      "--confirm",
      "octo/app#release:11",
    ]);

    expect(result.exitCode).toBe(0);
    expect(deleted).toEqual([11]);
    expect(result.output).toMatchObject({
      ok: true,
      data: { deleted: true, id: 11, repository },
    });
  });

  it("uploads a lazy Blob through the release service without reading it in the command", async () => {
    const content = new Blob(["binary"]);
    let closeCalls = 0;
    let captured: UploadReleaseAssetInput | undefined;
    const releases = {
      upload: async (_repository: unknown, _id: number, input: UploadReleaseAssetInput) => {
        captured = input;
        return Object.freeze({ id: 4, name: input.name });
      },
    } as unknown as ReleaseOperations;
    const opened: string[] = [];
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerReleaseCommands(program, {
      stdin: process.stdin,
      files: {
        open: async (path) => {
          opened.push(path);
          return {
            content,
            filename: "forgejo-linux-amd64",
            size: content.size,
            close: async () => {
              closeCalls += 1;
            },
          };
        },
      },
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: null,
        services: { releases },
      }),
    });

    const exitCode = await executeProgram(
      program,
      [
        "--repo",
        "octo/app",
        "release",
        "upload",
        "42",
        "./dist/forgejo-linux-amd64",
        "--name",
        "forgejo-linux-amd64",
      ],
      { stdout: () => undefined, stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(opened).toEqual(["./dist/forgejo-linux-amd64"]);
    expect(closeCalls).toBe(1);
    expect(captured).toEqual({
      content,
      filename: "forgejo-linux-amd64",
      name: "forgejo-linux-amd64",
    });
  });

  it("defaults the uploaded asset name to the opened file name", async () => {
    const content = new Blob(["binary"]);
    let captured: UploadReleaseAssetInput | undefined;
    const releases = {
      upload: async (_repository: unknown, _id: number, input: UploadReleaseAssetInput) => {
        captured = input;
        return Object.freeze({ id: 12, name: input.name });
      },
    } as unknown as ReleaseOperations;

    const result = await run(
      releaseProgram(releases, {
        open: async () => ({
          content,
          filename: "forgejo-darwin-arm64",
          size: content.size,
          close: async () => undefined,
        }),
      }),
      ["--repo", "octo/app", "release", "upload", "12", "./artifact"],
    );

    expect(result.exitCode).toBe(0);
    expect(captured).toEqual({
      content,
      filename: "forgejo-darwin-arm64",
      name: "forgejo-darwin-arm64",
    });
  });
});
