import { CliError } from "../core/errors.js";
import {
  readBoundedProcessOutput,
  type BoundedProcess,
  withProcessDeadline,
} from "../core/bounded-process-output.js";
import { hasControlCharacter } from "../core/text-validation.js";
import { gitCommandEnvironment } from "./git-command-environment.js";

export type GitBranchCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
}>;

export interface GitBranchCommandRunner {
  run(input: { args: readonly string[]; cwd: string }): Promise<GitBranchCommandResult>;
}

export interface GitBranchReader {
  current(cwd: string): Promise<string | null>;
}

const CURRENT_BRANCH_COMMAND = Object.freeze(["symbolic-ref", "--quiet", "--short", "HEAD"]);
const MAX_CWD_BYTES = 4096;
const MAX_BRANCH_BYTES = 1024;
const MAX_BRANCH_PROCESS_OUTPUT_BYTES = 4096;
const GIT_BRANCH_TIMEOUT_MS = 5000;

export type GitBranchProcessOptions = Readonly<{
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: "ignore";
  stdout: "pipe";
  stderr: "ignore";
}>;

export type GitBranchProcessSpawner = (
  args: readonly string[],
  options: GitBranchProcessOptions,
) => BoundedProcess;

export type BunGitBranchCommandRunnerOptions = Readonly<{
  spawn?: GitBranchProcessSpawner;
  timeoutMs?: number;
}>;

const defaultGitBranchProcessSpawner: GitBranchProcessSpawner = (args, options) => {
  const child = Bun.spawn([...args], options);
  return Object.freeze({
    exited: child.exited,
    stdout: child.stdout,
    kill: () => child.kill(),
  });
};

export class BunGitBranchCommandRunner implements GitBranchCommandRunner {
  readonly #spawn: GitBranchProcessSpawner;
  readonly #timeoutMs: number;

  public constructor(options: BunGitBranchCommandRunnerOptions = {}) {
    this.#spawn = options.spawn ?? defaultGitBranchProcessSpawner;
    this.#timeoutMs = options.timeoutMs ?? GIT_BRANCH_TIMEOUT_MS;
  }

  public async run(input: {
    args: readonly string[];
    cwd: string;
  }): Promise<GitBranchCommandResult> {
    if (
      input.args.length !== CURRENT_BRANCH_COMMAND.length ||
      input.args.some((value, index) => value !== CURRENT_BRANCH_COMMAND[index])
    ) {
      throw new CliError("validation_failed", "Refusing to execute a mutating Git command.");
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
            readBoundedProcessOutput(child.stdout, MAX_BRANCH_PROCESS_OUTPUT_BYTES, { signal }),
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
      throw new CliError("validation_failed", "Unable to inspect the local Git branch.", {
        cause,
      });
    }
  }
}

export class LocalGitBranchReader implements GitBranchReader {
  readonly #runner: GitBranchCommandRunner;

  public constructor(runner: GitBranchCommandRunner = new BunGitBranchCommandRunner()) {
    this.#runner = runner;
  }

  public async current(cwd: string): Promise<string | null> {
    if (
      cwd.length === 0 ||
      cwd.trim() !== cwd ||
      Buffer.byteLength(cwd, "utf8") > MAX_CWD_BYTES ||
      hasControlCharacter(cwd)
    ) {
      throw new CliError("validation_failed", "Git working directory is invalid.");
    }
    const result = await this.#runner.run({ args: CURRENT_BRANCH_COMMAND, cwd });
    if (result.exitCode !== 0) return null;

    const branch = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
    if (
      branch.length === 0 ||
      branch.trim() !== branch ||
      Buffer.byteLength(branch, "utf8") > MAX_BRANCH_BYTES ||
      hasControlCharacter(branch)
    ) {
      throw new CliError("validation_failed", "The current local Git branch is invalid.");
    }
    return branch;
  }
}
