import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, spyOn } from "bun:test";

import {
  createApplicationDependencies,
  createApplicationProgram,
} from "../../../src/app/create-application.js";
import { executeProgram } from "../../../src/cli/execute.js";

describe("application composition", () => {
  it("connects the API command to the host-bound environment account and real service bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "forgejo-composition-"));
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ version: "17.0.1-fixture" }),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const signal = new AbortController().signal;
    try {
      const program = createApplicationProgram({
        cwd: root,
        stdin: Readable.from([]),
        signal,
        environment: {
          FORGEJO_CONFIG_PATH: join(root, "config.json"),
          FORGEJO_HOST: "https://code.example.test",
          FORGEJO_TOKEN: "composition-fixture-token",
        },
      });

      const exitCode = await executeProgram(
        program,
        ["--host", "https://code.example.test", "--repo", "owner/project", "api", "version"],
        { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
      );

      expect(exitCode).toBe(0);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout.join(""))).toEqual({
        schema_version: "1",
        ok: true,
        data: { version: "17.0.1-fixture" },
      });
      expect(stderr).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(String(url)).toBe("https://code.example.test/api/v1/version");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "token composition-fixture-token",
      );
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      fetch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes sanitized progress through the default stderr output", async () => {
    const root = await mkdtemp(join(tmpdir(), "forgejo-progress-"));
    const write = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const dependencies = createApplicationDependencies({
        cwd: root,
        stdin: Readable.from([]),
        environment: { FORGEJO_CONFIG_PATH: join(root, "config.json") },
      });

      dependencies.runs.progress?.("Run\u001b[2J\nAuthorization: token fixture-secret");

      expect(write).toHaveBeenCalledTimes(1);
      const text = String(write.mock.calls[0]?.[0]);
      expect(text).toContain("Run\\u001b[2J\\u000aAuthorization: [REDACTED]");
      expect(text).not.toContain("fixture-secret");
      expect(text).not.toContain("\u001b");
      expect(text.endsWith("\n")).toBe(true);
      expect(text.trimEnd()).not.toContain("\n");
    } finally {
      write.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
