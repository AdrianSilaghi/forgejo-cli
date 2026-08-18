import { describe, expect, it } from "bun:test";

import type { AuthService } from "../../../src/auth/auth-service.js";
import type { CredentialStore } from "../../../src/auth/credential-store.js";
import { AuthCommandRuntimeAdapter } from "../../../src/cli/auth-command-runtime.js";

function tokenInput(token = "fixture") {
  return {
    read: async () => token,
  };
}

describe("AuthCommandRuntimeAdapter", () => {
  it("delegates login and list without changing their values", async () => {
    const calls: unknown[] = [];
    const accounts = [{ origin: "https://code.example.test", username: "agent", default: true }];
    const loginResult = {
      origin: "https://code.example.test",
      user: { id: 1, login: "agent", name: null },
    };
    const auth = {
      login: async (input: unknown) => {
        calls.push(input);
        return loginResult;
      },
      list: async () => accounts,
    } as unknown as AuthService;
    const runtime = new AuthCommandRuntimeAdapter({
      auth,
      credentials: {} as CredentialStore,
      environment: {},
      tokenInput: tokenInput(),
    });

    await expect(
      runtime.login({ host: "https://code.example.test", token: "fixture" }),
    ).resolves.toBe(loginResult);
    await expect(runtime.list()).resolves.toBe(accounts);
    expect(calls).toEqual([{ host: "https://code.example.test", token: "fixture" }]);
  });

  it("delegates automatic and piped-only token reads to the secure input port", async () => {
    const reads: unknown[] = [];
    const runtime = new AuthCommandRuntimeAdapter({
      auth: {} as AuthService,
      credentials: {} as CredentialStore,
      environment: {},
      tokenInput: {
        read: async (options: unknown) => {
          reads.push(options);
          return "fixture";
        },
      },
    });

    await expect(runtime.readToken({ pipedOnly: false })).resolves.toBe("fixture");
    await expect(runtime.readToken({ pipedOnly: true })).resolves.toBe("fixture");
    expect(reads).toEqual([{ pipedOnly: false }, { pipedOnly: true }]);
  });

  it("reports credential presence without returning credential values", async () => {
    const auth = {
      list: async () => [
        {
          origin: "https://code.example.test",
          username: "agent",
          default: true,
        },
      ],
    } as unknown as AuthService;
    const credentials = {
      get: async () => "super-secret-token",
    } as unknown as CredentialStore;
    const runtime = new AuthCommandRuntimeAdapter({
      auth,
      credentials,
      environment: {},
      tokenInput: tokenInput(),
    });

    const status = await runtime.status({ host: "https://code.example.test" });

    expect(status).toEqual({
      accounts: [
        {
          origin: "https://code.example.test",
          username: "agent",
          default: true,
          authenticated: true,
          source: "credential_store",
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("super-secret-token");
  });

  it("selects the exact default account before logout", async () => {
    const logouts: unknown[] = [];
    const auth = {
      list: async () => [
        {
          origin: "https://code.example.test",
          username: "agent",
          default: true,
        },
      ],
      logout: async (input: unknown) => {
        logouts.push(input);
      },
    } as unknown as AuthService;
    const runtime = new AuthCommandRuntimeAdapter({
      auth,
      credentials: {} as CredentialStore,
      environment: {},
      tokenInput: tokenInput(),
    });

    await expect(runtime.logout({ host: "https://code.example.test" })).resolves.toEqual({
      loggedOut: true,
      origin: "https://code.example.test",
      username: "agent",
    });
    expect(logouts).toEqual([{ host: "https://code.example.test", username: "agent" }]);
  });

  it("lets a host-bound environment token bypass an unavailable keychain", async () => {
    const auth = {
      list: async () => [{ origin: "https://code.example.test", username: "agent", default: true }],
    } as unknown as AuthService;
    const credentials = {
      get: async () => {
        throw new Error("keychain unavailable");
      },
    } as unknown as CredentialStore;
    const runtime = new AuthCommandRuntimeAdapter({
      auth,
      credentials,
      environment: {
        FORGEJO_HOST: "https://code.example.test",
        FORGEJO_TOKEN: "environment-token",
      },
      tokenInput: tokenInput(),
    });

    await expect(runtime.status({})).resolves.toEqual({
      accounts: [
        {
          origin: "https://code.example.test",
          username: null,
          default: false,
          authenticated: true,
          source: "environment",
        },
      ],
    });
  });

  it("requires a host binding for environment-token status", async () => {
    const runtime = new AuthCommandRuntimeAdapter({
      auth: { list: async () => [] } as unknown as AuthService,
      credentials: {} as CredentialStore,
      environment: { FORGEJO_TOKEN: "environment-token" },
      tokenInput: tokenInput(),
    });

    await expect(runtime.status({})).rejects.toMatchObject({ code: "not_authenticated" });
  });

  it("falls back to exact stored-account status when the requested host differs from the environment binding", async () => {
    const requestedKeys: unknown[] = [];
    const runtime = new AuthCommandRuntimeAdapter({
      auth: {
        list: async () => [
          { origin: "https://one.example", username: "one", default: true },
          { origin: "https://two.example", username: "two", default: true },
        ],
      } as unknown as AuthService,
      credentials: {
        get: async (key: unknown) => {
          requestedKeys.push(key);
          return null;
        },
      } as unknown as CredentialStore,
      environment: {
        FORGEJO_HOST: "https://one.example",
        FORGEJO_TOKEN: "environment-token",
      },
      tokenInput: tokenInput(),
    });

    await expect(runtime.status({ host: "https://two.example" })).resolves.toEqual({
      accounts: [
        {
          origin: "https://two.example",
          username: "two",
          default: true,
          authenticated: false,
          source: "credential_store",
        },
      ],
    });
    expect(requestedKeys).toEqual([{ origin: "https://two.example", username: "two" }]);
  });

  it("selects an explicit username and rejects ambiguous logout targets", async () => {
    const logouts: unknown[] = [];
    const accounts = [
      { origin: "https://code.example.test", username: "one", default: false },
      { origin: "https://code.example.test", username: "two", default: false },
    ];
    const runtime = new AuthCommandRuntimeAdapter({
      auth: {
        list: async () => accounts,
        logout: async (input: unknown) => {
          logouts.push(input);
        },
      } as unknown as AuthService,
      credentials: {} as CredentialStore,
      environment: {},
      tokenInput: tokenInput(),
    });

    await expect(
      runtime.logout({ host: "https://code.example.test", username: "two" }),
    ).resolves.toMatchObject({ loggedOut: true, username: "two" });
    await expect(runtime.logout({ host: "https://code.example.test" })).rejects.toMatchObject({
      code: "not_authenticated",
    });
    expect(logouts).toEqual([{ host: "https://code.example.test", username: "two" }]);
  });
});
