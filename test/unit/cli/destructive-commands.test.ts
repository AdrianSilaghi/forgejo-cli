import { describe, expect, it } from "bun:test";
import { Command } from "commander";

import type { LabelOperations } from "../../../src/forgejo/label-service.js";
import type { ReleaseOperations } from "../../../src/forgejo/release-service.js";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerLabelCommands } from "../../../src/commands/label-commands.js";
import { registerReleaseCommands } from "../../../src/commands/release-commands.js";

describe("destructive commands", () => {
  it("deletes by immutable ID only after explicit repository and target-derived confirmation", async () => {
    const deleted: number[] = [];
    const labels = {
      delete: async (_repository: unknown, id: number) => {
        deleted.push(id);
      },
    } as unknown as LabelOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerLabelCommands(program, {
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: null,
        services: { labels },
      }),
    });
    const stdout: string[] = [];

    const exitCode = await executeProgram(
      program,
      ["--repo", "octo/app", "label", "delete", "42", "--yes", "--confirm", "octo/app#label:42"],
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(deleted).toEqual([42]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      data: { deleted: true, id: 42 },
    });
  });

  it("rejects release deletion when the repository was only auto-detected", async () => {
    let resolved = false;
    const releases = {} as ReleaseOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerReleaseCommands(program, {
      stdin: process.stdin,
      files: {
        open: async () => {
          throw new Error("not used");
        },
      },
      resolve: async () => {
        resolved = true;
        return {
          origin: "https://code.example.test",
          repository: { owner: "octo", repository: "app" },
          localBranch: null,
          services: { releases },
        };
      },
    });
    const stdout: string[] = [];

    const exitCode = await executeProgram(
      program,
      ["release", "delete", "7", "--yes", "--confirm", "octo/app#release:7"],
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(exitCode).toBe(2);
    expect(resolved).toBe(false);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      error: { code: "confirmation_required" },
    });
  });
});
