import { describe, expect, it } from "bun:test";

import { AuthService } from "../../../src/auth/auth-service.js";
import type { CredentialKey, CredentialStore } from "../../../src/auth/credential-store.js";
import type { ForgejoConfig } from "../../../src/config/config-repository.js";
import type { ForgejoApi, ForgejoRequest } from "../../../src/http/forgejo-api.js";

class RecordingCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  readonly deleted: CredentialKey[] = [];

  async get(key: CredentialKey): Promise<string | null> {
    return this.values.get(JSON.stringify(key)) ?? null;
  }

  async set(key: CredentialKey, token: string): Promise<void> {
    this.values.set(JSON.stringify(key), token);
  }

  async delete(key: CredentialKey): Promise<void> {
    this.deleted.push(key);
    this.values.delete(JSON.stringify(key));
  }
}

const EMPTY_CONFIG: ForgejoConfig = { schema_version: 1, accounts: [] };

describe("AuthService", () => {
  it("validates a token before persisting its exact origin and identity", async () => {
    const requests: ForgejoRequest[] = [];
    const api: ForgejoApi = {
      async request(request) {
        requests.push(request);
        return { id: 7, login: "agent", full_name: "Build Agent" };
      },
    };
    const credentials = new RecordingCredentialStore();
    let savedAccount: { origin: string; username: string } | undefined;
    const accounts = {
      async load() {
        return EMPTY_CONFIG;
      },
      async upsertAccount(account: { origin: string; username: string }) {
        savedAccount = account;
        return EMPTY_CONFIG;
      },
      async removeAccount() {
        return EMPTY_CONFIG;
      },
    };
    const service = new AuthService({
      clientFactory: () => api,
      credentials,
      accounts,
    });

    await expect(
      service.login({ host: "https://GIT.example.com:443", token: "fixture" }),
    ).resolves.toEqual({
      origin: "https://git.example.com",
      user: { id: 7, login: "agent", name: "Build Agent" },
    });

    expect(requests).toEqual([{ method: "GET", path: ["user"] }]);
    expect(savedAccount).toEqual({ origin: "https://git.example.com", username: "agent" });
    expect(credentials.values.get(JSON.stringify(savedAccount))).toBe("fixture");
  });

  it("persists nothing when validation fails", async () => {
    const credentials = new RecordingCredentialStore();
    const service = new AuthService({
      clientFactory: () => ({ request: async () => ({ unexpected: true }) }),
      credentials,
      accounts: {
        load: async () => EMPTY_CONFIG,
        upsertAccount: async () => EMPTY_CONFIG,
        removeAccount: async () => EMPTY_CONFIG,
      },
    });

    await expect(
      service.login({ host: "https://git.example.com", token: "fixture" }),
    ).rejects.toMatchObject({ code: "protocol_failed" });
    expect(credentials.values.size).toBe(0);
  });

  it("rolls back a newly stored credential when metadata persistence fails", async () => {
    const credentials = new RecordingCredentialStore();
    const service = new AuthService({
      clientFactory: () => ({ request: async () => ({ id: 7, login: "agent" }) }),
      credentials,
      accounts: {
        load: async () => EMPTY_CONFIG,
        upsertAccount: async () => {
          throw new Error("disk failed");
        },
        removeAccount: async () => EMPTY_CONFIG,
      },
    });

    await expect(
      service.login({ host: "https://git.example.com", token: "fixture" }),
    ).rejects.toThrow("disk failed");
    expect(credentials.values.size).toBe(0);
    expect(credentials.deleted).toEqual([{ origin: "https://git.example.com", username: "agent" }]);
  });

  it("lists account metadata and logs out the exact canonical account", async () => {
    const credentials = new RecordingCredentialStore();
    const operations: string[] = [];
    const configured: ForgejoConfig = {
      schema_version: 1,
      accounts: [{ origin: "https://git.example.com:8443", username: "agent", default: true }],
    };
    const service = new AuthService({
      clientFactory: () => ({ request: async () => ({ id: 1, login: "unused" }) }),
      credentials: {
        ...credentials,
        get: credentials.get.bind(credentials),
        set: credentials.set.bind(credentials),
        async delete(key) {
          operations.push(`credential:${key.origin}:${key.username}`);
        },
      },
      accounts: {
        async load() {
          return configured;
        },
        async upsertAccount() {
          return configured;
        },
        async removeAccount(origin, username) {
          operations.push(`account:${origin}:${username}`);
          return EMPTY_CONFIG;
        },
      },
    });

    await expect(service.list()).resolves.toBe(configured.accounts);
    await service.logout({ host: "https://GIT.example.com:8443", username: "agent" });

    expect(operations).toEqual([
      "credential:https://git.example.com:8443:agent",
      "account:https://git.example.com:8443:agent",
    ]);
  });

  it("preserves the metadata failure when credential rollback also fails", async () => {
    const metadataFailure = new Error("metadata write failed");
    const service = new AuthService({
      clientFactory: () => ({ request: async () => ({ id: 7, login: "agent" }) }),
      credentials: {
        get: async () => null,
        set: async () => undefined,
        delete: async () => {
          throw new Error("credential rollback failed");
        },
      },
      accounts: {
        load: async () => EMPTY_CONFIG,
        upsertAccount: async () => {
          throw metadataFailure;
        },
        removeAccount: async () => EMPTY_CONFIG,
      },
    });

    await expect(service.login({ host: "https://git.example.com", token: "fixture" })).rejects.toBe(
      metadataFailure,
    );
  });
});
