import { describe, expect, test } from "bun:test";
import { createTtlCache } from "./cache";

describe("createTtlCache", () => {
  test("loads once, then serves from cache while fresh", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 60_000 });
    let loads = 0;
    const load = async () => ++loads;
    expect((await cache.get("a", load)).value).toBe(1);
    expect((await cache.get("a", load)).value).toBe(1);
    expect(loads).toBe(1);
  });

  test("concurrent callers share one in-flight load", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 60_000 });
    let loads = 0;
    const load = () => new Promise<number>((r) => setTimeout(() => r(++loads), 5));
    const results = await Promise.all([
      cache.get("a", load),
      cache.get("a", load),
      cache.get("a", load),
    ]);
    expect(results.map((r) => r.value)).toEqual([1, 1, 1]);
    expect(loads).toBe(1);
  });

  test("a failed refresh serves the expired value as stale", async () => {
    const cache = createTtlCache<string, string>({ ttlMs: 1 });
    await cache.get("a", async () => "old");
    await Bun.sleep(5);
    const r = await cache.get("a", async () => {
      throw new Error("down");
    });
    expect(r).toEqual({ value: "old", fresh: false, stale: true });
  });

  test("without a previous value the error propagates", async () => {
    const cache = createTtlCache<string, string>({ ttlMs: 1 });
    await expect(
      cache.get("a", async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
  });

  test("evicts the least recently stored entry beyond maxEntries", async () => {
    const cache = createTtlCache<number, number>({ ttlMs: 60_000, maxEntries: 3 });
    for (let i = 0; i < 5; i++) await cache.get(i, async () => i);
    expect(cache.size).toBe(3);
    let reloaded = false;
    await cache.get(0, async () => {
      reloaded = true;
      return 0;
    });
    expect(reloaded).toBe(true);
  });

  test("sweep drops long-expired entries", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 10 });
    await cache.get("a", async () => 1);
    cache.sweep(10, Date.now() + 1_000);
    expect(cache.size).toBe(0);
  });
});
