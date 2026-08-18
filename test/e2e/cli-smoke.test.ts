import { describe, expect, it } from "bun:test";

type Invocation = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

async function invoke(...args: readonly string[]): Promise<Invocation> {
  const environment = Object.fromEntries(
    ["PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "LC_ALL"].flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const child = Bun.spawn(["bun", "src/bin/forgejo.ts", ...args], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return Object.freeze({ exitCode, stdout, stderr });
}

describe("forgejo CLI end-to-end smoke", () => {
  it("emits one machine-readable version document through the production entrypoint", async () => {
    const result = await invoke("--version");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      schema_version: "1",
      ok: true,
      data: { version: "0.0.1" },
    });
  });

  it("keeps help machine-readable by default through the production entrypoint", async () => {
    const result = await invoke("--help");
    const output = JSON.parse(result.stdout) as {
      schema_version: string;
      ok: boolean;
      data: { help: string };
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(output).toMatchObject({ schema_version: "1", ok: true });
    expect(output.data.help).toContain("Agent-first, JSON-first CLI for Forgejo");
  });
});
