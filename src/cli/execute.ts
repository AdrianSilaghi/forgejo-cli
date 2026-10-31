import { type Command, CommanderError, type OutputConfiguration } from "commander";

import { CliError, type ErrorCode } from "../core/errors.js";
import { failure, success } from "../core/result.js";
import { humanOutput, safeTerminalText } from "./human-output.js";
import { parseOutputFields, projectFields } from "./output-fields.js";

export type CliIo = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
}>;

class JsonResult extends Error {
  public readonly data: unknown;
  public readonly human: string | undefined;
  public readonly exitCode: number;

  public constructor(data: unknown, human: string | undefined, exitCode: number) {
    super("CLI command completed");
    this.name = "JsonResult";
    this.data = data;
    this.human = human;
    this.exitCode = exitCode;
  }
}

export function returnJson(data: unknown, exitCode = 0): never {
  throw new JsonResult(data, undefined, exitCode);
}

export function returnResult(data: unknown, human?: string, exitCode = 0): never {
  throw new JsonResult(data, human, exitCode);
}

function exitCodeFor(errorCode: ErrorCode): number {
  switch (errorCode) {
    case "validation_failed":
    case "confirmation_required":
      return 2;
    case "not_authenticated":
    case "credential_store_unavailable":
      return 3;
    case "forbidden":
      return 4;
    case "not_found":
      return 5;
    case "conflict":
      return 6;
    case "rate_limited":
      return 7;
    case "network_failed":
    case "timeout":
      return 8;
    case "server_failed":
    case "protocol_failed":
    case "config_failed":
      return 9;
    case "cancelled":
      return 130;
  }
}

function write(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

function usesHumanOutput(program: Command): boolean {
  return (program.optsWithGlobals() as { human?: boolean }).human === true;
}

function configureCommandTree(program: Command, output: OutputConfiguration): void {
  program
    .exitOverride()
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .configureOutput(output);
  for (const command of program.commands) configureCommandTree(command, output);
}

export async function executeProgram(
  program: Command,
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  let capturedOutput = "";
  configureCommandTree(program, {
    writeOut: (value) => {
      capturedOutput += value;
    },
    writeErr: () => undefined,
  });
  program.hook("preAction", (_command, actionCommand) => {
    parseOutputFields((actionCommand.optsWithGlobals() as { fields?: string }).fields);
  });

  try {
    await program.parseAsync(["bun", "forgejo", ...argv], { from: "node" });
    throw new CliError("validation_failed", "A command is required.");
  } catch (caught) {
    let error = caught;
    if (error instanceof JsonResult) {
      try {
        const fields = (program.optsWithGlobals() as { fields?: string }).fields;
        let data = error.data;
        let projected = false;
        try {
          data = projectFields(error.data, fields);
          projected = fields !== undefined;
        } catch (cause) {
          if (!(cause instanceof CliError)) throw cause;
          // A presentation error must never turn a completed mutation into an apparent failure.
          io.stderr(
            `Warning: --fields was not applied: ${safeTerminalText(cause.message, true)} Command completed; original output follows.\n`,
          );
        }
        if (usesHumanOutput(program)) {
          io.stdout(
            `${projected || error.human === undefined ? humanOutput(data, projected) : safeTerminalText(error.human)}\n`,
          );
        } else {
          write(io, success(data));
        }
        return error.exitCode;
      } catch (cause) {
        error = cause;
      }
    }

    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.help")
    ) {
      if (usesHumanOutput(program)) {
        io.stdout(`${capturedOutput.trimEnd()}\n`);
        return 0;
      }
      write(io, success({ help: capturedOutput.trimEnd() }));
      return 0;
    }

    if (error instanceof CommanderError && error.code === "commander.version") {
      if (usesHumanOutput(program)) {
        io.stdout(`${capturedOutput.trim()}\n`);
        return 0;
      }
      write(io, success({ version: capturedOutput.trim() }));
      return 0;
    }

    const cliError =
      error instanceof CliError
        ? error
        : error instanceof CommanderError
          ? new CliError("validation_failed", error.message)
          : new CliError("server_failed", "Unexpected internal error.");
    const failed = failure({
      code: cliError.code,
      message: cliError.message,
      retryable: cliError.retryable,
      details: cliError.details,
    });
    if (usesHumanOutput(program)) {
      io.stdout(`${failed.error.code}: ${safeTerminalText(failed.error.message, true)}\n`);
    } else {
      write(io, failed);
    }
    return exitCodeFor(cliError.code);
  }
}
