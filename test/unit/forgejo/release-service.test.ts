import { describe, expect, it } from "bun:test";

import {
  type Release,
  ReleaseService,
  type RepositoryRef,
} from "../../../src/forgejo/release-service.js";
import type {
  ForgejoApi,
  ForgejoAssetUpload,
  ForgejoAssetUploader,
  ForgejoRequest,
} from "../../../src/http/forgejo-api.js";

const repository: RepositoryRef = Object.freeze({ owner: "acme", repository: "widget" });

const releaseResponse = {
  id: 42,
  tag_name: "v1.2.3",
  name: "Version 1.2.3",
  body: "Release notes",
  target_commitish: "main",
  draft: false,
  prerelease: true,
  hide_archive_links: false,
  created_at: "2026-08-18T09:00:00Z",
  published_at: null,
  html_url: "https://git.example.com/acme/widget/releases/tag/v1.2.3",
  tarball_url: "https://git.example.com/acme/widget/archive/v1.2.3.tar.gz",
  zipball_url: "https://git.example.com/acme/widget/archive/v1.2.3.zip",
  assets: [
    {
      id: 7,
      name: "forgejo-linux-amd64",
      size: 1_024,
      download_count: 9,
      type: "attachment",
      browser_download_url:
        "https://git.example.com/acme/widget/releases/download/v1.2.3/forgejo-linux-amd64",
      created_at: "2026-08-18T09:30:00Z",
    },
  ],
  author: { login: "ignored-api-field" },
};

const normalizedRelease: Release = {
  id: 42,
  tagName: "v1.2.3",
  name: "Version 1.2.3",
  body: "Release notes",
  targetCommitish: "main",
  draft: false,
  prerelease: true,
  hideArchiveLinks: false,
  createdAt: "2026-08-18T09:00:00Z",
  publishedAt: null,
  htmlUrl: "https://git.example.com/acme/widget/releases/tag/v1.2.3",
  tarballUrl: "https://git.example.com/acme/widget/archive/v1.2.3.tar.gz",
  zipballUrl: "https://git.example.com/acme/widget/archive/v1.2.3.zip",
  assets: [
    {
      id: 7,
      name: "forgejo-linux-amd64",
      size: 1_024,
      downloadCount: 9,
      type: "attachment",
      downloadUrl:
        "https://git.example.com/acme/widget/releases/download/v1.2.3/forgejo-linux-amd64",
      createdAt: "2026-08-18T09:30:00Z",
    },
  ],
};

class StubForgejoApi implements ForgejoApi {
  readonly calls: ForgejoRequest[] = [];
  readonly #responses: unknown[];

  public constructor(...responses: unknown[]) {
    this.#responses = [...responses];
  }

  public async request(request: ForgejoRequest): Promise<unknown> {
    this.calls.push(request);
    if (this.#responses.length === 0) {
      throw new Error("Unexpected Forgejo API request");
    }
    return this.#responses.shift();
  }
}

class StubAssetUploader implements ForgejoAssetUploader {
  readonly calls: ForgejoAssetUpload[] = [];
  readonly #response: unknown;

  public constructor(response: unknown) {
    this.#response = response;
  }

  public async uploadAsset(request: ForgejoAssetUpload): Promise<unknown> {
    this.calls.push(request);
    return this.#response;
  }
}

