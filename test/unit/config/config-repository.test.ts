import { afterEach, describe, expect, it } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigRepository } from "../../../src/config/config-repository.js";

const temporaryDirectories: string[] = [];

async function temporaryConfigPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forgejo-cli-config-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "config.json");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ConfigRepository", () => {
  it("returns an immutable empty config when no file exists", async () => {
    const repository = new ConfigRepository(await temporaryConfigPath());

    await expect(repository.load()).resolves.toEqual({ schema_version: 1, accounts: [] });
  });

  it("atomically stores account metadata with owner-only permissions and no token", async () => {
    const path = await temporaryConfigPath();
    const repository = new ConfigRepository(path);

    const saved = await repository.upsertAccount({
      origin: "https://git.example.com",
      username: "agent",
    });

    expect(saved).toEqual({
      schema_version: 1,
      accounts: [{ origin: "https://git.example.com", username: "agent", default: true }],
    });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const contents = await readFile(path, "utf8");
    expect(contents).not.toContain("token");
    expect(JSON.parse(contents)).toEqual(saved);
  });

  it("keeps exactly one default account per origin without mutating previous values", async () => {
    const repository = new ConfigRepository(await temporaryConfigPath());
    const first = await repository.upsertAccount({
      origin: "https://git.example.com",
      username: "alice",
    });
    const second = await repository.upsertAccount({
      origin: "https://git.example.com",
      username: "bob",
    });

    expect(first.accounts).toEqual([
      { origin: "https://git.example.com", username: "alice", default: true },
    ]);
    expect(second.accounts).toEqual([
      { origin: "https://git.example.com", username: "alice", default: false },
      { origin: "https://git.example.com", username: "bob", default: true },
    ]);
  });

  it("rejects symlink config files and invalid or secret-bearing config", async () => {
    const path = await temporaryConfigPath();
    const parent = join(path, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const target = join(parent, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, path);
    const repository = new ConfigRepository(path);

    await expect(
      repository.upsertAccount({ origin: "https://git.example.com", username: "agent" }),
    ).rejects.toMatchObject({ code: "config_failed" });

    await rm(path);
    await writeFile(path, JSON.stringify({ schema_version: 1, accounts: [], token: "reject" }), {
      mode: 0o600,
    });
    await expect(repository.load()).rejects.toMatchObject({ code: "config_failed" });
  });

  it("rejects a configuration inside a group- or world-accessible directory", async () => {
    const path = await temporaryConfigPath();
    const parent = join(path, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ schema_version: 1, accounts: [] }), { mode: 0o600 });
    await chmod(parent, 0o755);

    await expect(new ConfigRepository(path).load()).rejects.toMatchObject({
      code: "config_failed",
    });
  });

  it("rejects oversized configuration before parsing", async () => {
    const path = await temporaryConfigPath();
    const parent = join(path, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await writeFile(path, " ".repeat(1024 * 1024 + 1), { mode: 0o600 });

    await expect(new ConfigRepository(path).load()).rejects.toMatchObject({
      code: "config_failed",
      message: expect.stringContaining("size limit"),
    });
  });
});
