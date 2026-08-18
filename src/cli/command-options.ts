import { CliError } from "../core/errors.js";

const SAFE_REPOSITORY_PART = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/;

export type RepositorySlug = Readonly<{
  owner: string;
  repository: string;
}>;

export function parseRepositorySlug(value: string): RepositorySlug {
  const parts = value.split("/");
  const owner = parts[0];
  const repository = parts[1];
  if (
    parts.length !== 2 ||
    owner === undefined ||
    repository === undefined ||
    !SAFE_REPOSITORY_PART.test(owner) ||
    !SAFE_REPOSITORY_PART.test(repository)
  ) {
    throw new CliError(
      "validation_failed",
      "Repository must use the unambiguous owner/repository form.",
    );
  }
  return Object.freeze({ owner, repository });
}

export function parsePositiveInteger(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CliError("validation_failed", `${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliError("validation_failed", `${name} must be a safe positive integer.`);
  }
  return parsed;
}

export function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CliError("validation_failed", `${name} must be either true or false.`);
}

export function parseCsv(value: string): readonly string[] {
  const values = value.split(",");
  if (values.length === 0 || values.some((entry) => entry.length === 0 || entry.trim() !== entry)) {
    throw new CliError("validation_failed", "Comma-separated values cannot be blank or padded.");
  }
  return Object.freeze([...values]);
}

export type CompactDefined<T extends Readonly<Record<string, unknown>>> = Readonly<{
  [K in keyof T]?: Exclude<T[K], undefined>;
}>;

export function compactDefined<T extends Readonly<Record<string, unknown>>>(
  input: T,
): CompactDefined<T> {
  return Object.freeze(
    Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
  ) as CompactDefined<T>;
}
