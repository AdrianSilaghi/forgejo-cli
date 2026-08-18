import { describe, expect, it } from "bun:test";

import { gitCommandEnvironment } from "../../../src/git/git-command-environment.js";

describe("gitCommandEnvironment", () => {
  it("does not forward tokens or unrelated process environment", () => {
    expect(
      gitCommandEnvironment({
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        FORGEJO_TOKEN: "secret",
        UNRELATED_SECRET: "secret",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });
});
