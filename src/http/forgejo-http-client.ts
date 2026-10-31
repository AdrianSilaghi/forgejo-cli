import { CliError, type ErrorCode } from "../core/errors.js";
import { hasControlCharacter } from "../core/text-validation.js";
import type {
  ForgejoApi,
  ForgejoAssetUpload,
  ForgejoAssetUploader,
  ForgejoDownload,
  ForgejoDownloader,
  ForgejoDownloadRequest,
  ForgejoRequest,
  ForgejoText,
  ForgejoTextReader,
  ForgejoTextRequest,
  HttpMethod,
  QueryValue,
} from "./forgejo-api.js";
import { normalizeOrigin } from "./origin.js";

export type ForgejoHttpClientOptions = Readonly<{
  origin: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** At most two retries of transient GET/HEAD failures, within the request timeout. */
  maxRetries?: number;
  retryWait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  /** Whole-transfer limit for archive downloads, which outlive a normal request. */
  downloadTimeoutMs?: number;
  maxResponseBytes?: number;
  allowInsecureLocalhost?: boolean;
}>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ConnectionRefused",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const HTTP_DATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

function isTransientNetworkError(error: unknown): boolean {
  let transient = false;
  for (let depth = 0; depth < 8 && error instanceof Error; depth += 1) {
    if (error instanceof CliError) return false;
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string") {
      if (!TRANSIENT_NETWORK_CODES.has(code)) return false;
      transient = true;
    }
    error = error.cause;
  }
  return error === undefined && transient;
}

function retryDelay(response: Response | undefined, retry: number, now: number): number {
  const value = response?.headers.get("retry-after")?.trim();
  if (value !== undefined && /^\d+$/u.test(value)) {
    return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER);
  }
  if (value !== undefined && HTTP_DATE.test(value)) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
  }
  return 250 * 2 ** retry;
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    // Split long Retry-After waits so timers never overflow or release the event loop early.
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", abort);
        if (milliseconds > MAX_TIMER_DELAY_MS) {
          waitForRetry(milliseconds - MAX_TIMER_DELAY_MS, signal).then(resolve, reject);
        } else {
          resolve();
        }
      },
      Math.min(milliseconds, MAX_TIMER_DELAY_MS),
    );
    signal.addEventListener("abort", abort, { once: true });
  });
}
const MAX_TOKEN_BYTES = 4096;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURED_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const CONTENT_RANGE = /^bytes \d+-\d+\/(\d+|\*)$/u;

type SendInput = Readonly<{
  method: HttpMethod;
  url: string;
  headers: Headers;
  body?: string;
  signal: AbortSignal;
  callerSignal: AbortSignal | undefined;
  timeout: AbortSignal;
}>;

