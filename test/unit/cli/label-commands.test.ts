import { describe, expect, it } from "bun:test";
import { Command } from "commander";

import { executeProgram } from "../../../src/cli/execute.js";
import { registerLabelCommands } from "../../../src/commands/label-commands.js";
import type {
  CreateLabelInput,
  EditLabelInput,
  LabelOperations,
  ListLabelsOptions,
} from "../../../src/forgejo/label-service.js";

const repository = Object.freeze({ owner: "octo", repository: "app" });

async function executeLabelCommand(
  labels: LabelOperations,
  argv: readonly string[],
): Promise<number> {
  const program = new Command().name("forgejo").option("-R, --repo <slug>");
  registerLabelCommands(program, {
    resolve: async () => ({
      origin: "https://code.example.test",
      repository,
      localBranch: null,
      services: { labels },
    }),
  });
  return executeProgram(program, ["--repo", "octo/app", ...argv], {
    stdout: () => undefined,
    stderr: () => undefined,
  });
}

describe("label commands", () => {
  it("lists labels with sorting and explicit pagination", async () => {
    const calls: ListLabelsOptions[] = [];
    const labels = {
      list: async (_repository: unknown, options: ListLabelsOptions) => {
        calls.push(options);
        return Object.freeze([{ id: 7, name: "bug" }]);
      },
    } as unknown as LabelOperations;

    const exitCode = await executeLabelCommand(labels, [
      "label",
      "list",
      "--sort",
      "mostissues",
      "--page",
      "2",
      "--limit",
      "5",
    ]);

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ sort: "mostissues", page: 2, limit: 5 }]);
  });

  it("creates and edits labels with immutable normalized option objects", async () => {
    const calls: unknown[] = [];
    const createLabels = {
      create: async (target: unknown, input: CreateLabelInput) => {
        calls.push(["create", target, input]);
        return Object.freeze({ id: 7, ...input });
      },
    } as unknown as LabelOperations;
    const editLabels = {
      edit: async (target: unknown, id: number, input: EditLabelInput) => {
        calls.push(["edit", target, id, input]);
        return Object.freeze({ id, ...input });
      },
    } as unknown as LabelOperations;

    expect(
      await executeLabelCommand(createLabels, [
        "label",
        "create",
        "--name",
        "kind/bug",
        "--color",
        "d73a4a",
        "--description",
        "Defect",
        "--exclusive",
        "true",
        "--archived",
        "false",
      ]),
    ).toBe(0);
    expect(
      await executeLabelCommand(editLabels, [
        "label",
        "edit",
        "7",
        "--description",
        "Updated defect",
      ]),
    ).toBe(0);
    expect(calls).toEqual([
      [
        "create",
        repository,
        {
          name: "kind/bug",
          color: "d73a4a",
          description: "Defect",
          exclusive: true,
          isArchived: false,
        },
      ],
      ["edit", repository, 7, { description: "Updated defect" }],
    ]);
    expect(Object.isFrozen((calls[0] as unknown[])[2])).toBe(true);
    expect(Object.isFrozen((calls[1] as unknown[])[3])).toBe(true);
  });

  it("deletes only after exact target-derived confirmation", async () => {
    const deleted: unknown[] = [];
    const labels = {
      delete: async (target: unknown, id: number) => {
        deleted.push([target, id]);
      },
    } as unknown as LabelOperations;

    const exitCode = await executeLabelCommand(labels, [
      "label",
      "delete",
      "8",
      "--yes",
      "--confirm",
      "octo/app#label:8",
    ]);

    expect(exitCode).toBe(0);
    expect(deleted).toEqual([[repository, 8]]);
  });
});
