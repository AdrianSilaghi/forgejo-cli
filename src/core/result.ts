import type { ErrorCode } from "./errors.js";
import { redact, redactString } from "./redaction.js";

export type Success<T> = Readonly<{
  schema_version: "1";
  ok: true;
  data: T;
}>;

export type Failure = Readonly<{
  schema_version: "1";
  ok: false;
  error: Readonly<{
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details: Readonly<Record<string, unknown>>;
  }>;
}>;

export function success<T>(data: T): Success<T> {
  return { schema_version: "1", ok: true, data };
}

export function failure(error: {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, unknown>>;
}): Failure {
  return {
    schema_version: "1",
    ok: false,
    error: {
      code: error.code,
      message: redactString(error.message),
      retryable: error.retryable,
      details: redact(error.details ?? {}) as Readonly<Record<string, unknown>>,
    },
  };
}
