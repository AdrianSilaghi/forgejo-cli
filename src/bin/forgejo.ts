#!/usr/bin/env bun

import { createApplicationProgram } from "../app/create-application.js";
import { runApplication } from "../app/run-application.js";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  process.exitCode = await runApplication({
    argv: process.argv.slice(2),
    programFactory: () => createApplicationProgram({ signal: controller.signal }),
    io: {
      stdout: (value) => process.stdout.write(value),
      stderr: (value) => process.stderr.write(value),
    },
  });
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
