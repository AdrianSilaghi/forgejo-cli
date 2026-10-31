import { Readable } from "node:stream";

import { describe, expect, it } from "bun:test";

import { readContentInput } from "../../../src/cli/content-input.js";

describe("readContentInput", () => {
  it("returns direct content without mutating the input", async () => {
    const input = Object.freeze({ body: "agent-ready" });

    await expect(readContentInput(input, Readable.from([]))).resolves.toBe("agent-ready");
    expect(input).toEqual({ body: "agent-ready" });
  });

  it("reads bounded UTF-8 content from stdin", async () => {
    await expect(
      readContentInput({ bodyStdin: true }, Readable.from(["first", "\nsecond"])),
    ).resolves.toBe("first\nsecond");
  });

  it("uses --body-file - as stdin without changing whitespace or Unicode", async () => {
    const body = "first\r\n\tșță 日本語\nlast\n";
    await expect(
      readContentInput({ bodyFile: "-" }, Readable.from([Buffer.from(body)])),
    ).resolves.toBe(body);
  });

  it("applies the same bounds and conflicts to --body-file -", async () => {
    await expect(
      readContentInput({ bodyFile: "-" }, Readable.from(["ééé"]), { maxBytes: 5 }),
    ).rejects.toThrow("limit");
    await expect(
      readContentInput({ bodyFile: "-", bodyStdin: true }, Readable.from([])),
    ).rejects.toThrow("Exactly one");
    await expect(
      readContentInput({ bodyFile: "-", body: "body" }, Readable.from([])),
    ).rejects.toThrow("Exactly one");
  });

  it("rejects missing and mutually exclusive sources", async () => {
    await expect(readContentInput({}, Readable.from([]))).rejects.toThrow();
    await expect(
      readContentInput({ body: "one", bodyStdin: true }, Readable.from(["two"])),
    ).rejects.toThrow();
  });

  it("rejects input above the configured byte limit", async () => {
    await expect(
      readContentInput({ bodyStdin: true }, Readable.from(["x".repeat(9)]), { maxBytes: 8 }),
    ).rejects.toThrow();
  });
});
