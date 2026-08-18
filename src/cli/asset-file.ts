import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";

import { CliError } from "../core/errors.js";
import { hasControlCharacter } from "../core/text-validation.js";

const DEFAULT_MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;

export type AssetFile = Readonly<{
  content: Blob;
  filename: string;
  size: number;
  close(): Promise<void>;
}>;

export interface AssetFileSource {
  open(path: string): Promise<AssetFile>;
}

export type BunAssetFileSourceOptions = Readonly<{
  maxBytes?: number;
}>;

export class BunAssetFileSource implements AssetFileSource {
  readonly #maxBytes: number;

  public constructor(options: BunAssetFileSourceOptions = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_ASSET_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new CliError("validation_failed", "The release asset byte limit is invalid.");
    }
  }

  public async open(path: string): Promise<AssetFile> {
    if (
      path.length === 0 ||
      path.trim() !== path ||
      Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
      hasControlCharacter(path)
    ) {
      throw new CliError("validation_failed", "The release asset path is invalid.");
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      throw new CliError("validation_failed", "The release asset file is unavailable.", { cause });
    }

    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new CliError("validation_failed", "The release asset must be a regular file.");
      }
      if (!Number.isSafeInteger(stats.size) || stats.size > this.#maxBytes) {
        throw new CliError(
          "validation_failed",
          `The release asset exceeds the ${this.#maxBytes}-byte limit.`,
        );
      }

      const content = Bun.file(handle.fd).slice(0, stats.size);
      let closed = false;
      return Object.freeze({
        content,
        filename: basename(path),
        size: stats.size,
        close: async () => {
          if (closed) return;
          closed = true;
          await handle.close();
        },
      });
    } catch (cause) {
      await handle.close().catch(() => undefined);
      if (cause instanceof CliError) throw cause;
      throw new CliError("validation_failed", "The release asset file is unavailable.", { cause });
    }
  }
}
