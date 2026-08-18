import { CliError, type ErrorCode } from "../core/errors.js";
import { hasControlCharacter } from "../core/text-validation.js";
import type {
  ForgejoApi,
  ForgejoAssetUpload,
  ForgejoAssetUploader,
  ForgejoRequest,
  QueryValue,
} from "./forgejo-api.js";
import { normalizeOrigin } from "./origin.js";

export type ForgejoHttpClientOptions = Readonly<{
  origin: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowInsecureLocalhost?: boolean;
}>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_TOKEN_BYTES = 4096;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURED_RESPONSE_BYTES = 64 * 1024 * 1024;

function errorCodeForStatus(status: number): ErrorCode {
  if (status === 401) return "not_authenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409 || status === 422) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_failed";
  return "protocol_failed";
}

function buildUrl(
  origin: string,
  path: readonly string[],
  query: Readonly<Record<string, QueryValue>> | undefined,
): string {
  if (
    path.length === 0 ||
    path.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 1024 ||
        segment === "." ||
        segment === ".." ||
        hasControlCharacter(segment),
    )
  ) {
    throw new CliError("validation_failed", "API paths require non-empty path segments.");
  }

  const encodedPath = path.map((segment) => encodeURIComponent(segment)).join("/");
  const url = new URL(`/api/v1/${encodedPath}`, origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

function parseRedirectLocation(location: string, currentUrl: string): URL {
  try {
    return new URL(location, currentUrl);
  } catch (cause) {
    throw new CliError("protocol_failed", "Forgejo returned an invalid redirect location.", {
      cause,
    });
  }
}

async function responseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) {
      throw new CliError("protocol_failed", "Forgejo response exceeded the configured size limit.");
    }
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytesRead += next.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CliError(
          "protocol_failed",
          "Forgejo response exceeded the configured size limit.",
        );
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function responseData(response: Response, maxBytes: number): Promise<unknown> {
  if (response.status === 204 || response.status === 205) {
    return null;
  }

  const text = await responseText(response, maxBytes);
  if (text.length === 0) {
    return null;
  }

  if (response.headers.get("content-type")?.toLowerCase().includes("json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new CliError("protocol_failed", "Forgejo returned malformed JSON.", { cause });
    }
  }

  return text;
}

