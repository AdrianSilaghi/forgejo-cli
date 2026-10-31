import { describe, expect, it } from "bun:test";

import { collectPages } from "../../../src/cli/pagination.js";

describe("collectPages", () => {
  it("returns one immutable page with explicit metadata by default", async () => {
    const result = await collectPages(async () => Object.freeze([1, 2]), {
      page: 3,
      limit: 2,
      paginate: false,
    });

    expect(result).toEqual({
      items: [1, 2],
      pagination: { page: 3, limit: 2, itemCount: 2, hasNextPage: true, truncated: false },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
  });

  it("requires and enforces a positive max-items bound when paginating", async () => {
    await expect(
      collectPages(async () => [], { page: 1, limit: 2, paginate: true }),
    ).rejects.toThrow();

    const calls: unknown[] = [];
    const result = await collectPages(
      async (page, limit) => {
        calls.push({ page, limit });
        return page > 3 ? [] : Array.from({ length: limit }, (_, index) => `${page}:${index}`);
      },
      { page: 2, limit: 2, paginate: true, maxItems: 3 },
    );

    expect(calls).toEqual([
      { page: 2, limit: 2 },
      { page: 3, limit: 2 },
    ]);
    expect(result.items).toHaveLength(3);
    expect(result.pagination).toEqual({
      page: 2,
      limit: 2,
      itemCount: 3,
      hasNextPage: true,
      truncated: true,
    });
  });

  it("keeps the page size stable when max-items ends inside a later page", async () => {
    const issueNumbers = Object.freeze([397, 396, 395, 394]);
    const calls: unknown[] = [];
    const result = await collectPages(
      async (page, limit) => {
        calls.push({ page, limit });
        const offset = (page - 1) * limit;
        return issueNumbers.slice(offset, offset + limit);
      },
      { page: 1, limit: 2, paginate: true, maxItems: 3 },
    );

    expect({ calls, items: result.items }).toEqual({
      calls: [
        { page: 1, limit: 2 },
        { page: 2, limit: 2 },
      ],
      items: [397, 396, 395],
    });
  });

  it("continues short pages when the server caps page size below the requested limit", async () => {
    const calls: number[] = [];
    const pages = [[1, 2], [3], []];
    const result = await collectPages(
      async (page, limit) => {
        calls.push(page);
        expect(limit).toBe(100);
        return pages[page - 1] ?? [];
      },
      { page: 1, limit: 100, paginate: true, maxItems: 10 },
    );
    expect(calls).toEqual([1, 2, 3]);
    expect(result).toEqual({
      items: [1, 2, 3],
      pagination: { page: 1, limit: 100, itemCount: 3, hasNextPage: false, truncated: false },
    });
  });

  it("bounds requests even when the server returns only one item on every page", async () => {
    const calls: number[] = [];
    const result = await collectPages(
      async (page) => {
        calls.push(page);
        return [page];
      },
      { page: 1, limit: 100, paginate: true, maxItems: 3 },
    );
    expect(calls).toEqual([1, 2, 3]);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.pagination).toMatchObject({ hasNextPage: true, truncated: true });
  });

  it("conservatively reports the bound when an exact fit has not proved exhaustion", async () => {
    const calls: number[] = [];
    const result = await collectPages(
      async (page) => {
        calls.push(page);
        return page === 1 ? [1, 2] : [];
      },
      { page: 1, limit: 100, paginate: true, maxItems: 2 },
    );
    expect(calls).toEqual([1]);
    expect(result.pagination).toMatchObject({ hasNextPage: true, truncated: true });
  });

  it("reports truncation when max-items omits entries from a short page", async () => {
    const result = await collectPages(
      async (page) => Object.freeze(page === 1 ? [1, 2, 3, 4] : []),
      {
        page: 1,
        limit: 5,
        paginate: true,
        maxItems: 3,
      },
    );

    expect(result).toEqual({
      items: [1, 2, 3],
      pagination: {
        page: 1,
        limit: 5,
        itemCount: 3,
        hasNextPage: true,
        truncated: true,
      },
    });
  });
});
