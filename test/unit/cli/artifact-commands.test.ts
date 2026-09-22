import { describe, expect, it } from "bun:test";
import { Command } from "commander";

import type { DownloadSource } from "../../../src/cli/download-file.js";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerArtifactCommands } from "../../../src/commands/artifact-commands.js";
import type {
  ArtifactOperations,
  ListArtifactsOptions,
} from "../../../src/forgejo/artifact-service.js";

const repository = Object.freeze({ owner: "octo", repository: "app" });

function artifactProgram(
  artifacts: Partial<ArtifactOperations>,
  writes: Array<Readonly<{ path: string; source: DownloadSource }>> = [],
): Command {
  const program = new Command().name("forgejo").option("-R, --repo <slug>");
  registerArtifactCommands(program, {
    files: {
      write: async (path, source) => {
        writes.push({ path, source });
        return { path: `/abs/${path}`, bytes: 20_480 };
      },
    },
    resolve: async () => ({
      origin: "https://code.example.test",
      repository,
      localBranch: null,
      services: { artifacts: artifacts as ArtifactOperations },
    }),
  });
  return program;
}

async function run(program: Command, argv: readonly string[]) {
  const stdout: string[] = [];
  const exitCode = await executeProgram(program, argv, {
    stdout: (value) => stdout.push(value),
    stderr: () => undefined,
  });
  return { exitCode, output: JSON.parse(stdout.join("")) };
}

describe("artifact commands", () => {
  it("lists one run's artifacts by run number with a name filter", async () => {
    const requests: ListArtifactsOptions[] = [];
    const program = artifactProgram({
      list: async (_repository, options = {}) => {
        requests.push(options);
        return {
          items: [],
          pagination: { page: 1, limit: 30, itemCount: 0, hasNextPage: false },
        };
      },
    });

    const result = await run(program, [
      "artifact",
      "list",
      "--run",
      "1499",
      "--name",
      "coverage-report",
    ]);

    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([{ run: 1499, name: "coverage-report", page: 1, limit: 30 }]);
    expect(result.output).toMatchObject({ ok: true, data: { items: [] } });
  });

  it("views an artifact by id", async () => {
    const program = artifactProgram({
      view: async (_repository, id) => ({ id, name: "coverage-report" }) as never,
    });

    const result = await run(program, ["artifact", "view", "77"]);

    expect(result.output).toMatchObject({ ok: true, data: { id: 77, name: "coverage-report" } });
  });

  it("downloads an artifact into a new file", async () => {
    const writes: Array<Readonly<{ path: string; source: DownloadSource }>> = [];
    const download = {
      body: new ReadableStream<Uint8Array>(),
      contentType: "application/zip",
      declaredBytes: 20_480,
    };
    const program = artifactProgram(
      { download: async (_repository, id) => ({ id, download }) },
      writes,
    );

    const result = await run(program, ["artifact", "download", "77", "--output", "report.zip"]);

    expect(writes).toEqual([{ path: "report.zip", source: download }]);
    expect(result.output).toMatchObject({
      ok: true,
      data: { id: 77, path: "/abs/report.zip", bytes: 20_480 },
    });
  });

  it("deletes an artifact only with an explicit repository and the derived confirmation", async () => {
    const deleted: number[] = [];
    const program = () =>
      artifactProgram({
        delete: async (_repository, id) => {
          deleted.push(id);
        },
      });

    const confirmed = await run(program(), [
      "--repo",
      "octo/app",
      "artifact",
      "delete",
      "77",
      "--yes",
      "--confirm",
      "octo/app#artifact:77",
    ]);
    const implicit = await run(program(), [
      "artifact",
      "delete",
      "77",
      "--yes",
      "--confirm",
      "octo/app#artifact:77",
    ]);

    expect(deleted).toEqual([77]);
    expect(confirmed.output).toMatchObject({
      ok: true,
      data: { deleted: true, id: 77, repository },
    });
    expect(implicit.output).toMatchObject({ ok: false, error: { code: "confirmation_required" } });
  });

  it("rejects an artifact id that is not a positive integer", async () => {
    const result = await run(artifactProgram({}), ["artifact", "view", "report"]);

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  });
});
