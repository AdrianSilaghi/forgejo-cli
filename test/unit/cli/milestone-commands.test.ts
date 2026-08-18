import { describe, expect, it } from "bun:test";
import { Command } from "commander";

import { executeProgram } from "../../../src/cli/execute.js";
import { registerMilestoneCommands } from "../../../src/commands/milestone-commands.js";
import type {
  CreateMilestoneInput,
  EditMilestoneInput,
  ListMilestonesOptions,
  MilestoneOperations,
} from "../../../src/forgejo/milestone-service.js";

const repository = Object.freeze({ owner: "octo", repository: "app" });

async function executeMilestoneCommand(
  milestones: MilestoneOperations,
  argv: readonly string[],
): Promise<number> {
  const program = new Command().name("forgejo").option("-R, --repo <slug>");
  registerMilestoneCommands(program, {
    resolve: async () => ({
      origin: "https://code.example.test",
      repository,
      localBranch: null,
      services: { milestones },
    }),
  });
  return executeProgram(program, ["--repo", "octo/app", ...argv], {
    stdout: () => undefined,
    stderr: () => undefined,
  });
}

describe("milestone commands", () => {
  it("closes a milestone by stable numeric ID", async () => {
    const closed: number[] = [];
    const milestones = {
      close: async (_repository: unknown, id: number) => {
        closed.push(id);
        return Object.freeze({ id, state: "closed" });
      },
    } as unknown as MilestoneOperations;
    const program = new Command().name("forgejo").option("-R, --repo <slug>");
    registerMilestoneCommands(program, {
      resolve: async () => ({
        origin: "https://code.example.test",
        repository: { owner: "octo", repository: "app" },
        localBranch: null,
        services: { milestones },
      }),
    });

    const exitCode = await executeProgram(
      program,
      ["--repo", "octo/app", "milestone", "close", "9"],
      { stdout: () => undefined, stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(closed).toEqual([9]);
  });

  it("lists milestones with filters and explicit pagination", async () => {
    const calls: ListMilestonesOptions[] = [];
    const milestones = {
      list: async (_repository: unknown, options: ListMilestonesOptions) => {
        calls.push(options);
        return Object.freeze([{ id: 9, title: "v1" }]);
      },
    } as unknown as MilestoneOperations;

    const exitCode = await executeMilestoneCommand(milestones, [
      "milestone",
      "list",
      "--state",
      "all",
      "--name",
      "v1",
      "--page",
      "2",
      "--limit",
      "5",
    ]);

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ state: "all", name: "v1", page: 2, limit: 5 }]);
  });

  it("creates and edits milestones with immutable normalized option objects", async () => {
    const calls: unknown[] = [];
    const createMilestones = {
      create: async (target: unknown, input: CreateMilestoneInput) => {
        calls.push(["create", target, input]);
        return Object.freeze({ id: 9, ...input });
      },
    } as unknown as MilestoneOperations;
    const editMilestones = {
      edit: async (target: unknown, id: number, input: EditMilestoneInput) => {
        calls.push(["edit", target, id, input]);
        return Object.freeze({ id, ...input });
      },
    } as unknown as MilestoneOperations;

    expect(
      await executeMilestoneCommand(createMilestones, [
        "milestone",
        "create",
        "--title",
        "v1",
        "--description",
        "First release",
        "--due-on",
        "2026-09-01T00:00:00Z",
        "--state",
        "open",
      ]),
    ).toBe(0);
    expect(
      await executeMilestoneCommand(editMilestones, [
        "milestone",
        "edit",
        "9",
        "--title",
        "v1.1",
        "--description",
        "Updated release",
        "--due-on",
        "2026-10-01T00:00:00Z",
        "--state",
        "closed",
      ]),
    ).toBe(0);
    expect(calls).toEqual([
      [
        "create",
        repository,
        {
          title: "v1",
          description: "First release",
          dueOn: "2026-09-01T00:00:00Z",
          state: "open",
        },
      ],
      [
        "edit",
        repository,
        9,
        {
          title: "v1.1",
          description: "Updated release",
          dueOn: "2026-10-01T00:00:00Z",
          state: "closed",
        },
      ],
    ]);
    expect(Object.isFrozen((calls[0] as unknown[])[2])).toBe(true);
    expect(Object.isFrozen((calls[1] as unknown[])[3])).toBe(true);
  });

  it("deletes only after exact target-derived confirmation", async () => {
    const deleted: unknown[] = [];
    const milestones = {
      delete: async (target: unknown, id: number) => {
        deleted.push([target, id]);
      },
    } as unknown as MilestoneOperations;

    const exitCode = await executeMilestoneCommand(milestones, [
      "milestone",
      "delete",
      "10",
      "--yes",
      "--confirm",
      "octo/app#milestone:10",
    ]);

    expect(exitCode).toBe(0);
    expect(deleted).toEqual([[repository, 10]]);
  });
});
