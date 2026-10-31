import { describe, expect, it } from "bun:test";
import type { HttpMethod } from "../../../src/http/forgejo-api.js";
import {
  ForgejoHttpClient,
  type ForgejoHttpClientOptions,
} from "../../../src/http/forgejo-http-client.js";

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function fixture(
  responses: readonly (Response | Error)[],
  options: Partial<ForgejoHttpClientOptions> = {},
  realWait = false,
) {
  const calls: Array<Readonly<{ input: FetchInput; init: RequestInit | undefined }>> = [];
  const waits: number[] = [];
  const fetch = (async (input: FetchInput, init?: RequestInit) => {
    calls.push({ input, init });
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected fetch call");
    return response;
  }) as typeof globalThis.fetch;
  const client = new ForgejoHttpClient({
    origin: "https://git.example.com",
    token: "fixture",
    fetch,
    ...(realWait
      ? {}
      : {
          retryWait: async (delay: number) => {
            waits.push(delay);
          },
        }),
    ...options,
  });
  return { client, calls, waits };
}

function transient(code = "ECONNRESET"): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connection failed"), { code }),
  });
}

function ok(): Response {
  return Response.json({ ok: true });
}

const read = { method: "GET", path: ["user"] } as const;

describe("ForgejoHttpClient safe read retries", () => {
  it.each([429, 500, 502, 503, 504])(
    "retries transient HTTP %i and cancels the discarded body",
    async (status) => {
      let cancelled = false;
      const failure = new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status },
      );
      const { client, calls, waits } = fixture([failure, ok()]);
      await expect(client.request(read)).resolves.toEqual({ ok: true });
      expect(calls).toHaveLength(2);
      expect(waits).toEqual([250]);
      expect(cancelled).toBe(true);
      expect(calls[1]?.init?.signal).toBe(calls[0]?.init?.signal);
    },
  );

  it("caps retries at two and retains the final HTTP error", async () => {
    const { client, calls, waits } = fixture(
      Array.from({ length: 3 }, () => new Response(null, { status: 503 })),
    );
    await expect(client.request(read)).rejects.toMatchObject({
      code: "server_failed",
      details: { http_status: 503 },
    });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([250, 500]);
  });

  it("honors Retry-After seconds and HTTP dates without real delays", async () => {
    const { client, waits } = fixture(
      [
        new Response(null, { status: 429, headers: { "retry-after": "2" } }),
        new Response(null, {
          status: 503,
          headers: { "retry-after": "Thu, 01 Jan 1970 00:00:05 GMT" },
        }),
        ok(),
      ],
      { now: () => 1000 },
    );
    await expect(client.request(read)).resolves.toEqual({ ok: true });
    expect(waits).toEqual([2000, 4000]);
  });

  it.each(["nonsense", "-1", "1.5"])(
    "uses bounded backoff for invalid Retry-After %s",
    async (value) => {
      const { client, waits } = fixture([
        new Response(null, { status: 503, headers: { "retry-after": value } }),
        ok(),
      ]);
      await client.request(read);
      expect(waits).toEqual([250]);
    },
  );

  it.each(["ECONNRESET", "ConnectionRefused"])(
    "retries recognized transient connection failure %s",
    async (code) => {
      const { client, calls, waits } = fixture([transient(code), ok()]);
      await expect(client.request(read)).resolves.toEqual({ ok: true });
      expect(calls).toHaveLength(2);
      expect(waits).toEqual([250]);
    },
  );

  it.each([
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ])("never retries TLS error %s", async (code) => {
    const { client, calls, waits } = fixture([transient(code), ok()]);
    await expect(client.request(read)).rejects.toMatchObject({
      code: "network_failed",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("does not retry an unknown fetch error or a transient wrapper around a certificate failure", async () => {
    for (const failure of [
      new TypeError("invalid request"),
      Object.assign(new Error("connection failed", { cause: transient("CERT_HAS_EXPIRED") }), {
        code: "ECONNRESET",
      }),
    ]) {
      const { client, calls } = fixture([failure, ok()]);
      await expect(client.request(read)).rejects.toMatchObject({
        code: "network_failed",
        retryable: false,
      });
      expect(calls).toHaveLength(1);
    }
  });

  it.each([400, 401, 403, 404, 409, 422, 501, 505])(
    "never retries permanent HTTP %i",
    async (status) => {
      const { client, calls, waits } = fixture([new Response(null, { status }), ok()]);
      await expect(client.request(read)).rejects.toBeInstanceOf(Error);
      expect(calls).toHaveLength(1);
      expect(waits).toEqual([]);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "never retries %s failures",
    async (method: HttpMethod) => {
      for (const failure of [new Response(null, { status: 503 }), transient()]) {
        const { client, calls, waits } = fixture([failure, ok()]);
        await expect(client.request({ ...read, method })).rejects.toMatchObject({
          retryable: false,
        });
        expect(calls).toHaveLength(1);
        expect(waits).toEqual([]);
      }
    },
  );

  it("retries HEAD, text and download headers while never replaying a received body", async () => {
    const head = fixture([transient(), new Response(null)]);
    await expect(head.client.request({ ...read, method: "HEAD" })).resolves.toBeNull();
    expect(head.calls).toHaveLength(2);
    const text = fixture([transient(), new Response("log")]);
    await expect(text.client.readText({ path: ["logs"] })).resolves.toMatchObject({ text: "log" });
    const download = fixture([new Response(null, { status: 503 }), new Response("zip")]);
    const result = await download.client.download({ path: ["archive"] });
    expect(await new Response(result.body).text()).toBe("zip");
    const invalid = fixture([
      new Response("{", { headers: { "content-type": "application/json" } }),
      ok(),
    ]);
    await expect(invalid.client.request(read)).rejects.toMatchObject({ code: "protocol_failed" });
    expect(invalid.calls).toHaveLength(1);
  });

  it("keeps the redirect budget across retries and fails closed across origins", async () => {
    const redirect = () =>
      new Response(null, { status: 302, headers: { location: "/api/v1/moved" } });
    const limited = fixture([
      redirect(),
      new Response(null, { status: 503 }),
      redirect(),
      redirect(),
      redirect(),
      ok(),
    ]);
    await expect(limited.client.request(read)).rejects.toMatchObject({ code: "protocol_failed" });
    expect(limited.calls).toHaveLength(5);
    const cross = fixture([
      transient(),
      new Response(null, { status: 302, headers: { location: "https://evil.example/user" } }),
      ok(),
    ]);
    await expect(cross.client.request(read)).rejects.toMatchObject({ code: "protocol_failed" });
    expect(cross.calls).toHaveLength(2);
  });

  it("lets callers disable retries and validates the retry cap", async () => {
    const disabled = fixture([new Response(null, { status: 503 }), ok()], { maxRetries: 0 });
    await expect(disabled.client.request(read)).rejects.toMatchObject({ code: "server_failed" });
    expect(disabled.calls).toHaveLength(1);
    for (const maxRetries of [-1, 1.5, 3, Number.NaN]) {
      expect(() => fixture([], { maxRetries })).toThrow();
    }
  });

  it("aborts the default retry wait immediately, including oversized Retry-After", async () => {
    for (const retryAfter of ["60", "999999999999999999999999999999999999"]) {
      const abort = new AbortController();
      let started: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const client = new ForgejoHttpClient({
        origin: "https://git.example.com",
        token: "fixture",
        fetch: (async () => {
          started?.();
          return new Response(null, { status: 429, headers: { "retry-after": retryAfter } });
        }) as unknown as typeof globalThis.fetch,
      });
      const result = client.request({ ...read, signal: abort.signal });
      await ready;
      await Promise.resolve();
      abort.abort();
      await expect(result).rejects.toMatchObject({ code: "cancelled", retryable: false });
    }
  });

  it("preserves one timeout across retry waits", async () => {
    const { client, calls } = fixture(
      [new Response(null, { status: 429, headers: { "retry-after": "60" } }), ok()],
      {
        timeoutMs: 1,
      },
      true,
    );
    await expect(client.request(read)).rejects.toMatchObject({ code: "timeout" });
    expect(calls).toHaveLength(1);
  });

  it("combines default and per-request cancellation signals", async () => {
    for (const abortDefault of [true, false]) {
      const outer = new AbortController();
      const inner = new AbortController();
      const { client, calls } = fixture([new Response(null, { status: 503 }), ok()], {
        signal: outer.signal,
        retryWait: async () => {
          (abortDefault ? outer : inner).abort();
        },
      });
      await expect(client.request({ ...read, signal: inner.signal })).rejects.toMatchObject({
        code: "cancelled",
      });
      expect(calls).toHaveLength(1);
    }
  });
  it("caps transient network failures and keeps the final cause private", async () => {
    const { client, calls, waits } = fixture([transient(), transient(), transient(), ok()]);
    await expect(client.request(read)).rejects.toMatchObject({
      code: "network_failed",
      retryable: true,
    });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([250, 500]);
  });

  it("allows an elapsed Retry-After date and a zero delay", async () => {
    const { client, calls } = fixture(
      [
        new Response(null, {
          status: 429,
          headers: { "retry-after": "Thu, 01 Jan 1970 00:00:01 GMT" },
        }),
        new Response(null, { status: 503, headers: { "retry-after": "0" } }),
        ok(),
      ],
      { now: () => 2000 },
      true,
    );
    await expect(client.request(read)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it.each(["request", "text", "download", "upload"] as const)(
    "uses default cancellation during an in-flight %s",
    async (operation) => {
      const controller = new AbortController();
      let started: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const client = new ForgejoHttpClient({
        origin: "https://git.example.com",
        token: "fixture",
        signal: controller.signal,
        fetch: (async (_input: FetchInput, init?: RequestInit) => {
          started?.();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }) as typeof globalThis.fetch,
      });
      const result =
        operation === "request"
          ? client.request(read)
          : operation === "text"
            ? client.readText({ path: ["logs"] })
            : operation === "download"
              ? client.download({ path: ["archive"] })
              : client.uploadAsset({
                  path: ["assets"],
                  name: "asset.bin",
                  filename: "asset.bin",
                  content: new Blob(["x"]),
                });
      await ready;
      controller.abort();
      await expect(result).rejects.toMatchObject({ code: "cancelled", retryable: false });
    },
  );

  it.each(["request", "upload"] as const)(
    "rejects an already cancelled %s before fetch",
    async (operation) => {
      const controller = new AbortController();
      controller.abort();
      const { client, calls } = fixture([ok()], { signal: controller.signal });
      const result =
        operation === "request"
          ? client.request(read)
          : client.uploadAsset({
              path: ["assets"],
              name: "asset.bin",
              filename: "asset.bin",
              content: new Blob(["x"]),
            });
      await expect(result).rejects.toMatchObject({ code: "cancelled", retryable: false });
      expect(calls).toHaveLength(0);
    },
  );
});
