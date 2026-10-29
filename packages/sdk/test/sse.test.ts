import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSSE } from "../src/index.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(body: ReadableStream<Uint8Array>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of parseSSE<T>(body)) out.push(event);
  return out;
}

describe("parseSSE", () => {
  it("parses data frames into JSON events", async () => {
    const body = streamOf(['data: {"type":"stdout","data":"hi"}\n\n', 'data: {"type":"exit","exitCode":0}\n\n']);
    assert.deepEqual(await collect(body), [
      { type: "stdout", data: "hi" },
      { type: "exit", exitCode: 0 },
    ]);
  });

  it("handles frames split across chunks", async () => {
    const wire = 'data: {"type":"stdout","data":"hello"}\n\n';
    const chunks = [wire.slice(0, 5), wire.slice(5, 20), wire.slice(20)];
    assert.deepEqual(await collect(streamOf(chunks)), [{ type: "stdout", data: "hello" }]);
  });

  it("skips comment and empty-data frames", async () => {
    const body = streamOf([": ping\n\n", "data: \n\n", 'data: {"type":"end"}\n\n']);
    assert.deepEqual(await collect(body), [{ type: "end" }]);
  });
});
