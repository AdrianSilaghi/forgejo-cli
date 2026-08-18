import { describe, expect, it } from "bun:test";

import {
  createCredentialHelperRunner,
  credentialHelperEnvironment,
  PlatformCredentialStore,
  type CredentialHelperRunner,
} from "../../../src/auth/platform-credential-store.js";

describe("PlatformCredentialStore", () => {
  it("cancels and terminates a credential helper whose stdout exceeds the fixed bound", async () => {
    let cancelled = false;
    let killed = false;
    let stderrMode: string | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const runner = createCredentialHelperRunner({
      spawn: (_args, options) => {
        stderrMode = options.stderr;
        return {
          exited: Promise.resolve(0),
          stdout,
          kill() {
            killed = true;
          },
        };
      },
    });
    const store = new PlatformCredentialStore({ platform: "linux", runner });

    await expect(
      store.get({ origin: "https://git.example.com", username: "agent" }),
    ).rejects.toMatchObject({ code: "credential_store_unavailable" });
    expect(cancelled).toBe(true);
    expect(killed).toBe(true);
    expect(stderrMode).toBe("ignore");
  });

  it("kills a stalled credential helper at its injected deadline", async () => {
    let cancelled = false;
    let killed = false;
    const stdout = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const runner = createCredentialHelperRunner({
      timeoutMs: 5,
      spawn: () => ({
        exited: new Promise<number>(() => undefined),
        stdout,
        kill() {
          killed = true;
        },
      }),
    });
    const store = new PlatformCredentialStore({ platform: "linux", runner });

    await expect(
      store.get({ origin: "https://git.example.com", username: "agent" }),
    ).rejects.toMatchObject({
      code: "credential_store_unavailable",
      message: "The operating-system credential store is unavailable.",
    });
    expect(cancelled).toBe(true);
    expect(killed).toBe(true);
  });

  it("passes only the minimum non-secret environment to credential helpers", () => {
    expect(
      credentialHelperEnvironment({
        PATH: "/usr/bin",
        HOME: "/home/agent",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        FORGEJO_TOKEN: "must-not-cross-process-boundary",
        UNRELATED_SECRET: "must-not-cross-process-boundary",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("pipes credentials to the macOS helper without placing the token in argv", async () => {
    const calls: Array<{ args: readonly string[]; input: string }> = [];
    const runner: CredentialHelperRunner = async (args, input) => {
      calls.push({ args, input });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const store = new PlatformCredentialStore({ platform: "darwin", runner });

    await store.set({ origin: "https://git.example.com:8443", username: "agent" }, "secret-token");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["git", "credential-osxkeychain", "store"]);
    expect(calls[0]?.args.join(" ")).not.toContain("secret-token");
    expect(calls[0]?.input).toContain("password=secret-token\n");
    expect(calls[0]?.input).toContain("host=git.example.com:8443\n");
    expect(calls[0]?.input).toContain("path=forgejo-cli\n");
  });

  it("reads and deletes only the exact origin and username tuple", async () => {
    const calls: Array<{ args: readonly string[]; input: string }> = [];
    const runner: CredentialHelperRunner = async (args, input) => {
      calls.push({ args, input });
      return {
        exitCode: 0,
        stdout: args.at(-1) === "get" ? "username=agent\npassword=stored-token\n" : "",
        stderr: "",
      };
    };
    const store = new PlatformCredentialStore({ platform: "linux", runner });
    const key = { origin: "https://git.example.com", username: "agent" } as const;

    await expect(store.get(key)).resolves.toBe("stored-token");
    await store.delete(key);

    expect(calls.map((call) => call.args)).toEqual([
      ["git", "credential-libsecret", "get"],
      ["git", "credential-libsecret", "erase"],
    ]);
    expect(calls.every((call) => call.input.includes("username=agent\n"))).toBe(true);
  });

  it("fails closed when no supported secure credential helper exists", () => {
    expect(() => new PlatformCredentialStore({ platform: "win32" })).toThrow(
      expect.objectContaining({ code: "credential_store_unavailable" }),
    );
  });

  it("returns null when the helper has no password for the exact tuple", async () => {
    const store = new PlatformCredentialStore({
      platform: "linux",
      runner: async () => ({ exitCode: 0, stdout: "username=agent\n", stderr: "" }),
    });

    await expect(
      store.get({ origin: "https://git.example.com", username: "agent" }),
    ).resolves.toBeNull();
  });

  it("returns a generic error without exposing helper diagnostics", async () => {
    const store = new PlatformCredentialStore({
      platform: "linux",
      runner: async () => ({
        exitCode: 1,
        stdout: "password=secret-token\n",
        stderr: "helper failed with secret-token",
      }),
    });

    try {
      await store.get({ origin: "https://git.example.com", username: "agent" });
      throw new Error("Expected the credential helper to fail.");
    } catch (error) {
      expect(error).toMatchObject({ code: "credential_store_unavailable" });
      expect(String(error)).not.toContain("secret-token");
    }
  });

  it.each([
    { username: "", token: "token" },
    { username: "agent\ninjected", token: "token" },
    { username: "agent", token: "" },
    { username: "agent", token: "x\nbad" },
  ])("rejects credential-protocol injection before invoking the helper", async (input) => {
    let invoked = false;
    const store = new PlatformCredentialStore({
      platform: "darwin",
      runner: async () => {
        invoked = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await expect(
      store.set({ origin: "https://git.example.com", username: input.username }, input.token),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(invoked).toBe(false);
  });
});
