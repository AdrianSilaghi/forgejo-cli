import { Command } from "commander";

import type { CliIo } from "../cli/execute.js";
import { executeProgram } from "../cli/execute.js";

export type RunApplicationOptions = Readonly<{
  argv: readonly string[];
  io: CliIo;
  programFactory(): Command;
}>;

export async function runApplication(options: RunApplicationOptions): Promise<number> {
  let program: Command;
  try {
    program = options.programFactory();
  } catch (error) {
    program = new Command()
      .name("forgejo")
      .option("--human")
      .action(() => {
        throw error;
      });
    return executeProgram(program, options.argv.includes("--human") ? ["--human"] : [], options.io);
  }
  return executeProgram(program, options.argv, options.io);
}