type ReadGuard = Readonly<{
  callerSignal: AbortSignal | undefined;
  timeout: AbortSignal;
  retryable: boolean;
}>;

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
    if (isStringList(value)) {
      for (const entry of value) url.searchParams.append(key, entry);
    } else if (value !== undefined) {
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

function isStringList(value: QueryValue): value is readonly string[] {
  return Array.isArray(value);
}

function parseByteCount(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function totalFromContentRange(value: string | null): number | null {
  return value === null ? null : parseByteCount(CONTENT_RANGE.exec(value.trim())?.[1]);
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

async function guardedRead<T>(guard: ReadGuard, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (cause instanceof CliError) throw cause;
    if (guard.callerSignal?.aborted === true) {
      throw new CliError("cancelled", "Forgejo response was cancelled.", { cause });
    }
    if (guard.timeout.aborted) {
      throw new CliError("timeout", "Forgejo response timed out.", {
        retryable: guard.retryable,
        cause,
      });
    }
    throw new CliError("network_failed", "Unable to read the Forgejo response.", {
      retryable: guard.retryable,
      cause,
    });
  }
}

async function guardedResponseData(
  input: ReadGuard & Readonly<{ response: Response; maxBytes: number }>,
): Promise<unknown> {
  return guardedRead(input, () => responseData(input.response, input.maxBytes));
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

export class ForgejoHttpClient
  implements ForgejoApi, ForgejoAssetUploader, ForgejoTextReader, ForgejoDownloader
{
  readonly #origin: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #signal: AbortSignal | undefined;
  readonly #maxRetries: number;
  readonly #retryWait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #downloadTimeoutMs: number;
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
    this.#signal = options.signal;
    this.#maxRetries = options.maxRetries ?? 2;
    if (!Number.isSafeInteger(this.#maxRetries) || this.#maxRetries < 0 || this.#maxRetries > 2) {
      throw new CliError("validation_failed", "Forgejo retry limit is invalid.");
    }
    this.#retryWait = options.retryWait ?? waitForRetry;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new CliError("validation_failed", "Forgejo request timeout is invalid.");
    }
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#downloadTimeoutMs) || this.#downloadTimeoutMs < 1) {
      throw new CliError("validation_failed", "Forgejo download timeout is invalid.");
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

  #signals(
    caller: AbortSignal | undefined,
    milliseconds: number,
  ): Pick<SendInput, "callerSignal" | "timeout" | "signal"> {
    const callers = [this.#signal, caller].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const callerSignal = callers.length > 0 ? AbortSignal.any(callers) : undefined;
    const timeout = AbortSignal.timeout(milliseconds);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    return { callerSignal, timeout, signal };
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

    const { timeout, signal, callerSignal } = this.#signals(request.signal, this.#timeoutMs);
    const response = await this.#send({
      method: request.method,
      url,
      headers,
      ...(body === undefined ? {} : { body }),
      signal,
      callerSignal,
      timeout,
    });
    return guardedResponseData({
      response,
      maxBytes: this.#maxResponseBytes,
      callerSignal,
      timeout,
      retryable: request.method === "GET" || request.method === "HEAD",
    });
  }

  public async readText(request: ForgejoTextRequest): Promise<ForgejoText> {
    if (
      request.tailBytes !== undefined &&
      (!Number.isSafeInteger(request.tailBytes) || request.tailBytes < 1)
    ) {
      throw new CliError(
        "validation_failed",
        "The requested tail size must be a positive integer.",
      );
    }
    const url = buildUrl(this.#origin, request.path, request.query);
    const headers = new Headers({
      accept: "text/plain",
      authorization: `token ${this.#token}`,
    });
    if (request.tailBytes !== undefined) {
      headers.set("range", `bytes=-${request.tailBytes}`);
    }

    const { timeout, signal, callerSignal } = this.#signals(request.signal, this.#timeoutMs);
    const response = await this.#send({
      method: "GET",
      url,
      headers,
      signal,
      callerSignal,
      timeout,
    });
    const text = await guardedRead({ callerSignal, timeout, retryable: true }, () =>
      responseText(response, this.#maxResponseBytes),
    );
    const partial = response.status === 206;
    return Object.freeze({
      text,
      partial,
      totalBytes: partial
        ? totalFromContentRange(response.headers.get("content-range"))
        : Buffer.byteLength(text, "utf8"),
    });
  }

  public async download(request: ForgejoDownloadRequest): Promise<ForgejoDownload> {
    const url = buildUrl(this.#origin, request.path, request.query);
    const headers = new Headers({
      accept: "*/*",
      authorization: `token ${this.#token}`,
    });
    const { timeout, signal, callerSignal } = this.#signals(
      request.signal,
      this.#downloadTimeoutMs,
    );
    const response = await this.#send({
      method: "GET",
      url,
      headers,
      signal,
      callerSignal,
      timeout,
    });
    if (response.body === null) {
      throw new CliError("protocol_failed", "Forgejo returned a download without a body.");
    }
    return Object.freeze({
      body: response.body,
      contentType: response.headers.get("content-type"),
      declaredBytes: parseByteCount(response.headers.get("content-length")),
    });
  }

  /**
   * Sends one request and follows only same-origin redirects, so the token never
   * leaves the configured origin. Returns the first non-redirect success.
   */
  async #send(input: SendInput): Promise<Response> {
    const readOnly = input.method === "GET" || input.method === "HEAD";
    let currentUrl = input.url;

    for (let redirects = 0, retries = 0; redirects <= MAX_REDIRECTS; ) {
      let response: Response;
      try {
        input.signal.throwIfAborted();
        response = await this.#fetch(currentUrl, {
          method: input.method,
          headers: input.headers,
          ...(input.body === undefined ? {} : { body: input.body }),
          redirect: "manual",
          signal: input.signal,
        });
      } catch (cause) {
        const retryable = readOnly && isTransientNetworkError(cause);
        if (!input.signal.aborted && retryable && retries < this.#maxRetries) {
          await this.#pause(input, retryDelay(undefined, retries++, this.#now()));
          continue;
        }
        throw this.#requestFailure(input, cause, retryable);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        await cancelResponseBody(response);
        const location = response.headers.get("location");
        if (!location) {
          throw new CliError("protocol_failed", "Forgejo returned a redirect without a location.");
        }
        if (!readOnly) {
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
        redirects += 1;
        continue;
      }

      if (!response.ok) {
        await cancelResponseBody(response);
        const retryable = readOnly && RETRY_STATUSES.has(response.status);
        if (retryable && retries < this.#maxRetries) {
          await this.#pause(input, retryDelay(response, retries++, this.#now()));
          continue;
        }
        const code = errorCodeForStatus(response.status);
        throw new CliError(code, `Forgejo request failed with HTTP ${response.status}.`, {
          retryable,
          details: { http_status: response.status },
        });
      }

      return response;
    }

    throw new CliError("protocol_failed", "Forgejo redirect handling failed.");
  }

  #requestFailure(input: SendInput, cause: unknown, retryable: boolean): CliError {
    if (input.callerSignal?.aborted === true) {
      return new CliError("cancelled", "Forgejo request was cancelled.", { cause });
    }
    if (input.timeout.aborted) {
      return new CliError("timeout", "Forgejo request timed out.", {
        retryable: input.method === "GET" || input.method === "HEAD",
        cause,
      });
    }
    return new CliError("network_failed", "Unable to reach the Forgejo server.", {
      retryable,
      cause,
    });
  }

  async #pause(input: SendInput, milliseconds: number): Promise<void> {
    try {
      await this.#retryWait(milliseconds, input.signal);
      input.signal.throwIfAborted();
    } catch (cause) {
      throw this.#requestFailure(input, cause, false);
    }
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
    const { timeout, signal, callerSignal } = this.#signals(request.signal, this.#timeoutMs);

    let response: Response;
    try {
      signal.throwIfAborted();
      response = await this.#fetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal,
      });
    } catch (cause) {
      if (callerSignal?.aborted === true) {
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
      callerSignal,
      timeout,
      retryable: false,
    });
  }
}
