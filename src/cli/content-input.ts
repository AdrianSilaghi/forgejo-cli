import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

import { CliError } from "../core/errors.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;

export type ContentInput = Readonly<{
  body?: string;
  bodyFile?: string;
  bodyStdin?: boolean;
}>;

export type ContentInputOptions = Readonly<{
  maxBytes?: number;
}>;

async function readBounded(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let byteCount = 0;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      byteCount += buffer.byteLength;
      if (byteCount > maxBytes) {
        stream.destroy();
        throw new CliError(
          "validation_failed",
          `Content input exceeds the ${maxBytes}-byte limit.`,
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("validation_failed", "Unable to read content input.", { cause: error });
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function readContentInput(
  input: ContentInput,
  stdin: Readable,
  options: ContentInputOptions = {},
): Promise<string> {
  const selected = [
    input.body !== undefined,
    input.bodyFile !== undefined,
    input.bodyStdin === true,
  ];
  if (selected.filter(Boolean).length !== 1) {
    throw new CliError(
      "validation_failed",
      "Exactly one of --body, --body-file, or --body-stdin is required.",
    );
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new CliError("validation_failed", "The content byte limit must be a positive integer.");
  }

  if (input.body !== undefined) {
    if (Buffer.byteLength(input.body, "utf8") > maxBytes) {
      throw new CliError("validation_failed", `Content input exceeds the ${maxBytes}-byte limit.`);
    }
    return input.body;
  }

  if (input.bodyFile !== undefined) {
    if (input.bodyFile.length === 0) {
      throw new CliError("validation_failed", "The body file path cannot be empty.");
    }
    return readBounded(createReadStream(input.bodyFile), maxBytes);
  }

  return readBounded(stdin, maxBytes);
}
