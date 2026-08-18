const SENSITIVE_KEYS = /(?:authorization|cookie|password|secret|token|credential|api[_-]?key)/i;
const AUTHORIZATION_VALUE = /(authorization\s*:\s*)(?:token|bearer)\s+[^\s,;]+/gi;
const URL_CREDENTIAL = /(https?:\/\/)[^/@\s]+@/gi;

export function redactString(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE, "$1[REDACTED]")
    .replace(URL_CREDENTIAL, "$1[REDACTED]@");
}

export function redact(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEYS.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redact(entryValue, entryKey),
      ]),
    );
  }

  return value;
}
