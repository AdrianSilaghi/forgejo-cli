import { CliError } from "../core/errors.js";

export type GitRemote = Readonly<{
  host: string;
  owner: string;
  repository: string;
}>;

export type GitRemoteReference = Readonly<
  GitRemote & ({ transport: "https"; origin: string } | { transport: "ssh"; origin: null })
>;

const ENCODED_SEPARATOR = /%(?:2f|5c)/i;
const ENCODED_DOT = /%2e/i;
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function parsePath(rawPath: string): Pick<GitRemote, "owner" | "repository"> {
  if (ENCODED_SEPARATOR.test(rawPath) || ENCODED_DOT.test(rawPath)) {
    throw new CliError("validation_failed", "Git remote path contains unsafe encoding.");
  }

  const path = rawPath.replace(/^\//, "");
  const parts = path.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new CliError("validation_failed", "Git remote must identify exactly owner/repository.");
  }

  let owner: string;
  let repository: string;
  try {
    owner = decodeURIComponent(parts[0] ?? "");
    repository = decodeURIComponent(parts[1] ?? "").replace(/\.git$/i, "");
  } catch (cause) {
    throw new CliError("validation_failed", "Git remote path contains invalid encoding.", {
      cause,
    });
  }

  const safeSegment = /^[\p{L}\p{N}_.-]+$/u;
  if (!safeSegment.test(owner) || !safeSegment.test(repository)) {
    throw new CliError("validation_failed", "Git remote owner or repository is invalid.");
  }

  return { owner, repository };
}

function validateHost(host: string): string {
  const normalized = host.toLowerCase();
  const unwrapped = normalized.startsWith("[") ? normalized.slice(1, -1) : normalized;
  if (unwrapped.endsWith(".") || normalized.length === 0 || hasControlCharacter(normalized)) {
    throw new CliError("validation_failed", "Git remote hostname is invalid.");
  }
  return normalized;
}

export function parseGitRemoteReference(input: string): GitRemoteReference {
  if (input.trim() !== input || hasControlCharacter(input)) {
    throw new CliError("validation_failed", "Git remote URL is invalid.");
  }

  if (input.startsWith("https://") || input.startsWith("ssh://")) {
    let url: URL;
    try {
      url = new URL(input);
    } catch (cause) {
      throw new CliError("validation_failed", "Git remote URL is invalid.", { cause });
    }

    if (url.protocol === "https:" && (url.username || url.password)) {
      throw new CliError("validation_failed", "HTTPS Git remotes must not contain credentials.");
    }
    if (url.protocol === "ssh:" && url.password) {
      throw new CliError("validation_failed", "SSH Git remotes must not contain passwords.");
    }
    if (url.search || url.hash || url.hostname.endsWith(".")) {
      throw new CliError("validation_failed", "Git remote URL contains unsupported components.");
    }

    const remote = {
      host: validateHost(url.hostname),
      ...parsePath(url.pathname),
    } as const;
    if (url.protocol === "https:") {
      return Object.freeze({
        ...remote,
        transport: "https" as const,
        origin: url.origin,
      });
    }

    return Object.freeze({
      ...remote,
      transport: "ssh" as const,
      origin: null,
    });
  }

  const scp = /^(?:[A-Za-z0-9_.-]+@)?(\[[0-9A-Fa-f:]+\]|[^:\s]+):(.+)$/.exec(input);
  if (scp) {
    return Object.freeze({
      host: validateHost(scp[1] ?? ""),
      ...parsePath(scp[2] ?? ""),
      transport: "ssh" as const,
      origin: null,
    });
  }

  throw new CliError("validation_failed", "Git remote must use HTTPS or SSH.");
}

export function parseGitRemote(input: string): GitRemote {
  const parsed = parseGitRemoteReference(input);
  return Object.freeze({
    host: parsed.host,
    owner: parsed.owner,
    repository: parsed.repository,
  });
}
