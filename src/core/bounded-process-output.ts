export type BoundedProcess = Readonly<{
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
}>;

export class ProcessOutputLimitError extends Error {
  public constructor() {
    super("Process output exceeded its fixed byte limit.");
    this.name = "ProcessOutputLimitError";
  }
}

export class ProcessDeadlineError extends Error {
  public constructor() {
    super("Process exceeded its fixed execution deadline.");
    this.name = "ProcessDeadlineError";
  }
}

type ProcessOutputReader = Readonly<{
  read(): Promise<Readonly<{ done: boolean; value?: Uint8Array | undefined }>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}>;

async function readNextChunk(
  reader: ProcessOutputReader,
  signal: AbortSignal | undefined,
): Promise<Readonly<{ done: boolean; value?: Uint8Array | undefined }>> {
  if (signal === undefined) return reader.read();
  if (signal.aborted) {
    void reader.cancel().catch(() => undefined);
    throw new ProcessDeadlineError();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
      finish(() => reject(new ProcessDeadlineError()));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (cause: unknown) => finish(() => reject(cause)),
    );
  });
}

export async function withProcessDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Process deadline must be a positive safe integer.");
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new ProcessDeadlineError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function readBoundedProcessOutput(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("Process output byte limit must be a positive safe integer.");
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await readNextChunk(reader, options.signal);
      if (result.done) break;

      const chunk = result.value;
      if (chunk === undefined) {
        throw new TypeError("Process output stream returned an invalid chunk.");
      }
      if (totalBytes + chunk.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProcessOutputLimitError();
      }
      totalBytes += chunk.byteLength;
      chunks.push(chunk.slice());
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A deadline may leave a pending read until the terminated child closes its pipe.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
