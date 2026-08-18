import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  BunGitCommandRunner,
  LocalGitRepositoryReader,
  type GitCommandRunner,
} from "../../../src/git/local-git-repository-reader.js";

describe("LocalGitRepositoryReader", () => {
  it("cancels and terminates local Git when config output exceeds the streaming bound", async () => {
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
    const runner = new BunGitCommandRunner({
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
        args: ["config", "--local", "--get", "remote.origin.url"],
        cwd: "/repo",
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: "Unable to inspect the local Git repository.",
    });
    expect(cancelled).toBe(true);
    expect(killed).toBe(true);
  });

  it("kills stalled local Git config inspection at its injected deadline", async () => {
    let cancelled = false;
    let killed = false;
    const stdout = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const runner = new BunGitCommandRunner({
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
        args: ["config", "--local", "--get", "remote.origin.url"],
        cwd: "/repo",
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: "Unable to inspect the local Git repository.",
    });
    expect(cancelled).toBe(true);
    expect(killed).toBe(true);
  });

  it("preserves the bounded-read failure when stream cancellation also fails", async () => {
    let killed = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100_000));
      },
      cancel() {
        throw new Error("stream cancellation failed");
      },
    });
    const runner = new BunGitCommandRunner({
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
        args: ["config", "--local", "--get", "remote.origin.url"],
        cwd: "/repo",
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: "Unable to inspect the local Git repository.",
    });
    expect(killed).toBe(true);
  });

  it("uses the production runner to read raw local config without contacting a remote", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgejo-cli-repository-"));
    try {
      const initialized = Bun.spawn(["git", "init", "--quiet", directory], { stderr: "pipe" });
      expect(await initialized.exited).toBe(0);
      const configured = Bun.spawn([
        "git",
        "-C",
        directory,
        "config",
        "--local",
        "remote.origin.url",
        "https://git.example.com/acme/widget.git",
      ]);
      expect(await configured.exited).toBe(0);

      await expect(
        new LocalGitRepositoryReader().getRemoteUrl({ cwd: directory, remote: "origin" }),
      ).resolves.toBe("https://git.example.com/acme/widget.git");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("the production runner refuses commands outside its local read-only allowlist", async () => {
    const runner = new BunGitCommandRunner();

    await expect(
      runner.run({ cwd: "/work/repository", args: ["fetch", "origin"] }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("maps production runner spawn failures to stable errors", async () => {
    const runner = new BunGitCommandRunner();

    await expect(
      runner.run({
        cwd: "/directory/that/does/not/exist/forgejo-cli",
        args: ["config", "--local", "--get", "remote.origin.url"],
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: "Unable to inspect the local Git repository.",
    });
  });

  it("reads a remote through a fixed local-only Git config command", async () => {
    const calls: Array<Readonly<{ args: readonly string[]; cwd: string }>> = [];
    const runner: GitCommandRunner = {
      async run(input) {
        calls.push(Object.freeze({ args: Object.freeze([...input.args]), cwd: input.cwd }));
        return { exitCode: 0, stdout: "https://git.example.com/acme/widget.git\n" };
      },
    };
    const reader = new LocalGitRepositoryReader(runner);

    await expect(reader.getRemoteUrl({ cwd: "/work/repository", remote: "origin" })).resolves.toBe(
      "https://git.example.com/acme/widget.git",
    );
    expect(calls).toEqual([
      {
        args: ["config", "--local", "--get", "remote.origin.url"],
        cwd: "/work/repository",
      },
    ]);
  });

  it.each(["--upload-pack=evil", "bad remote", "../origin", "remote.url"])(
    "rejects unsafe remote name %s before invoking Git",
    async (remote) => {
      let invoked = false;
      const reader = new LocalGitRepositoryReader({
        async run() {
          invoked = true;
          return { exitCode: 0, stdout: "unused" };
        },
      });

      await expect(reader.getRemoteUrl({ cwd: "/work", remote })).rejects.toMatchObject({
        code: "validation_failed",
      });
      expect(invoked).toBe(false);
    },
  );

  it("returns a stable error without exposing Git stderr", async () => {
    const reader = new LocalGitRepositoryReader({
      async run() {
        return { exitCode: 1, stdout: "" };
      },
    });

    await expect(
      reader.getRemoteUrl({ cwd: "/secret/worktree", remote: "origin" }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "validation_failed",
        message: "Unable to read the requested local Git remote.",
      }),
    );
  });

  it.each([
    "https://git.example.com/acme/widget.git\nhttps://evil.example/a/b.git",
    "https://git.example.com/acme/widget.git\u0000secret",
  ])("rejects malformed command output", async (stdout) => {
    const reader = new LocalGitRepositoryReader({
      async run() {
        return { exitCode: 0, stdout };
      },
    });

    await expect(
      reader.getRemoteUrl({ cwd: "/work/repository", remote: "origin" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("bounds local Git config output", async () => {
    const reader = new LocalGitRepositoryReader({
      async run() {
        return { exitCode: 0, stdout: `https://git.example.com/acme/${"a".repeat(8192)}` };
      },
    });

    await expect(
      reader.getRemoteUrl({ cwd: "/work/repository", remote: "origin" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
