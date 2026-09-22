import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunDownloadFileTarget } from "../../../src/cli/download-file.js";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function failingStream(first: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(first));
        return;
      }
      controller.error(new Error("connection reset"));
    },
  });
}

/** A live, unfinished body, like an HTTP download nobody has finished reading. */
function trackedStream(...chunks: string[]): {
  stream: ReadableStream<Uint8Array>;
  wasCancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("BunDownloadFileTarget", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "forgejo-download-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("streams a download into a new owner-only file and reports its absolute path and size", async () => {
    const path = join(directory, "logs.zip");

    const written = await new BunDownloadFileTarget().write(path, {
      body: streamOf("PK", "-archive"),
      declaredBytes: 10,
    });

    expect(written).toEqual({ path, bytes: 10 });
    expect(await readFile(path, "utf8")).toBe("PK-archive");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("never overwrites an existing file", async () => {
    const path = join(directory, "keep.zip");
    await writeFile(path, "original");

    await expect(
      new BunDownloadFileTarget().write(path, { body: streamOf("new"), declaredBytes: null }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(await readFile(path, "utf8")).toBe("original");
  });

  it("never writes through a symlink at the output path", async () => {
    const target = join(directory, "elsewhere.txt");
    const link = join(directory, "link.zip");
    await symlink(target, link);

    await expect(
      new BunDownloadFileTarget().write(link, { body: streamOf("data"), declaredBytes: null }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(await exists(target)).toBe(false);
  });

  it("refuses a declared size above the limit before creating anything", async () => {
    const path = join(directory, "big.zip");

    await expect(
      new BunDownloadFileTarget({ maxBytes: 4 }).write(path, {
        body: streamOf("12345"),
        declaredBytes: 5,
      }),
    ).rejects.toMatchObject({ code: "protocol_failed" });
    expect(await exists(path)).toBe(false);
  });

  it("stops at the limit when the size was not declared, and removes the partial file", async () => {
    const path = join(directory, "undeclared.zip");

    await expect(
      new BunDownloadFileTarget({ maxBytes: 4 }).write(path, {
        body: streamOf("12", "345"),
        declaredBytes: null,
      }),
    ).rejects.toMatchObject({ code: "protocol_failed" });
    expect(await exists(path)).toBe(false);
  });

  it("removes the partial file when the transfer fails midway", async () => {
    const path = join(directory, "broken.zip");

    await expect(
      new BunDownloadFileTarget().write(path, {
        body: failingStream("half"),
        declaredBytes: null,
      }),
    ).rejects.toMatchObject({ code: "network_failed" });
    expect(await exists(path)).toBe(false);
  });

  it("rejects unsafe or unusable output paths", async () => {
    const target = new BunDownloadFileTarget();

    for (const path of ["", " padded.zip", "bad\nname.zip", join(directory, "missing", "a.zip")]) {
      await expect(
        target.write(path, { body: streamOf("x"), declaredBytes: null }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    }
  });

  it("cancels the download when the output path is rejected, so the connection closes at once", async () => {
    const download = trackedStream("never read");

    await expect(
      new BunDownloadFileTarget().write("bad\nname.zip", {
        body: download.stream,
        declaredBytes: null,
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(download.wasCancelled()).toBe(true);
  });

  it("cancels the download when the transfer fails midway, not only when reading fails", async () => {
    const path = join(directory, "capped.zip");
    const download = trackedStream("12", "345");

    await expect(
      new BunDownloadFileTarget({ maxBytes: 4 }).write(path, {
        body: download.stream,
        declaredBytes: null,
      }),
    ).rejects.toMatchObject({ code: "protocol_failed" });
    expect(download.wasCancelled()).toBe(true);
    expect(await exists(path)).toBe(false);
  });

  it("rejects an invalid byte limit", () => {
    expect(() => new BunDownloadFileTarget({ maxBytes: 0 })).toThrow();
  });
});
