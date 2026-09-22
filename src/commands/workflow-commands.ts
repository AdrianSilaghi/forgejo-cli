import type { Command } from "commander";

import type { RepositoryCommandRuntime, WorkflowRunServices } from "../cli/command-runtime.js";
import { returnJson } from "../cli/execute.js";
import { CliError } from "../core/errors.js";
import type { DispatchWorkflowInput } from "../forgejo/workflow-run-service.js";
import { selectionFor } from "./repository-command.js";

type WorkflowRuntime = RepositoryCommandRuntime<WorkflowRunServices>;

type DispatchOptions = Readonly<{
  ref: string;
  input: readonly string[];
}>;

function collectInput(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

/** `key=value`, split at the first `=` so values may themselves contain `=`. */
function parseInputs(values: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (values.length === 0) return undefined;
  const entries = values.map((value): readonly [string, string] => {
    const separator = value.indexOf("=");
    if (separator < 1) {
      throw new CliError("validation_failed", "Workflow inputs use the key=value form.");
    }
    return [value.slice(0, separator), value.slice(separator + 1)];
  });
  const keys = entries.map(([key]) => key);
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated !== undefined) {
    throw new CliError("validation_failed", `Workflow input ${repeated} was given more than once.`);
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function registerWorkflowCommands(program: Command, runtime: WorkflowRuntime): void {
  const workflow = program.command("workflow").description("Start Forgejo Actions workflows");

  workflow
    .command("dispatch <file>")
    .description("Start a workflow_dispatch run and return its run number")
    .requiredOption("--ref <ref>", "Branch or tag to run the workflow from")
    .option("--input <key=value>", "Workflow input; repeat for more", collectInput, [])
    .action(async (file: string, options: DispatchOptions, command: Command) => {
      const inputs = parseInputs(options.input);
      const input: DispatchWorkflowInput =
        inputs === undefined ? { ref: options.ref } : { ref: options.ref, inputs };
      const resolved = await runtime.resolve(selectionFor(command));
      returnJson(await resolved.services.workflowRuns.dispatch(resolved.repository, file, input));
    });
}
