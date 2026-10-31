import { z } from "zod";
import { CliError } from "../src/core/errors.js";
import type { ForgejoApi } from "../src/http/forgejo-api.js";
import { normalizeOrigin } from "../src/http/origin.js";

export function fixtureTarget(host: string, repository: string, confirmation: string) {
  const origin = normalizeOrigin(host);
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)\/(forgejo-cli-e2e-[a-z0-9-]+)$/.exec(repository);
  if (!match?.[1] || !match[2] || repository.length > 180 || confirmation !== repository) {
    throw new CliError(
      "validation_failed",
      "Live tests require owner/forgejo-cli-e2e-<unique-name> and its exact --confirm value.",
    );
  }
  return Object.freeze({ origin, repository, owner: match[1], name: match[2] });
}

export type FixtureTarget = ReturnType<typeof fixtureTarget>;

const fixtureSchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string(),
  private: z.literal(true),
  default_branch: z.literal("main"),
});

export async function createLiveFixture(api: ForgejoApi, target: FixtureTarget) {
  const created = fixtureSchema.parse(
    await api.request({
      method: "POST",
      path: ["orgs", target.owner, "repos"],
      body: {
        name: target.name,
        description:
          "Dedicated Forgejo CLI E2E evidence. Contains no application or customer data.",
        private: true,
        auto_init: true,
        default_branch: "main",
      },
    }),
  );
  if (created.full_name !== target.repository) {
    throw new CliError("protocol_failed", "Fixture creation returned a different repository.");
  }
  const verified = fixtureSchema.parse(
    await api.request({
      method: "GET",
      path: ["repos", target.owner, target.name],
    }),
  );
  if (verified.id !== created.id || verified.full_name !== target.repository) {
    throw new CliError("protocol_failed", "Fixture identity changed during verification.");
  }
  return Object.freeze({ ...target, id: verified.id });
}
