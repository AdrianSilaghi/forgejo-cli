import { parsePositiveInteger } from "../cli/command-options.js";
import type { ResolvedRepository } from "../cli/command-runtime.js";
import { CliError } from "../core/errors.js";
import type { PullRequestOperations } from "../forgejo/pull-request-service.js";

type SelectorRepository = ResolvedRepository<Readonly<{ pullRequests: PullRequestOperations }>>;

function numberFromUrl(value: string, resolved: SelectorRepository): number {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("validation_failed", "Pull request URL is invalid.");
  }
  const origin = new URL(resolved.origin);
  const { owner, repository } = resolved.repository;
  const prefix = `${origin.pathname.replace(/\/$/u, "")}/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/`;
  const number = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length).replace(/\/$/u, "")
    : "";
  if (
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    url.search ||
    !/^\d+$/u.test(number)
  ) {
    throw new CliError(
      "validation_failed",
      "Pull request URL must match the selected Forgejo origin and repository.",
    );
  }
  return parsePositiveInteger(number, "pull request number");
}

export async function resolvePullRequestSelector(
  value: string | undefined,
  resolved: SelectorRepository,
  options: Readonly<{ state?: "open" | "closed" }> = {},
): Promise<number> {
  if (value !== undefined && /^\d+$/u.test(value))
    return parsePositiveInteger(value, "pull request number");
  if (value !== undefined && /^https?:\/\//iu.test(value)) return numberFromUrl(value, resolved);
  const branch = value ?? resolved.localBranch;
  if (
    branch === null ||
    branch.length === 0 ||
    Array.from(branch).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new CliError(
      "validation_failed",
      "A pull request number, URL, or branch is required when Git has no current branch.",
    );
  }
  const separator = branch.indexOf(":");
  const head = separator === -1 ? branch : branch.slice(separator + 1);
  let match: number | undefined;
  // shortcut: branch searches scan at most 100 pages; use a number or URL for larger repositories.
  for (let page = 1; page <= 100; page += 1) {
    const pulls = await resolved.services.pullRequests.list(resolved.repository, {
      head,
      state: options.state ?? "open",
      page,
      limit: 100,
    });
    for (const pull of pulls) {
      if (separator === -1 ? pull.head.ref !== branch : pull.head.label !== branch) continue;
      if (match !== undefined && match !== pull.number)
        throw new CliError(
          "conflict",
          "Multiple pull requests match this branch; use a number or URL.",
        );
      match = pull.number;
    }
    if (pulls.length === 0) {
      if (match === undefined)
        throw new CliError(
          "not_found",
          "No pull request matches this branch in the selected state.",
        );
      return match;
    }
  }
  throw new CliError(
    "conflict",
    "The pull request search exceeded its page limit; use a number or URL.",
  );
}
