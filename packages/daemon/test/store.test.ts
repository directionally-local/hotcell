import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyUsage, SandboxStore } from "../src/store.js";
import type {
  CodeContextInfo,
  ExposedPort,
  ProcessInfo,
  SandboxRecord,
  SessionInfo,
  TemplateRecord,
} from "../src/types.js";

function record(id: string, overrides: Partial<SandboxRecord> = {}): SandboxRecord {
  return {
    id,
    image: "alpine",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    labels: {},
    env: {},
    persist: true,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    sleepAfterMs: 0,
    usage: emptyUsage(),
    limits: {},
    ...overrides,
  };
}

function proc(procId: string): ProcessInfo {
  return {
    procId,
    pid: 42,
    command: "sleep 1",
    status: "running",
    exitCode: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath: `/tmp/${procId}.log`,
  };
}

function exposed(port: number): ExposedPort {
  return {
    port,
    exposeId: `sbx-${port}`,
    token: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    url: `http://sbx-${port}.localhost:4751/`,
  };
}

function session(sessionId: string): SessionInfo {
  return { sessionId, cwd: "/workspace", env: {}, createdAt: "2026-01-01T00:00:00.000Z" };
}

function context(contextId: string): CodeContextInfo {
  return {
    contextId,
    language: "python",
    dir: `/tmp/${contextId}`,
    procId: "p1",
    pid: 7,
    seq: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function template(name: string): TemplateRecord {
  return {
    name,
    driver: "firecracker",
    image: "alpine",
    limits: { memoryMb: 128 },
    createdAt: "2026-01-01T00:00:00.000Z",
    sizeBytes: 1024,
  };
}

describe("emptyUsage", () => {
  it("returns a zeroed accumulator", () => {
    assert.deepEqual(emptyUsage(), {
      cpuSeconds: 0,
      memByteSeconds: 0,
      egressBytes: 0,
      providerCalls: 0,
      providerBytes: 0,
      providerTokensIn: 0,
      providerTokensOut: 0,
      providerCost: 0,
      lastCpuTotalNs: 0,
      lastSampledAt: "",
    });
  });
});

describe("SandboxStore sandboxes", () => {
  it("adds, gets, lists and removes records", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a", { createdAt: "2026-01-01T00:00:00.000Z" }));
      store.add(record("b", { createdAt: "2026-01-02T00:00:00.000Z" }));

      assert.equal(store.get("a")?.id, "a");
      assert.equal(store.get("missing"), undefined);

      // Newest first.
      assert.deepEqual(store.list().map((r) => r.id), ["b", "a"]);

      assert.equal(store.remove("a"), true);
      assert.equal(store.remove("a"), false);
      assert.equal(store.get("a"), undefined);
    } finally {
      store.close();
    }
  });

  it("upserts on a repeated id", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a", { status: "creating" }));
      store.add(record("a", { status: "running" }));
      assert.equal(store.get("a")?.status, "running");
      assert.equal(store.list().length, 1);
    } finally {
      store.close();
    }
  });

  it("touch refreshes lastActivityAt and is a no-op for unknown ids", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a", { lastActivityAt: "2020-01-01T00:00:00.000Z" }));
      store.touch("a");
      assert.notEqual(store.get("a")?.lastActivityAt, "2020-01-01T00:00:00.000Z");
      assert.doesNotThrow(() => store.touch("missing"));
    } finally {
      store.close();
    }
  });
});

describe("SandboxStore exec tracking", () => {
  it("counts open exec streams and never goes negative", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      assert.equal(store.openExecs("a"), 0);
      store.beginExec("a");
      store.beginExec("a");
      assert.equal(store.openExecs("a"), 2);
      store.endExec("a");
      assert.equal(store.openExecs("a"), 1);
      store.endExec("a");
      store.endExec("a");
      assert.equal(store.openExecs("a"), 0);
    } finally {
      store.close();
    }
  });
});

describe("SandboxStore usage", () => {
  it("accumulates egress bytes, ignoring non-positive and unknown ids", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      store.addEgress("a", 100);
      store.addEgress("a", 50);
      store.addEgress("a", 0);
      store.addEgress("a", -10);
      store.addEgress("missing", 10);
      assert.equal(store.get("a")?.usage.egressBytes, 150);
    } finally {
      store.close();
    }
  });

  it("accumulates provider usage and clamps negative deltas", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      store.addProviderUsage("a", { bytes: 10, tokensIn: 5, tokensOut: 3, cost: 0.25 });
      store.addProviderUsage("a", { bytes: -1, tokensIn: -1, tokensOut: -1, cost: -1 });
      const usage = store.get("a")!.usage;
      assert.equal(usage.providerCalls, 2);
      assert.equal(usage.providerBytes, 10);
      assert.equal(usage.providerTokensIn, 5);
      assert.equal(usage.providerTokensOut, 3);
      assert.equal(usage.providerCost, 0.25);
    } finally {
      store.close();
    }
  });

  it("setUsage replaces the accumulator", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      store.setUsage("a", { ...emptyUsage(), cpuSeconds: 12 });
      assert.equal(store.get("a")?.usage.cpuSeconds, 12);
      assert.doesNotThrow(() => store.setUsage("missing", emptyUsage()));
    } finally {
      store.close();
    }
  });
});

