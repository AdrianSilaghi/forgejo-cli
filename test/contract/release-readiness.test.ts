import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function repositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, `file://${repositoryRoot}/`), "utf8");
}

async function optionalRepositoryFile(path: string): Promise<string> {
  try {
    return await repositoryFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mappingBlock(source: string, key: string): string {
  const lines = source.split(/\r?\n/);
  const keyPattern = new RegExp(`^(\\s*)["']?${escapeRegExp(key)}["']?\\s*:\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => keyPattern.test(line));
  if (start < 0) return "";

  const indentation = keyPattern.exec(lines[start] ?? "")?.[1]?.length ?? 0;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() !== "" && !line.trimStart().startsWith("#")) {
      const nextIndentation = /^\s*/.exec(line)?.[0].length ?? 0;
      if (nextIndentation <= indentation) break;
    }
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

function occurrences(source: string, pattern: RegExp): number {
  return [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))]
    .length;
}

function scalarMappingEntries(block: string): readonly string[] {
  return Object.freeze(
    block
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line) => {
        const match = /^\s+["']?([a-z-]+)["']?\s*:\s*["']?([a-z]+)["']?\s*(?:#.*)?$/i.exec(line);
        return match?.[1] === undefined || match[2] === undefined
          ? []
          : [`${match[1]}:${match[2]}`];
      })
      .sort(),
  );
}

function sequenceItemContaining(source: string, needle: string): string {
  const lines = source.split(/\r?\n/);
  const target = lines.findIndex((line) => line.includes(needle));
  if (target < 0) return "";

  let start = target;
  let indentation = -1;
  while (start >= 0) {
    const match = /^(\s*)-\s+/.exec(lines[start] ?? "");
    if (match?.[1] !== undefined) {
      indentation = match[1].length;
      break;
    }
    start -= 1;
  }
  if (start < 0) return "";

  let end = target + 1;
  while (end < lines.length) {
    const match = /^(\s*)-\s+/.exec(lines[end] ?? "");
    if (match?.[1]?.length === indentation) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

describe("release readiness", () => {
  it("publishes the DanubeData package while preserving its executable and provenance identity", async () => {
    const manifest = JSON.parse(await repositoryFile("package.json")) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      name: "@danubedata/forgejo-cli",
      license: "MIT",
      bin: { forgejo: "dist/bin/forgejo.js" },
      repository: {
        type: "git",
        url: "git+https://github.com/AdrianSilaghi/forgejo-cli.git",
      },
      bugs: { url: "https://github.com/AdrianSilaghi/forgejo-cli/issues" },
      homepage: "https://github.com/AdrianSilaghi/forgejo-cli#readme",
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/",
      },
    });
  });

  it("documents the DanubeData origin, global npm install, and one-time workflow bootstrap", async () => {
    const readme = await repositoryFile("README.md");
    const prose = readme.replace(/\s+/g, " ");

    expect(prose).toMatch(/originally built for DanubeData(?:'s)? .* workflow/i);
    expect(readme).toContain("npm install --global @danubedata/forgejo-cli");
    expect(readme).toMatch(/(?:initial publication|bootstrap)/i);
    expect(readme).toContain("@danubedata/forgejo-cli@0.1.0");
    expect(readme).toContain("AdrianSilaghi/forgejo-cli");
    expect(readme).toMatch(/gh workflow run\s+bootstrap-npm\.yml/);
    expect(readme).toContain("@danubedata/forgejo-cli@0.1.0");
    expect(readme).toContain("NPM_TOKEN");
    expect(prose).toMatch(/NPM_TOKEN.*granular.*@danubedata/i);
    expect(prose).toMatch(/bypass (?:2FA|two-factor)/i);
    expect(readme).toContain("release.yml");
    expect(readme).toMatch(/(?:2FA|two-factor)/i);
    expect(readme).toMatch(/trusted publish/i);
    expect(prose).toMatch(/(?:delete|remove).*NPM_TOKEN/i);

    const runBootstrap = prose.indexOf("bootstrap-npm.yml");
    const configureOidc = prose.indexOf("release.yml", runBootstrap);
    const removeTokenOffset = prose.slice(configureOidc).search(/(?:delete|remove).*NPM_TOKEN/i);
    const removeToken =
      removeTokenOffset < 0 ? removeTokenOffset : configureOidc + removeTokenOffset;
    expect(runBootstrap).toBeGreaterThanOrEqual(0);
    expect(configureOidc).toBeGreaterThan(runBootstrap);
    expect(removeToken).toBeGreaterThan(configureOidc);
  });

  it("attributes the MIT license to Adrian Silaghi and DanubeData contributors", async () => {
    const license = await repositoryFile("LICENSE");

    expect(license).toMatch(
      /^Copyright \(c\) 2026 Adrian Silaghi (?:and|&) DanubeData contributors$/m,
    );
  });

  it("pins Node 24 and verifies the npm trusted-publishing runtime without a cache", async () => {
    const workflow = await repositoryFile(".github/workflows/release.yml");
    const publishNpm = mappingBlock(workflow, "publish-npm");

    expect(publishNpm).toMatch(/uses\s*:\s*actions\/setup-node@[0-9a-f]{40}(?:\s|#|$)/);
    expect(publishNpm).toMatch(/node-version\s*:\s*["']?24["']?(?:\s|#|$)/);
    expect(publishNpm).toMatch(
      /registry-url\s*:\s*["']?https:\/\/registry\.npmjs\.org\/?["']?(?:\s|#|$)/,
    );
    expect(publishNpm).toMatch(/package-manager-cache\s*:\s*false(?:\s|#|$)/);
    expect(publishNpm).not.toMatch(/^\s*cache(?:-dependency-path)?\s*:/m);
    expect(publishNpm).toContain("11.5.1");
    expect(publishNpm).toMatch(/npm\s+--version/);
  });

  it("keeps the signed-tag, OIDC, staged-release, and tarball publication gates", async () => {
    const workflow = await repositoryFile(".github/workflows/release.yml");
    const build = mappingBlock(workflow, "build");
    const stageRelease = mappingBlock(workflow, "stage-release");
    const publishNpm = mappingBlock(workflow, "publish-npm");
    const publish = mappingBlock(workflow, "publish");

    expect(build).toMatch(/id-token\s*:\s*write/);
    expect(publishNpm).toMatch(/id-token\s*:\s*write/);
    expect(occurrences(workflow, /git verify-tag/)).toBeGreaterThanOrEqual(2);
    expect(occurrences(workflow, /git merge-base\s+--is-ancestor/)).toBeGreaterThanOrEqual(2);
    expect(occurrences(workflow, /origin\/main/)).toBeGreaterThanOrEqual(2);

    expect(stageRelease).toMatch(/needs\s*:\s*(?:\[\s*)?build/);
    expect(stageRelease).toContain("--draft");
    expect(publishNpm).toMatch(/needs\s*:\s*(?:\[\s*)?stage-release/);
    expect(publishNpm).toContain("package.json");
    expect(publishNpm).toContain("GITHUB_REF_NAME");
    expect(publishNpm).toMatch(/npm\s+pack/);
    expect(publishNpm).toMatch(/npm\s+install[\s\S]*package_tarball/);
    expect(publishNpm).toContain("node_modules/.bin/forgejo");
    expect(publishNpm).toMatch(/npm\s+publish[\s\S]*--access public[\s\S]*--provenance/);
    expect(publishNpm).toMatch(/npm\s+publish[^\n]*--ignore-scripts/);

    expect(publish).toMatch(/needs\s*:\s*(?:\[\s*)?publish-npm/);
    expect(publish).toMatch(/gh release edit[\s\S]*--draft=false/);
  });

  it("validates the tag, package, and CLI versions before building release artifacts", async () => {
    const workflow = await repositoryFile(".github/workflows/release.yml");
    const validate = mappingBlock(workflow, "validate");
    const build = mappingBlock(workflow, "build");
    const stageRelease = mappingBlock(workflow, "stage-release");

    expect(validate).toMatch(/git verify-tag/);
    expect(validate).toMatch(/git merge-base\s+--is-ancestor[\s\S]*origin\/main/);
    expect(validate).toContain("GITHUB_REF_NAME");
    expect(validate).toContain("package.json");
    expect(validate).toMatch(/forgejo(?:\.ts|\.js)?[^\n]*--version/);
    expect(validate).toContain("tag_version");
    expect(validate).toContain("package_version");
    expect(validate).toContain("cli_version");
    expect(occurrences(validate, /test\s+["']/)).toBeGreaterThanOrEqual(2);
    expect(validate).not.toMatch(
      /upload-artifact|attest-build-provenance|attest-sbom|gh release|npm publish|--compile/,
    );

    expect(build).toMatch(/needs\s*:\s*(?:\[\s*)?validate/);
    expect(stageRelease).toMatch(/needs\s*:\s*(?:\[\s*)?build/);
  });
});

describe("one-time npm bootstrap workflow", () => {
  it("is manual-only, explicitly confirmed, main-only, and least-privilege", async () => {
    const workflow = await optionalRepositoryFile(".github/workflows/bootstrap-npm.yml");
    const triggers = mappingBlock(workflow, "on");
    const dispatch = mappingBlock(workflow, "workflow_dispatch");
    const confirmation = mappingBlock(workflow, "confirmation");

    expect(triggers).toContain("workflow_dispatch");
    expect(triggers).not.toMatch(/\b(?:push|pull_request|schedule|workflow_call)\s*:/);
    expect(dispatch).toContain("confirmation:");
    expect(confirmation).toMatch(/required\s*:\s*true/);
    expect(confirmation).toContain("@danubedata/forgejo-cli@0.1.0");
    expect(workflow).toMatch(/CONFIRMATION\s*:\s*\$\{\{\s*inputs\.confirmation\s*\}\}/);
    expect(workflow).toMatch(/test[^\n]*CONFIRMATION[^\n]*=[^\n]*@danubedata\/forgejo-cli@0\.1\.0/);

    expect(scalarMappingEntries(mappingBlock(workflow, "permissions"))).toEqual([
      "contents:read",
      "id-token:write",
    ]);
    expect(workflow).toMatch(/GITHUB_REF(?:_NAME)?[^\n]*(?:refs\/heads\/main|["']main["'])/);
    expect(workflow).toMatch(/git fetch[^\n]*origin[^\n]*main/);
    expect(workflow).toMatch(/git rev-parse[^\n]*origin\/main/);
    expect(workflow).toMatch(
      /test[^\n]*(?:GITHUB_SHA|git rev-parse HEAD)[^\n]*=[^\n]*git rev-parse origin\/main/,
    );
  });

  it("pins its runtimes and fails closed unless exactly version 0.1.0 is unpublished", async () => {
    const workflow = await optionalRepositoryFile(".github/workflows/bootstrap-npm.yml");
    const availabilityStep = sequenceItemContaining(workflow, "npm view");

    expect(workflow).toMatch(/uses\s*:\s*actions\/setup-node@[0-9a-f]{40}(?:\s|#|$)/);
    expect(workflow).toMatch(/node-version\s*:\s*["']?24["']?(?:\s|#|$)/);
    expect(workflow).toMatch(
      /registry-url\s*:\s*["']?https:\/\/registry\.npmjs\.org\/?["']?(?:\s|#|$)/,
    );
    expect(workflow).toMatch(/package-manager-cache\s*:\s*false(?:\s|#|$)/);
    expect(workflow).not.toMatch(/^\s*cache(?:-dependency-path)?\s*:/m);
    expect(workflow).toMatch(/uses\s*:\s*oven-sh\/setup-bun@[0-9a-f]{40}(?:\s|#|$)/);
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run verify");
    expect(workflow).toMatch(/package\.json/);
    expect(workflow).toMatch(/test[^\n]*(?:package_version|package\.json)[^\n]*=[^\n]*0\.1\.0/);

    expect(availabilityStep).toMatch(
      /npm\s+view\s+["']?@danubedata\/forgejo-cli@0\.1\.0["']?\s+version/,
    );
    expect(availabilityStep).toContain("E404");
    expect(occurrences(availabilityStep, /exit\s+1/)).toBeGreaterThanOrEqual(2);
  });

  it("smoke-tests the tarball and exposes NPM_TOKEN only to npm publish", async () => {
    const workflow = await optionalRepositoryFile(".github/workflows/bootstrap-npm.yml");
    const publishStep = sequenceItemContaining(
      workflow,
      `npm publish "\${{ steps.package.outputs.tarball }}"`,
    );
    const nodeAuthTokenValues = [
      ...publishStep.matchAll(/^\s*NODE_AUTH_TOKEN\s*:\s*([^#\n]+)$/gm),
    ].map((match) => match[1]?.trim());

    expect(workflow).toMatch(/npm\s+pack/);
    expect(workflow).toMatch(/npm\s+install[\s\S]*package_tarball/);
    expect(workflow).toContain("node_modules/.bin/forgejo");
    expect(workflow).toMatch(/npm\s+publish[\s\S]*package_tarball[\s\S]*--access public/);
    expect(workflow).toMatch(/npm\s+publish[\s\S]*package_tarball[\s\S]*--provenance/);
    expect(publishStep).toMatch(/npm\s+publish[^\n]*--ignore-scripts/);
    expect(nodeAuthTokenValues).toEqual([`\${{ secrets.NPM_TOKEN }}`]);
    expect(occurrences(workflow, /secrets\.NPM_TOKEN/)).toBe(1);
    expect(workflow).not.toMatch(/set\s+-x/);
    expect(workflow).not.toMatch(
      /\b(?:echo|printf|printenv|env|npm config get)\b[^\n]*(?:NPM_TOKEN|NODE_AUTH_TOKEN)/,
    );
  });
});
