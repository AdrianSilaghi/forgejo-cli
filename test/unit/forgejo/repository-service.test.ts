import { describe, expect, it } from "bun:test";
import { RepositoryService } from "../../../src/forgejo/repository-service.js";
import type { ForgejoApi, ForgejoRequest } from "../../../src/http/forgejo-api.js";

class RecordingApi implements ForgejoApi {
  public readonly requests: ForgejoRequest[] = [];

  public constructor(private readonly response: unknown) {}

  public async request(request: ForgejoRequest): Promise<unknown> {
    this.requests.push(request);
    return this.response;
  }
}

describe("RepositoryService", () => {
  it("views a repository through the exact Forgejo path and returns a detached immutable value", async () => {
    const response = {
      id: 41,
      name: "widget",
      full_name: "acme/widget",
      description: "Agent tools",
      default_branch: "main",
      private: true,
      internal: false,
      fork: false,
      archived: false,
      html_url: "https://git.example.com/acme/widget",
      ssh_url: "ssh://git@git.example.com/acme/widget.git",
      clone_url: "https://git.example.com/acme/widget.git",
      owner: { id: 7, login: "acme", full_name: "Acme Incorporated" },
      stars_count: 9,
      forks_count: 3,
      open_issues_count: 4,
      open_pr_counter: 2,
      created_at: "2026-08-01T10:00:00Z",
      updated_at: "2026-08-18T09:30:00Z",
      server_only_field: "ignored",
    };
    const api = new RecordingApi(response);

    const repository = await new RepositoryService(api).view({
      owner: "acme",
      repository: "widget",
    });

    expect(api.requests).toEqual([{ method: "GET", path: ["repos", "acme", "widget"] }]);
    expect(repository).toEqual({
      id: 41,
      name: "widget",
      fullName: "acme/widget",
      description: "Agent tools",
      defaultBranch: "main",
      private: true,
      internal: false,
      fork: false,
      archived: false,
      htmlUrl: "https://git.example.com/acme/widget",
      sshUrl: "ssh://git@git.example.com/acme/widget.git",
      cloneUrl: "https://git.example.com/acme/widget.git",
      owner: { id: 7, login: "acme", fullName: "Acme Incorporated" },
      starsCount: 9,
      forksCount: 3,
      openIssuesCount: 4,
      openPullRequestsCount: 2,
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-18T09:30:00Z",
    });
    expect(repository).not.toBe(response);
    expect(Object.isFrozen(repository)).toBe(true);
    expect(Object.isFrozen(repository.owner)).toBe(true);
  });

  it("rejects a malformed Forgejo repository response at runtime", async () => {
    const api = new RecordingApi({ id: "not-a-number", name: "widget" });

    await expect(
      new RepositoryService(api).view({ owner: "acme", repository: "widget" }),
    ).rejects.toMatchObject({ code: "protocol_failed" });
  });

  it("validates repository path segments before making a request", async () => {
    const api = new RecordingApi({});

    await expect(
      new RepositoryService(api).view({ owner: " ", repository: "widget" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      new RepositoryService(api).view({ owner: "..", repository: "widget" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(api.requests).toHaveLength(0);
  });
});
