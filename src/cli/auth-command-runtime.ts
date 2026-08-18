import type { Readable } from "node:stream";

import type { AuthService } from "../auth/auth-service.js";
import type { CredentialStore } from "../auth/credential-store.js";
import type { ForgejoEnvironment } from "../auth/account-resolver.js";
import { resolveEnvironmentToken } from "../auth/environment-token.js";
import { CliError } from "../core/errors.js";
import { normalizeOrigin } from "../http/origin.js";
import type { AuthCommandRuntime } from "./command-runtime.js";

export type AuthCommandRuntimeAdapterOptions = Readonly<{
  auth: AuthService;
  credentials: CredentialStore;
  environment: ForgejoEnvironment;
  stdin: Readable;
}>;

type AuthStatusEntry = Readonly<{
  origin: string;
  username: string | null;
  default: boolean;
  authenticated: boolean;
  source: "credential_store" | "environment";
}>;

export class AuthCommandRuntimeAdapter implements AuthCommandRuntime {
  public readonly stdin: Readable;
  readonly #auth: AuthService;
  readonly #credentials: CredentialStore;
  readonly #environment: ForgejoEnvironment;

  public constructor(options: AuthCommandRuntimeAdapterOptions) {
    this.#auth = options.auth;
    this.#credentials = options.credentials;
    this.#environment = Object.freeze({ ...options.environment });
    this.stdin = options.stdin;
  }

  public async login(input: { host: string; token: string }) {
    return this.#auth.login(input);
  }

  public async list() {
    return this.#auth.list();
  }

  public async status(input: { host?: string }): Promise<Readonly<Record<string, unknown>>> {
    const requestedOrigin = input.host === undefined ? undefined : normalizeOrigin(input.host);
    const environmentToken = this.#environment.FORGEJO_TOKEN;
    if (environmentToken !== undefined) {
      const environmentHost = this.#environment.FORGEJO_HOST;
      if (environmentHost === undefined) {
        throw new CliError(
          "not_authenticated",
          "FORGEJO_HOST is required whenever FORGEJO_TOKEN is set.",
        );
      }
      const origin = normalizeOrigin(environmentHost);
      if (requestedOrigin === undefined || requestedOrigin === origin) {
        resolveEnvironmentToken({ requestedOrigin: origin, environment: this.#environment });
        const environmentAccount: AuthStatusEntry = Object.freeze({
          origin,
          username: null,
          default: false,
          authenticated: true,
          source: "environment" as const,
        });
        return Object.freeze({ accounts: Object.freeze([environmentAccount]) });
      }
    }

    const configured = (await this.#auth.list()).filter(
      (account) =>
        requestedOrigin === undefined || normalizeOrigin(account.origin) === requestedOrigin,
    );
    const storedAccounts: readonly AuthStatusEntry[] = await Promise.all(
      configured.map(async (account) =>
        Object.freeze({
          ...account,
          authenticated:
            (await this.#credentials.get({
              origin: normalizeOrigin(account.origin),
              username: account.username,
            })) !== null,
          source: "credential_store" as const,
        }),
      ),
    );

    return Object.freeze({ accounts: Object.freeze([...storedAccounts]) });
  }

  public async logout(input: {
    host: string;
    username?: string;
  }): Promise<Readonly<Record<string, unknown>>> {
    const origin = normalizeOrigin(input.host);
    const candidates = (await this.#auth.list()).filter(
      (account) => normalizeOrigin(account.origin) === origin,
    );
    const selected =
      input.username === undefined
        ? candidates.length === 1
          ? candidates[0]
          : candidates.find((account) => account.default)
        : candidates.find((account) => account.username === input.username);
    if (selected === undefined) {
      throw new CliError(
        "not_authenticated",
        "No unambiguous configured account matches the requested logout target.",
      );
    }
    await this.#auth.logout({ host: origin, username: selected.username });
    return Object.freeze({ loggedOut: true, origin, username: selected.username });
  }
}
