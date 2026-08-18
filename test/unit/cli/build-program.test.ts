import { describe, expect, it } from "bun:test";
import { type BuildProgramDependencies, buildProgram } from "../../../src/cli/build-program.js";
import type { AuthCommandRuntime } from "../../../src/cli/command-runtime.js";
import { executeProgram } from "../../../src/cli/execute.js";

type AuthCall =
  | Readonly<{ command: "login"; input: Readonly<{ host: string; token: string }> }>
  | Readonly<{ command: "status"; input: Readonly<{ host?: string }> }>
  | Readonly<{
      command: "logout";
      input: Readonly<{ host: string; username?: string }>;
    }>;

function buildAuthProgram(
  calls: AuthCall[],
  tokenReads: Array<Readonly<{ pipedOnly: boolean }>> = [],
) {
  const auth = {
    readToken: async (options: Readonly<{ pipedOnly: boolean }>) => {
      tokenReads.push(options);
      return "fixture";
    },
    login: async (input) => {
      calls.push({ command: "login", input });
      return {
        origin: input.host,
        user: { id: 1, login: "agent", name: null },
      };
    },
    list: async () => [],
    status: async (input) => {
      calls.push({ command: "status", input });
      return { authenticated: true };
    },
    logout: async (input) => {
      calls.push({ command: "logout", input });
      return { loggedOut: true };
    },
  } satisfies AuthCommandRuntime;

  return buildProgram({
    auth,
    repository: {} as BuildProgramDependencies["repository"],
    pullRequests: {} as BuildProgramDependencies["pullRequests"],
    issues: {} as BuildProgramDependencies["issues"],
    labels: {} as BuildProgramDependencies["labels"],
    milestones: {} as BuildProgramDependencies["milestones"],
    releases: {} as BuildProgramDependencies["releases"],
  });
}

function outputBuffer() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

describe("buildProgram", () => {
  it("exposes the complete agent-first command surface", () => {
    const program = buildProgram({} as BuildProgramDependencies);

    expect(program.commands.map((command) => command.name())).toEqual([
      "auth",
      "repo",
      "pr",
      "issue",
      "label",
      "milestone",
      "release",
    ]);
    expect(
      program.commands
        .find((command) => command.name() === "release")
        ?.commands.map((command) => command.name()),
    ).toEqual(["list", "view", "create", "edit", "delete", "upload"]);
    expect(program.options.map((option) => option.long)).toEqual([
      "--version",
      "--host",
      "--repo",
      "--remote",
      "--account",
      "--human",
    ]);
  });

  it("accepts auth login without requiring the piped-token compatibility flag", async () => {
    const calls: AuthCall[] = [];
    const tokenReads: Array<Readonly<{ pipedOnly: boolean }>> = [];
    const program = buildAuthProgram(calls, tokenReads);
    const output = outputBuffer();

    const exitCode = await executeProgram(
      program,
      ["auth", "login", "--host", "https://code.example.test"],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(tokenReads).toEqual([{ pipedOnly: false }]);
    expect(calls).toEqual([
      {
        command: "login",
        input: { host: "https://code.example.test", token: "fixture" },
      },
    ]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({ ok: true });
    expect(output.stderr).toEqual([]);
  });

  it("forwards the nested auth status host when the root command also defines host", async () => {
    const calls: AuthCall[] = [];
    const program = buildAuthProgram(calls);
    const output = outputBuffer();

    const exitCode = await executeProgram(
      program,
      ["auth", "status", "--host", "https://code.example.test"],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ command: "status", input: { host: "https://code.example.test" } }]);
    expect(output.stderr).toEqual([]);
  });

  it("forwards the nested auth logout host when the root command also defines host", async () => {
    const calls: AuthCall[] = [];
    const program = buildAuthProgram(calls);
    const output = outputBuffer();

    const exitCode = await executeProgram(
      program,
      ["auth", "logout", "--host", "https://code.example.test", "--user", "agent"],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        command: "logout",
        input: { host: "https://code.example.test", username: "agent" },
      },
    ]);
    expect(output.stderr).toEqual([]);
  });

  it("rejects a missing auth login host before consuming stdin", async () => {
    const calls: AuthCall[] = [];
    const tokenReads: Array<Readonly<{ pipedOnly: boolean }>> = [];
    const program = buildAuthProgram(calls, tokenReads);
    const output = outputBuffer();

    const exitCode = await executeProgram(program, ["auth", "login"], output.io);

    expect(exitCode).toBe(2);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      schema_version: "1",
      ok: false,
      error: {
        code: "validation_failed",
        message: expect.stringContaining("host"),
        retryable: false,
      },
    });
    expect(output.stderr).toEqual([]);
    expect(tokenReads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("rejects an insecure auth login host before reading a token", async () => {
    const calls: AuthCall[] = [];
    const tokenReads: Array<Readonly<{ pipedOnly: boolean }>> = [];
    const program = buildAuthProgram(calls, tokenReads);
    const output = outputBuffer();

    const exitCode = await executeProgram(
      program,
      ["auth", "login", "--host", "http://code.example.test"],
      output.io,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      schema_version: "1",
      ok: false,
      error: { code: "validation_failed", retryable: false },
    });
    expect(output.stderr).toEqual([]);
    expect(tokenReads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("keeps the explicit piped-token flag compatible", async () => {
    const calls: AuthCall[] = [];
    const tokenReads: Array<Readonly<{ pipedOnly: boolean }>> = [];
    const program = buildAuthProgram(calls, tokenReads);
    const output = outputBuffer();

    const exitCode = await executeProgram(
      program,
      ["auth", "login", "--host", "https://code.example.test", "--with-token"],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(tokenReads).toEqual([{ pipedOnly: true }]);
    expect(calls).toEqual([
      {
        command: "login",
        input: { host: "https://code.example.test", token: "fixture" },
      },
    ]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({ ok: true });
    expect(output.stderr).toEqual([]);
  });

  it("serializes a nested parser failure as one JSON document", async () => {
    const calls: AuthCall[] = [];
    const tokenReads: Array<Readonly<{ pipedOnly: boolean }>> = [];
    const program = buildAuthProgram(calls, tokenReads);
    const output = outputBuffer();

    const exitCode = await executeProgram(
      program,
      ["auth", "login", "--host", "https://code.example.test", "--unknown-option"],
      output.io,
    );

    expect(exitCode).toBe(2);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      schema_version: "1",
      ok: false,
      error: {
        code: "validation_failed",
        message: expect.stringContaining("unknown option '--unknown-option'"),
        retryable: false,
      },
    });
    expect(output.stderr).toEqual([]);
    expect(tokenReads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([[["help", "auth"]], [["auth", "help", "login"]]] as const)(
    "serializes explicit nested help as one JSON success document",
    async (args) => {
      const program = buildAuthProgram([]);
      const output = outputBuffer();

      const exitCode = await executeProgram(program, args, output.io);

      expect(exitCode).toBe(0);
      expect(output.stdout).toHaveLength(1);
      expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
        schema_version: "1",
        ok: true,
        data: { help: expect.stringContaining("Usage: forgejo auth") },
      });
      expect(output.stderr).toEqual([]);
    },
  );
});
