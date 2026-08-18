import { describe, expect, it } from "bun:test";

import { buildProgram, type BuildProgramDependencies } from "../../../src/cli/build-program.js";

describe("buildProgram", () => {
  it("exposes the complete agent-first command surface", () => {
    const program = buildProgram({} as BuildProgramDependencies);

    expect(program.commands.map((command) => command.name())).toEqual([
      "auth",
      "repo",
      "pr",
      "issue",
      "label",
      "milestone",
      "release",
    ]);
    expect(
      program.commands
        .find((command) => command.name() === "release")
        ?.commands.map((command) => command.name()),
    ).toEqual(["list", "view", "create", "edit", "delete", "upload"]);
    expect(program.options.map((option) => option.long)).toEqual([
      "--version",
      "--host",
      "--repo",
      "--remote",
      "--account",
      "--human",
    ]);
  });
});
