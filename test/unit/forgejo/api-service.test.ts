import { describe, expect, it } from "bun:test";
import { ApiService } from "../../../src/forgejo/api-service.js";
import type { ForgejoRequest } from "../../../src/http/forgejo-api.js";

describe("generic GET API", () => {
  it("normalizes API-relative paths, keeps repeated query values, uses only GET and redacts", async () => {
    const requests: ForgejoRequest[] = [];
    const service = new ApiService({
      request: async (request) => {
        requests.push(request);
        return {
          token: "secret",
          nested: [{ password: "hidden", name: "ok" }],
          url: "https://user:pass@example.test/a",
        };
      },
    });
    const result = await service.get("/api/v1/repos/octo/app", [
      "state=open",
      "label=a=b",
      "label=two",
    ]);
    expect(requests).toEqual([
      {
        method: "GET",
        path: ["repos", "octo", "app"],
        query: { state: "open", label: ["a=b", "two"] },
      },
    ]);
    expect(result).toEqual({
      token: "[REDACTED]",
      nested: [{ password: "[REDACTED]", name: "ok" }],
      url: "https://[REDACTED]@example.test/a",
    });
  });
  it("accepts leading slash or bare paths and preserves JSON primitives", async () => {
    for (const endpoint of ["repos/octo/app", "/repos/octo/app", "api/v1/repos/octo/app"]) {
      expect(await new ApiService({ request: async () => null }).get(endpoint)).toBeNull();
    }
  });
  it("preserves valid JSON scalars and arrays and treats prototype names as plain query keys", async () => {
    const requests: ForgejoRequest[] = [];
    const values = [true, false, 42, "text", [null, 1, { valid: true }]];
    for (const response of values) {
      const service = new ApiService({
        request: async (request) => {
          requests.push(request);
          return response;
        },
      });
      expect(
        await service.get("repos/octo/app", ["__proto__=one", "__proto__=two", "empty="]),
      ).toEqual(response);
    }
    expect(Object.entries(requests[0]?.query ?? {})).toContainEqual(["__proto__", ["one", "two"]]);
  });
  it("rejects unsafe endpoints before transport", async () => {
    let calls = 0;
    const service = new ApiService({
      request: async () => {
        calls++;
        return {};
      },
    });
    for (const endpoint of [
      "",
      "/",
      "https://evil.test/a",
      "//evil.test/a",
      "user@host/repos",
      "repos/../user",
      "repos/./app",
      "repos/%2e%2e/user",
      "repos/%252e%252e/user",
      "repos/a%2fb",
      "repos/a%5cb",
      "repos/a\\b",
      "repos//app",
      "repos/a?x=1",
      "repos/a#x",
      "repos/%zz",
      "repos/%00",
      " repos/a",
      "repos/a\n",
    ]) {
      await expect(service.get(endpoint)).rejects.toMatchObject({ code: "validation_failed" });
    }
    expect(calls).toBe(0);
  });
  it("rejects malformed, unsafe or unbounded queries without transport", async () => {
    let calls = 0;
    const service = new ApiService({
      request: async () => {
        calls++;
        return {};
      },
    });
    for (const query of [
      ["noequals"],
      ["=empty"],
      ["bad\n=value"],
      ["_method=DELETE"],
      Array.from({ length: 101 }, () => "a=b"),
      [`a=${"x".repeat(8193)}`],
    ]) {
      await expect(service.get("user", query)).rejects.toMatchObject({ code: "validation_failed" });
    }
    expect(calls).toBe(0);
  });
  it("rejects invalid, cyclic, too deep, or oversized response JSON", async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let deep: unknown = null;
    for (let i = 0; i < 40; i++) deep = [deep];
    for (const response of [
      undefined,
      Number.NaN,
      1n,
      new Date(),
      { bad: undefined },
      cyclic,
      deep,
      Array.from({ length: 100_001 }, () => 0),
      "x".repeat(8 * 1024 * 1024 + 1),
    ]) {
      await expect(
        new ApiService({ request: async () => response }).get("user"),
      ).rejects.toMatchObject({ code: "protocol_failed" });
    }
  });
});
