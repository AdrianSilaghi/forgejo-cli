import { describe, expect, it } from "bun:test";

import { resolveEnvironmentToken } from "../../../src/auth/environment-token.js";

describe("resolveEnvironmentToken", () => {
  it("requires an explicitly bound matching host", () => {
    expect(
      resolveEnvironmentToken({
        requestedOrigin: "https://git.example.com",
        environment: {
          FORGEJO_TOKEN: "secret-token",
          FORGEJO_HOST: "https://GIT.example.com:443",
        },
      }),
    ).toBe("secret-token");
  });

  it("never lets an untrusted remote choose where an environment token is sent", () => {
    expect(() =>
      resolveEnvironmentToken({
        requestedOrigin: "https://evil.example",
        environment: { FORGEJO_TOKEN: "secret-token" },
      }),
    ).toThrow(expect.objectContaining({ code: "not_authenticated" }));

    expect(() =>
      resolveEnvironmentToken({
        requestedOrigin: "https://evil.example",
        environment: {
          FORGEJO_TOKEN: "secret-token",
          FORGEJO_HOST: "https://git.example.com",
        },
      }),
    ).toThrow(expect.objectContaining({ code: "not_authenticated" }));
  });

  it("returns null when no environment token exists", () => {
    expect(
      resolveEnvironmentToken({
        requestedOrigin: "https://git.example.com",
        environment: {},
      }),
    ).toBeNull();
  });
});
