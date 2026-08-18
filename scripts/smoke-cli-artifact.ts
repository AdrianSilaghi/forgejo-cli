import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  readBoundedProcessOutput,
  withProcessDeadline,
} from "../src/core/bounded-process-output.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 10_000;

type Scenario = Readonly<{
  name: string;
  args: readonly string[];
  expectedExitCode: number;
}>;

const scenarios: readonly Scenario[] = Object.freeze([
  Object.freeze({ name: "version", args: Object.freeze(["--version"]), expectedExitCode: 0 }),
  Object.freeze({ name: "help", args: Object.freeze(["--help"]), expectedExitCode: 0 }),
  Object.freeze({ name: "parser_error", args: Object.freeze(["unknown"]), expectedExitCode: 2 }),
  Object.freeze({ name: "auth_list", args: Object.freeze(["auth", "list"]), expectedExitCode: 0 }),
]);

async function invoke(
  executable: string,
  scenario: Scenario,
  isolatedDirectory: string,
): Promise<Readonly<{ name: string; exitCode: number; response: unknown }>> {
  const { PATH: path } = process.env;
  if (path === undefined) throw new Error("PATH is required for artifact smoke tests.");
  const child = Bun.spawn([executable, ...scenario.args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: path,
      HOME: isolatedDirectory,
      XDG_CONFIG_HOME: join(isolatedDirectory, ".config"),
    },
  });

  try {
    const [exitCode, stdout, stderr] = await withProcessDeadline(
      PROCESS_TIMEOUT_MS,
      async (signal) =>
        Promise.all([
          child.exited,
          readBoundedProcessOutput(child.stdout, MAX_OUTPUT_BYTES, { signal }),
          readBoundedProcessOutput(child.stderr, MAX_OUTPUT_BYTES, { signal }),
        ]),
    );
    if (exitCode !== scenario.expectedExitCode) {
      throw new Error(
        `${scenario.name} exited with ${exitCode}; expected ${scenario.expectedExitCode}.`,
      );
    }
    if (stderr.length !== 0) {
      throw new Error(`${scenario.name} wrote unexpected stderr output.`);
    }
    if (stdout.trim().split("\n").length !== 1) {
      throw new Error(`${scenario.name} did not emit exactly one JSON document.`);
    }
    return Object.freeze({
      name: scenario.name,
      exitCode,
      response: JSON.parse(stdout) as unknown,
    });
  } catch (cause) {
    child.kill();
    throw cause;
  }
}

const executableInput = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
if (executableInput === undefined || executableInput.length === 0) {
  throw new Error("Usage: bun scripts/smoke-cli-artifact.ts <executable>");
}
const executable = isAbsolute(executableInput) ? executableInput : resolve(executableInput);
const isolatedDirectory = await mkdtemp(join(tmpdir(), "forgejo-cli-smoke-"));
const results = [];
for (const scenario of scenarios) {
  results.push(await invoke(executable, scenario, isolatedDirectory));
}
process.stdout.write(`${JSON.stringify(results)}\n`);
