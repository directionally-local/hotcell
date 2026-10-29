import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HotcellClient } from "../src/index.js";

const originalFetch = globalThis.fetch;

function stubFetch(capture: (body: Record<string, unknown>) => void): void {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capture(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        id: "sbx1",
        status: "running",
        image: "img",
        createdAt: new Date().toISOString(),
        labels: {},
        env: {},
        persist: true,
        lastActivityAt: new Date().toISOString(),
        sleepAfterMs: 0,
        limits: {},
        usage: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("getSandbox create body", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("forwards repo, repoRef and patch to the daemon", async () => {
    let body: Record<string, unknown> = {};
    stubFetch((b) => (body = b));
    const client = new HotcellClient({ endpoint: "http://127.0.0.1:4750", apiKey: "k" });
    await client.getSandbox(undefined, {
      repo: "https://github.com/o/r.git",
      repoRef: "main",
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n",
    });
    assert.equal(body.repo, "https://github.com/o/r.git");
    assert.equal(body.repoRef, "main");
    assert.equal(body.patch, "diff --git a/x b/x\n--- a/x\n+++ b/x\n");
  });

  it("createRunSandbox defaults egress on and forwards the run options", async () => {
    let body: Record<string, unknown> = {};
    stubFetch((b) => (body = b));
    const client = new HotcellClient({ endpoint: "http://127.0.0.1:4750", apiKey: "k" });
    await client.createRunSandbox({
      repo: "https://github.com/o/r.git",
      patch: "diff --git a/x b/x\n",
      memoryMb: 2048,
      cpus: 2,
    });
    assert.equal(body.egress, true);
    assert.equal(body.repo, "https://github.com/o/r.git");
    assert.equal(body.patch, "diff --git a/x b/x\n");
    assert.equal(body.memoryMb, 2048);
    assert.equal(body.cpus, 2);
  });

  it("omits patch when not supplied", async () => {
    let body: Record<string, unknown> = {};
    stubFetch((b) => (body = b));
    const client = new HotcellClient({ endpoint: "http://127.0.0.1:4750", apiKey: "k" });
    await client.getSandbox(undefined, { repo: "https://github.com/o/r.git" });
    assert.equal("patch" in body, false);
  });
});
