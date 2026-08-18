import { describe, expect, it } from "bun:test";
import { Command } from "commander";

import { executeProgram, returnJson, returnResult } from "../../../src/cli/execute.js";
import { CliError } from "../../../src/core/errors.js";

function outputBuffer(): {
  stdout: string[];
  stderr: string[];
  io: { stdout(value: string): void; stderr(value: string): void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

describe("executeProgram", () => {
  it("writes exactly one JSON success document to stdout", async () => {
    const program = new Command().name("forgejo");
    program.command("ping").action(() => returnJson({ pong: true }));
    const output = outputBuffer();

    const exitCode = await executeProgram(program, ["ping"], output.io);

    expect(exitCode).toBe(0);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toEqual({
      schema_version: "1",
      ok: true,
      data: { pong: true },
    });
    expect(output.stderr).toEqual([]);
  });

  it("converts parser failures into stable JSON and exit code 2", async () => {
    const program = new Command().name("forgejo");
    const output = outputBuffer();

    const exitCode = await executeProgram(program, ["unknown"], output.io);

    expect(exitCode).toBe(2);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      schema_version: "1",
      ok: false,
      error: { code: "validation_failed", retryable: false },
    });
    expect(output.stderr).toEqual([]);
  });

  it("returns help as JSON instead of contaminating stdout with prose", async () => {
    const program = new Command().name("forgejo").description("Agent-first Forgejo CLI");
    const output = outputBuffer();

    const exitCode = await executeProgram(program, ["--help"], output.io);

    expect(exitCode).toBe(0);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      schema_version: "1",
      ok: true,
      data: { help: expect.stringContaining("Agent-first Forgejo CLI") },
    });
  });

  it("maps domain errors without reflecting secrets", async () => {
    const program = new Command().name("forgejo");
    program.command("fail").action(() => {
      throw new CliError("not_authenticated", "Authorization: token secret-token");
    });
    const output = outputBuffer();

    const exitCode = await executeProgram(program, ["fail"], output.io);

    expect(exitCode).toBe(3);
    const serialized = output.stdout.join("");
    expect(serialized).not.toContain("secret-token");
    expect(JSON.parse(serialized)).toMatchObject({
      ok: false,
      error: { code: "not_authenticated", message: "Authorization: [REDACTED]" },
    });
  });

  it("uses an explicit human rendering only when --human is selected", async () => {
    const program = new Command().name("forgejo").option("--human");
    program.command("ping").action(() => returnResult({ pong: true }, "Pong"));
    const output = outputBuffer();

    const exitCode = await executeProgram(program, ["--human", "ping"], output.io);

    expect(exitCode).toBe(0);
    expect(output.stdout).toEqual(["Pong\n"]);
    expect(output.stderr).toEqual([]);
  });

  it("renders concise human errors without changing the exit code", async () => {
    const program = new Command().name("forgejo").option("--human");
    program.command("fail").action(() => {
      throw new CliError("not_found", "Release not found.");
    });
    const output = outputBuffer();

    const exitCode = await executeProgram(program, ["--human", "fail"], output.io);

    expect(exitCode).toBe(5);
    expect(output.stdout).toEqual(["not_found: Release not found.\n"]);
    expect(output.stderr).toEqual([]);
  });
});
