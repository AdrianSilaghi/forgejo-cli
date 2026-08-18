import { isIP } from "node:net";

import { CliError } from "../core/errors.js";

export type NormalizeOriginOptions = Readonly<{
  allowInsecureLocalhost?: boolean;
}>;

function isLoopback(hostname: string): boolean {
  const unwrapped = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (unwrapped === "localhost" || unwrapped === "::1") {
    return true;
  }

  return isIP(unwrapped) === 4 && unwrapped.startsWith("127.");
}

export function normalizeOrigin(input: string, options: NormalizeOriginOptions = {}): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new CliError("validation_failed", "Forgejo host must be a valid origin.", { cause });
  }

  if (url.username || url.password) {
    throw new CliError("validation_failed", "Forgejo host must not contain user information.");
  }
  if (url.hostname.endsWith(".")) {
    throw new CliError("validation_failed", "Forgejo host must not use a trailing-dot hostname.");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    throw new CliError("validation_failed", "Forgejo host must contain only an origin.");
  }

  const secure = url.protocol === "https:";
  const allowedLoopback =
    url.protocol === "http:" && options.allowInsecureLocalhost === true && isLoopback(url.hostname);
  if (!secure && !allowedLoopback) {
    throw new CliError("validation_failed", "Forgejo host must use HTTPS.");
  }

  return url.origin;
}
