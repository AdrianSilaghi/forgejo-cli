import { z } from "zod";

import type { ForgejoConfig } from "../config/config-repository.js";
import { CliError } from "../core/errors.js";
import type { ForgejoApi } from "../http/forgejo-api.js";
import { normalizeOrigin } from "../http/origin.js";
import type { CredentialStore } from "./credential-store.js";

const UserSchema = z
  .object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    full_name: z.string().nullish(),
  })
  .passthrough();

export type AuthenticatedUser = Readonly<{
  id: number;
  login: string;
  name: string | null;
}>;

export type AccountRepository = Readonly<{
  load(): Promise<ForgejoConfig>;
  upsertAccount(input: { origin: string; username: string }): Promise<ForgejoConfig>;
  removeAccount(origin: string, username: string): Promise<ForgejoConfig>;
}>;

export type AuthServiceOptions = Readonly<{
  clientFactory(origin: string, token: string): ForgejoApi;
  credentials: CredentialStore;
  accounts: AccountRepository;
}>;

export class AuthService {
  readonly #clientFactory: AuthServiceOptions["clientFactory"];
  readonly #credentials: CredentialStore;
  readonly #accounts: AccountRepository;

  public constructor(options: AuthServiceOptions) {
    this.#clientFactory = options.clientFactory;
    this.#credentials = options.credentials;
    this.#accounts = options.accounts;
  }

  public async login(input: {
    host: string;
    token: string;
  }): Promise<Readonly<{ origin: string; user: AuthenticatedUser }>> {
    const origin = normalizeOrigin(input.host);
    const response = await this.#clientFactory(origin, input.token).request({
      method: "GET",
      path: ["user"],
    });
    const parsed = UserSchema.safeParse(response);
    if (!parsed.success) {
      throw new CliError("protocol_failed", "Forgejo returned an invalid authenticated user.");
    }

    const key = { origin, username: parsed.data.login } as const;
    await this.#credentials.set(key, input.token);
    try {
      await this.#accounts.upsertAccount(key);
    } catch (error) {
      await this.#credentials.delete(key).catch(() => undefined);
      throw error;
    }

    return Object.freeze({
      origin,
      user: Object.freeze({
        id: parsed.data.id,
        login: parsed.data.login,
        name: parsed.data.full_name ?? null,
      }),
    });
  }

  public async list(): Promise<ForgejoConfig["accounts"]> {
    return (await this.#accounts.load()).accounts;
  }

  public async logout(input: { host: string; username: string }): Promise<void> {
    const origin = normalizeOrigin(input.host);
    const key = { origin, username: input.username } as const;
    await this.#credentials.delete(key);
    await this.#accounts.removeAccount(origin, input.username);
  }
}
