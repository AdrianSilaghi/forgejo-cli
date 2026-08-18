import { Readable } from "node:stream";

import { describe, expect, it } from "bun:test";
import { Command } from "commander";

import type { AuthCommandRuntime } from "../../../src/cli/command-runtime.js";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerAuthCommands } from "../../../src/commands/auth-commands.js";

describe("auth commands", () => {
  it("accepts a personal access token only through stdin", async () => {
    let loginInput: { host: string; token: string } | undefined;
    const runtime = {
      stdin: Readable.from(["fixture\n"]),
      login: async (input) => {
        loginInput = input;
        return { origin: input.host, user: { id: 1, login: "agent", name: null } };
      },
      list: async () => [],
      status: async () => ({}),
      logout: async () => ({}),
    } satisfies AuthCommandRuntime;
    const program = new Command().name("forgejo");
    registerAuthCommands(program, runtime);
    const stdout: string[] = [];

    const exitCode = await executeProgram(
      program,
      ["auth", "login", "--host", "https://code.example.test", "--with-token"],
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(loginInput).toEqual({
      host: "https://code.example.test",
      token: "fixture",
    });
    expect(stdout.join("")).not.toContain("fixture");
  });

  it("does not expose a token-valued command option", () => {
    const runtime = {
      stdin: Readable.from([]),
      login: async () => ({
        origin: "https://code.example.test",
        user: { id: 1, login: "agent", name: null },
      }),
      list: async () => [],
      status: async () => ({}),
      logout: async () => ({}),
    } satisfies AuthCommandRuntime;
    const program = new Command().name("forgejo");

    registerAuthCommands(program, runtime);

    const login = program.commands.find((command) => command.name() === "auth")?.commands[0];
    expect(login?.options.some((option) => option.flags.includes("token <"))).toBe(false);
  });

  it("passes structured status, list, and logout inputs to the runtime", async () => {
    const calls: unknown[] = [];
    const runtime = {
      stdin: Readable.from([]),
      login: async () => ({
        origin: "https://code.example.test",
        user: { id: 1, login: "agent", name: null },
      }),
      status: async (input) => {
        calls.push({ status: input });
        return { accounts: [] };
      },
      list: async () => {
        calls.push({ list: true });
        return [];
      },
      logout: async (input) => {
        calls.push({ logout: input });
        return { loggedOut: true };
      },
    } satisfies AuthCommandRuntime;

    const invoke = async (args: readonly string[]) => {
      const program = new Command().name("forgejo");
      registerAuthCommands(program, runtime);
      const stdout: string[] = [];
      const exitCode = await executeProgram(program, args, {
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toHaveLength(1);
    };

    await invoke(["auth", "status"]);
    await invoke(["auth", "status", "--host", "https://code.example.test"]);
    await invoke(["auth", "list"]);
    await invoke(["auth", "logout", "--host", "https://code.example.test"]);
    await invoke(["auth", "logout", "--host", "https://code.example.test", "--user", "agent"]);

    expect(calls).toEqual([
      { status: {} },
      { status: { host: "https://code.example.test" } },
      { list: true },
      { logout: { host: "https://code.example.test" } },
      { logout: { host: "https://code.example.test", username: "agent" } },
    ]);
  });
});
