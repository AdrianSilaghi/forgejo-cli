import { describe, expect, it } from "bun:test";

import {
  compactDefined,
  parseBoolean,
  parseCsv,
  parsePositiveInteger,
  parseRepositorySlug,
} from "../../../src/cli/command-options.js";

describe("command option parsing", () => {
  it("parses an explicit owner/repository without accepting ambiguous paths", () => {
    expect(parseRepositorySlug("owner/project")).toEqual({ owner: "owner", repository: "project" });
    expect(() => parseRepositorySlug("owner/group/project")).toThrow();
    expect(() => parseRepositorySlug("../project")).toThrow();
  });

  it("parses positive safe integers", () => {
    expect(parsePositiveInteger("42", "issue number")).toBe(42);
    expect(() => parsePositiveInteger("0", "issue number")).toThrow();
    expect(() => parsePositiveInteger("1.5", "issue number")).toThrow();
  });

  it("parses deterministic booleans and CSV lists", () => {
    expect(parseBoolean("true", "draft")).toBe(true);
    expect(parseBoolean("false", "draft")).toBe(false);
    expect(() => parseBoolean("yes", "draft")).toThrow();
    expect(parseCsv("one,two,three")).toEqual(["one", "two", "three"]);
    expect(() => parseCsv("one,,two")).toThrow();
  });

  it("creates a new object containing only defined values", () => {
    const input = Object.freeze({ state: "open", page: undefined, limit: 20 });
    expect(compactDefined(input)).toEqual({ state: "open", limit: 20 });
    expect(input).toEqual({ state: "open", page: undefined, limit: 20 });
  });
});
