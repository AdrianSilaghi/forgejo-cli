import { describe, expect, it } from "bun:test";
import { Command } from "commander";

import { executeProgram } from "../../../src/cli/execute.js";
import { registerWorkflowCommands } from "../../../src/commands/workflow-commands.js";
import type {
  DispatchWorkflowInput,
  WorkflowRunOperations,
} from "../../../src/forgejo/workflow-run-service.js";

const repository = Object.freeze({ owner: "octo", repository: "app" });

function workflowProgram(dispatches: Array<readonly [string, DispatchWorkflowInput]>): Command {
  const program = new Command().name("forgejo").option("-R, --repo <slug>");
  const workflowRuns = {
    dispatch: async (_repository: unknown, workflow: string, input: DispatchWorkflowInput) => {
      dispatches.push([workflow, input]);
      return { id: 1561, number: 46, jobs: ["shell"] };
    },
  } as unknown as WorkflowRunOperations;
  registerWorkflowCommands(program, {
    resolve: async () => ({
      origin: "https://code.example.test",
      repository,
      localBranch: null,
      services: { workflowRuns },
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

describe("workflow commands", () => {
  it("dispatches with repeatable key=value inputs, splitting only at the first '='", async () => {
    const dispatches: Array<readonly [string, DispatchWorkflowInput]> = [];

    const result = await run(workflowProgram(dispatches), [
      "workflow",
      "dispatch",
      "build.yml",
      "--ref",
      "master",
      "--input",
      "environment=staging",
      "--input",
      "filter=a=b",
    ]);

    expect(result.exitCode).toBe(0);
    expect(dispatches).toEqual([
      ["build.yml", { ref: "master", inputs: { environment: "staging", filter: "a=b" } }],
    ]);
    expect(result.output).toEqual({
      schema_version: "1",
      ok: true,
      data: { id: 1561, number: 46, jobs: ["shell"] },
    });
  });

  it("sends no inputs when none were given", async () => {
    const dispatches: Array<readonly [string, DispatchWorkflowInput]> = [];

    await run(workflowProgram(dispatches), [
      "workflow",
      "dispatch",
      "build.yml",
      "--ref",
      "v1.2.3",
    ]);

    expect(dispatches).toEqual([["build.yml", { ref: "v1.2.3" }]]);
  });

  it("rejects malformed or repeated inputs and a missing --ref before dispatching", async () => {
    const dispatches: Array<readonly [string, DispatchWorkflowInput]> = [];
    const attempts = [
      ["workflow", "dispatch", "build.yml", "--ref", "master", "--input", "novalue"],
      ["workflow", "dispatch", "build.yml", "--ref", "master", "--input", "=value"],
      ["workflow", "dispatch", "build.yml", "--ref", "master", "--input", "a=1", "--input", "a=2"],
      ["workflow", "dispatch", "build.yml"],
    ];

    for (const argv of attempts) {
      const result = await run(workflowProgram(dispatches), argv);
      expect(result.exitCode).toBe(2);
      expect(result.output).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    }
    expect(dispatches).toHaveLength(0);
  });
});
