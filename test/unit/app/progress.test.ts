import { expect, it } from "bun:test";
import { createApplicationDependencies } from "../../../src/app/create-application.js";

it("redacts and escapes untrusted watch progress before stderr or injected output", () => {
  const lines: string[] = [];
  const dependencies = createApplicationDependencies({ progress: (text) => lines.push(text) });
  dependencies.runs.progress?.("Run: \u001b[2J\nAuthorization: token super-secret");
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("\u001b");
  expect(lines[0]).not.toContain("\n");
  expect(lines[0]).not.toContain("super-secret");
});
