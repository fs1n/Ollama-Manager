import { describe, expect, test } from "bun:test";
import { clip, readBodyLimited, withIdleTimeout } from "./http";

function trickle(chunks: string[], gapMs: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(new TextEncoder().encode(c));
        await Bun.sleep(gapMs);
      }
      controller.close();
    },
  });
}

describe("withIdleTimeout", () => {
  test("passes a steadily streaming body through untouched", async () => {
    const body = withIdleTimeout(trickle(["a", "b", "c"], 5), 200, () => {});
    expect(await new Response(body).text()).toBe("abc");
  });

  test("a slow total is fine as long as chunks keep coming", async () => {
    // 6 chunks × 20 ms = 120 ms total, above the 50 ms idle limit
    const body = withIdleTimeout(trickle(["1", "2", "3", "4", "5", "6"], 20), 50, () => {});
    expect(await new Response(body).text()).toBe("123456");
  });

  test("errors and aborts upstream once no chunk arrives within the limit", async () => {
    let aborted = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
      },
    });
    const body = withIdleTimeout(stalled, 30, () => {
      aborted = true;
    });
    await expect(new Response(body).text()).rejects.toThrow(/Idle timeout/);
    expect(aborted).toBe(true);
  });

  test("null bodies stay null", () => {
    expect(withIdleTimeout(null, 10, () => {})).toBeNull();
  });
});

describe("readBodyLimited", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://x/", { method: "POST", body, headers });

  test("returns bodies within the limit", async () => {
    expect(await readBodyLimited(post('{"key":"x"}'), 100)).toBe('{"key":"x"}');
  });

  test("refuses by declared length and by actual length", async () => {
    expect(await readBodyLimited(post("x".repeat(200)), 100)).toBeNull();
    expect(await readBodyLimited(post("tiny", { "content-length": "999999" }), 100)).toBeNull();
  });
});

test("clip shortens long log values", () => {
  expect(clip("abcdef", 3)).toBe("abc…");
  expect(clip("abc", 3)).toBe("abc");
});
