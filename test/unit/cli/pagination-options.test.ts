import { describe, expect, it } from "bun:test";

import { paginationOptions } from "../../../src/commands/pagination-options.js";

describe("paginationOptions", () => {
  it("enforces Forgejo page-size and agent-operation bounds", () => {
    expect(() => paginationOptions({ limit: "101" })).toThrow();
    expect(() => paginationOptions({ paginate: true, limit: "100", maxItems: "10001" })).toThrow();
    expect(paginationOptions({ paginate: true, limit: "100", maxItems: "10000" })).toEqual({
      page: 1,
      limit: 100,
      paginate: true,
      maxItems: 10000,
    });
  });
});
