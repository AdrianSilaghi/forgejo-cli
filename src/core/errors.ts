export const ERROR_CODES = Object.freeze([
  "validation_failed",
  "confirmation_required",
  "not_authenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "network_failed",
  "timeout",
  "server_failed",
  "protocol_failed",
  "config_failed",
  "credential_store_unavailable",
  "cancelled",
] as const);

export type ErrorCode = (typeof ERROR_CODES)[number];

export class CliError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CliError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}
