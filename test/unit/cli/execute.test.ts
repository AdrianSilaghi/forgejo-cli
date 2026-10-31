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

describe("shared result presentation", () => {
  async function run(data: unknown, argv: readonly string[], human?: string, exitCode = 0) {
    const program = new Command().name("forgejo").option("--human").option("--fields <fields>");
    program.command("show").action(() => returnResult(data, human, exitCode));
    const output = outputBuffer();
    const code = await executeProgram(program, [...argv, "show"], output.io);
    return { code, text: output.stdout.join(""), writes: output.stdout, warnings: output.stderr };
  }

  it("projects object and array data while preserving the success envelope", async () => {
    const data = Object.freeze({ number: 4, title: "Fix", body: "long" });
    for (const value of [data, [data]]) {
      const result = await run(value, ["--fields", "number,title"]);
      expect(result.code).toBe(0);
      expect(result.writes).toHaveLength(1);
      expect(JSON.parse(result.text)).toEqual({
        schema_version: "1",
        ok: true,
        data: Array.isArray(value) ? [{ number: 4, title: "Fix" }] : { number: 4, title: "Fix" },
      });
    }
    expect(data.body).toBe("long");
  });

  it("projects paginated items without dropping pagination metadata", async () => {
    const pagination = { page: 2, hasNextPage: true, truncated: true };
    const result = await run({ items: [{ number: 4, title: "Fix" }], pagination }, [
      "--fields",
      "number",
    ]);
    expect(JSON.parse(result.text).data).toEqual({ items: [{ number: 4 }], pagination });
    expect(
      JSON.parse((await run({ items: [], pagination }, ["--fields", "number"])).text).data,
    ).toEqual({ items: [], pagination });
  });

  it("rejects malformed, nested, duplicate and prototype fields before invoking handlers", async () => {
    for (const fields of [
      "",
      "title,",
      "title,title",
      "author.login",
      "__proto__",
      "constructor",
      "prototype",
      "toString",
      "title\n",
    ]) {
      let calls = 0;
      const program = new Command().option("--fields <fields>");
      program.command("create").action(() => {
        calls += 1;
        returnJson({ title: "Created" });
      });
      const output = outputBuffer();
      expect(await executeProgram(program, ["--fields", fields, "create"], output.io)).toBe(2);
      expect(calls).toBe(0);
      expect(JSON.parse(output.stdout.join(""))).toMatchObject({
        schema_version: "1",
        ok: false,
        error: { code: "validation_failed" },
      });
    }
  });

  it("keeps successful results and exit status when selected fields are unavailable", async () => {
    for (const data of [{ title: "Created", id: 42 }, [1, 2], true]) {
      const result = await run(data, ["--fields", "missing"], undefined, 1);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.text)).toEqual({ schema_version: "1", ok: true, data });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Command completed");
      expect(result.warnings[0]).toContain("original output");
    }
    const human = await run({ title: "Created" }, ["--human", "--fields", "missing"]);
    expect(human.code).toBe(0);
    expect(human.text).toContain("Created");
    expect(human.warnings).toHaveLength(1);
  });

  it("does not project errors or replace their exit status", async () => {
    const program = new Command().option("--fields <fields>");
    program.command("fail").action(() => {
      throw new CliError("not_found", "Missing.");
    });
    const output = outputBuffer();
    expect(await executeProgram(program, ["--fields", "number", "fail"], output.io)).toBe(5);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("renders issue and workflow job lists as readable tables", async () => {
    const issue = await run(
      { items: [{ number: 4, title: "Fix", state: "open" }], pagination: {} },
      ["--human"],
    );
    expect(issue.text).toContain("NUMBER");
    expect(issue.text).toContain("TITLE");
    expect(issue.text).toContain("STATE");
    expect(issue.text).toContain("Fix");
    expect(issue.text).not.toContain('"items"');
    const jobs = await run(
      { run: { number: 4 }, jobs: [{ index: 0, name: "Test", status: "success", attempt: 1 }] },
      ["--human"],
    );
    expect(jobs.text).toContain("INDEX");
    expect(jobs.text).toContain("Test");
    expect(jobs.text).toContain("success");
  });

  it("honors fields in human tables and keeps untrusted text on one line", async () => {
    const result = await run(
      [{ number: 4, title: "Fix\nforged\r\t\u001b[31mRED\u009b31m" }],
      ["--human", "--fields", "number,title"],
    );
    expect(result.code).toBe(0);
    expect(result.text).not.toContain("\u001b");
    expect(result.text).not.toContain("\u009b");
    expect(result.text.trimEnd().split("\n")).toHaveLength(2);
  });

  it("preserves explicit multiline human logs while neutralizing terminal controls", async () => {
    const result = await run({ text: "raw" }, ["--human"], "line 1\n\tline 2\u001b[31m\rline 3");
    expect(result.text).toContain("line 1\n\tline 2");
    expect(result.text).not.toContain("\u001b");
    expect(result.text).not.toContain("\r");
  });

  it("renders every explicitly selected field in a human table", async () => {
    const result = await run(
      [{ number: 4, body: "Requested body", title: "Omitted" }],
      ["--human", "--fields", "number,body"],
    );
    expect(result.text).toContain("BODY");
    expect(result.text).toContain("Requested body");
    expect(result.text).not.toContain("TITLE");
  });

  it("renders selected fields instead of an explicit human summary", async () => {
    const result = await run(
      { id: 42, partial: true },
      ["--human", "--fields", "id"],
      "Full summary",
    );
    expect(result.code).toBe(0);
    expect(result.text).toBe("id: 42\n");
    expect(result.text).not.toContain("Full summary");
    const unavailable = await run({ id: 42 }, ["--human", "--fields", "missing"], "Full summary");
    expect(unavailable.text).toBe("Full summary\n");
    expect(unavailable.warnings).toHaveLength(1);
  });

  it("propagates success exit codes in JSON and human modes", async () => {
    for (const argv of [[], ["--human"]]) {
      const result = await run({ status: "failure" }, argv, "Failed", 1);
      expect(result.code).toBe(1);
    }
    const program = new Command();
    program.command("status").action(() => returnJson({ status: "failure" }, 1));
    const output = outputBuffer();
    expect(await executeProgram(program, ["status"], output.io)).toBe(1);
    expect(JSON.parse(output.stdout.join("")).ok).toBe(true);
  });
});
