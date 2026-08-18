import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerLabelCommands } from "../../../src/commands/label-commands.js";
import type { LabelOperations } from "../../../src/forgejo/label-service.js";

describe("paginated list commands", () => {
  it("fetches bounded pages and returns explicit JSON pagination metadata", async () => {
    const calls: unknown[] = [];
    const labels = {
      list: async (_repository: unknown, options: { page?: number; limit?: number }) => {
        calls.push(options);
        return Array.from({ length: options.limit ?? 0 }, (_, index) => ({
          id: (options.page ?? 0) * 10 + index,
        }));
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
      [
        "--repo",
        "octo/app",
        "label",
        "list",
        "--page",
        "2",
        "--limit",
        "2",
        "--paginate",
        "--max-items",
        "3",
      ],
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { page: 2, limit: 2 },
      { page: 3, limit: 2 },
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      data: {
        items: [{ id: 20 }, { id: 21 }, { id: 30 }],
        pagination: { itemCount: 3, truncated: true, hasNextPage: true },
      },
    });
  });
});
