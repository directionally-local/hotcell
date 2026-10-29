import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSSE } from "../../sdk/src/index.js";
import { formatSseEvent } from "../src/api/sse.js";

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

describe("formatSseEvent", () => {
  it("frames an event as a single data line followed by a blank line", () => {
    assert.equal(formatSseEvent({ type: "exit", exitCode: 0 }), 'data: {"type":"exit","exitCode":0}\n\n');
  });
});

describe("SSE writer → parseSSE round trip", () => {
  it("round-trips a sequence of events", async () => {
    const events = [
      { type: "stdout", data: "hello" },
      { type: "stderr", data: "oops" },
      { type: "exit", exitCode: 0 },
    ];
    const body = streamOf(events.map(formatSseEvent));
    assert.deepEqual(await collect(body), events);
  });

  it("reassembles frames split across chunk boundaries", async () => {
    const events = [
      { type: "stdout", data: "a".repeat(50) },
      { type: "exit", exitCode: 1 },
    ];
    const wire = events.map(formatSseEvent).join("");
    // Split at awkward points, including mid-frame and mid-JSON.
    const chunks = [wire.slice(0, 3), wire.slice(3, 17), wire.slice(17, 40), wire.slice(40)];
    assert.deepEqual(await collect(streamOf(chunks)), events);
  });

  it("skips frames without a data line and empty data", async () => {
    const body = streamOf([": keepalive\n\n", "data: \n\n", formatSseEvent({ type: "end" })]);
    assert.deepEqual(await collect(body), [{ type: "end" }]);
  });

  it("ignores a trailing partial frame", async () => {
    const body = streamOf([formatSseEvent({ type: "end" }), 'data: {"type":"stdout"']);
    assert.deepEqual(await collect(body), [{ type: "end" }]);
  });
});
