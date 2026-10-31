import { describe, expect, it } from "bun:test";
import { pollingOptions, pollUntil } from "../../../src/cli/polling.js";

describe("bounded polling", () => {
  it("polls serially, reports progress, and returns the terminal observation", async () => {
    let time = 0;
    let loads = 0;
    const progress: number[] = [];
    const result = await pollUntil(
      async () => ++loads,
      (value) => value === 3,
      { intervalMs: 10, timeoutMs: 100 },
      {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
      (value) => progress.push(value),
    );
    expect(result).toBe(3);
    expect(time).toBe(20);
    expect(progress).toEqual([1, 2, 3]);
  });
  it("times out without starting another request after its deadline", async () => {
    let time = 0;
    let loads = 0;
    await expect(
      pollUntil(
        async () => ++loads,
        () => false,
        { intervalMs: 10, timeoutMs: 15 },
        {
          now: () => time,
          sleep: async (ms) => {
            time += ms;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(loads).toBe(2);
    expect(time).toBe(15);
  });
  it("rejects terminal data returned after the deadline", async () => {
    let time = 0;
    await expect(
      pollUntil(
        async () => {
          time = 11;
          return true;
        },
        Boolean,
        { intervalMs: 1, timeoutMs: 10 },
        { now: () => time },
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });
  it("stops on cancellation, including an in-flight request", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = pollUntil(
      async () => {
        calls++;
        controller.abort();
        return new Promise<boolean>(() => {});
      },
      Boolean,
      { intervalMs: 10, timeoutMs: 100 },
      { signal: controller.signal },
    );
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(1);
  });
  it("bounds an unresponsive request", async () => {
    await expect(
      pollUntil(async () => new Promise<boolean>(() => {}), Boolean, {
        intervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
  it("validates and bounds CLI interval and timeout before polling", () => {
    expect(pollingOptions({ interval: "2", timeout: "10" })).toEqual({
      intervalMs: 2000,
      timeoutMs: 10000,
    });
    for (const options of [
      { interval: "0" },
      { timeout: "NaN" },
      { timeout: "86401" },
      { interval: "3601" },
    ])
      expect(() => pollingOptions(options)).toThrow();
  });
});

it("uses the production sleeper and aborts its long timer on cancellation", async () => {
  let loads = 0;
  expect(
    await pollUntil(
      async () => ++loads,
      (value) => value === 2,
      { intervalMs: 1, timeoutMs: 100 },
    ),
  ).toBe(2);
  const controller = new AbortController();
  const result = pollUntil(
    async () => false,
    Boolean,
    { intervalMs: 1000000, timeoutMs: 2000000 },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 1);
  await expect(result).rejects.toMatchObject({ code: "cancelled" });
});

it("aborts the signal passed to the load when its deadline expires", async () => {
  let signal: AbortSignal | undefined;
  await expect(
    pollUntil(
      async (value) => {
        signal = value;
        return new Promise<boolean>(() => {});
      },
      Boolean,
      { intervalMs: 1, timeoutMs: 5 },
    ),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(signal?.aborted).toBe(true);
});