describe("SandboxStore egress tokens", () => {
  it("binds, resolves, spends and revokes tokens", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      store.addEgressToken("tok", "a", { spendCapUsd: 5 });

      assert.equal(store.resolveEgressToken("tok"), "a");
      assert.equal(store.resolveEgressToken("nope"), undefined);

      const full = store.resolveEgressTokenFull("tok");
      assert.equal(full?.sandboxId, "a");
      assert.equal(full?.policy.spendCapUsd, 5);
      assert.equal(full?.spendUsd, 0);

      store.addEgressTokenSpend("tok", 1.5);
      assert.equal(store.resolveEgressTokenFull("tok")?.spendUsd, 1.5);

      assert.deepEqual(store.listEgressTokens("a").map((t) => t.token), ["tok"]);
      assert.equal(store.removeEgressToken("tok"), true);
      assert.equal(store.removeEgressToken("tok"), false);
      assert.equal(store.resolveEgressToken("tok"), undefined);
    } finally {
      store.close();
    }
  });
});

describe("SandboxStore runtime state", () => {
  it("stores processes", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      store.addProcess("a", proc("p1"));
      assert.equal(store.getProcess("a", "p1")?.pid, 42);
      assert.equal(store.getProcess("a", "missing"), undefined);
      assert.deepEqual(store.listProcesses("a").map((p) => p.procId), ["p1"]);
    } finally {
      store.close();
    }
  });

  it("stores exposed ports and resolves routes", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      store.addExposed("a", exposed(8080));
      store.addExposed("a", exposed(3000));

      assert.deepEqual(store.listExposed("a").map((e) => e.port), [3000, 8080]);
      assert.deepEqual(store.resolveRoute("sbx-8080"), {
        sandboxId: "a",
        port: 8080,
        token: null,
      });

      assert.equal(store.removeExposed("a", 8080), true);
      assert.equal(store.removeExposed("a", 8080), false);
      assert.equal(store.resolveRoute("sbx-8080"), undefined);
    } finally {
      store.close();
    }
  });

  it("stores sessions", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      store.addSession("a", session("s1"));
      assert.equal(store.getSession("a", "s1")?.cwd, "/workspace");
      assert.equal(store.getSession("a", "missing"), undefined);
      assert.deepEqual(store.listSessions("a").map((s) => s.sessionId), ["s1"]);
      assert.equal(store.removeSession("a", "s1"), true);
      assert.equal(store.removeSession("a", "s1"), false);
    } finally {
      store.close();
    }
  });

  it("stores code contexts", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      store.addContext("a", context("c1"));
      assert.equal(store.getContext("a", "c1")?.pid, 7);
      assert.equal(store.getContext("a", "missing"), undefined);
      assert.deepEqual(store.listContexts("a").map((c) => c.contextId), ["c1"]);
      assert.equal(store.removeContext("a", "c1"), true);
      assert.equal(store.removeContext("a", "c1"), false);
    } finally {
      store.close();
    }
  });

  it("clearRuntimeState drops processes, ports and contexts but keeps sessions", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      store.addProcess("a", proc("p1"));
      store.addExposed("a", exposed(8080));
      store.addContext("a", context("c1"));
      store.addSession("a", session("s1"));

      store.clearRuntimeState("a");

      assert.deepEqual(store.listProcesses("a"), []);
      assert.deepEqual(store.listExposed("a"), []);
      assert.deepEqual(store.listContexts("a"), []);
      assert.equal(store.resolveRoute("sbx-8080"), undefined);
      assert.equal(store.getSession("a", "s1")?.sessionId, "s1");
      assert.equal(store.get("a")?.id, "a");
    } finally {
      store.close();
    }
  });

  it("clearSandbox also drops sessions and egress tokens", () => {
    const store = new SandboxStore();
    try {
      store.add(record("a"));
      store.addSession("a", session("s1"));
      store.addEgressToken("tok", "a");

      store.clearSandbox("a");

      assert.deepEqual(store.listSessions("a"), []);
      assert.deepEqual(store.listEgressTokens("a"), []);
      assert.equal(store.resolveEgressToken("tok"), undefined);
      assert.equal(store.get("a")?.id, "a");
    } finally {
      store.close();
    }
  });
});

describe("SandboxStore templates", () => {
  it("adds, gets, lists and removes templates", () => {
    const store = new SandboxStore();
    try {
      store.addTemplate(template("t1"));
      assert.equal(store.getTemplate("t1")?.driver, "firecracker");
      assert.equal(store.getTemplate("missing"), undefined);
      assert.deepEqual(store.listTemplates().map((t) => t.name), ["t1"]);
      assert.equal(store.removeTemplate("t1"), true);
      assert.equal(store.removeTemplate("t1"), false);
    } finally {
      store.close();
    }
  });
});
