import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

async function invoke(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, "src/bin/forgejo.ts", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("complete workflow command surface", () => {
  it("exposes the PR lifecycle and checks through the production composition", async () => {
    const result = await invoke(["pr", "--help"]);
    expect(result.exitCode).toBe(0);
    const { data } = JSON.parse(result.stdout);
    for (const name of ["edit", "diff", "close", "reopen", "merge", "checks"]) {
      expect(data.help).toContain(name);
    }
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("registers field selection, API access, completion and run watch", async () => {
    const root = await invoke(["--help"]);
    const run = await invoke(["run", "--help"]);
    expect(root.exitCode).toBe(0);
    for (const name of ["--fields", "api", "completion"]) {
      expect(JSON.parse(root.stdout).data.help).toContain(name);
    }
    expect(JSON.parse(run.stdout).data.help).toContain("watch");
  });

  it("generates shell completion without authentication", async () => {
    const result = await invoke(["--human", "completion", "bash"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("forgejo-cli");
    expect(result.stdout).toContain("--fields");
  });

  it("ships an unambiguous executable alongside the existing executable", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    expect(manifest.bin["forgejo-cli"]).toBe("dist/bin/forgejo.js");
    expect(manifest.bin.forgejo).toBe("dist/bin/forgejo.js");
  });
});
