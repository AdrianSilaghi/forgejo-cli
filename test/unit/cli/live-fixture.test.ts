import { describe, expect, it } from "bun:test";
import { createLiveFixture, fixtureTarget } from "../../../scripts/live-fixture.js";
import type { ForgejoRequest } from "../../../src/http/forgejo-api.js";

describe("live E2E fixture isolation", () => {
  it("requires HTTPS, a dedicated repository name and exact confirmation", () => {
    for (const [host, repository, confirmation] of [
      ["http://git.example.test", "acme/forgejo-cli-e2e-test", "acme/forgejo-cli-e2e-test"],
      ["https://git.example.test", "acme/production", "acme/production"],
      ["https://git.example.test", "acme/forgejo-cli-e2e-test", "wrong"],
      ["https://git.example.test", "acme/../forgejo-cli-e2e-test", "acme/../forgejo-cli-e2e-test"],
    ] as const) {
      expect(() => fixtureTarget(host, repository, confirmation)).toThrow();
    }
  });

  it("creates only a private dedicated repository and verifies its identity", async () => {
    const requests: ForgejoRequest[] = [];
    const fixture = await createLiveFixture(
      {
        request: async (request) => {
          requests.push(request);
          return {
            id: 7,
            full_name: "acme/forgejo-cli-e2e-test",
            private: true,
            default_branch: "main",
          };
        },
      },
      fixtureTarget(
        "https://git.example.test",
        "acme/forgejo-cli-e2e-test",
        "acme/forgejo-cli-e2e-test",
      ),
    );
    expect(fixture.id).toBe(7);
    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: ["orgs", "acme", "repos"],
        body: expect.objectContaining({
          private: true,
          auto_init: true,
          name: "forgejo-cli-e2e-test",
        }),
      }),
      expect.objectContaining({ method: "GET", path: ["repos", "acme", "forgejo-cli-e2e-test"] }),
    ]);
  });

  it("fails closed on public or mismatched server responses", async () => {
    const target = fixtureTarget(
      "https://git.example.test",
      "acme/forgejo-cli-e2e-test",
      "acme/forgejo-cli-e2e-test",
    );
    for (const response of [
      { id: 7, full_name: target.repository, private: false, default_branch: "main" },
      { id: 7, full_name: "acme/production", private: true, default_branch: "main" },
    ]) {
      await expect(createLiveFixture({ request: async () => response }, target)).rejects.toThrow();
    }
  });
});
