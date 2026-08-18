import type { z } from "zod";

import { CliError } from "../core/errors.js";

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("validation_failed", "Forgejo command input is invalid.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("protocol_failed", "Forgejo returned an incompatible response.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
