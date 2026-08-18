import { describe, expect, it } from "bun:test";

import { resolveConfigPath } from "../../../src/config/paths.js";

describe("resolveConfigPath", () => {
  it("uses an explicit absolute path, then XDG, then the home config directory", () => {
    expect(resolveConfigPath({ FORGEJO_CONFIG_PATH: "/secure/config.json" })).toBe(
      "/secure/config.json",
    );
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/config" })).toBe(
      "/config/forgejo-cli/config.json",
    );
    expect(resolveConfigPath({ HOME: "/home/agent" })).toBe(
      "/home/agent/.config/forgejo-cli/config.json",
    );
  });

  it("rejects relative and missing configuration roots", () => {
    expect(() => resolveConfigPath({ FORGEJO_CONFIG_PATH: "relative.json" })).toThrow();
    expect(() => resolveConfigPath({ XDG_CONFIG_HOME: "relative" })).toThrow();
    expect(() => resolveConfigPath({})).toThrow();
  });
});
