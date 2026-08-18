import { describe, expect, it } from "bun:test";

import { AccountResolver } from "../../../src/auth/account-resolver.js";
import type { CredentialKey, CredentialStore } from "../../../src/auth/credential-store.js";
import type { ForgejoConfig } from "../../../src/config/config-repository.js";

class RecordingCredentialStore implements CredentialStore {
  readonly requested: CredentialKey[] = [];

  public constructor(private readonly token: string | null) {}

  public async get(key: CredentialKey): Promise<string | null> {
    this.requested.push(Object.freeze({ ...key }));
    return this.token;
  }

  public async set(): Promise<void> {}
  public async delete(): Promise<void> {}
}

function accountSource(accounts: ForgejoConfig["accounts"]): {
  load(): Promise<ForgejoConfig>;
} {
  return {
    async load() {
      return { schema_version: 1, accounts };
    },
  };
}

describe("AccountResolver", () => {
  it("prefers a host-bound environment token and never reads the credential store", async () => {
    const credentials = new RecordingCredentialStore("stored");
    const resolver = new AccountResolver({
      accounts: accountSource([]),
      credentials,
    });

    const result = await resolver.resolve({
      origin: "https://git.example.com:8443",
      explicitHost: "https://GIT.example.com:8443",
      environment: { FORGEJO_TOKEN: "env-token" },
    });

    expect(result).toEqual({
      origin: "https://git.example.com:8443",
      username: null,
      token: "env-token",
      source: "environment",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(credentials.requested).toEqual([]);
  });

  it("accepts FORGEJO_HOST as the explicit environment-token binding", async () => {
    const resolver = new AccountResolver({
      accounts: accountSource([]),
      credentials: new RecordingCredentialStore(null),
    });

    await expect(
      resolver.resolve({
        origin: "https://git.example.com",
        environment: {
          FORGEJO_HOST: "https://GIT.example.com:443",
          FORGEJO_TOKEN: "env-token",
        },
      }),
    ).resolves.toMatchObject({
      origin: "https://git.example.com",
      token: "env-token",
      source: "environment",
    });
  });

  it("does not let a Git-derived origin bind an environment token", async () => {
    const resolver = new AccountResolver({
      accounts: accountSource([]),
      credentials: new RecordingCredentialStore(null),
    });

    await expect(
      resolver.resolve({
        origin: "https://git.example.com",
        environment: { FORGEJO_TOKEN: "env-token" },
      }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
  });

  it("rejects conflicting explicit and environment host bindings", async () => {
    const resolver = new AccountResolver({
      accounts: accountSource([]),
      credentials: new RecordingCredentialStore(null),
    });

    await expect(
      resolver.resolve({
        origin: "https://one.example",
        explicitHost: "https://one.example",
        environment: {
          FORGEJO_HOST: "https://two.example",
          FORGEJO_TOKEN: "env-token",
        },
      }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
  });

  it("selects the default account for the exact canonical origin including port", async () => {
    const credentials = new RecordingCredentialStore("stored");
    const resolver = new AccountResolver({
      accounts: accountSource([
        { origin: "https://git.example.com", username: "wrong-port", default: true },
        {
          origin: "https://git.example.com:8443",
          username: "agent",
          default: true,
        },
      ]),
      credentials,
    });

    await expect(
      resolver.resolve({ origin: "https://GIT.example.com:8443", environment: {} }),
    ).resolves.toEqual({
      origin: "https://git.example.com:8443",
      username: "agent",
      token: "stored",
      source: "credential_store",
    });
    expect(credentials.requested).toEqual([
      { origin: "https://git.example.com:8443", username: "agent" },
    ]);
  });

  it("selects an explicitly requested username at the exact origin", async () => {
    const credentials = new RecordingCredentialStore("stored");
    const resolver = new AccountResolver({
      accounts: accountSource([
        { origin: "https://git.example.com", username: "one", default: true },
        { origin: "https://git.example.com", username: "two", default: false },
      ]),
      credentials,
    });

    await expect(
      resolver.resolve({
        origin: "https://git.example.com",
        username: "two",
        environment: {},
      }),
    ).resolves.toMatchObject({ username: "two", token: "stored" });
  });

  it("fails closed when account selection is ambiguous", async () => {
    const resolver = new AccountResolver({
      accounts: accountSource([
        { origin: "https://git.example.com", username: "one", default: false },
        { origin: "https://git.example.com", username: "two", default: false },
      ]),
      credentials: new RecordingCredentialStore("stored"),
    });

    await expect(
      resolver.resolve({ origin: "https://git.example.com", environment: {} }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
  });

  it.each([null, "", " token", "token\nleak"])(
    "rejects a missing or malformed stored token without including it in the error",
    async (token) => {
      const resolver = new AccountResolver({
        accounts: accountSource([
          { origin: "https://git.example.com", username: "agent", default: true },
        ]),
        credentials: new RecordingCredentialStore(token),
      });

      try {
        await resolver.resolve({ origin: "https://git.example.com", environment: {} });
        throw new Error("Expected account resolution to fail.");
      } catch (error) {
        expect(error).toMatchObject({ code: "not_authenticated" });
        if (token === null || token.length === 0) {
          expect(String(error)).not.toContain("stored-token-that-does-not-exist");
        } else {
          expect(String(error)).not.toContain(token);
        }
      }
    },
  );

  it.each(["stored", "environment"] as const)("bounds %s tokens", async (source) => {
    const oversized = "s".repeat(4097);
    const resolver = new AccountResolver({
      accounts: accountSource([
        { origin: "https://git.example.com", username: "agent", default: true },
      ]),
      credentials: new RecordingCredentialStore(source === "stored" ? oversized : null),
    });

    await expect(
      resolver.resolve({
        origin: "https://git.example.com",
        ...(source === "environment" ? { explicitHost: "https://git.example.com" } : {}),
        environment: source === "environment" ? { FORGEJO_TOKEN: oversized } : {},
      }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
  });
});
