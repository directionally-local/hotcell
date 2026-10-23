/**
 * Docker-free egress control-plane check. Exercises the gateway's policy
 * enforcement + cost metering entirely in-process (mock upstream + in-memory
 * store), so the per-token policy logic can be verified anywhere — no container
 * runtime required (the full container-backed flow is asserted by `smoke.ts` /
 * `smoke-remote.ts` against a real daemon). Run: `npm run check:egress`.
 */

import { createServer, request as httpRequest } from "node:http";
import { createServer as netCreateServer } from "node:net";
import assert from "node:assert/strict";
import { buildProviders, createEgressProxy } from "./proxy/egress.js";
import { parseEgressFirewallDrop } from "./net/firewall.js";
import { proxyEnvWanted } from "./api/server.js";
import { Allowlist } from "./proxy/allowlist.js";
import { DEFAULT_MODEL_PRICES } from "./pricing.js";
import { loadConfig } from "./config.js";
import { emptyUsage, SandboxStore } from "./store.js";
import type { EgressPolicy, SandboxRecord } from "./types.js";

const REAL_KEY = "REAL-KEY-123";

async function main(): Promise<void> {
  const config = loadConfig();
  config.dbPath = ":memory:";
  const store = new SandboxStore(":memory:");

  const sandboxId = "sbxtest01";
  const rec: SandboxRecord = {
    id: sandboxId,
    image: "test",
    status: "running",
    createdAt: new Date().toISOString(),
    labels: {},
    env: {},
    persist: false,
    lastActivityAt: new Date().toISOString(),
    sleepAfterMs: 0,
    limits: {},
    usage: emptyUsage(),
  };
  store.add(rec);

  // Mock provider upstream: echoes the auth header it received, echoes the
  // request's `model`, returns 11/7 tokens, and includes `usage.cost` only when
  // asked via `x-mock-cost` — so we can exercise both the reported-cost and the
  // computed-from-table paths.
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let model = "gpt-4o";
      try {
        const o = JSON.parse(body || "{}");
        if (typeof o.model === "string") model = o.model;
      } catch {
        /* ignore */
      }
      const usage: Record<string, number> = { prompt_tokens: 11, completion_tokens: 7 };
      if (req.headers["x-mock-cost"]) usage.cost = 0.0123;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model, usage, receivedAuth: req.headers["authorization"] }));
    });
  });
  const upstreamPort = await listen(upstream);

  const egress = createEgressProxy({
    config,
    store,
    prices: DEFAULT_MODEL_PRICES,
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        authHeader: "authorization",
        format: (k: string) => `Bearer ${k}`,
        apiKey: REAL_KEY,
      },
    },
  });
  const egressPort = await listen(egress);
  const base = `http://127.0.0.1:${egressPort}`;

  const mint = (policy: EgressPolicy = {}): string => {
    const token = SandboxStore.newEgressToken();
    store.addEgressToken(token, sandboxId, policy);
    return token;
  };
  const call = async (
    token: string,
    body: Record<string, unknown> = { model: "gpt-4o" },
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${base}/mock/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hotcell-egress": token, ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`  ✓ ${label}`);
  };

  // 0) Parse the per-packet kernel log emitted before an enforced DROP.
  {
    assert.deepEqual(
      parseEgressFirewallDrop("6,102,3456000,-;HOTCELL_EGRESS_DROP IN=br-test OUT=eth0 SRC=10.200.0.9 DST=203.0.113.8 LEN=60 PROTO=TCP SPT=42000 DPT=443 SYN"),
      { sourceIp: "10.200.0.9", destinationIp: "203.0.113.8", protocol: "tcp", port: 443 },
    );
    assert.equal(parseEgressFirewallDrop("6,103,3457000,-;ordinary kernel message"), undefined);
    ok("default-deny firewall log parser extracts source, destination, protocol, and port");
  }

  // 1) Key injection: upstream sees the REAL key, never the token.
  {
    const token = mint();
    const r = await call(token);
    assert.equal(r.status, 200, "valid call should 200");
    assert.equal(r.json.receivedAuth, `Bearer ${REAL_KEY}`, "upstream must see injected real key");
    ok("key injection: upstream receives real key, not the token");
  }

  // 2) Computed cost from the price table (no provider-reported cost).
  {
    const token = mint();
    await call(token, { model: "gpt-4o" });
    const u = store.get(sandboxId)!.usage;
    // gpt-4o = $2.5/1M in, $10/1M out → 11*2.5e-6 + 7*10e-6 = 9.75e-5
    const expected = (11 / 1e6) * 2.5 + (7 / 1e6) * 10;
    const spend = store.resolveEgressTokenFull(token)!.spendUsd;
    assert.ok(Math.abs(spend - expected) < 1e-12, `computed cost ${spend} != ${expected}`);
    assert.ok(u.providerCalls >= 1 && u.providerTokensIn >= 11, "tokens metered");
    ok(`computed cost from table: $${spend.toFixed(8)} for gpt-4o 11/7`);
  }

  // 3) Reported cost is authoritative (not recomputed) when present.
  {
    const token = mint();
    await call(token, { model: "gpt-4o" }, { "x-mock-cost": "1" });
    const spend = store.resolveEgressTokenFull(token)!.spendUsd;
    assert.ok(Math.abs(spend - 0.0123) < 1e-9, `reported cost should win, got ${spend}`);
    ok("reported cost authoritative ($0.0123)");
  }

  // 4) Invalid token → 403.
  {
    const r = await call("sbx-nope");
    assert.equal(r.status, 403, "invalid token should 403");
    ok("invalid token → 403");
  }

  // 5) Expired token → 403.
  {
    const token = mint({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const r = await call(token);
    assert.equal(r.status, 403, "expired token should 403");
    ok("expired token → 403");
  }

  // 6) Provider not in scope → 403.
  {
    const token = mint({ providers: ["openai"] }); // calling /mock
    const r = await call(token);
    assert.equal(r.status, 403, "out-of-scope provider should 403");
    ok("provider out of scope → 403");
  }

  // 7) Model not in allowlist → 403; allowed model → 200.
  {
    const token = mint({ models: ["gpt-4o"] });
    const bad = await call(token, { model: "gpt-3.5-turbo" });
    assert.equal(bad.status, 403, "disallowed model should 403");
    const good = await call(token, { model: "gpt-4o" });
    assert.equal(good.status, 200, "allowed model should 200");
    ok("model allowlist: gpt-3.5 → 403, gpt-4o → 200");
  }

  // 8) Spend cap → 402 once accumulated spend reaches the cap.
  {
    const token = mint({ spendCapUsd: 0.01 });
    const first = await call(token, { model: "gpt-4o" }, { "x-mock-cost": "1" }); // spends 0.0123
    assert.equal(first.status, 200, "first call under cap should 200");
    const second = await call(token, { model: "gpt-4o" }, { "x-mock-cost": "1" });
    assert.equal(second.status, 402, "second call over cap should 402");
    ok("spend cap → first 200, then 402");
  }

  // 9) Rate limit (calls) → 429 on the 2nd call within the window.
  {
    const token = mint({ rateLimit: { calls: 1, windowMs: 60_000 } });
    const first = await call(token);
    assert.equal(first.status, 200, "first call should 200");
    const second = await call(token);
    assert.equal(second.status, 429, "second call should 429");
    ok("rate limit (calls=1) → first 200, then 429");
  }

  // 10) Config-driven providers: built-ins, custom shapes, and CF-gateway repoint.
  {
    const cfg = loadConfig();
    cfg.providerKeys = { openai: "k1", google: "k2", cfopenai: "k3", noshape: "k4" };
    cfg.providerConfigs = {
      // Cloudflare AI Gateway prefix in front of OpenAI, expressed as a custom provider.
      cfopenai: {
        baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/openai",
        authHeader: "authorization",
        formatTemplate: "Bearer {key}",
      },
    };
    const built = buildProviders(cfg);
    assert.ok(built.openai && built.openai.baseUrl === "https://api.openai.com", "built-in openai");
    assert.ok(built.google && built.google.authHeader === "x-goog-api-key", "built-in google");
    assert.ok(built.cfopenai, "custom cfopenai provider present");
    assert.equal(built.cfopenai!.format("XYZ"), "Bearer XYZ", "custom format template applied");
    assert.ok(built.cfopenai!.baseUrl.includes("cloudflare"), "custom base URL used");
    assert.ok(!built.noshape, "keyed-but-shapeless provider is omitted");
    ok("config-driven providers: built-ins + custom CF-gateway, shapeless omitted");
  }

  // 11) Allowlist matcher (pure): exact, wildcard, denylist, port-strip.
  {
    const al = new Allowlist(["pypi.org", "*.githubusercontent.com"], ["dns.google"]);
    assert.equal(al.check("pypi.org").allow, true, "exact allow");
    assert.equal(al.check("raw.githubusercontent.com").allow, true, "wildcard allow");
    assert.equal(al.check("evil.example").allow, false, "default deny");
    assert.equal(al.check("dns.google").allow, false, "denylist wins");
    assert.equal(al.check("pypi.org:443").allow, true, "port stripped");
    ok("allowlist matcher: exact, wildcard, denylist, port-strip");
  }

  // 11b) Proxy-env injection policy (pure): enforcement always wins; egress-wired
  //      microVM sandboxes get it too (NIC-less guests are default-deny by
  //      construction — without HTTP(S)_PROXY at the loopback relay, allowlisted
  //      npm/pip/git traffic dies on DNS); plain container sandboxes keep the
  //      old opt-in-via-enforcement behavior.
  {
    assert.equal(proxyEnvWanted("container", true, false), false, "container, no enforce: no proxy env");
    assert.equal(proxyEnvWanted("container", true, true), true, "enforcement always injects");
    assert.equal(proxyEnvWanted("applevz", true, false), true, "egress-wired applevz injects");
    assert.equal(proxyEnvWanted("firecracker", true, false), true, "egress-wired firecracker injects");
    assert.equal(proxyEnvWanted("applevz", false, false), false, "no egress, no enforce: nothing");
    assert.equal(proxyEnvWanted("applevz", false, true), true, "enforcement injects even without egress flag");
    ok("proxy-env policy: enforce always; egress-wired microVM drivers too");
  }

  // 12) Forward proxy + CONNECT tunnel + provider-domain guard (custom allowlist
  //     that permits 127.0.0.1 only). Exercises the security-critical path.
  {
    const fwAllow = new Allowlist(["127.0.0.1", "localhost"], []);
    const fwProxy = createEgressProxy({
      config,
      store,
      prices: DEFAULT_MODEL_PRICES,
      allowlist: fwAllow,
      providers: {}, // provider-host guard still derives from built-in defaults
    });
    const fwPort = await listen(fwProxy);
    const token = mint();

    // Absolute-form HTTP forward proxy: allowed host → 200, denied → 403,
    // LLM-provider host → 403 (guard).
    const fAllowed = await forward(fwPort, `http://127.0.0.1:${upstreamPort}/v1/x`, token);
    assert.equal(fAllowed.status, 200, "forward to allowed host should 200");
    const fDenied = await forward(fwPort, "http://evil.example/x", token);
    assert.equal(fDenied.status, 403, "forward to denied host should 403");
    const fProvider = await forward(fwPort, "http://api.openai.com/v1/chat", token);
    assert.equal(fProvider.status, 403, "forward to LLM provider should 403 (guard)");

    // CONNECT tunnel: allowed host round-trips bytes; denied + provider → 403.
    const echo = netCreateServer((s) => s.pipe(s));
    const echoPort = await listen(echo);
    const cOk = await connectProxy(fwPort, `127.0.0.1:${echoPort}`, token);
    assert.equal(cOk.status, 200, "CONNECT to allowed host should 200");
    const echoed = await new Promise<string>((resolve) => {
      cOk.socket!.once("data", (d: Buffer) => resolve(d.toString()));
      cOk.socket!.write("ping");
    });
    assert.equal(echoed, "ping", "CONNECT tunnel round-trips bytes");
    cOk.socket!.destroy();

    const cDenied = await connectProxy(fwPort, "evil.example:443", token);
    assert.equal(cDenied.status, 403, "CONNECT to denied host should 403");
    const cProvider = await connectProxy(fwPort, "api.openai.com:443", token);
    assert.equal(cProvider.status, 403, "CONNECT to LLM provider should 403 (guard)");

    fwProxy.close();
    echo.close();
    ok("forward proxy + CONNECT: allow round-trips, deny → 403, provider guard → 403");
  }

  // 13) Per-sandbox spend ceiling: a hard cap across all of a sandbox's tokens,
  //     independent of per-token policy.
  {
    const sb2: SandboxRecord = { ...rec, id: "sbxcap0002", egressSpendCapUsd: 0.01, usage: emptyUsage() };
    store.add(sb2);
    const token = SandboxStore.newEgressToken();
    store.addEgressToken(token, sb2.id); // no per-token policy
    const first = await fetch(`${base}/mock/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hotcell-egress": token, "x-mock-cost": "1" },
      body: JSON.stringify({ model: "gpt-4o" }),
    });
    assert.equal(first.status, 200, "first call under sandbox cap should 200");
    const second = await fetch(`${base}/mock/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hotcell-egress": token, "x-mock-cost": "1" },
      body: JSON.stringify({ model: "gpt-4o" }),
    });
    assert.equal(second.status, 402, "second call over sandbox cap should 402");
    ok("per-sandbox spend ceiling → first 200, then 402");
  }

  // 14) Provider redirects are relayed, never followed: a cross-origin 302 from
  //     the provider must not carry the injected key (a non-`authorization`
  //     header, which fetch would NOT strip on a cross-origin hop) to the target.
  {
    const stolen: Array<string | undefined> = [];
    const thief = createServer((req, res) => {
      stolen.push(req.headers["x-api-key"] as string | undefined);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const thiefPort = await listen(thief);
    const location = `http://127.0.0.1:${thiefPort}/collect`;
    const redirector = createServer((req, res) => {
      req.resume();
      res.writeHead(302, { location, "content-type": "text/plain" });
      res.end("moved");
    });
    const redirectorPort = await listen(redirector);
    const redirEgress = createEgressProxy({
      config,
      store,
      prices: DEFAULT_MODEL_PRICES,
      providers: {
        redir: {
          baseUrl: `http://127.0.0.1:${redirectorPort}`,
          authHeader: "x-api-key",
          format: (k: string) => k,
          apiKey: REAL_KEY,
        },
      },
    });
    const redirPort = await listen(redirEgress);
    try {
      const r = await fetch(`http://127.0.0.1:${redirPort}/redir/v1/messages`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", "x-hotcell-egress": mint() },
        body: JSON.stringify({ model: "gpt-4o" }),
      });
      assert.equal(r.status, 302, "gateway relays the provider's 302 unchanged");
      assert.equal(r.headers.get("location"), location, "Location header relayed as-is");
      assert.equal(await r.text(), "moved", "redirect body relayed");
      assert.deepEqual(stolen, [], "redirect target never contacted with (or without) the provider key");
    } finally {
      redirEgress.close();
      redirector.close();
      thief.close();
    }
    ok("provider 302 relayed to the sandbox, not followed (injected key never leaves for the Location host)");
  }

  console.log(`\negress-check: ${passed} checks passed`);
  egress.close();
  upstream.close();
  store.close();
}

/** Send an absolute-form (forward-proxy) GET through the gateway. */
function forward(
  port: number,
  absUrl: string,
  token: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path: absUrl, headers: { "proxy-authorization": `Bearer ${token}` } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? -1, body: b }));
      },
    );
    req.on("error", () => resolve({ status: -1, body: "" }));
    req.end();
  });
}

/** Open a CONNECT tunnel through the gateway. Resolves on either outcome. */
function connectProxy(
  port: number,
  authority: string,
  token: string,
): Promise<{ status: number; socket?: import("node:net").Socket }> {
  return new Promise((resolve) => {
    const req = httpRequest({
      method: "CONNECT",
      host: "127.0.0.1",
      port,
      path: authority,
      headers: { "proxy-authorization": `Bearer ${token}` },
    });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode ?? -1, socket }));
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? -1 });
    });
    req.on("error", () => resolve({ status: -1 }));
    req.end();
  });
}

function listen(server: { listen: (...a: any[]) => any; address: () => any }): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("egress-check FAILED:", err);
    process.exit(1);
  },
);
