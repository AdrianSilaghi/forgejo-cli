import { afterEach, describe, expect, it } from "bun:test";

import { ForgejoHttpClient } from "../../src/http/forgejo-http-client.js";

const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("ForgejoHttpClient integration", () => {
  it("performs an authenticated request against a real loopback HTTP server", async () => {
    const requests: Array<Readonly<{ path: string; authorization: string | null }>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(
          Object.freeze({
            path: `${url.pathname}${url.search}`,
            authorization: request.headers.get("authorization"),
          }),
        );
        return Response.json({ id: 7, login: "agent" });
      },
    });
    servers.push(server);
    const client = new ForgejoHttpClient({
      origin: `http://127.0.0.1:${server.port}`,
      token: "fixture",
      allowInsecureLocalhost: true,
    });

    await expect(
      client.request({ method: "GET", path: ["user"], query: { page: 2 } }),
    ).resolves.toEqual({ id: 7, login: "agent" });
    expect(requests).toEqual([
      {
        path: "/api/v1/user?page=2",
        authorization: "token fixture",
      },
    ]);
  });
});
