import { CliError } from "../core/errors.js";

export type PaginationOptions = Readonly<{
  page: number;
  limit: number;
  paginate: boolean;
  maxItems?: number;
}>;

export type PaginatedResult<T> = Readonly<{
  items: readonly T[];
  pagination: Readonly<{
    page: number;
    limit: number;
    itemCount: number;
    hasNextPage: boolean;
    truncated: boolean;
  }>;
}>;

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliError("validation_failed", `${name} must be a positive safe integer.`);
  }
}

export async function collectPages<T>(
  fetchPage: (page: number, limit: number) => Promise<readonly T[]>,
  options: PaginationOptions,
): Promise<PaginatedResult<T>> {
  assertPositiveInteger(options.page, "page");
  assertPositiveInteger(options.limit, "limit");
  if (options.paginate && options.maxItems === undefined) {
    throw new CliError("validation_failed", "--paginate requires a positive --max-items bound.");
  }
  if (options.maxItems !== undefined) assertPositiveInteger(options.maxItems, "max-items");

  if (!options.paginate) {
    const items = Object.freeze([...(await fetchPage(options.page, options.limit))]);
    return Object.freeze({
      items,
      pagination: Object.freeze({
        page: options.page,
        limit: options.limit,
        itemCount: items.length,
        hasNextPage: items.length === options.limit,
        truncated: false,
      }),
    });
  }

  const maxItems = options.maxItems as number;
  let items: readonly T[] = Object.freeze([]);
  let page = options.page;
  let hasNextPage = false;

  while (items.length < maxItems) {
    const requestLimit = Math.min(options.limit, maxItems - items.length);
    const received = await fetchPage(page, requestLimit);
    const accepted = received.slice(0, requestLimit);
    items = Object.freeze([...items, ...accepted]);
    hasNextPage = received.length >= requestLimit;
    if (!hasNextPage || accepted.length === 0) break;
    page += 1;
  }

  const truncated = items.length === maxItems && hasNextPage;
  return Object.freeze({
    items,
    pagination: Object.freeze({
      page: options.page,
      limit: options.limit,
      itemCount: items.length,
      hasNextPage,
      truncated,
    }),
  });
}
