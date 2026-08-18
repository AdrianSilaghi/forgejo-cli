import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  BunGitBranchCommandRunner,
  LocalGitBranchReader,
  type GitBranchCommandRunner,
} from "../../../src/git/local-git-branch-reader.js";

describe("LocalGitBranchReader", () => {
  it("cancels and terminates local Git when branch output exceeds the streaming bound", async () => {
    let cancelled = false;
    let killed = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const runner = new BunGitBranchCommandRunner({
      spawn: () => ({
        exited: Promise.resolve(0),
        stdout,
        kill() {
          killed = true;
        },
      }),
    });

    await expect(
      runner.run({
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd: "/repo",
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: "Unable to inspect the local Git branch.",
    });
    expect(cancelled).toBe(true);
    expect(killed).toBe(true);
  });

  it("kills stalled local Git branch inspection at its injected deadline", async () => {
    let cancelled = false;
    let killed = false;
    const stdout = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const runner = new BunGitBranchCommandRunner({
      timeoutMs: 5,
      spawn: () => ({
        exited: new Promise<number>(() => undefined),
        stdout,
        kill() {
          killed = true;
        },
      }),
    });

    await expect(
      runner.run({
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd: "/repo",
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: "Unable to inspect the local Git branch.",
    });
    expect(cancelled).toBe(true);
    expect(killed).toBe(true);
  });

  it("uses the production runner to inspect a real local repository without contacting a remote", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgejo-cli-branch-"));
    try {
      const setup = Bun.spawn(
        ["git", "init", "--quiet", "--initial-branch", "feature/agent", directory],
        {
          stderr: "pipe",
        },
      );
      expect(await setup.exited).toBe(0);

      await expect(new LocalGitBranchReader().current(directory)).resolves.toBe("feature/agent");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a bounded current branch from a local read-only command", async () => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const runner: GitBranchCommandRunner = {
      run: async (input) => {
        calls.push(input);
        return { exitCode: 0, stdout: "feature/agent-safe\n" };
      },
    };

    await expect(new LocalGitBranchReader(runner).current("/repo")).resolves.toBe(
      "feature/agent-safe",
    );
    expect(calls).toEqual([{ args: ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd: "/repo" }]);
  });

  it("returns null for detached HEAD and rejects malformed output", async () => {
    const detached: GitBranchCommandRunner = {
      run: async () => ({ exitCode: 1, stdout: "" }),
    };
    const malformed: GitBranchCommandRunner = {
      run: async () => ({ exitCode: 0, stdout: "secret\nsecond\n" }),
    };

    await expect(new LocalGitBranchReader(detached).current("/repo")).resolves.toBeNull();
    await expect(new LocalGitBranchReader(malformed).current("/repo")).rejects.toThrow();
  });

  it("returns null outside a Git worktree so explicit repository commands still work", async () => {
    const outsideRepository: GitBranchCommandRunner = {
      run: async () => ({ exitCode: 128, stdout: "" }),
    };

    await expect(
      new LocalGitBranchReader(outsideRepository).current("/workspace"),
    ).resolves.toBeNull();
  });

  for (const [label, cwd] of [
    ["empty", ""],
    ["leading whitespace", " /repo"],
    ["control character", "/repo\u0000secret"],
    ["oversized", "a".repeat(4097)],
  ] as const) {
    it(`rejects invalid working directory ${label} before invoking Git`, async () => {
      let invoked = false;
      const reader = new LocalGitBranchReader({
        async run() {
          invoked = true;
          return { exitCode: 0, stdout: "main\n" };
        },
      });

      await expect(reader.current(cwd)).rejects.toMatchObject({ code: "validation_failed" });
      expect(invoked).toBe(false);
    });
  }

  for (const [label, stdout] of [
    ["empty", ""],
    ["leading whitespace", " main"],
    ["oversized", `${"a".repeat(1025)}\n`],
    ["control character", "main\u0000secret"],
  ] as const) {
    it(`rejects ${label} branch output without exposing it`, async () => {
      const reader = new LocalGitBranchReader({
        async run() {
          return { exitCode: 0, stdout };
        },
      });

      await expect(reader.current("/repo")).rejects.toMatchObject({ code: "validation_failed" });
    });
  }
});
