import { afterEach, describe, expect, it, vi } from "vitest";

import { pushWithRetry } from "./retry.js";

describe("pushWithRetry", () => {
  afterEach(() => vi.useRealTimers());

  it("returns on first success without retrying", async () => {
    const fn = vi.fn();
    await pushWithRetry(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error("The remote end hung up unexpectedly");
    });
    const done = pushWithRetry(fn);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("matches transient markers in the git stderr buffer", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("git push failed") as Error & { stderr?: Buffer };
        err.stderr = Buffer.from("fatal: early EOF");
        throw err;
      }
    });
    const done = pushWithRetry(fn);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on a permanent error", async () => {
    const fn = vi.fn(() => {
      throw new Error("remote: Permission to repo denied");
    });
    await expect(pushWithRetry(fn)).rejects.toThrow("Permission");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting the backoff (1s/2s/4s)", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(() => {
      throw new Error("error: 500 Internal Server Error");
    });
    const done = pushWithRetry(fn);
    const rejection = expect(done).rejects.toThrow("500");
    await vi.advanceTimersByTimeAsync(7000);
    await rejection;
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
  });
});