describe("ReleaseService", () => {
  it("lists and paginates releases using the exact Forgejo query contract", async () => {
    const api = new StubForgejoApi([releaseResponse]);
    const service = new ReleaseService(api);

    const page = await service.list(repository, {
      page: 2,
      limit: 1,
      draft: false,
      prerelease: true,
      query: "1.2",
    });

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "releases"],
        query: {
          page: 2,
          limit: 1,
          draft: false,
          "pre-release": true,
          q: "1.2",
        },
      },
    ]);
    expect(page).toEqual({
      items: [normalizedRelease],
      pagination: { page: 2, limit: 1, itemCount: 1, hasNextPage: true },
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.items[0])).toBe(true);
    expect(Object.isFrozen(page.items[0]?.assets)).toBe(true);
    expect(Object.isFrozen(page.items[0]?.assets[0])).toBe(true);
    expect(Object.isFrozen(page.pagination)).toBe(true);
  });

  it("uses bounded pagination defaults without sending undefined filters", async () => {
    const api = new StubForgejoApi([]);
    const service = new ReleaseService(api);

    const page = await service.list(repository);

    expect(api.calls[0]).toEqual({
      method: "GET",
      path: ["repos", "acme", "widget", "releases"],
      query: { page: 1, limit: 30 },
    });
    expect(page.pagination).toEqual({
      page: 1,
      limit: 30,
      itemCount: 0,
      hasNextPage: false,
    });
  });

  it("views a release by immutable numeric ID", async () => {
    const api = new StubForgejoApi(releaseResponse);
    const service = new ReleaseService(api);

    await expect(service.viewById(repository, 42)).resolves.toEqual(normalizedRelease);
    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "releases", "42"],
      },
    ]);
  });

  it("views a release by tag as a single encoded path segment", async () => {
    const api = new StubForgejoApi(releaseResponse);
    const service = new ReleaseService(api);

    await expect(service.viewByTag(repository, "release/2026.08")).resolves.toEqual(
      normalizedRelease,
    );
    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "releases", "tags", "release/2026.08"],
      },
    ]);
  });

  it("creates a release with an exact snake-case Forgejo body", async () => {
    const api = new StubForgejoApi(releaseResponse);
    const service = new ReleaseService(api);

    const created = await service.create(repository, {
      tagName: "v1.2.3",
      targetCommitish: "main",
      name: "Version 1.2.3",
      body: "Release notes",
      draft: false,
      prerelease: true,
      hideArchiveLinks: false,
    });

    expect(api.calls).toEqual([
      {
        method: "POST",
        path: ["repos", "acme", "widget", "releases"],
        body: {
          tag_name: "v1.2.3",
          target_commitish: "main",
          name: "Version 1.2.3",
          body: "Release notes",
          draft: false,
          prerelease: true,
          hide_archive_links: false,
        },
      },
    ]);
    expect(created).toEqual(normalizedRelease);
  });

  it("omits absent optional fields from create bodies", async () => {
    const api = new StubForgejoApi(releaseResponse);
    const service = new ReleaseService(api);

    await service.create(repository, { tagName: "v1.2.3" });

    expect(api.calls[0]).toEqual({
      method: "POST",
      path: ["repos", "acme", "widget", "releases"],
      body: { tag_name: "v1.2.3" },
    });
  });

  it("edits a release by ID and sends only requested fields", async () => {
    const api = new StubForgejoApi(releaseResponse);
    const service = new ReleaseService(api);

    const edited = await service.edit(repository, 42, {
      name: "Renamed",
      body: "",
      draft: true,
      hideArchiveLinks: true,
    });

    expect(api.calls).toEqual([
      {
        method: "PATCH",
        path: ["repos", "acme", "widget", "releases", "42"],
        body: {
          name: "Renamed",
          body: "",
          draft: true,
          hide_archive_links: true,
        },
      },
    ]);
    expect(edited).toEqual(normalizedRelease);
  });

  it("deletes only by a positive safe integer ID and validates the empty response", async () => {
    const api = new StubForgejoApi(null);
    const service = new ReleaseService(api);

    await expect(service.delete(repository, 42)).resolves.toBeUndefined();
    expect(api.calls).toEqual([
      {
        method: "DELETE",
        path: ["repos", "acme", "widget", "releases", "42"],
      },
    ]);

    await expect(service.delete(repository, Number.MAX_SAFE_INTEGER + 1)).rejects.toBeDefined();
    expect(api.calls).toHaveLength(1);
  });

  it("uploads an asset through the narrow multipart port and normalizes its response", async () => {
    const api = new StubForgejoApi();
    const uploader = new StubAssetUploader(releaseResponse.assets[0]);
    const service = new ReleaseService(api, uploader);
    const content = new Blob(["binary-content"], { type: "application/octet-stream" });

    const uploaded = await service.upload(repository, 42, {
      name: "forgejo-linux-amd64",
      filename: "forgejo-linux-amd64",
      content,
    });

    expect(uploader.calls).toEqual([
      {
        path: ["repos", "acme", "widget", "releases", "42", "assets"],
        name: "forgejo-linux-amd64",
        filename: "forgejo-linux-amd64",
        content,
      },
    ]);
    const expectedAsset = normalizedRelease.assets[0];
    if (expectedAsset === undefined) throw new Error("Expected normalized release asset fixture");
    expect(uploaded).toEqual(expectedAsset);
    expect(Object.isFrozen(uploaded)).toBe(true);
  });

  it("rejects unsafe asset names before invoking the uploader", async () => {
    const uploader = new StubAssetUploader(releaseResponse.assets[0]);
    const service = new ReleaseService(new StubForgejoApi(), uploader);

    await expect(
      service.upload(repository, 42, {
        name: "../secret",
        filename: "asset.bin",
        content: new Blob(["asset"]),
      }),
    ).rejects.toBeDefined();
    expect(uploader.calls).toHaveLength(0);
  });

  it("rejects malformed Forgejo release and delete responses at runtime", async () => {
    const malformedReleaseApi = new StubForgejoApi({ ...releaseResponse, id: "42" });
    const malformedDeleteApi = new StubForgejoApi({ ok: true });

    await expect(
      new ReleaseService(malformedReleaseApi).viewById(repository, 42),
    ).rejects.toBeDefined();
    await expect(
      new ReleaseService(malformedDeleteApi).delete(repository, 42),
    ).rejects.toBeDefined();
  });

  it("validates repository, tag, pagination, and edit inputs before making a request", async () => {
    const api = new StubForgejoApi();
    const service = new ReleaseService(api);

    await expect(service.list(repository, { page: 0 })).rejects.toBeDefined();
    await expect(service.viewByTag(repository, "")).rejects.toBeDefined();
    await expect(service.edit(repository, 42, {})).rejects.toBeDefined();
    await expect(service.viewById({ owner: "", repository: "widget" }, 42)).rejects.toBeDefined();
    expect(api.calls).toHaveLength(0);
  });
});
