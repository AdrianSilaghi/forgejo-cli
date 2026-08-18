import type { ForgejoConfig } from "../config/config-repository.js";
import { CliError } from "../core/errors.js";
import { normalizeOrigin } from "../http/origin.js";
import type { CredentialStore } from "./credential-store.js";
import { resolveEnvironmentToken } from "./environment-token.js";

export interface AccountMetadataSource {
  load(): Promise<ForgejoConfig>;
}

export type ResolvedAccount = Readonly<{
  origin: string;
  username: string | null;
  token: string;
  source: "environment" | "credential_store";
}>;

export type AccountResolverOptions = Readonly<{
  accounts: AccountMetadataSource;
  credentials: CredentialStore;
}>;

export type ForgejoEnvironment = Readonly<{
  FORGEJO_HOST?: string;
  FORGEJO_TOKEN?: string;
  [key: string]: string | undefined;
}>;

const MAX_TOKEN_BYTES = 4096;

function validateUsername(username: string): void {
  if (
    username.length === 0 ||
    username.length > 255 ||
    username.trim() !== username ||
    /[\r\n]/u.test(username)
  ) {
    throw new CliError("validation_failed", "Forgejo account username is invalid.");
  }
}

function validateToken(token: string | null): string {
  if (
    token === null ||
    token.length === 0 ||
    Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES ||
    token.trim() !== token ||
    /[\r\n]/u.test(token)
  ) {
    throw new CliError("not_authenticated", "No usable credential exists for this account.");
  }
  return token;
}

export class AccountResolver {
  readonly #accounts: AccountMetadataSource;
  readonly #credentials: CredentialStore;

  public constructor(options: AccountResolverOptions) {
    this.#accounts = options.accounts;
    this.#credentials = options.credentials;
  }

  public async resolve(input: {
    origin: string;
    explicitHost?: string;
    username?: string;
    environment: ForgejoEnvironment;
  }): Promise<ResolvedAccount> {
    const origin = normalizeOrigin(input.origin);
    const environmentToken = this.#environmentToken({
      origin,
      explicitHost: input.explicitHost,
      environment: input.environment,
    });
    if (environmentToken !== null) {
      return Object.freeze({
        origin,
        username: null,
        token: environmentToken,
        source: "environment" as const,
      });
    }

    if (input.explicitHost !== undefined && normalizeOrigin(input.explicitHost) !== origin) {
      throw new CliError("not_authenticated", "The explicit host is bound to a different origin.");
    }

    const accounts = (await this.#accounts.load()).accounts.filter((account) => {
      try {
        return normalizeOrigin(account.origin) === origin;
      } catch (cause) {
        throw new CliError("config_failed", "Configured Forgejo account origin is invalid.", {
          cause,
        });
      }
    });
    const account = this.#selectAccount(accounts, input.username);
    const token = validateToken(
      await this.#credentials.get({ origin, username: account.username }),
    );
    return Object.freeze({
      origin,
      username: account.username,
      token,
      source: "credential_store" as const,
    });
  }

  #environmentToken(input: {
    origin: string;
    explicitHost: string | undefined;
    environment: ForgejoEnvironment;
  }): string | null {
    if (input.environment.FORGEJO_TOKEN === undefined) return null;

    const explicitOrigin =
      input.explicitHost === undefined ? undefined : normalizeOrigin(input.explicitHost);
    const environmentHost = input.environment.FORGEJO_HOST;
    const environmentOrigin =
      environmentHost === undefined ? undefined : normalizeOrigin(environmentHost);
    if (
      explicitOrigin !== undefined &&
      environmentOrigin !== undefined &&
      explicitOrigin !== environmentOrigin
    ) {
      throw new CliError(
        "not_authenticated",
        "Explicit and environment Forgejo hosts identify different origins.",
      );
    }

    const boundOrigin = explicitOrigin ?? environmentOrigin;
    if (boundOrigin === undefined) {
      throw new CliError(
        "not_authenticated",
        "An explicit Forgejo host is required whenever FORGEJO_TOKEN is set.",
      );
    }
    return validateToken(
      resolveEnvironmentToken({
        requestedOrigin: input.origin,
        environment: Object.freeze({
          FORGEJO_HOST: boundOrigin,
          FORGEJO_TOKEN: input.environment.FORGEJO_TOKEN,
        }),
      }),
    );
  }

  #selectAccount(
    accounts: ForgejoConfig["accounts"],
    requestedUsername: string | undefined,
  ): ForgejoConfig["accounts"][number] {
    if (requestedUsername !== undefined) {
      validateUsername(requestedUsername);
      const matching = accounts.filter((account) => account.username === requestedUsername);
      if (matching.length !== 1) {
        throw new CliError("not_authenticated", "The requested Forgejo account is unavailable.");
      }
      return matching[0] as ForgejoConfig["accounts"][number];
    }

    if (accounts.length === 1) return accounts[0] as ForgejoConfig["accounts"][number];
    const defaults = accounts.filter((account) => account.default);
    if (defaults.length !== 1) {
      throw new CliError(
        "not_authenticated",
        "No unambiguous Forgejo account is configured for this origin.",
      );
    }
    return defaults[0] as ForgejoConfig["accounts"][number];
  }
}
