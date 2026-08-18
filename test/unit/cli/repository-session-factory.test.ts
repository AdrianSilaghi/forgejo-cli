import { describe, expect, it } from "bun:test";

import type { RepositorySelection } from "../../../src/cli/command-runtime.js";
import {
  RepositorySessionFactory,
  type ForgejoServiceBundle,
} from "../../../src/cli/repository-session-factory.js";

describe("RepositorySessionFactory", () => {
  it("resolves context, exact account, local branch, and injected services without mutation", async () => {
    const contextInputs: unknown[] = [];
    const accountInputs: unknown[] = [];
    const serviceInputs: unknown[] = [];
    const services = Object.freeze({}) as ForgejoServiceBundle;
    const selection: RepositorySelection = Object.freeze({
      host: "https://code.example.test",
      repository: Object.freeze({ owner: "octo", repository: "app" }),
      remote: "upstream",
      username: "agent",
    });
    const factory = new RepositorySessionFactory({
      cwd: "/workspace",
      environment: Object.freeze({ FORGEJO_TOKEN: "token" }),
      contexts: {
        resolve: async (input) => {
          contextInputs.push(input);
          return {
            origin: "https://code.example.test",
            owner: "octo",
            repository: "app",
            sources: { origin: "explicit", repository: "explicit" },
          };
        },
      },
      accounts: {
        resolve: async (input) => {
          accountInputs.push(input);
          return {
            origin: "https://code.example.test",
            username: null,
            token: "token",
            source: "environment",
          };
        },
      },
      branches: { current: async () => "feature" },
      serviceFactory: (origin, token) => {
        serviceInputs.push({ origin, token });
        return services;
      },
    });

    const resolved = await factory.resolve(selection);

    expect(contextInputs).toEqual([
      {
        cwd: "/workspace",
        repository: "octo/app",
        host: "https://code.example.test",
        remote: "upstream",
      },
    ]);
    expect(accountInputs).toEqual([
      {
        origin: "https://code.example.test",
        explicitHost: "https://code.example.test",
        username: "agent",
        environment: { FORGEJO_TOKEN: "token" },
      },
    ]);
    expect(serviceInputs).toEqual([{ origin: "https://code.example.test", token: "token" }]);
    expect(resolved).toMatchObject({
      origin: "https://code.example.test",
      repository: { owner: "octo", repository: "app" },
      localBranch: "feature",
      services,
    });
    expect(selection).toEqual({
      host: "https://code.example.test",
      repository: { owner: "octo", repository: "app" },
      remote: "upstream",
      username: "agent",
    });
  });
});
