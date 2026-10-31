import { CliError } from "../core/errors.js";
import { redact } from "../core/redaction.js";
import type { ForgejoApi, QueryValue } from "../http/forgejo-api.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export interface ApiOperations {
  get(endpoint: string, query?: readonly string[]): Promise<JsonValue>;
}

function hasControl(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

export function apiPath(endpoint: string): readonly string[] {
  if (
    endpoint.length === 0 ||
    endpoint.length > 8192 ||
    endpoint.trim() !== endpoint ||
    hasControl(endpoint) ||
    /[ :@?#\\]/.test(endpoint) ||
    endpoint.startsWith("//")
  ) {
    throw new CliError(
      "validation_failed",
      "API endpoint must be a safe relative path without a query or fragment.",
    );
  }
  const relative = endpoint.replace(/^\//, "").replace(/^api\/v1\//, "");
  const path = relative.split("/").map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new CliError("validation_failed", "API endpoint contains invalid encoding.");
    }
    if (
      decoded.length === 0 ||
      decoded.length > 1024 ||
      decoded === "." ||
      decoded === ".." ||
      hasControl(decoded) ||
      /[%/\\ :@?#]/.test(decoded)
    ) {
      throw new CliError("validation_failed", "API endpoint contains an unsafe path segment.");
    }
    return decoded;
  });
  return Object.freeze(path);
}

export function apiQuery(input: readonly string[]): Readonly<Record<string, QueryValue>> {
  if (input.length > 100)
    throw new CliError("validation_failed", "API queries cannot exceed 100 entries.");
  const pairs = input.map((entry): readonly [string, string] => {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (
      separator < 1 ||
      entry.length > 8192 ||
      hasControl(entry) ||
      !/^[A-Za-z0-9_.[\]-]+$/.test(key) ||
      /^_method$/i.test(key)
    ) {
      throw new CliError("validation_failed", "API queries require safe key=value entries.");
    }
    return [key, value];
  });
  return Object.freeze(
    Object.fromEntries(
      Object.entries(Object.groupBy(pairs, ([key]) => key)).map(([key, entries]) => {
        const values = (entries ?? []).map(([, value]) => value);
        return [key, values.length === 1 ? values[0] : values];
      }),
    ),
  );
}

function validateJson(value: unknown): asserts value is JsonValue {
  let nodes = 0;
  let bytes = 0;
  const visit = (entry: unknown, depth: number): void => {
    nodes += 1;
    if (depth > 32 || nodes > 100_000 || bytes > 8 * 1024 * 1024)
      throw new CliError("protocol_failed", "Forgejo JSON response exceeds the safety bounds.");
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (typeof entry === "string") {
      bytes += Buffer.byteLength(entry, "utf8");
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (
      typeof entry === "object" &&
      entry !== null &&
      (Object.getPrototypeOf(entry) === Object.prototype || Object.getPrototypeOf(entry) === null)
    ) {
      for (const [key, item] of Object.entries(entry)) {
        bytes += Buffer.byteLength(key, "utf8");
        visit(item, depth + 1);
      }
      return;
    }
    throw new CliError("protocol_failed", "Forgejo returned an incompatible JSON response.");
  };
  visit(value, 0);
  if (bytes > 8 * 1024 * 1024)
    throw new CliError("protocol_failed", "Forgejo JSON response exceeds the safety bounds.");
}

export class ApiService implements ApiOperations {
  readonly #api: ForgejoApi;
  public constructor(api: ForgejoApi) {
    this.#api = api;
  }
  public async get(endpoint: string, query: readonly string[] = []): Promise<JsonValue> {
    const path = apiPath(endpoint);
    const parsedQuery = apiQuery(query);
    const response = await this.#api.request({ method: "GET", path, query: parsedQuery });
    validateJson(response);
    return redact(response) as JsonValue;
  }
}
