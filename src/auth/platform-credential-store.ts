import { CliError } from "../core/errors.js";
import {
  readBoundedProcessOutput,
  type BoundedProcess,
  withProcessDeadline,
} from "../core/bounded-process-output.js";
import { normalizeOrigin } from "../http/origin.js";
import type { CredentialKey, CredentialStore } from "./credential-store.js";

export type CredentialHelperResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type CredentialHelperRunner = (
  args: readonly string[],
  input: string,
) => Promise<CredentialHelperResult>;

export type PlatformCredentialStoreOptions = Readonly<{
  platform?: NodeJS.Platform;
  runner?: CredentialHelperRunner;
}>;

export type CredentialHelperProcessOptions = Readonly<{
  stdin: Blob;
  stdout: "pipe";
  stderr: "ignore";
  env: Readonly<Record<string, string>>;
}>;

export type CredentialHelperProcessSpawner = (
  args: readonly string[],
  options: CredentialHelperProcessOptions,
) => BoundedProcess;

export type CredentialHelperRunnerFactoryOptions = Readonly<{
  spawn?: CredentialHelperProcessSpawner;
  timeoutMs?: number;
}>;

const MAX_CREDENTIAL_HELPER_OUTPUT_BYTES = 65_536;
const CREDENTIAL_HELPER_TIMEOUT_MS = 30_000;
const CREDENTIAL_FIELD_SEPARATOR = "=";
const PASSWORD_FIELD = `password${CREDENTIAL_FIELD_SEPARATOR}`;

const CREDENTIAL_HELPER_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "LANG",
  "LC_ALL",
  "GNOME_KEYRING_CONTROL",
] as const);

export function credentialHelperEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...Object.fromEntries(
      CREDENTIAL_HELPER_ENVIRONMENT_KEYS.flatMap((key) => {
        const value = environment[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
}

const defaultCredentialHelperProcessSpawner: CredentialHelperProcessSpawner = (args, options) => {
  const child = Bun.spawn([...args], options);
  return Object.freeze({
    exited: child.exited,
    stdout: child.stdout,
    kill: () => child.kill(),
  });
};

export function createCredentialHelperRunner(
  options: CredentialHelperRunnerFactoryOptions = {},
): CredentialHelperRunner {
  const spawn = options.spawn ?? defaultCredentialHelperProcessSpawner;
  const timeoutMs = options.timeoutMs ?? CREDENTIAL_HELPER_TIMEOUT_MS;
  return async (args, input) => {
    const child = spawn(args, {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "ignore",
      env: credentialHelperEnvironment(globalThis.process.env),
    });
    try {
      const [exitCode, stdout] = await withProcessDeadline(timeoutMs, async (signal) =>
        Promise.all([
          child.exited,
          readBoundedProcessOutput(child.stdout, MAX_CREDENTIAL_HELPER_OUTPUT_BYTES, { signal }),
        ]),
      );
      return Object.freeze({ exitCode, stdout, stderr: "" });
    } catch (cause) {
      try {
        child.kill();
      } catch {
        // Process termination is best-effort; preserve the bounded-read failure.
      }
      throw cause;
    }
  };
}

const defaultRunner = createCredentialHelperRunner();

function helperFor(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "credential-osxkeychain";
  if (platform === "linux") return "credential-libsecret";
  throw new CliError(
    "credential_store_unavailable",
    "No supported secure credential store is available on this platform.",
  );
}

function credentialInput(key: CredentialKey, token?: string): string {
  const origin = new URL(normalizeOrigin(key.origin));
  if (key.username.length === 0 || /[\r\n]/.test(key.username)) {
    throw new CliError("validation_failed", "Credential username is invalid.");
  }
  const fields = [
    `protocol=${origin.protocol.slice(0, -1)}`,
    `host=${origin.host}`,
    "path=forgejo-cli",
    `username=${key.username}`,
    ...(token === undefined ? [] : [`password=${token}`]),
    "",
  ];
  return `${fields.join("\n")}\n`;
}

function passwordFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith(PASSWORD_FIELD)) return line.slice(PASSWORD_FIELD.length);
  }
  return null;
}

export class PlatformCredentialStore implements CredentialStore {
  readonly #helper: string;
  readonly #runner: CredentialHelperRunner;

  public constructor(options: PlatformCredentialStoreOptions = {}) {
    this.#helper = helperFor(options.platform ?? process.platform);
    this.#runner = options.runner ?? defaultRunner;
  }

  public async get(key: CredentialKey): Promise<string | null> {
    const result = await this.#run("get", credentialInput(key));
    return passwordFromOutput(result.stdout);
  }

  public async set(key: CredentialKey, token: string): Promise<void> {
    if (token.length === 0 || /[\r\n]/.test(token)) {
      throw new CliError("validation_failed", "Credential token is invalid.");
    }
    await this.#run("store", credentialInput(key, token));
  }

  public async delete(key: CredentialKey): Promise<void> {
    await this.#run("erase", credentialInput(key));
  }

  async #run(action: "erase" | "get" | "store", input: string): Promise<CredentialHelperResult> {
    let result: CredentialHelperResult;
    try {
      result = await this.#runner(["git", this.#helper, action], input);
    } catch (cause) {
      throw new CliError(
        "credential_store_unavailable",
        "The operating-system credential store is unavailable.",
        { cause },
      );
    }
    if (result.exitCode !== 0) {
      throw new CliError(
        "credential_store_unavailable",
        "The operating-system credential store is unavailable.",
      );
    }
    return result;
  }
}
