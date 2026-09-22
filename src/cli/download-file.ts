import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { CliError } from "../core/errors.js";
import { hasControlCharacter } from "../core/text-validation.js";

const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const OWNER_READ_WRITE = 0o600;
// O_EXCL makes creation fail on any existing entry, including a symlink, so a
// download can never overwrite a file or be redirected through a link.
const CREATE_NEW_FILE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export type DownloadSource = Readonly<{
  body: ReadableStream<Uint8Array>;
  declaredBytes: number | null;
}>;

export type DownloadedFile = Readonly<{
  path: string;
  bytes: number;
}>;

export interface DownloadFileTarget {
  write(path: string, source: DownloadSource): Promise<DownloadedFile>;
}

export type BunDownloadFileTargetOptions = Readonly<{
  maxBytes?: number;
}>;

type FileHandle = Awaited<ReturnType<typeof open>>;

type OutputFile = Readonly<{
  absolutePath: string;
  handle: FileHandle;
}>;

function assertUsablePath(path: string): void {
  if (
    path.length === 0 ||
    path.trim() !== path ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
    hasControlCharacter(path)
  ) {
    throw new CliError("validation_failed", "The output path is invalid.");
  }
}

function sizeLimitError(maxBytes: number): CliError {
  return new CliError("protocol_failed", `The download exceeds the ${maxBytes}-byte limit.`);
}

async function writeFully(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset);
    offset += bytesWritten;
  }
}

/** Best-effort cleanup: a failure here must not mask the error being reported. */
async function quietly(cleanup: () => Promise<unknown>): Promise<void> {
  try {
    await cleanup();
  } catch {
    // The original failure is the one worth reporting.
  }
}

export class BunDownloadFileTarget implements DownloadFileTarget {
  readonly #maxBytes: number;

  public constructor(options: BunDownloadFileTargetOptions = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new CliError("validation_failed", "The download byte limit is invalid.");
    }
  }

  /**
   * Every failure path cancels the download: the body is a live HTTP response,
   * and leaving it unread would hold its connection open until a timeout.
   */
  public async write(path: string, source: DownloadSource): Promise<DownloadedFile> {
    let target: OutputFile;
    try {
      target = await this.#create(path, source.declaredBytes);
    } catch (cause) {
      await quietly(() => source.body.cancel());
      throw cause;
    }
    return this.#copy(source.body, target);
  }

  async #create(path: string, declaredBytes: number | null): Promise<OutputFile> {
    assertUsablePath(path);
    if (declaredBytes !== null && declaredBytes > this.#maxBytes) {
      throw sizeLimitError(this.#maxBytes);
    }
    const absolutePath = resolve(path);
    try {
      const handle = await open(absolutePath, CREATE_NEW_FILE, OWNER_READ_WRITE);
      return Object.freeze({ absolutePath, handle });
    } catch (cause) {
      throw new CliError(
        "validation_failed",
        "The output file must not exist yet, and its directory must be writable.",
        { cause },
      );
    }
  }

  async #copy(body: ReadableStream<Uint8Array>, target: OutputFile): Promise<DownloadedFile> {
    const reader = body.getReader();
    let bytes = 0;
    try {
      while (true) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (cause) {
          throw new CliError("network_failed", "Unable to read the Forgejo download.", {
            retryable: true,
            cause,
          });
        }
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > this.#maxBytes) throw sizeLimitError(this.#maxBytes);
        await writeFully(target.handle, next.value);
      }
      await target.handle.close();
      return Object.freeze({ path: target.absolutePath, bytes });
    } catch (cause) {
      // Whichever step failed — reading, writing, or the size cap — release the
      // connection first, then drop the partial file.
      await quietly(() => reader.cancel());
      await quietly(() => target.handle.close());
      await quietly(() => unlink(target.absolutePath));
      if (cause instanceof CliError) throw cause;
      throw new CliError("validation_failed", "Unable to write the output file.", { cause });
    } finally {
      reader.releaseLock();
    }
  }
}
