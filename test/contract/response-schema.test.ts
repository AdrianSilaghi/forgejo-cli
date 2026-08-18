import { describe, expect, it } from "bun:test";

import { ERROR_CODES } from "../../src/core/errors.js";
import { failure, success } from "../../src/core/result.js";

type JsonSchema = Readonly<{
  oneOf: readonly [
    Readonly<{ required: readonly string[] }>,
    Readonly<{
      required: readonly string[];
      properties: Readonly<{
        error: Readonly<{
          properties: Readonly<{ code: Readonly<{ enum: readonly string[] }> }>;
        }>;
      }>;
    }>,
  ];
}>;

describe("response-v1 JSON schema", () => {
  it("tracks success, failure, and every stable runtime error code", async () => {
    const schema = (await Bun.file("schemas/response-v1.schema.json").json()) as JsonSchema;

    expect(schema.oneOf[0].required).toEqual(Object.keys(success({})));
    expect(schema.oneOf[1].required).toEqual(
      Object.keys(
        failure({
          code: "validation_failed",
          message: "invalid",
          retryable: false,
        }),
      ),
    );
    expect(schema.oneOf[1].properties.error.properties.code.enum).toEqual(ERROR_CODES);
  });
});
