import { describe, expect, it } from "bun:test";
import { resolvePullRequestSelector } from "../../../src/commands/pull-request-selector.js";
import type { PullRequestOperations } from "../../../src/forgejo/pull-request-service.js";

function context(pulls: readonly unknown[] = [], localBranch: string | null = "topic") {
  const requests: unknown[] = [];
  return {
    requests,
    resolved: {
      origin: "https://git.example.test",
      repository: { owner: "acme", repository: "app" },
      localBranch,
      services: {
        pullRequests: {
          list: async (_repository: unknown, options: { page: number }) => {
            requests.push(options);
            return options.page === 1 ? pulls : [];
          },
        } as unknown as PullRequestOperations,
      },
    },
  };
}

describe("pull request selector", () => {
  it("resolves a numeric index and an exact origin/repository URL without listing", async () => {
    const { resolved, requests } = context();
    expect(await resolvePullRequestSelector("42", resolved)).toBe(42);
    expect(
      await resolvePullRequestSelector("https://git.example.test/acme/app/pulls/42", resolved),
    ).toBe(42);
    expect(requests).toHaveLength(0);
  });

  it("infers current branch and resolves explicit branches by exact ref or qualified label", async () => {
    for (const value of [undefined, "topic", "fork:topic"]) {
      const { resolved, requests } = context([
        { number: 42, head: { ref: "topic", label: "fork:topic" } },
      ]);
      expect(await resolvePullRequestSelector(value, resolved)).toBe(42);
      expect(requests).toEqual([
        { head: "topic", state: "open", page: 1, limit: 100 },
        { head: "topic", state: "open", page: 2, limit: 100 },
      ]);
    }
  });

  it("refuses foreign URLs, detached heads, absent and ambiguous matches", async () => {
    const { resolved } = context();
    for (const value of [
      "https://evil.test/acme/app/pulls/42",
      "https://git.example.test/acme/other/pulls/42",
      "https://user:secret@git.example.test/acme/app/pulls/42",
      "https://git.example.test/acme/app/pulls/42?secret=x",
      "0",
    ]) {
      await expect(resolvePullRequestSelector(value, resolved)).rejects.toMatchObject({
        code: "validation_failed",
      });
    }
    await expect(
      resolvePullRequestSelector(undefined, context([], null).resolved),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(resolvePullRequestSelector("missing", resolved)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      resolvePullRequestSelector(
        "topic",
        context([
          { number: 1, head: { ref: "topic", label: "a:topic" } },
          { number: 2, head: { ref: "topic", label: "b:topic" } },
        ]).resolved,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not choose a match until all pages have ruled out ambiguity", async () => {
    const { resolved } = context();
    const pages: number[] = [];
    const pulls = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      head: { ref: i === 0 ? "topic" : "other", label: "acme:other" },
    }));
    const paginated = {
      ...resolved,
      services: {
        pullRequests: {
          list: async (_repo: unknown, options: { page: number }) => {
            pages.push(options.page);
            return options.page === 1
              ? pulls
              : [{ number: 101, head: { ref: "topic", label: "fork:topic" } }];
          },
        } as unknown as PullRequestOperations,
      },
    };
    await expect(resolvePullRequestSelector("topic", paginated)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(pages).toEqual([1, 2]);
  });
  it("searches closed branches for reopen and bounds ambiguous repository scans", async () => {
    const { resolved, requests } = context([
      { number: 42, head: { ref: "topic", label: "acme:topic" } },
    ]);
    expect(await resolvePullRequestSelector(undefined, resolved, { state: "closed" })).toBe(42);
    expect(requests).toEqual([
      { head: "topic", state: "closed", page: 1, limit: 100 },
      { head: "topic", state: "closed", page: 2, limit: 100 },
    ]);
    let calls = 0;
    const capped = {
      ...resolved,
      services: {
        pullRequests: {
          list: async () => {
            calls += 1;
            return Array.from({ length: 100 }, () => ({
              number: 42,
              head: { ref: "topic", label: "acme:topic" },
            }));
          },
        } as unknown as PullRequestOperations,
      },
    };
    await expect(resolvePullRequestSelector("topic", capped)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(calls).toBe(100);
  });
  it("checks later pages even when a server caps page size below the requested limit", async () => {
    const { resolved } = context();
    const capped = {
      ...resolved,
      services: {
        pullRequests: {
          list: async (_repo: unknown, options: { page: number }) => [
            { number: options.page, head: { ref: "topic", label: `fork${options.page}:topic` } },
          ],
        } as unknown as PullRequestOperations,
      },
    };
    await expect(resolvePullRequestSelector("topic", capped)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
