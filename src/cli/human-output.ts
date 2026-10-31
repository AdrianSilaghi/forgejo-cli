const TABLE_FIELDS = [
  "index",
  "number",
  "id",
  "title",
  "name",
  "state",
  "status",
  "workflow",
  "ref",
  "defaultBranch",
  "tagName",
  "description",
  "htmlUrl",
] as const;

export function safeTerminalText(value: string, singleLine = false): string {
  // Escape untrusted terminal controls, keeping the structure of explicit logs and diffs.
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    if (!singleLine && (character === "\n" || character === "\t")) return character;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
    return character;
  }).join("");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cell(value: unknown): string {
  return safeTerminalText(typeof value === "string" ? value : (JSON.stringify(value) ?? ""), true);
}

function table(rows: readonly Readonly<Record<string, unknown>>[], projected: boolean): string {
  if (rows.length === 0) return "No results.";
  const fields = projected
    ? Object.keys(rows[0] ?? {})
    : TABLE_FIELDS.filter((field) => rows.some((row) => Object.hasOwn(row, field)));
  if (fields.length === 0) return safeTerminalText(JSON.stringify(rows, null, 2));
  const lines = [
    fields.map((field) => field.toUpperCase()),
    ...rows.map((row) => fields.map((field) => cell(row[field]))),
  ];
  const widths = fields.map((_, index) =>
    Math.max(...lines.map((line) => line[index]?.length ?? 0)),
  );
  return lines
    .map((line) =>
      line
        .map((value, index) =>
          index === line.length - 1 ? value : value.padEnd(widths[index] ?? 0),
        )
        .join("  "),
    )
    .join("\n");
}

export function humanOutput(data: unknown, projected = false): string {
  const { items, jobs } = isRecord(data) ? data : {};
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(items)
      ? items
      : Array.isArray(jobs)
        ? jobs
        : undefined;
  if (rows?.every(isRecord)) return table(rows, projected);
  if (isRecord(data)) {
    return Object.entries(data)
      .map(([key, value]) => `${safeTerminalText(key, true)}: ${cell(value)}`)
      .join("\n");
  }
  return cell(data);
}
