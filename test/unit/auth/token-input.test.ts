import { describe, expect, it } from "bun:test";
import { PassThrough, Readable } from "node:stream";

import {
  ReadlineHiddenTokenPrompt,
  readTokenFromStream,
  SecureTokenInput,
} from "../../../src/auth/token-input.js";

function inputStream(chunks: Iterable<string>, isTTY: boolean): Readable & { isTTY: boolean } {
  return Object.assign(Readable.from(chunks), { isTTY });
}

describe("readTokenFromStream", () => {
  it("accepts one bounded token and removes a trailing newline", async () => {
    await expect(readTokenFromStream(Readable.from(["secret-token\n"]))).resolves.toBe(
      "secret-token",
    );
  });

  it("rejects empty input, multiple lines, and oversized input", async () => {
    await expect(readTokenFromStream(Readable.from(["\n"]))).rejects.toThrow();
    await expect(readTokenFromStream(Readable.from(["one\ntwo\n"]))).rejects.toThrow();
    await expect(readTokenFromStream(Readable.from(["x".repeat(4097)]))).rejects.toThrow();
  });
});

describe("SecureTokenInput", () => {
  it("reads one bounded token from non-TTY stdin without prompting", async () => {
    let prompted = false;
    const input = new SecureTokenInput({
      stream: inputStream(["secret-token\n"], false),
      prompt: {
        readHidden: async () => {
          prompted = true;
          return "unexpected-token";
        },
      },
    });

    await expect(input.read({ pipedOnly: false })).resolves.toBe("secret-token");
    expect(prompted).toBe(false);
  });

  it("retains the stream size bound when stdin is non-TTY", async () => {
    const input = new SecureTokenInput({
      stream: inputStream(["x".repeat(4097)], false),
      prompt: { readHidden: async () => "unexpected-token" },
    });

    await expect(input.read({ pipedOnly: false })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("keeps piped-only mode compatible with non-TTY stdin", async () => {
    let prompted = false;
    const input = new SecureTokenInput({
      stream: inputStream(["secret-token\n"], false),
      prompt: {
        readHidden: async () => {
          prompted = true;
          return "unexpected-token";
        },
      },
    });

    await expect(input.read({ pipedOnly: true })).resolves.toBe("secret-token");
    expect(prompted).toBe(false);
  });

  it("uses the hidden prompt for TTY input without echoing the token", async () => {
    const token = "fixture";
    const promptOutput: string[] = [];
    const input = new SecureTokenInput({
      stream: inputStream([], true),
      prompt: {
        readHidden: async (message: string) => {
          promptOutput.push(message);
          return token;
        },
      },
    });

    await expect(input.read({ pipedOnly: false })).resolves.toBe(token);
    expect(promptOutput).toHaveLength(1);
    expect(promptOutput.join("")).not.toContain(token);
  });

  it("rejects piped-only mode on a TTY before reading or prompting", async () => {
    let streamRead = false;
    let prompted = false;
    const stream = Object.assign(
      Readable.from(
        (async function* tokenInput() {
          streamRead = true;
          yield "secret-token\n";
        })(),
      ),
      { isTTY: true },
    );
    const input = new SecureTokenInput({
      stream,
      prompt: {
        readHidden: async () => {
          prompted = true;
          return "unexpected-token";
        },
      },
    });

    await expect(input.read({ pipedOnly: true })).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(streamRead).toBe(false);
    expect(prompted).toBe(false);
  });
});

describe("ReadlineHiddenTokenPrompt", () => {
  it("reads from a TTY without echoing the token and restores raw mode", async () => {
    const token = "fixture";
    const rawMode: boolean[] = [];
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (enabled: boolean) => {
        rawMode.push(enabled);
        return input;
      },
    });
    const output = new PassThrough();
    const outputChunks: Buffer[] = [];
    output.on("data", (chunk) => outputChunks.push(Buffer.from(chunk)));
    const prompt = new ReadlineHiddenTokenPrompt({ input, output });

    const result = prompt.readHidden("Forgejo personal access token: ");
    input.end(`${token}\n`);

    await expect(result).resolves.toBe(token);
    const rendered = Buffer.concat(outputChunks).toString("utf8");
    expect(rendered).toContain("Forgejo personal access token: ");
    expect(rendered).toEndWith("\n");
    expect(rendered).not.toContain(token);
    expect(rawMode).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);
  });
});
