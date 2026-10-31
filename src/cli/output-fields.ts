import { CliError } from "../core/errors.js";

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOutputFields(input?: string): readonly string[] | undefined {
  if (input === undefined) return undefined;
  const fields = input.split(",").map((field) => field.trim());
  if (
    [...input].some(
      (character) =>
        character.charCodeAt(0) <= 0x1f ||
        (character.charCodeAt(0) >= 0x7f && character.charCodeAt(0) <= 0x9f),
    ) ||
    fields.some(
      (field) =>
        !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(field) ||
        field in Object.prototype ||
        field === "prototype",
    ) ||
    new Set(fields).size !== fields.length
  ) {
    throw new CliError("validation_failed", "--fields requires unique, flat field names.");
  }
  return fields;
}

/** Select own, flat fields only; pagination describes the original collection. */
export function projectFields(data: unknown, input?: string): unknown {
  const fields = parseOutputFields(input);
  if (fields === undefined) return data;

  const project = (value: unknown): Readonly<Record<string, unknown>> => {
    if (!record(value)) {
      throw new CliError(
        "validation_failed",
        "--fields requires object data or a collection of objects.",
      );
    }
    for (const field of fields) {
      if (!Object.hasOwn(value, field)) {
        throw new CliError("validation_failed", `Unknown output field: ${field}.`);
      }
    }
    return Object.fromEntries(fields.map((field) => [field, value[field]]));
  };

  if (Array.isArray(data)) return data.map(project);
  const { items } = record(data) ? data : {};
  if (record(data) && Array.isArray(items) && Object.hasOwn(data, "pagination")) {
    return { ...data, items: items.map(project) };
  }
  return project(data);
}
