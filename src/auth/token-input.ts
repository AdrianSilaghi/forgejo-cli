import type { Readable } from "node:stream";

import { CliError } from "../core/errors.js";

const MAX_TOKEN_BYTES = 4096;

export async function readTokenFromStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_TOKEN_BYTES) {
      throw new CliError("validation_failed", "Token input exceeds the 4096-byte limit.");
    }
    chunks.push(buffer);
  }

  let token = Buffer.concat(chunks).toString("utf8");
  if (token.endsWith("\n")) {
    token = token.slice(0, -1);
    if (token.endsWith("\r")) {
      token = token.slice(0, -1);
    }
  }

  if (token.length === 0 || /[\r\n]/.test(token) || token.trim() !== token) {
    throw new CliError(
      "validation_failed",
      "Token input must contain exactly one non-empty token.",
    );
  }

  return token;
}
