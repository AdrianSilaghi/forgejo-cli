import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { executeProgram } from "../../../src/cli/execute.js";
import { registerApiCommands } from "../../../src/commands/api-commands.js";
import type { ApiOperations } from "../../../src/forgejo/api-service.js";

async function run(argv: readonly string[], api: ApiOperations) {
  let output = "";
  const program = new Command().name("forgejo").option("--human");
  registerApiCommands(program, {
    resolve: async () => ({
      origin: "https://code.example.test",
      repository: { owner: "octo", repository: "app" },
      localBranch: null,
      services: { api },
    }),
  });
  const code = await executeProgram(program, argv, {
    stdout: (value) => {
      output += value;
    },
    stderr: () => undefined,
  });
  return { code, result: JSON.parse(output) };
}
describe("api commands", () => {
  it("returns a GET response in the JSON envelope with repeated query options", async () => {
    const calls: unknown[] = [];
    const result = await run(["api", "/user", "--query", "a=b", "--query", "a=c"], {
      get: async (...args) => {
        calls.push(args);
        return { login: "octo" };
      },
    });
    expect(result.code).toBe(0);
    expect(result.result.data).toEqual({ login: "octo" });
    expect(calls).toEqual([["/user", ["a=b", "a=c"]]]);
  });
  it("passes explicitly selected page and limit on a single request", async () => {
    const calls: unknown[] = [];
    const result = await run(["api", "repos/octo/app/issues", "--page", "2", "--limit", "1"], {
      get: async (_endpoint, query) => {
        calls.push(query);
        return [];
      },
    });
    expect(result.code).toBe(0);
    expect(calls).toEqual([["page=2", "limit=1"]]);
  });
  it("uses bounded existing pagination and emits its metadata", async () => {
    const calls: unknown[] = [];
    const result = await run(
      ["api", "repos/octo/app/issues", "--paginate", "--max-items", "3", "--limit", "2"],
      {
        get: async (_endpoint, query) => {
          calls.push(query);
          return query?.includes("page=3") ? [] : [1, 2];
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.result.data.items).toEqual([1, 2, 1]);
    expect(result.result.data.pagination.truncated).toBe(true);
    expect(calls).toEqual([
      ["page=1", "limit=2"],
      ["page=2", "limit=2"],
    ]);
  });
  it("retrieves all capped API pages before reporting exhaustion", async () => {
    const calls: unknown[] = [];
    const result = await run(
      ["api", "repos/octo/app/issues", "--paginate", "--max-items", "10", "--limit", "100"],
      {
        get: async (_endpoint, query) => {
          calls.push(query);
          return query?.includes("page=1") ? [1, 2] : query?.includes("page=2") ? [3] : [];
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.result.data.items).toEqual([1, 2, 3]);
    expect(result.result.data.pagination).toMatchObject({ hasNextPage: false, truncated: false });
    expect(calls).toEqual([
      ["page=1", "limit=100"],
      ["page=2", "limit=100"],
      ["page=3", "limit=100"],
    ]);
  });
  it("rejects pagination without a bound, object pagination, conflicting paging queries and unsupported writes", async () => {
    for (const argv of [
      ["api", "user", "--paginate"],
      ["api", "user", "--method", "POST"],
      ["api", "user", "--paginate", "--max-items", "2", "--query", "page=2"],
      ["api", "user", "--paginate", "--max-items", "2"],
    ]) {
      const result = await run(argv, { get: async () => ({ login: "octo" }) });
      expect(result.code).not.toBe(0);
    }
  });
});
