import { describe, expect, it } from "bun:test";

import { ForgejoHttpClient } from "../../../src/http/forgejo-http-client.js";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchCall = readonly [FetchInput, RequestInit | undefined];

function fakeFetch(...responses: Response[]): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetch = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    calls.push([input, init]);
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch call");
    }
    return response;
  }) as typeof globalThis.fetch;

  return { fetch, calls };
}

function client(fetch: typeof globalThis.fetch, maxResponseBytes?: number): ForgejoHttpClient {
  return new ForgejoHttpClient({
    origin: "https://git.example.com",
    token: "fixture",
    fetch,
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });
}

function headerOf(call: FetchCall | undefined, name: string): string | null {
  return new Headers(call?.[1]?.headers).get(name);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("ForgejoHttpClient query arrays", () => {
  it("sends each array element as a repeated query key, which is how Forgejo reads filters", async () => {
    const fake = fakeFetch(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );

    await client(fake.fetch).request({
      method: "GET",
      path: ["repos", "acme", "widget", "actions", "runs"],
      query: { status: ["failure", "cancelled"], page: 1, event: [] },
    });

    const url = new URL(String(fake.calls[0]?.[0]));
    expect(url.searchParams.getAll("status")).toEqual(["failure", "cancelled"]);
    expect(url.searchParams.has("event")).toBe(false);
    expect(url.searchParams.get("page")).toBe("1");
  });
});

describe("ForgejoHttpClient.readText", () => {
  it("asks for plain text and returns a whole log with its declared size", async () => {
    const fake = fakeFetch(
      new Response("line one\nline two\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", "content-length": "18" },
      }),
    );

    const result = await client(fake.fetch).readText({
      path: ["repos", "acme", "widget", "actions", "jobs", "7", "logs"],
      query: { attempt: 2 },
    });

    expect(result).toEqual({ text: "line one\nline two\n", partial: false, totalBytes: 18 });
    expect(String(fake.calls[0]?.[0])).toBe(
      "https://git.example.com/api/v1/repos/acme/widget/actions/jobs/7/logs?attempt=2",
    );
    expect(headerOf(fake.calls[0], "accept")).toBe("text/plain");
    expect(headerOf(fake.calls[0], "authorization")).toBe("token fixture");
    expect(headerOf(fake.calls[0], "range")).toBeNull();
    expect(fake.calls[0]?.[1]?.method).toBe("GET");
  });

  it("requests only the tail with a suffix range and reports the full size from Content-Range", async () => {
    const fake = fakeFetch(
      new Response("tail\n", {
        status: 206,
        headers: { "content-type": "text/plain", "content-range": "bytes 10767-10771/10772" },
      }),
    );

    const result = await client(fake.fetch).readText({
      path: ["repos", "acme", "widget", "actions", "jobs", "7", "logs"],
      tailBytes: 5,
    });

    expect(headerOf(fake.calls[0], "range")).toBe("bytes=-5");
    expect(result).toEqual({ text: "tail\n", partial: true, totalBytes: 10_772 });
  });

  it("treats an unknown total in Content-Range as unknown rather than guessing", async () => {
    const fake = fakeFetch(
      new Response("tail", { status: 206, headers: { "content-range": "bytes 0-3/*" } }),
    );

    await expect(client(fake.fetch).readText({ path: ["logs"], tailBytes: 4 })).resolves.toEqual({
      text: "tail",
      partial: true,
      totalBytes: null,
    });
  });

  it("rejects a tail size that is not a positive safe integer before any request", async () => {
    const fake = fakeFetch();

    for (const tailBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        client(fake.fetch).readText({ path: ["logs"], tailBytes }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("maps HTTP failures to stable error codes and keeps reads retryable only when safe", async () => {
    const fake = fakeFetch(
      new Response('{"message":"not found"}', { status: 404 }),
      new Response("busy", { status: 503 }),
    );
    const api = client(fake.fetch);

    await expect(api.readText({ path: ["logs"] })).rejects.toMatchObject({
      code: "not_found",
      retryable: false,
      details: { http_status: 404 },
    });
    await expect(api.readText({ path: ["logs"] })).rejects.toMatchObject({
      code: "server_failed",
      retryable: true,
    });
  });

  it("enforces the response size limit on log bodies", async () => {
    const fake = fakeFetch(new Response("x".repeat(64), { status: 200 }));

    await expect(client(fake.fetch, 16).readText({ path: ["logs"] })).rejects.toMatchObject({
      code: "protocol_failed",
    });
  });

  it("follows same-origin redirects and refuses to send credentials across origins", async () => {
    const same = fakeFetch(
      new Response(null, { status: 302, headers: { location: "/api/v1/moved/logs" } }),
      new Response("moved", { status: 200 }),
    );
    await expect(client(same.fetch).readText({ path: ["logs"] })).resolves.toMatchObject({
      text: "moved",
    });
    expect(String(same.calls[1]?.[0])).toBe("https://git.example.com/api/v1/moved/logs");

    const cross = fakeFetch(
      new Response(null, { status: 302, headers: { location: "https://evil.example/logs" } }),
    );
    await expect(client(cross.fetch).readText({ path: ["logs"] })).rejects.toMatchObject({
      code: "protocol_failed",
    });
    expect(cross.calls).toHaveLength(1);
  });
});

describe("ForgejoHttpClient.download", () => {
  it("returns the body as a stream with its content type and declared size", async () => {
    const fake = fakeFetch(
      new Response("PK-archive", {
        status: 200,
        headers: { "content-type": "application/zip", "content-length": "10" },
      }),
    );

    const download = await client(fake.fetch).download({
      path: ["repos", "acme", "widget", "actions", "runs", "9", "logs"],
    });

    expect(download.contentType).toBe("application/zip");
    expect(download.declaredBytes).toBe(10);
    expect(await readAll(download.body)).toBe("PK-archive");
    expect(headerOf(fake.calls[0], "authorization")).toBe("token fixture");
    expect(fake.calls[0]?.[1]?.method).toBe("GET");
  });

  it("reports an absent or malformed content length as unknown", async () => {
    const fake = fakeFetch(
      new Response("zip", { status: 200, headers: { "content-length": "ten" } }),
    );

    const download = await client(fake.fetch).download({ path: ["artifact.zip"] });

    expect(download.declaredBytes).toBeNull();
    expect(download.contentType).toBeNull();
    expect(await readAll(download.body)).toBe("zip");
  });

  it("follows a same-origin redirect to the archive and refuses a cross-origin one", async () => {
    const same = fakeFetch(
      new Response(null, { status: 307, headers: { location: "/api/v1/raw/artifact.zip" } }),
      new Response("zip", { status: 200 }),
    );
    const download = await client(same.fetch).download({ path: ["artifact.zip"] });
    expect(await readAll(download.body)).toBe("zip");

    const cross = fakeFetch(
      new Response(null, {
        status: 302,
        headers: { location: "https://storage.example/bucket/artifact.zip" },
      }),
    );
    await expect(client(cross.fetch).download({ path: ["artifact.zip"] })).rejects.toMatchObject({
      code: "protocol_failed",
    });
  });

  it("maps a missing archive to not_found without exposing a body", async () => {
    const fake = fakeFetch(new Response("missing", { status: 404 }));

    await expect(client(fake.fetch).download({ path: ["artifact.zip"] })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects a response without a body", async () => {
    const fake = fakeFetch(new Response(null, { status: 200 }));

    await expect(client(fake.fetch).download({ path: ["artifact.zip"] })).rejects.toMatchObject({
      code: "protocol_failed",
    });
  });
});
