import { mkdtemp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { BunAssetFileSource } from "../../../src/cli/asset-file.js";

describe("BunAssetFileSource", () => {
  it("opens a regular file as a Blob with a basename and known size", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgejo-asset-"));
    const path = join(directory, "asset.bin");
    await writeFile(path, "asset-data");

    const asset = await new BunAssetFileSource({ maxBytes: 64 }).open(path);

    expect(asset.filename).toBe("asset.bin");
    expect(asset.size).toBe(10);
    expect(asset.content).toBeInstanceOf(Blob);
    await asset.close();
  });

  it("streams from the validated open file when its path is replaced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgejo-asset-"));
    const path = join(directory, "asset.bin");
    const replacement = join(directory, "replacement.bin");
    await writeFile(path, "validated-content");
    await writeFile(replacement, "replacement-content");

    const asset = await new BunAssetFileSource({ maxBytes: 64 }).open(path);
    await rename(replacement, path);

    expect(await asset.content.text()).toBe("validated-content");
    await asset.close();
  });

  it("rejects directories, symlinks, and files above the configured bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgejo-asset-"));
    const nested = join(directory, "nested");
    const large = join(directory, "large.bin");
    const link = join(directory, "asset-link");
    await mkdir(nested);
    await writeFile(large, "12345");
    await symlink(large, link);
    const source = new BunAssetFileSource({ maxBytes: 4 });

    await expect(source.open(nested)).rejects.toThrow();
    await expect(source.open(link)).rejects.toThrow();
    await expect(source.open(large)).rejects.toThrow();
  });
});
