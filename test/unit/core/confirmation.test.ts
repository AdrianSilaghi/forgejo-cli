import { describe, expect, it } from "bun:test";

import { assertDestructiveConfirmation, confirmationFor } from "../../../src/core/confirmation.js";

describe("destructive confirmation", () => {
  it("derives a stable value from repository, resource type, and immutable ID", () => {
    expect(confirmationFor("acme/widget", "release", 123)).toBe("acme/widget#release:123");
  });

  it("requires --yes and an exact target-derived confirmation", () => {
    expect(() =>
      assertDestructiveConfirmation({
        repository: "acme/widget",
        resource: "release",
        id: 123,
        yes: true,
        confirm: "acme/other#release:123",
      }),
    ).toThrow();

    expect(() =>
      assertDestructiveConfirmation({
        repository: "acme/widget",
        resource: "release",
        id: 123,
        yes: false,
        confirm: "acme/widget#release:123",
      }),
    ).toThrow();

    expect(
      assertDestructiveConfirmation({
        repository: "acme/widget",
        resource: "release",
        id: 123,
        yes: true,
        confirm: "acme/widget#release:123",
      }),
    ).toBeUndefined();
  });
});