async function guardedResponseData(input: {
  response: Response;
  maxBytes: number;
  callerSignal: AbortSignal | undefined;
  timeout: AbortSignal;
  retryable: boolean;
}): Promise<unknown> {
  try {
    return await responseData(input.response, input.maxBytes);
  } catch (cause) {
    if (cause instanceof CliError) throw cause;
    if (input.callerSignal?.aborted === true) {
      throw new CliError("cancelled", "Forgejo response was cancelled.", { cause });
    }
    if (input.timeout.aborted) {
      throw new CliError("timeout", "Forgejo response timed out.", {
        retryable: input.retryable,
        cause,
      });
    }
    throw new CliError("network_failed", "Unable to read the Forgejo response.", {
      retryable: input.retryable,
      cause,
    });
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

const SAFE_ASSET_NAME = /^[^/\\]{1,255}$/u;

function assertSafeAssetName(value: string): void {
  if (
    !SAFE_ASSET_NAME.test(value) ||
    hasControlCharacter(value) ||
    value.trim() !== value ||
    value === "." ||
    value === ".."
  ) {
    throw new CliError("validation_failed", "Release asset names must be safe file names.");
  }
}

export class ForgejoHttpClient implements ForgejoApi, ForgejoAssetUploader {
  readonly #origin: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  public constructor(options: ForgejoHttpClientOptions) {
    this.#origin = normalizeOrigin(
      options.origin,
      options.allowInsecureLocalhost === undefined
        ? {}
        : { allowInsecureLocalhost: options.allowInsecureLocalhost },
    );
    if (
      options.token.length === 0 ||
      options.token.trim() !== options.token ||
      Buffer.byteLength(options.token, "utf8") > MAX_TOKEN_BYTES ||
      hasControlCharacter(options.token)
    ) {
      throw new CliError("not_authenticated", "Forgejo credential is invalid.");
    }
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new CliError("validation_failed", "Forgejo request timeout is invalid.");
    }
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(this.#maxResponseBytes) ||
      this.#maxResponseBytes < 1 ||
      this.#maxResponseBytes > MAX_CONFIGURED_RESPONSE_BYTES
    ) {
      throw new CliError("validation_failed", "Forgejo response size limit is invalid.");
    }
  }

  public async request(request: ForgejoRequest): Promise<unknown> {
    const url = buildUrl(this.#origin, request.path, request.query);
    const headers = new Headers({
      accept: "application/json",
      authorization: `token ${this.#token}`,
    });
    let body: string | undefined;
    if (request.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(request.body);
    }

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let currentUrl = url;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      let response: Response;
      try {
        response = await this.#fetch(currentUrl, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal,
        });
      } catch (cause) {
        if (request.signal?.aborted === true) {
          throw new CliError("cancelled", "Forgejo request was cancelled.", {
            retryable: false,
            cause,
          });
        }
        if (timeout.aborted) {
          throw new CliError("timeout", "Forgejo request timed out.", {
            retryable: request.method === "GET" || request.method === "HEAD",
            cause,
          });
        }
        throw new CliError("network_failed", "Unable to reach the Forgejo server.", {
          retryable: request.method === "GET" || request.method === "HEAD",
          cause,
        });
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        await cancelResponseBody(response);
        const location = response.headers.get("location");
        if (!location) {
          throw new CliError("protocol_failed", "Forgejo returned a redirect without a location.");
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new CliError(
            "protocol_failed",
            "Refusing to replay a mutating request after redirect.",
          );
        }
        if (redirects === MAX_REDIRECTS) {
          throw new CliError("protocol_failed", "Forgejo exceeded the redirect limit.");
        }

        const redirected = parseRedirectLocation(location, currentUrl);
        if (redirected.username || redirected.password) {
          throw new CliError(
            "protocol_failed",
            "Refusing an authenticated redirect containing user information.",
          );
        }
        if (redirected.origin !== this.#origin) {
          throw new CliError("protocol_failed", "Refusing a cross-origin authenticated redirect.");
        }
        currentUrl = redirected.toString();
        continue;
      }

      if (!response.ok) {
        await cancelResponseBody(response);
        const code = errorCodeForStatus(response.status);
        const readOnly = request.method === "GET" || request.method === "HEAD";
        throw new CliError(code, `Forgejo request failed with HTTP ${response.status}.`, {
          retryable: readOnly && (code === "rate_limited" || code === "server_failed"),
          details: { http_status: response.status },
        });
      }

      return guardedResponseData({
        response,
        maxBytes: this.#maxResponseBytes,
        callerSignal: request.signal,
        timeout,
        retryable: request.method === "GET" || request.method === "HEAD",
      });
    }

    throw new CliError("protocol_failed", "Forgejo redirect handling failed.");
  }

  public async uploadAsset(request: ForgejoAssetUpload): Promise<unknown> {
    assertSafeAssetName(request.name);
    assertSafeAssetName(request.filename);
    if (!Number.isSafeInteger(request.content.size) || request.content.size < 0) {
      throw new CliError("validation_failed", "Release asset size is invalid.");
    }

    const url = buildUrl(this.#origin, request.path, { name: request.name });
    const headers = new Headers({
      accept: "application/json",
      authorization: `token ${this.#token}`,
    });
    const body = new FormData();
    body.append("attachment", request.content, request.filename);
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal,
      });
    } catch (cause) {
      if (request.signal?.aborted === true) {
        throw new CliError("cancelled", "Forgejo asset upload was cancelled.", {
          cause,
        });
      }
      if (timeout.aborted) {
        throw new CliError("timeout", "Forgejo asset upload timed out.", {
          cause,
        });
      }
      throw new CliError("network_failed", "Unable to upload the Forgejo release asset.", {
        cause,
      });
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      await cancelResponseBody(response);
      throw new CliError("protocol_failed", "Refusing to replay an asset upload after redirect.");
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      const code = errorCodeForStatus(response.status);
      throw new CliError(code, `Forgejo request failed with HTTP ${response.status}.`, {
        retryable: false,
        details: { http_status: response.status },
      });
    }
    return guardedResponseData({
      response,
      maxBytes: this.#maxResponseBytes,
      callerSignal: request.signal,
      timeout,
      retryable: false,
    });
  }
}
