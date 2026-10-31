import { CliError } from "../core/errors.js";
import { parsePositiveInteger } from "./command-options.js";

export type PollingRuntime = Readonly<{
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}>;
export type PollingOptions = Readonly<{ intervalMs: number; timeoutMs: number }>;
export type RawPollingOptions = Readonly<{ interval?: string; timeout?: string }>;

export function pollingOptions(options: RawPollingOptions): PollingOptions {
  const interval = parsePositiveInteger(options.interval ?? "3", "poll interval");
  const timeout = parsePositiveInteger(options.timeout ?? "300", "watch timeout");
  if (interval > 3600 || timeout > 86400) {
    throw new CliError(
      "validation_failed",
      "Interval must be at most 3600 seconds and timeout at most 86400 seconds.",
    );
  }
  return { intervalMs: interval * 1000, timeoutMs: timeout * 1000 };
}

function stopped(signal: AbortSignal | undefined, expired: boolean): void {
  if (signal?.aborted) throw new CliError("cancelled", "Watching was cancelled.");
  if (expired) throw new CliError("timeout", "Watching timed out before completion.");
}

// The API transport has its own request timeout; this also bounds a stalled poll or sleep.
async function bounded<T>(
  operation: () => Promise<T>,
  remaining: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      cancel = () => reject(new CliError("cancelled", "Watching was cancelled."));
      timer = setTimeout(
        () => reject(new CliError("timeout", "Watching timed out before completion.")),
        remaining,
      );
      signal?.addEventListener("abort", cancel, { once: true });
      Promise.resolve()
        .then(() => {
          stopped(signal, false);
          return operation();
        })
        .then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    if (cancel !== undefined) signal?.removeEventListener("abort", cancel);
  }
}

async function sleepFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const cancel = () => {
    clearTimeout(timer);
    wake?.();
  };
  try {
    await new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, milliseconds);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

export async function pollUntil<T>(
  load: (signal: AbortSignal) => Promise<T>,
  complete: (value: T) => boolean,
  options: PollingOptions,
  runtime: PollingRuntime = {},
  progress?: (value: T) => void,
): Promise<T> {
  const now = runtime.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  runtime.signal?.addEventListener("abort", cancel, { once: true });
  if (runtime.signal?.aborted) cancel();
  const sleep = runtime.sleep ?? ((milliseconds) => sleepFor(milliseconds, controller.signal));
  try {
    for (;;) {
      stopped(controller.signal, now() >= deadline);
      const value = await bounded(
        () => load(controller.signal),
        deadline - now(),
        controller.signal,
      );
      stopped(controller.signal, now() >= deadline);
      progress?.(value);
      if (complete(value)) return value;
      await bounded(
        () => sleep(Math.min(options.intervalMs, deadline - now())),
        deadline - now(),
        controller.signal,
      );
    }
  } finally {
    controller.abort();
    runtime.signal?.removeEventListener("abort", cancel);
  }
}
