import { Readable } from "node:stream";

import { describe, expect, it } from "bun:test";

import { readTokenFromStream } from "../../../src/auth/token-input.js";

describe("readTokenFromStream", () => {
  it("accepts one bounded token and removes a trailing newline", async () => {
    await expect(readTokenFromStream(Readable.from(["secret-token\n"]))).resolves.toBe(
      "secret-token",
    );
  });

  it("rejects empty input, multiple lines, and oversized input", async () => {
    await expect(readTokenFromStream(Readable.from(["\n"]))).rejects.toThrow();
    await expect(readTokenFromStream(Readable.from(["one\ntwo\n"]))).rejects.toThrow();
    await expect(readTokenFromStream(Readable.from(["x".repeat(4097)]))).rejects.toThrow();
  });
});
