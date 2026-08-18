import { describe, expect, it } from "bun:test";

import type { ForgejoConfig } from "../../../src/config/config-repository.js";
import {
  RepositoryContextResolver,
  type GitRepositoryReader,
} from "../../../src/git/repository-context.js";

class RecordingGitRepositoryReader implements GitRepositoryReader {
  readonly calls: Array<Readonly<{ cwd: string; remote: string }>> = [];

  public constructor(private readonly value: string) {}

  public async getRemoteUrl(input: { cwd: string; remote: string }): Promise<string> {
    this.calls.push(Object.freeze({ ...input }));
    return this.value;
  }
}

function config(
  accounts: ForgejoConfig["accounts"] = [],
): Readonly<{ load(): Promise<ForgejoConfig> }> {
  return {
    async load() {
      return { schema_version: 1, accounts };
    },
  };
}

describe("RepositoryContextResolver", () => {
  it("uses an explicit repository and host without consulting Git", async () => {
    const git = new RecordingGitRepositoryReader("https://wrong.example/other/repository.git");
    const resolver = new RepositoryContextResolver({ git, accounts: config() });

    const result = await resolver.resolve({
      cwd: "/work/repository",
      repository: "acme/widget",
      host: "https://GIT.example.com:8443",
    });

    expect(result).toEqual({
      origin: "https://git.example.com:8443",
      owner: "acme",
      repository: "widget",
      sources: { origin: "explicit", repository: "explicit" },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sources)).toBe(true);
    expect(git.calls).toEqual([]);
  });

  it("lets an explicit repository override Git while retaining the exact HTTPS remote origin", async () => {
    const git = new RecordingGitRepositoryReader("https://git.example.com:8443/ignored/remote.git");
    const resolver = new RepositoryContextResolver({ git, accounts: config() });

    await expect(
      resolver.resolve({ cwd: "/work/repository", repository: "acme/widget" }),
    ).resolves.toEqual({
      origin: "https://git.example.com:8443",
      owner: "acme",
      repository: "widget",
      sources: { origin: "git_https", repository: "explicit" },
    });
  });

  it("uses an explicit host with Git coordinates only when the remote origin matches", async () => {
    const git = new RecordingGitRepositoryReader("https://new.example:9443/remote/widget.git");
    const resolver = new RepositoryContextResolver({ git, accounts: config() });

    await expect(
      resolver.resolve({ cwd: "/work/repository", host: "https://new.example:9443" }),
    ).resolves.toEqual({
      origin: "https://new.example:9443",
      owner: "remote",
      repository: "widget",
      sources: { origin: "explicit", repository: "git" },
    });
  });

  it("never combines an explicit host credential with coordinates from another remote", async () => {
    const git = new RecordingGitRepositoryReader("https://attacker.example/acme/widget.git");
    const resolver = new RepositoryContextResolver({ git, accounts: config() });

    await expect(
      resolver.resolve({ cwd: "/work/repository", host: "https://git.example.com" }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("does not match"),
    });
  });

  it("resolves an HTTPS remote without losing its non-default port", async () => {
    const git = new RecordingGitRepositoryReader("https://git.example.com:8443/acme/widget.git");
    const resolver = new RepositoryContextResolver({ git, accounts: config() });

    await expect(resolver.resolve({ cwd: "/work/repository" })).resolves.toEqual({
      origin: "https://git.example.com:8443",
      owner: "acme",
      repository: "widget",
      sources: { origin: "git_https", repository: "git" },
    });
    expect(git.calls).toEqual([{ cwd: "/work/repository", remote: "origin" }]);
  });

  it("maps an SSH remote only when configured accounts identify exactly one HTTPS origin", async () => {
    const git = new RecordingGitRepositoryReader("git@git.example.com:acme/widget.git");
    const resolver = new RepositoryContextResolver({
      git,
      accounts: config([
        {
          origin: "https://git.example.com:8443",
          username: "agent-one",
          default: true,
        },
        {
          origin: "https://git.example.com:8443",
          username: "agent-two",
          default: false,
        },
      ]),
    });

    await expect(resolver.resolve({ cwd: "/work/repository" })).resolves.toEqual({
      origin: "https://git.example.com:8443",
      owner: "acme",
      repository: "widget",
      sources: { origin: "configured_account", repository: "git" },
    });
  });

  it("requires an explicit host to match the configured origin for an SSH remote", async () => {
    const git = new RecordingGitRepositoryReader("git@git.example.com:acme/widget.git");
    const resolver = new RepositoryContextResolver({
      git,
      accounts: config([
        {
          origin: "https://git.example.com:8443",
          username: "agent",
          default: true,
        },
      ]),
    });

    await expect(
      resolver.resolve({ cwd: "/work/repository", host: "https://git.example.com" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      resolver.resolve({ cwd: "/work/repository", host: "https://git.example.com:8443" }),
    ).resolves.toMatchObject({
      origin: "https://git.example.com:8443",
      owner: "acme",
      repository: "widget",
      sources: { origin: "explicit", repository: "git" },
    });
  });

  it("fails closed when an SSH host maps to multiple configured HTTPS origins", async () => {
    const git = new RecordingGitRepositoryReader("ssh://git@git.example.com/acme/widget.git");
    const resolver = new RepositoryContextResolver({
      git,
      accounts: config([
        {
          origin: "https://git.example.com",
          username: "agent",
          default: true,
        },
        {
          origin: "https://git.example.com:8443",
          username: "agent",
          default: true,
        },
      ]),
    });

    await expect(resolver.resolve({ cwd: "/work/repository" })).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("ambiguous"),
    });
  });

  it("never guesses an HTTPS origin for an unconfigured SSH remote", async () => {
    const git = new RecordingGitRepositoryReader("git@git.example.com:acme/widget.git");
    const resolver = new RepositoryContextResolver({ git, accounts: config() });

    await expect(resolver.resolve({ cwd: "/work/repository" })).rejects.toMatchObject({
      code: "not_authenticated",
    });
  });

  it.each(["owner", "owner/repository/extra", "../repository", "owner/repo name"])(
    "rejects invalid explicit repository %s",
    async (repository) => {
      const resolver = new RepositoryContextResolver({
        git: new RecordingGitRepositoryReader("https://git.example.com/acme/widget.git"),
        accounts: config(),
      });

      await expect(
        resolver.resolve({ repository, host: "https://git.example.com" }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    },
  );

  it("bounds explicit repository segments", async () => {
    const resolver = new RepositoryContextResolver({
      git: new RecordingGitRepositoryReader("https://git.example.com/acme/widget.git"),
      accounts: config(),
    });

    await expect(
      resolver.resolve({
        repository: `owner/${"a".repeat(256)}`,
        host: "https://git.example.com",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
