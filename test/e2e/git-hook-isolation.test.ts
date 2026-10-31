import { expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCommandEnvironment } from "../../src/git/git-command-environment.js";

it("Git fixture tests preserve the invoking hook repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgejo-cli-hook-"));
  const env = gitCommandEnvironment(process.env);
  try {
    const initialized = Bun.spawn(["git", "init", "--quiet", directory], { env, stderr: "pipe" });
    expect(await initialized.exited).toBe(0);
    const configPath = join(directory, ".git", "config");
    const before = await readFile(configPath, "utf8");
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "test/unit/git/local-git-repository-reader.test.ts",
        "test/unit/git/local-git-branch-reader.test.ts",
      ],
      {
        env: { ...env, GIT_DIR: join(directory, ".git") },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(exitCode).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
