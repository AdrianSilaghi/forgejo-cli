import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerRepositoryCommands } from "../../../src/commands/repository-commands.js";
import type { RepositoryOperations } from "../../../src/forgejo/repository-service.js";

describe("repository commands", () => {
  it("reports normalized detection context without making an API request", async () => {
    const repositories = {} as RepositoryOperations;
    const program = new Command().name("forgejo");
    registerRepositoryCommands(program, {
      detect: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: "feature",
      }),
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: "feature",
        services: { repositories },
      }),
    });
    const stdout: string[] = [];

    const exitCode = await executeProgram(program, ["repo", "detect"], {
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      data: {
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: "feature",
      },
    });
  });

  it("views the explicitly selected repository through the repository service", async () => {
    const viewed: unknown[] = [];
    const repositories = {
      view: async (repository: unknown) => {
        viewed.push(repository);
        return Object.freeze({
          id: 7,
          fullName: "octo/app",
          defaultBranch: "main",
        });
      },
    } as unknown as RepositoryOperations;
    const program = new Command()
      .name("forgejo")
      .option("--host <url>")
      .option("-R, --repo <slug>")
      .option("--remote <name>")
      .option("--account <username>");
    registerRepositoryCommands(program, {
      detect: async () => {
        throw new Error("repository detection must not run for repo view");
      },
      resolve: async (selection) => {
        expect(selection).toEqual({
          host: "https://code.example.test",
          repository: { owner: "octo", repository: "app" },
          remote: "upstream",
          username: "agent",
        });
        return {
          origin: "https://code.example.test",
          repository: { owner: "octo", repository: "app" },
          localBranch: "feature",
          services: { repositories },
        };
      },
    });
    const stdout: string[] = [];

    const exitCode = await executeProgram(
      program,
      [
        "--host",
        "https://code.example.test",
        "--repo",
        "octo/app",
        "--remote",
        "upstream",
        "--account",
        "agent",
        "repo",
        "view",
      ],
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(viewed).toEqual([{ owner: "octo", repository: "app" }]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      data: { id: 7, fullName: "octo/app", defaultBranch: "main" },
    });
  });
});
