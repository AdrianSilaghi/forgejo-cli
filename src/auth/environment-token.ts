import { CliError } from "../core/errors.js";
import { normalizeOrigin } from "../http/origin.js";

export function resolveEnvironmentToken(input: {
  requestedOrigin: string;
  environment: Readonly<{
    FORGEJO_TOKEN?: string;
    FORGEJO_HOST?: string;
    [key: string]: string | undefined;
  }>;
}): string | null {
  const token = input.environment.FORGEJO_TOKEN;
  if (token === undefined) return null;
  if (token.length === 0 || token.trim() !== token || /[\r\n]/.test(token)) {
    throw new CliError("not_authenticated", "FORGEJO_TOKEN is invalid.");
  }

  const host = input.environment.FORGEJO_HOST;
  if (!host) {
    throw new CliError(
      "not_authenticated",
      "FORGEJO_HOST is required whenever FORGEJO_TOKEN is set.",
    );
  }

  const requestedOrigin = normalizeOrigin(input.requestedOrigin);
  const boundOrigin = normalizeOrigin(host);
  if (requestedOrigin !== boundOrigin) {
    throw new CliError("not_authenticated", "FORGEJO_TOKEN is bound to a different origin.");
  }

  return token;
}
