import { describe, expect, it } from "bun:test";

import { runApplication } from "../../../src/app/run-application.js";
import { CliError } from "../../../src/core/errors.js";

describe("runApplication", () => {
  it("serializes composition failures instead of leaking an unhandled stack", async () => {
    const stdout: string[] = [];

    const exitCode = await runApplication({
      argv: [],
      programFactory: () => {
        throw new CliError("config_failed", "Configuration unavailable.");
      },
      io: { stdout: (value) => stdout.push(value), stderr: () => undefined },
    });

    expect(exitCode).toBe(9);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      error: { code: "config_failed", message: "Configuration unavailable." },
    });
  });
});
