import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { executeProgram } from "../../../src/cli/execute.js";
import {
  generateCompletion,
  registerCompletionCommands,
} from "../../../src/commands/completion-commands.js";

function program() {
  const root = new Command().name("forgejo").option("--human").option("-R, --repo <slug>");
  root.command("pr").command("view <id>").option("--comments");
  root.command("api <endpoint>").option("--query <pair>");
  registerCompletionCommands(root);
  return root;
}
describe("static completion", () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    it(`generates ${shell} from all commands/flags for both executable names`, () => {
      const script = generateCompletion(program(), shell);
      for (const word of [
        "forgejo",
        "forgejo-cli",
        "pr",
        "view",
        "api",
        ...(shell === "fish"
          ? ["comments", "query", "repo", "human"]
          : ["--comments", "--query", "--repo", "-R", "--human"]),
        "completion",
        shell === "fish" ? "help" : "--help",
      ])
        expect(script).toContain(word);
      expect(script).not.toContain("eval");
      expect(script).not.toContain("$(${ ");
    });
  }
  for (const shell of ["bash", "zsh"]) {
    it(`passes ${shell} syntax validation`, () => {
      const checked = spawnSync(shell, ["-n"], {
        input: generateCompletion(program(), shell),
        encoding: "utf8",
      });
      expect(checked.stderr).toBe("");
      expect(checked.status).toBe(0);
    });
  }
  it("returns one JSON document by default and raw script with --human", async () => {
    for (const human of [false, true]) {
      let output = "";
      const code = await executeProgram(
        program(),
        [...(human ? ["--human"] : []), "completion", "bash"],
        {
          stdout: (value) => {
            output += value;
          },
          stderr: () => undefined,
        },
      );
      expect(code).toBe(0);
      if (human) expect(output).toStartWith("#");
      else expect(JSON.parse(output).data.script).toContain("forgejo-cli");
    }
  });
  it("rejects unsupported shells and unsafe metadata", () => {
    expect(() => generateCompletion(program(), "powershell")).toThrow();
    const unsafe = program();
    unsafe.command("bad;touch-pwn");
    expect(() => generateCompletion(unsafe, "bash")).toThrow();
  });
});
