import type { ForgejoConfig } from "../config/config-repository.js";
import { CliError } from "../core/errors.js";
import { hasControlCharacter } from "../core/text-validation.js";
import { normalizeOrigin } from "../http/origin.js";
import type { GitRepositoryReader } from "./local-git-repository-reader.js";
import { parseGitRemoteReference, type GitRemoteReference } from "./remote-url.js";

export type { GitRepositoryReader } from "./local-git-repository-reader.js";

export type RepositoryContext = Readonly<{
  origin: string;
  owner: string;
  repository: string;
  sources: Readonly<{
    origin: "explicit" | "git_https" | "configured_account";
    repository: "explicit" | "git";
  }>;
}>;

export interface AccountMetadataSource {
  load(): Promise<ForgejoConfig>;
}

export type RepositoryContextResolverOptions = Readonly<{
  git: GitRepositoryReader;
  accounts: AccountMetadataSource;
}>;

const REPOSITORY_SEGMENT = /^[\p{L}\p{N}_.-]+$/u;
const MAX_REPOSITORY_SEGMENT_LENGTH = 255;

function parseRepository(input: string): Readonly<{ owner: string; repository: string }> {
  if (input.trim() !== input || hasControlCharacter(input)) {
    throw new CliError("validation_failed", "Repository must use owner/name format.");
  }
  const [owner, repository, extra] = input.split("/");
  if (
    extra !== undefined ||
    owner === undefined ||
    repository === undefined ||
    !REPOSITORY_SEGMENT.test(owner) ||
    !REPOSITORY_SEGMENT.test(repository) ||
    owner.length > MAX_REPOSITORY_SEGMENT_LENGTH ||
    repository.length > MAX_REPOSITORY_SEGMENT_LENGTH ||
    owner === "." ||
    owner === ".." ||
    repository === "." ||
    repository === ".."
  ) {
    throw new CliError("validation_failed", "Repository must use owner/name format.");
  }
  return Object.freeze({ owner, repository });
}

function hostname(origin: string): string {
  const value = new URL(origin).hostname.toLowerCase();
  return value.startsWith("[") ? value.slice(1, -1) : value;
}

function remoteHostname(remote: GitRemoteReference): string {
  return remote.host.startsWith("[") ? remote.host.slice(1, -1) : remote.host;
}

export class RepositoryContextResolver {
  readonly #git: GitRepositoryReader;
  readonly #accounts: AccountMetadataSource;

  public constructor(options: RepositoryContextResolverOptions) {
    this.#git = options.git;
    this.#accounts = options.accounts;
  }

  public async resolve(input: {
    cwd?: string;
    repository?: string;
    host?: string;
    remote?: string;
  }): Promise<RepositoryContext> {
    const explicitRepository =
      input.repository === undefined ? undefined : parseRepository(input.repository);
    const explicitOrigin = input.host === undefined ? undefined : normalizeOrigin(input.host);

    let remote: GitRemoteReference | undefined;
    if (explicitRepository === undefined || explicitOrigin === undefined) {
      const remoteUrl = await this.#git.getRemoteUrl({
        cwd: input.cwd ?? process.cwd(),
        remote: input.remote ?? "origin",
      });
      remote = parseGitRemoteReference(remoteUrl);
    }

    const repository = explicitRepository ?? this.#repositoryFromRemote(remote);
    const remoteOrigin = remote === undefined ? undefined : await this.#originFromRemote(remote);
    if (
      explicitRepository === undefined &&
      explicitOrigin !== undefined &&
      remoteOrigin?.origin !== explicitOrigin
    ) {
      throw new CliError(
        "validation_failed",
        "The explicit Forgejo host does not match the repository Git remote.",
      );
    }
    const resolvedOrigin =
      explicitOrigin === undefined
        ? remoteOrigin
        : Object.freeze({ origin: explicitOrigin, source: "explicit" as const });
    if (resolvedOrigin === undefined) {
      throw new CliError("validation_failed", "Repository context is incomplete.");
    }
    return Object.freeze({
      origin: resolvedOrigin.origin,
      owner: repository.owner,
      repository: repository.repository,
      sources: Object.freeze({
        origin: resolvedOrigin.source,
        repository: explicitRepository === undefined ? "git" : "explicit",
      }),
    });
  }

  #repositoryFromRemote(
    remote: GitRemoteReference | undefined,
  ): Readonly<{ owner: string; repository: string }> {
    if (remote === undefined) {
      throw new CliError("validation_failed", "Repository context is incomplete.");
    }
    return Object.freeze({ owner: remote.owner, repository: remote.repository });
  }

  async #originFromRemote(remote: GitRemoteReference | undefined): Promise<
    Readonly<{
      origin: string;
      source: "git_https" | "configured_account";
    }>
  > {
    if (remote === undefined) {
      throw new CliError("validation_failed", "Repository context is incomplete.");
    }
    if (remote.transport === "https") {
      return Object.freeze({
        origin: normalizeOrigin(remote.origin),
        source: "git_https" as const,
      });
    }

    const expectedHostname = remoteHostname(remote);
    const configuredOrigins = [
      ...new Set(
        (await this.#accounts.load()).accounts
          .map((account) => {
            try {
              return normalizeOrigin(account.origin);
            } catch (cause) {
              throw new CliError("config_failed", "Configured Forgejo account origin is invalid.", {
                cause,
              });
            }
          })
          .filter((origin) => hostname(origin) === expectedHostname),
      ),
    ];

    if (configuredOrigins.length === 0) {
      throw new CliError(
        "not_authenticated",
        "The SSH Git remote does not match a configured Forgejo origin.",
      );
    }
    if (configuredOrigins.length > 1) {
      throw new CliError(
        "validation_failed",
        "The SSH Git remote is ambiguous across configured Forgejo origins.",
      );
    }

    const origin = configuredOrigins[0];
    if (origin === undefined) {
      throw new CliError("not_authenticated", "No Forgejo origin could be resolved.");
    }
    return Object.freeze({ origin, source: "configured_account" as const });
  }
}
