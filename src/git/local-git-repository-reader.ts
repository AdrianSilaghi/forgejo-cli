import { CliError } from "../core/errors.js";
import {
  readBoundedProcessOutput,
  type BoundedProcess,
  withProcessDeadline,
} from "../core/bounded-process-output.js";
import { hasControlCharacter } from "../core/text-validation.js";
import { gitCommandEnvironment } from "./git-command-environment.js";

export type GitCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
}>;

export interface GitCommandRunner {
  run(input: { args: readonly string[]; cwd: string }): Promise<GitCommandResult>;
}

export interface GitRepositoryReader {
  getRemoteUrl(input: { cwd: string; remote: string }): Promise<string>;
}

const MAX_CWD_BYTES = 4096;
const MAX_REMOTE_URL_BYTES = 8192;
const MAX_GIT_PROCESS_OUTPUT_BYTES = 16_384;
const GIT_PROCESS_TIMEOUT_MS = 5000;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const REMOTE_CONFIG_KEY = /^remote\.[A-Za-z0-9][A-Za-z0-9_-]{0,254}\.url$/;

export type GitProcessOptions = Readonly<{
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: "ignore";
  stdout: "pipe";
  stderr: "ignore";
}>;

export type GitProcessSpawner = (
  args: readonly string[],
  options: GitProcessOptions,
) => BoundedProcess;

export type BunGitCommandRunnerOptions = Readonly<{
  spawn?: GitProcessSpawner;
  timeoutMs?: number;
}>;

const defaultGitProcessSpawner: GitProcessSpawner = (args, options) => {
  const child = Bun.spawn([...args], options);
  return Object.freeze({
    exited: child.exited,
    stdout: child.stdout,
    kill: () => child.kill(),
  });
};

function isAllowedLocalCommand(args: readonly string[]): boolean {
  return (
    args.length === 4 &&
    args[0] === "config" &&
    args[1] === "--local" &&
    args[2] === "--get" &&
    REMOTE_CONFIG_KEY.test(args[3] ?? "")
  );
}

function validateCwd(cwd: string): void {
  if (
    cwd.length === 0 ||
    Buffer.byteLength(cwd, "utf8") > MAX_CWD_BYTES ||
    cwd.trim() !== cwd ||
    hasControlCharacter(cwd)
  ) {
    throw new CliError("validation_failed", "Git working directory is invalid.");
  }
}

export class BunGitCommandRunner implements GitCommandRunner {
  readonly #spawn: GitProcessSpawner;
  readonly #timeoutMs: number;

  public constructor(options: BunGitCommandRunnerOptions = {}) {
    this.#spawn = options.spawn ?? defaultGitProcessSpawner;
    this.#timeoutMs = options.timeoutMs ?? GIT_PROCESS_TIMEOUT_MS;
  }

  public async run(input: { args: readonly string[]; cwd: string }): Promise<GitCommandResult> {
    validateCwd(input.cwd);
    if (!isAllowedLocalCommand(input.args)) {
      throw new CliError("validation_failed", "Refusing to execute a non-local Git command.");
    }

    try {
      const child = this.#spawn(["git", ...input.args], {
        cwd: input.cwd,
        env: gitCommandEnvironment(process.env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      try {
        const [exitCode, stdout] = await withProcessDeadline(this.#timeoutMs, async (signal) =>
          Promise.all([
            child.exited,
            readBoundedProcessOutput(child.stdout, MAX_GIT_PROCESS_OUTPUT_BYTES, { signal }),
          ]),
        );
        return Object.freeze({ exitCode, stdout });
      } catch (cause) {
        try {
          child.kill();
        } catch {
          // Process termination is best-effort; preserve the bounded-read failure.
        }
        throw cause;
      }
    } catch (cause) {
      throw new CliError("validation_failed", "Unable to inspect the local Git repository.", {
        cause,
      });
    }
  }
}

export class LocalGitRepositoryReader implements GitRepositoryReader {
  readonly #runner: GitCommandRunner;

  public constructor(runner: GitCommandRunner = new BunGitCommandRunner()) {
    this.#runner = runner;
  }

  public async getRemoteUrl(input: { cwd: string; remote: string }): Promise<string> {
    validateCwd(input.cwd);
    if (!REMOTE_NAME.test(input.remote)) {
      throw new CliError("validation_failed", "Git remote name is invalid.");
    }

    const result = await this.#runner.run({
      args: Object.freeze(["config", "--local", "--get", `remote.${input.remote}.url`]),
      cwd: input.cwd,
    });
    if (result.exitCode !== 0) {
      throw new CliError("validation_failed", "Unable to read the requested local Git remote.");
    }

    const remoteUrl = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
    if (
      remoteUrl.length === 0 ||
      Buffer.byteLength(remoteUrl, "utf8") > MAX_REMOTE_URL_BYTES ||
      remoteUrl.trim() !== remoteUrl ||
      hasControlCharacter(remoteUrl)
    ) {
      throw new CliError("validation_failed", "The local Git remote URL is invalid.");
    }
    return remoteUrl;
  }
}
