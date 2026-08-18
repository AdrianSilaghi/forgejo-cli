import type { Command } from "commander";

import { parsePositiveInteger } from "../cli/command-options.js";
import type { PaginationOptions } from "../cli/pagination.js";
import { CliError } from "../core/errors.js";

const MAX_PAGE_SIZE = 100;
const MAX_PAGINATED_ITEMS = 10_000;

export type RawPaginationOptions = Readonly<{
  page?: string;
  limit?: string;
  paginate?: boolean;
  maxItems?: string;
}>;

export function withPaginationOptions(command: Command): Command {
  return command
    .option("--page <number>", "Page number", "1")
    .option("--limit <number>", "Items per request", "30")
    .option("--paginate", "Fetch additional pages")
    .option("--max-items <number>", "Required upper bound when --paginate is used");
}

export function paginationOptions(options: RawPaginationOptions): PaginationOptions {
  const limit = parsePositiveInteger(options.limit ?? "30", "limit");
  const maxItems =
    options.maxItems === undefined
      ? undefined
      : parsePositiveInteger(options.maxItems, "max-items");
  if (limit > MAX_PAGE_SIZE) {
    throw new CliError("validation_failed", `limit cannot exceed ${MAX_PAGE_SIZE}.`);
  }
  if (maxItems !== undefined && maxItems > MAX_PAGINATED_ITEMS) {
    throw new CliError("validation_failed", `max-items cannot exceed ${MAX_PAGINATED_ITEMS}.`);
  }
  return Object.freeze({
    page: parsePositiveInteger(options.page ?? "1", "page"),
    limit,
    paginate: options.paginate === true,
    ...(maxItems === undefined ? {} : { maxItems }),
  });
}
