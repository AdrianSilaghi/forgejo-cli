import { describe, expect, it } from "bun:test";

import { ArtifactService } from "../../../src/forgejo/artifact-service.js";
import type {
  ForgejoApi,
  ForgejoDownload,
  ForgejoDownloader,
  ForgejoDownloadRequest,
  ForgejoRequest,
} from "../../../src/http/forgejo-api.js";

const repository = Object.freeze({ owner: "acme", repository: "widget" });

const artifactResponse = {
  id: 77,
  name: "coverage-report",
  run_id: 1580,
  size_in_bytes: 20_480,
  expired: false,
  created_at: "2026-09-22T18:46:19Z",
  updated_at: "2026-09-22T18:46:19Z",
  expires_at: "2026-12-21T18:46:19Z",
  archive_download_url: "https://git.example.com/api/v1/repos/acme/widget/actions/artifacts/77/zip",
  workflow_run: { id: 1580 },
};

const normalizedArtifact = {
  id: 77,
  name: "coverage-report",
  runId: 1580,
  sizeBytes: 20_480,
  expired: false,
  createdAt: "2026-09-22T18:46:19Z",
  updatedAt: "2026-09-22T18:46:19Z",
  expiresAt: "2026-12-21T18:46:19Z",
  downloadUrl: "https://git.example.com/api/v1/repos/acme/widget/actions/artifacts/77/zip",
};

class StubApi implements ForgejoApi {
  readonly calls: ForgejoRequest[] = [];
  readonly #responses: unknown[];

  public constructor(...responses: unknown[]) {
    this.#responses = [...responses];
  }

  public async request(request: ForgejoRequest): Promise<unknown> {
    this.calls.push(request);
    if (this.#responses.length === 0) throw new Error("Unexpected Forgejo API request");
    return this.#responses.shift();
  }
}

class StubDownloader implements ForgejoDownloader {
  readonly calls: ForgejoDownloadRequest[] = [];

  public constructor(readonly response: ForgejoDownload) {}

  public async download(request: ForgejoDownloadRequest): Promise<ForgejoDownload> {
    this.calls.push(request);
    return this.response;
  }
}

describe("ArtifactService", () => {
  it("lists repository artifacts a page at a time and normalizes them", async () => {
    const api = new StubApi([artifactResponse]);

    const page = await new ArtifactService(api).list(repository, { name: "coverage-report" });

    expect(api.calls).toEqual([
      {
        method: "GET",
        path: ["repos", "acme", "widget", "actions", "artifacts"],
        query: { page: 1, limit: 30, name: "coverage-report" },
      },
    ]);
    expect(page).toEqual({
      items: [normalizedArtifact],
      pagination: { page: 1, limit: 30, itemCount: 1, hasNextPage: false },
    });
  });

  it("lists one run's artifacts by resolving its run number first", async () => {
    const api = new StubApi(
      {
        total_count: 1,
        workflow_runs: [{ id: 1580, index_in_repo: 1499, status: "success" }],
      },
      [],
    );

    const page = await new ArtifactService(api).list(repository, { run: 1499, page: 2, limit: 5 });

    expect(api.calls[0]?.query).toEqual({ run_number: 1499, page: 1, limit: 1 });
    expect(api.calls[1]).toEqual({
      method: "GET",
      path: ["repos", "acme", "widget", "actions", "runs", "1580", "artifacts"],
      query: { page: 2, limit: 5 },
    });
    expect(page.items).toEqual([]);
  });

  it("views one artifact by its API id", async () => {
    const api = new StubApi(artifactResponse);

    await expect(new ArtifactService(api).view(repository, 77)).resolves.toEqual(
      normalizedArtifact,
    );
    expect(api.calls).toEqual([
      { method: "GET", path: ["repos", "acme", "widget", "actions", "artifacts", "77"] },
    ]);
  });

  it("downloads the artifact archive through the download transport", async () => {
    const download: ForgejoDownload = {
      body: new ReadableStream(),
      contentType: "application/zip",
      declaredBytes: 20_480,
    };
    const downloader = new StubDownloader(download);

    const result = await new ArtifactService(new StubApi(), downloader).download(repository, 77);

    expect(downloader.calls).toEqual([
      { path: ["repos", "acme", "widget", "actions", "artifacts", "77", "zip"] },
    ]);
    expect(result).toEqual({ id: 77, download });
  });

  it("deletes an artifact by its API id", async () => {
    const api = new StubApi(null);

    await new ArtifactService(api).delete(repository, 77);

    expect(api.calls).toEqual([
      { method: "DELETE", path: ["repos", "acme", "widget", "actions", "artifacts", "77"] },
    ]);
  });

  it("validates ids, page sizes and names before any request, and fails without a downloader", async () => {
    const api = new StubApi();
    const service = new ArtifactService(api);

    await expect(service.view(repository, 0)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.list(repository, { limit: 500 })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.list(repository, { name: " padded" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.download(repository, 77)).rejects.toMatchObject({
      code: "config_failed",
    });
    expect(api.calls).toHaveLength(0);
  });

  it("rejects a list response that is not an artifact array", async () => {
    const api = new StubApi({ artifacts: [] });

    await expect(new ArtifactService(api).list(repository)).rejects.toMatchObject({
      code: "protocol_failed",
    });
  });
});
