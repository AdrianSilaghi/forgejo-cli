#!/usr/bin/env bun

import { createApplicationProgram } from "../app/create-application.js";
import { runApplication } from "../app/run-application.js";

const exitCode = await runApplication({
  argv: process.argv.slice(2),
  programFactory: createApplicationProgram,
  io: {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
});

process.exitCode = exitCode;
