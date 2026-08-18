import { describe, expect, it } from "bun:test";

import { normalizeOrigin } from "../../../src/http/origin.js";

describe("normalizeOrigin", () => {
  it.each([
    ["https://GIT.Example.com", "https://git.example.com"],
    ["https://git.example.com:443", "https://git.example.com"],
    ["https://git.example.com:8443/", "https://git.example.com:8443"],
    ["https://bücher.example", "https://xn--bcher-kva.example"],
    ["https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it("allows loopback HTTP only when explicitly enabled", () => {
    expect(() => normalizeOrigin("http://127.0.0.1:3000")).toThrow();
    expect(normalizeOrigin("http://127.0.0.1:3000", { allowInsecureLocalhost: true })).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it.each([
    "http://git.example.com",
    "https://user@git.example.com",
    "https://git.example.com./",
    "https://git.example.com/path",
    "https://git.example.com?token=secret",
    "https://git.example.com/#fragment",
  ])("rejects unsafe origin %s", (origin) => {
    expect(() => normalizeOrigin(origin)).toThrow();
  });
});
