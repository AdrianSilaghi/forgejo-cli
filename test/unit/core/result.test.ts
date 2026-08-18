import { describe, expect, it } from "bun:test";

import { failure, success } from "../../../src/core/result.js";

describe("result envelopes", () => {
  it("emits a versioned success envelope", () => {
    expect(success({ number: 42 })).toEqual({
      schema_version: "1",
      ok: true,
      data: { number: 42 },
    });
  });

  it("emits a redacted versioned failure envelope", () => {
    expect(
      failure({
        code: "not_authenticated",
        message: "Authorization: token super-secret",
        retryable: false,
        details: { token: "private", host: "git.example.com" },
      }),
    ).toEqual({
      schema_version: "1",
      ok: false,
      error: {
        code: "not_authenticated",
        message: "Authorization: [REDACTED]",
        retryable: false,
        details: { token: "[REDACTED]", host: "git.example.com" },
      },
    });
  });

  it("redacts credentials nested inside arrays and URLs", () => {
    expect(
      failure({
        code: "protocol_failed",
        message: "Forgejo response validation failed.",
        retryable: false,
        details: {
          context: [
            "Authorization: Bearer nested-secret",
            "https://agent:password@git.example.com/acme/widget",
            { api_key: "secret-key" },
          ],
        },
      }),
    ).toMatchObject({
      error: {
        details: {
          context: [
            "Authorization: [REDACTED]",
            "https://[REDACTED]@git.example.com/acme/widget",
            { api_key: "[REDACTED]" },
          ],
        },
      },
    });
  });
});
