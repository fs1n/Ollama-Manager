import { describe, expect, test } from "bun:test";
import { readNdjsonLines } from "./api";

function chunked(...parts: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const p of parts) controller.enqueue(new TextEncoder().encode(p));
        controller.close();
      },
    }),
  );
}

async function collect(r: Response): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const line of readNdjsonLines(r)) out.push(line);
  return out;
}

describe("readNdjsonLines", () => {
  test("one object per line", async () => {
    expect(await collect(chunked('{"a":1}\n{"a":2}\n'))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("objects split across chunk boundaries are reassembled", async () => {
    expect(await collect(chunked('{"sta', 'tus":"pull', 'ing"}\n{"b"', ":2}\n"))).toEqual([
      { status: "pulling" },
      { b: 2 },
    ]);
  });

  test("a final line without newline is still read", async () => {
    expect(await collect(chunked('{"a":1}\n{"done":true}'))).toEqual([{ a: 1 }, { done: true }]);
  });

  test("blank lines and broken JSON are skipped, not fatal", async () => {
    expect(await collect(chunked('{"a":1}\n\n  \nnot json\n{"a":2}\n{"trunc'))).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  test("multibyte characters split between chunks survive", async () => {
    const bytes = new TextEncoder().encode('{"t":"Grüße"}\n');
    const cut = bytes.indexOf(0xc3) + 1; // in the middle of "ü"
    const r = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes.slice(0, cut));
          c.enqueue(bytes.slice(cut));
          c.close();
        },
      }),
    );
    expect(await collect(r)).toEqual([{ t: "Grüße" }]);
  });

  test("no body yields nothing", async () => {
    expect(await collect(new Response(null))).toEqual([]);
  });
});
