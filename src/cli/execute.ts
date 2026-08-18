import { type Command, CommanderError } from "commander";

import { CliError, type ErrorCode } from "../core/errors.js";
import { failure, success } from "../core/result.js";

export type CliIo = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
}>;

class JsonResult extends Error {
  public readonly data: unknown;
  public readonly human: string | undefined;

  public constructor(data: unknown, human?: string) {
    super("CLI command completed");
    this.name = "JsonResult";
    this.data = data;
    this.human = human;
  }
}

export function returnJson(data: unknown): never {
  throw new JsonResult(data);
}

export function returnResult(data: unknown, human: string): never {
  throw new JsonResult(data, human);
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

export async function executeProgram(
  program: Command,
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  let capturedOutput = "";
  program
    .exitOverride()
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .configureOutput({
      writeOut: (value) => {
        capturedOutput += value;
      },
      writeErr: () => undefined,
    });

  try {
    await program.parseAsync(["bun", "forgejo", ...argv], { from: "node" });
    throw new CliError("validation_failed", "A command is required.");
  } catch (error) {
    if (error instanceof JsonResult) {
      if (usesHumanOutput(program)) {
        io.stdout(`${error.human ?? JSON.stringify(error.data, null, 2)}\n`);
        return 0;
      }
      write(io, success(error.data));
      return 0;
    }

    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
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
      io.stdout(`${failed.error.code}: ${failed.error.message}\n`);
    } else {
      write(io, failed);
    }
    return exitCodeFor(cliError.code);
  }
}
