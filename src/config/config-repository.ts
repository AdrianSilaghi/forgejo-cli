import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import { CliError } from "../core/errors.js";
import { normalizeOrigin } from "../http/origin.js";

const AccountSchema = z
  .object({
    origin: z.string(),
    username: z.string().min(1).max(255),
    default: z.boolean(),
  })
  .strict();

const ConfigSchema = z
  .object({
    schema_version: z.literal(1),
    accounts: z.array(AccountSchema),
  })
  .strict()
  .superRefine((config, context) => {
    const defaults = new Set<string>();
    for (const account of config.accounts) {
      if (account.default && defaults.has(account.origin)) {
        context.addIssue({
          code: "custom",
          message: `Multiple default accounts exist for ${account.origin}.`,
        });
      }
      if (account.default) defaults.add(account.origin);
    }
  });

export type AccountMetadata = Readonly<z.infer<typeof AccountSchema>>;
export type ForgejoConfig = Readonly<{
  schema_version: 1;
  accounts: readonly AccountMetadata[];
}>;

const EMPTY_CONFIG: ForgejoConfig = Object.freeze({
  schema_version: 1,
  accounts: Object.freeze([]),
});
const MAX_CONFIG_BYTES = 1024 * 1024;

function immutableConfig(config: z.infer<typeof ConfigSchema>): ForgejoConfig {
  return Object.freeze({
    schema_version: 1 as const,
    accounts: Object.freeze(config.accounts.map((account) => Object.freeze({ ...account }))),
  });
}

async function assertNotSymlink(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new CliError("config_failed", "Refusing to use a symbolic-link configuration path.");
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CliError("config_failed", "Unable to inspect the configuration path.", {
        cause: error,
      });
    }
  }
}

function isCurrentUserOwner(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

async function assertSecureDirectory(path: string): Promise<void> {
  await assertNotSymlink(path);
  try {
    const stats = await lstat(path);
    if (
      !stats.isDirectory() ||
      !isCurrentUserOwner(stats.uid) ||
      (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
    ) {
      throw new CliError(
        "config_failed",
        "Configuration directory must be owner-controlled with 0700 permissions.",
      );
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("config_failed", "Unable to inspect the configuration directory.", {
      cause: error,
    });
  }
}

export class ConfigRepository {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = path;
  }

  public async load(): Promise<ForgejoConfig> {
    await assertNotSymlink(this.#path);
    try {
      const stats = await lstat(this.#path);
      await assertSecureDirectory(dirname(this.#path));
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        !isCurrentUserOwner(stats.uid) ||
        (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
      ) {
        throw new CliError(
          "config_failed",
          "Configuration must be an owner-controlled regular file with 0600 permissions.",
        );
      }
      if (!Number.isSafeInteger(stats.size) || stats.size > MAX_CONFIG_BYTES) {
        throw new CliError("config_failed", "Configuration exceeds the fixed size limit.");
      }
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      return immutableConfig(ConfigSchema.parse(parsed));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_CONFIG;
      if (error instanceof CliError) throw error;
      throw new CliError("config_failed", "Unable to load Forgejo account metadata.", {
        cause: error,
      });
    }
  }

  public async upsertAccount(input: { origin: string; username: string }): Promise<ForgejoConfig> {
    const origin = normalizeOrigin(input.origin);
    const current = await this.load();
    const existing = current.accounts.some(
      (account) => account.origin === origin && account.username === input.username,
    );
    const accounts = current.accounts
      .map((account) =>
        account.origin === origin
          ? { ...account, default: account.username === input.username }
          : { ...account },
      )
      .concat(existing ? [] : [{ origin, username: input.username, default: true }]);
    const next = immutableConfig(ConfigSchema.parse({ schema_version: 1, accounts }));
    await this.save(next);
    return next;
  }

  public async removeAccount(originInput: string, username: string): Promise<ForgejoConfig> {
    const origin = normalizeOrigin(originInput);
    const current = await this.load();
    const remaining = current.accounts.filter(
      (account) => !(account.origin === origin && account.username === username),
    );
    const originAccounts = remaining.filter((account) => account.origin === origin);
    const needsDefault =
      originAccounts.length > 0 && !originAccounts.some((account) => account.default);
    const defaultUsername = needsDefault ? originAccounts[0]?.username : undefined;
    const accounts = remaining.map((account) =>
      account.origin === origin && account.username === defaultUsername
        ? { ...account, default: true }
        : { ...account },
    );
    const next = immutableConfig(ConfigSchema.parse({ schema_version: 1, accounts }));
    await this.save(next);
    return next;
  }

  public async save(config: ForgejoConfig): Promise<void> {
    const validated = immutableConfig(ConfigSchema.parse(config));
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertSecureDirectory(directory);
    await assertNotSymlink(this.#path);

    const temporary = join(directory, `.${basename(this.#path)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#path);
      if (process.platform !== "win32") await chmod(this.#path, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof CliError) throw error;
      throw new CliError("config_failed", "Unable to save Forgejo account metadata.", {
        cause: error,
      });
    }
  }
}
