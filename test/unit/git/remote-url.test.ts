import { describe, expect, it } from "bun:test";

import { parseGitRemote } from "../../../src/git/remote-url.js";

describe("parseGitRemote", () => {
  it.each([
    ["https://git.example.com/acme/widget.git", "git.example.com", "acme", "widget"],
    ["ssh://git@git.example.com/acme/widget.git", "git.example.com", "acme", "widget"],
    ["git@git.example.com:acme/widget.git", "git.example.com", "acme", "widget"],
    ["ssh://git@[2001:db8::1]/acme/widget.git", "[2001:db8::1]", "acme", "widget"],
  ])("parses %s", (remote, host, owner, repository) => {
    expect(parseGitRemote(remote)).toEqual({ host, owner, repository });
  });

  it.each([
    "https://user:secret@git.example.com/acme/widget.git",
    "https://git.example.com./acme/widget.git",
    "https://git.example.com/acme/../admin.git",
    "https://git.example.com/acme%2Fadmin/widget.git",
    "https://git.example.com/acme/widget.git?token=secret",
    "https://git.example.com/acme/widget.git#fragment",
    "git@git.example.com:acme/widget/extra.git",
    "file:///tmp/widget",
  ])("rejects hostile or ambiguous remote %s", (remote) => {
    expect(() => parseGitRemote(remote)).toThrow();
  });
});
