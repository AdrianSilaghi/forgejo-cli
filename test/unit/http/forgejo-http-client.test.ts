import { describe, expect, it } from "bun:test";

import { CliError } from "../../../src/core/errors.js";
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

describe("ForgejoHttpClient", () => {
  it("rejects malformed credentials before constructing a request", () => {
    expect(
      () =>
        new ForgejoHttpClient({
          origin: "https://git.example.com",
          token: "x\nbad",
        }),
    ).toThrow();
  });

  it("rejects relative or control-character path segments before fetch", async () => {
    const fake = fakeFetch();
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(
      client.request({ method: "GET", path: ["repos", "..", "admin"] }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      client.request({ method: "GET", path: ["repos", "bad\nsegment"] }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(fake.calls).toHaveLength(0);
  });

  it("encodes path segments, appends allowlisted query values, and authenticates in-process", async () => {
    const fake = fakeFetch(
      new Response(JSON.stringify({ id: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(
      client.request({
        method: "GET",
        path: ["repos", "acme team", "widget", "pulls"],
        query: { page: 2, state: "open", ignored: undefined },
      }),
    ).resolves.toEqual({ id: 42 });

    expect(fake.calls).toHaveLength(1);
    const [url, init] = fake.calls[0] ?? [];
    expect(url).toBe(
      "https://git.example.com/api/v1/repos/acme%20team/widget/pulls?page=2&state=open",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("token fixture");
    expect(init?.redirect).toBe("manual");
  });

  it("follows bounded same-origin redirects for reads", async () => {
    const fake = fakeFetch(
      new Response(null, { status: 302, headers: { location: "/api/v1/user/" } }),
      new Response(JSON.stringify({ login: "agent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(client.request({ method: "GET", path: ["user"] })).resolves.toEqual({
      login: "agent",
    });
    expect(fake.calls).toHaveLength(2);
  });

  it("fails closed on cross-origin redirects and never sends a second request", async () => {
    const fake = fakeFetch(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(client.request({ method: "GET", path: ["user"] })).rejects.toMatchObject({
      code: "protocol_failed",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("fails closed on same-origin redirects containing user information", async () => {
    const fake = fakeFetch(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker@git.example.com/api/v1/user" },
      }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(client.request({ method: "GET", path: ["user"] })).rejects.toMatchObject({
      code: "protocol_failed",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("maps a malformed redirect location to a stable protocol error", async () => {
    const fake = fakeFetch(
      new Response(null, {
        status: 302,
        headers: { location: "https://[invalid" },
      }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(client.request({ method: "GET", path: ["user"] })).rejects.toMatchObject({
      code: "protocol_failed",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("does not replay mutations across redirects", async () => {
    const fake = fakeFetch(
      new Response(null, { status: 307, headers: { location: "/api/v1/pulls" } }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(
      client.request({ method: "POST", path: ["repos", "acme", "widget", "pulls"], body: {} }),
    ).rejects.toMatchObject({ code: "protocol_failed" });
    expect(fake.calls).toHaveLength(1);
  });

  it("streams a release asset through a fixed same-origin multipart request", async () => {
    const fake = fakeFetch(
      new Response(JSON.stringify({ id: 9, name: "forgejo-linux-amd64" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });
    const content = new Blob(["binary-content"], { type: "application/octet-stream" });

    await expect(
      client.uploadAsset({
        path: ["repos", "acme", "widget", "releases", "42", "assets"],
        name: "forgejo-linux-amd64",
        content,
        filename: "forgejo-linux-amd64",
      }),
    ).resolves.toMatchObject({ id: 9 });

    const [url, init] = fake.calls[0] ?? [];
    expect(url).toBe(
      "https://git.example.com/api/v1/repos/acme/widget/releases/42/assets?name=forgejo-linux-amd64",
    );
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe("token fixture");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error("Expected multipart form data");
    expect(form.get("attachment")).toBeInstanceOf(Blob);
  });

  it("never replays an asset upload after a redirect", async () => {
    const fake = fakeFetch(
      new Response(null, { status: 307, headers: { location: "/api/v1/redirected" } }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(
      client.uploadAsset({
        path: ["repos", "acme", "widget", "releases", "42", "assets"],
        name: "asset.bin",
        content: new Blob(["asset"]),
        filename: "asset.bin",
      }),
    ).rejects.toMatchObject({ code: "protocol_failed" });
    expect(fake.calls).toHaveLength(1);
  });

  it("distinguishes caller cancellation from a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = (async (_input: FetchInput, _init?: RequestInit) => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof globalThis.fetch;
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch,
    });

    await expect(
      client.request({ method: "GET", path: ["user"], signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled", retryable: false });
  });

  it("bounds successful response bodies before parsing them", async () => {
    const fake = fakeFetch(
      new Response(JSON.stringify({ body: "x".repeat(128) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
      maxResponseBytes: 64,
    });

    await expect(client.request({ method: "GET", path: ["user"] })).rejects.toMatchObject({
      code: "protocol_failed",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps the request timeout active while consuming the response body", async () => {
    const fetch = (async (_input: FetchInput, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch,
      timeoutMs: 1,
    });

    await expect(client.request({ method: "GET", path: ["user"] })).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });

  it.each([
    [401, "not_authenticated"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [500, "server_failed"],
  ] as const)("maps HTTP %i to %s without reflecting response secrets", async (status, code) => {
    const fake = fakeFetch(
      new Response(JSON.stringify({ message: "Authorization: token leaked" }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    try {
      await client.request({ method: "GET", path: ["user"] });
      expect.unreachable("request should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code });
      expect(JSON.stringify(error)).not.toContain("leaked");
      expect((error as Error).message).not.toContain("leaked");
    }
  });

  it("never marks a failed mutation as safe to retry", async () => {
    const fake = fakeFetch(
      new Response(JSON.stringify({ message: "uncertain mutation outcome" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(
      client.request({
        method: "POST",
        path: ["repos", "acme", "widget", "issues"],
        body: { title: "Do not duplicate" },
      }),
    ).rejects.toMatchObject({ code: "server_failed", retryable: false });
  });

  it("cancels non-success response bodies before returning an API error", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("server diagnostics"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    );
    const fake = fakeFetch(response);
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(client.request({ method: "GET", path: ["user"] })).rejects.toMatchObject({
      code: "server_failed",
    });
    expect(cancelled).toBe(true);
  });

  it("cancels non-success upload response bodies before returning an API error", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("upload diagnostics"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    );
    const fake = fakeFetch(response);
    const client = new ForgejoHttpClient({
      origin: "https://git.example.com",
      token: "fixture",
      fetch: fake.fetch,
    });

    await expect(
      client.uploadAsset({
        path: ["repos", "acme", "widget", "releases", "42", "assets"],
        name: "asset.bin",
        filename: "asset.bin",
        content: new Blob(["asset"]),
      }),
    ).rejects.toMatchObject({ code: "server_failed", retryable: false });
    expect(cancelled).toBe(true);
  });
});
