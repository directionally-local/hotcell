import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Config } from "../src/config.js";
import { buildProviders, parseUsage } from "../src/proxy/egress.js";
import { egressConfig } from "../src/api/server.js";

function config(partial: Partial<Config>): Config {
  return partial as Config;
}

describe("buildProviders", () => {
  it("builds known providers with their default base URL and auth format", () => {
    const providers = buildProviders(
      config({
        providerKeys: { openai: "sk-1", anthropic: "ak" },
        providerConfigs: {},
      }),
    );

    assert.equal(providers.openai?.baseUrl, "https://api.openai.com");
    assert.equal(providers.openai?.authHeader, "authorization");
    assert.equal(providers.openai?.format("sk-1"), "Bearer sk-1");

    assert.equal(providers.anthropic?.baseUrl, "https://api.anthropic.com");
    assert.equal(providers.anthropic?.authHeader, "x-api-key");
    assert.equal(providers.anthropic?.format("ak"), "ak");
  });

  it("skips providers with an empty key", () => {
    const providers = buildProviders(
      config({ providerKeys: { openai: "" }, providerConfigs: {} }),
    );
    assert.equal(providers.openai, undefined);
  });

  it("applies a custom base URL, auth header and format template", () => {
    const providers = buildProviders(
      config({
        providerKeys: { custom: "k" },
        providerConfigs: {
          custom: {
            baseUrl: "https://example.test",
            authHeader: "x-key",
            formatTemplate: "Token {key}",
          },
        },
      }),
    );

    assert.equal(providers.custom?.baseUrl, "https://example.test");
    assert.equal(providers.custom?.authHeader, "x-key");
    assert.equal(providers.custom?.format("k"), "Token k");
  });

  it("sends the raw key for a custom provider without a template", () => {
    const providers = buildProviders(
      config({
        providerKeys: { custom: "k" },
        providerConfigs: { custom: { baseUrl: "https://example.test", authHeader: "x-key" } },
      }),
    );
    assert.equal(providers.custom?.format("k"), "k");
  });

  it("adds github as a keyless provider when configured", () => {
    const providers = buildProviders(
      config({ providerKeys: { github: "gh" }, providerConfigs: {} }),
    );
    assert.equal(providers.github?.baseUrl, "https://api.github.com");
    assert.equal(providers.github?.format("gh"), "Bearer gh");
  });

  it("omits a custom provider that lacks a base URL or auth header", () => {
    const providers = buildProviders(
      config({
        providerKeys: { custom: "k" },
        providerConfigs: { custom: { baseUrl: "https://example.test" } },
      }),
    );
    assert.equal(providers.custom, undefined);
  });
});


describe("parseUsage", () => {
  const body = (o: unknown) => [Buffer.from(JSON.stringify(o))];

  it("reads OpenAI chat completions usage", () => {
    const u = parseUsage(body({ model: "gpt-4o", usage: { prompt_tokens: 11, completion_tokens: 7 } }), [], false);
    assert.equal(u.tokensIn, 11);
    assert.equal(u.tokensOut, 7);
    assert.equal(u.model, "gpt-4o");
    assert.equal(u.found, true);
  });

  it("reads OpenAI Responses usage (input_tokens/output_tokens)", () => {
    const u = parseUsage(body({ model: "gpt-5", usage: { input_tokens: 36, output_tokens: 87 } }), [], false);
    assert.equal(u.tokensIn, 36);
    assert.equal(u.tokensOut, 87);
    assert.equal(u.found, true);
  });

  it("reads OpenAI Responses streaming usage from response.completed", () => {
    const sse = [
      "event: response.created",
      'data: {"type":"response.created","response":{"model":"gpt-5"}}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"model":"gpt-5","usage":{"input_tokens":36,"output_tokens":87}}}',
      "",
    ].join("\n");
    const u = parseUsage([Buffer.from(sse)], [], false);
    assert.equal(u.tokensIn, 36);
    assert.equal(u.tokensOut, 87);
    assert.equal(u.model, "gpt-5");
    assert.equal(u.found, true);
  });

  it("counts Anthropic cache tokens as input", () => {
    const u = parseUsage(
      body({ model: "claude-opus-4", usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 } }),
      [],
      false,
    );
    assert.equal(u.tokensIn, 18);
    assert.equal(u.tokensOut, 20);
  });

  it("reads Gemini usageMetadata including thoughts", () => {
    const u = parseUsage(
      body({ modelVersion: "gemini-2.0-flash", usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 25 } }),
      [],
      false,
    );
    assert.equal(u.tokensIn, 100);
    assert.equal(u.tokensOut, 75);
    assert.equal(u.model, "gemini-2.0-flash");
  });

  it("captures OpenRouter's reported cost", () => {
    const u = parseUsage(body({ model: "x", usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.0123 } }), [], false);
    assert.equal(u.cost, 0.0123);
  });

  it("reports found=false when the response carries no usage", () => {
    const u = parseUsage(body({ choices: [] }), [], false);
    assert.equal(u.found, false);
  });

  it("reads usage from the tail when the body was truncated", () => {
    const head = Buffer.from('data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n');
    const tail = Buffer.from('data: {"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\n');
    const u = parseUsage([head], [tail], true);
    assert.equal(u.tokensIn, 100);
    assert.equal(u.tokensOut, 10);
  });
});

describe("egressConfig", () => {
  const cfg = (partial: Partial<Config>) =>
    ({ egressPort: 4752, egressAdvertiseHost: "host.docker.internal", ...partial }) as Config;

  it("advertises /v1 for OpenAI-SDK providers", () => {
    const { providers } = egressConfig(cfg({ providerKeys: { openai: "k", openrouter: "k" }, providerConfigs: {} }));
    const byName = Object.fromEntries(providers.map((p) => [p.name, p.baseUrl]));
    assert.equal(byName.openai, "http://host.docker.internal:4752/openai/v1");
    assert.equal(byName.openrouter, "http://host.docker.internal:4752/openrouter/v1");
  });

  it("does not add /v1 for Anthropic or Gemini (their SDKs append the version)", () => {
    const { providers } = egressConfig(cfg({ providerKeys: { anthropic: "k", gemini: "k" }, providerConfigs: {} }));
    const byName = Object.fromEntries(providers.map((p) => [p.name, p.baseUrl]));
    assert.equal(byName.anthropic, "http://host.docker.internal:4752/anthropic");
    assert.equal(byName.gemini, "http://host.docker.internal:4752/gemini");
  });

  it("keeps an operator-repointed base URL's own path convention", () => {
    const { providers } = egressConfig(
      cfg({
        providerKeys: { openai: "k" },
        providerConfigs: { openai: { baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/openai" } },
      }),
    );
    assert.equal(providers[0]?.baseUrl, "http://host.docker.internal:4752/openai");
  });
});

// --- built-in routes (contract with Autopilot's provider presets) --------------

import { createServer as createHttpServer, type Server } from "node:http";
import { createEgressProxy, listRoutes } from "../src/proxy/egress.js";
import { Allowlist } from "../src/proxy/allowlist.js";
import { BUILTIN_ROUTE_IDS, canonicalRouteName, resolveRoutes } from "../src/proxy/routes.js";
import { DEFAULT_MODEL_PRICES } from "../src/pricing.js";
import type { SandboxStore } from "../src/store.js";
import type { EgressTokenRecord } from "../src/types.js";

/** Autopilot preset id → the base URL its client appends `/chat/completions` (etc.) to. */
const AUTOPILOT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  moonshot: "https://api.moonshot.ai/v1",
  "kimi-code": "https://api.kimi.ai/coding/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  minimax: "https://api.minimax.io/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  vercel: "https://ai-gateway.vercel.sh/v1",
  zai: "https://api.z.ai/api/paas/v4",
  "zai-coding": "https://api.z.ai/api/coding/paas/v4",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  requesty: "https://router.requesty.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

describe("built-in routes", () => {
  it("exist for every Autopilot preset with a static base URL (plus google alias and github)", () => {
    for (const id of [...Object.keys(AUTOPILOT_BASE_URLS), "google", "github"]) {
      assert.ok(BUILTIN_ROUTE_IDS.includes(id), `missing built-in route: ${id}`);
    }
  });

  it("reach the preset's upstream path when a client appends the same trailing path", () => {
    const keys = Object.fromEntries(Object.keys(AUTOPILOT_BASE_URLS).map((id) => [id, `k-${id}`]));
    const providers = buildProviders(config({ providerKeys: keys, providerConfigs: {} }));
    for (const [id, upstream] of Object.entries(AUTOPILOT_BASE_URLS)) {
      const p = providers[id];
      assert.ok(p, `route ${id} not built`);
      // The client is configured with `<gateway>/<id>` + the preset's trailing
      // path; the gateway forwards `baseUrl + "/" + rest`, so this must equal
      // the preset's base URL.
      assert.ok(upstream === p.baseUrl || upstream.startsWith(p.baseUrl + "/"), `upstream for ${id}: ${p.baseUrl} vs ${upstream}`);
      // And the auto-wired base URL (host + sdkBasePath) points at the same
      // place — except Anthropic and Gemini, whose native SDKs append their own
      // version prefix, so their advertised URL stays at the host.
      const advertised = id === "anthropic" || id === "gemini" ? new URL(upstream).origin : upstream;
      assert.equal(p.baseUrl + (p.sdkBasePath ?? ""), advertised, `advertised path for ${id}`);
      assert.equal(p.apiKey, `k-${id}`);
    }
  });

  it("use Bearer auth everywhere except Anthropic (x-api-key) and Gemini native (x-goog-api-key)", () => {
    const keys = Object.fromEntries(Object.keys(AUTOPILOT_BASE_URLS).map((id) => [id, "k"]));
    const providers = buildProviders(config({ providerKeys: keys, providerConfigs: {} }));
    for (const id of Object.keys(AUTOPILOT_BASE_URLS)) {
      const p = providers[id]!;
      if (id === "anthropic") {
        assert.equal(p.authHeader, "x-api-key");
        assert.equal(p.format("k"), "k");
      } else if (id === "gemini") {
        assert.equal(p.authHeader, "x-goog-api-key");
        assert.ok(p.pathAuth?.pathPattern.test("v1beta/openai/chat/completions"), "OpenAI-compatible path uses the alternate shape");
        assert.ok(!p.pathAuth?.pathPattern.test("v1beta/models/gemini-2.5-pro:generateContent"));
        assert.equal(p.pathAuth?.authHeader, "authorization");
        assert.equal(p.pathAuth?.format("k"), "Bearer k");
      } else {
        assert.equal(p.authHeader, "authorization", id);
        assert.equal(p.format("k"), "Bearer k", id);
      }
    }
  });

  it("keyless local runtimes are OFF until enabled, then active with no key", () => {
    // Not by default: they expose the host's loopback (and Ollama can pull/delete models).
    const off = buildProviders(config({ providerKeys: {}, providerConfigs: {} }));
    assert.equal(off.ollama, undefined);
    assert.equal(off.lmstudio, undefined);
    // `hotcell keys add ollama` / HOTCELL_PROVIDER_OLLAMA_KEYLESS=true enables them.
    const on = buildProviders(config({ providerKeys: {}, providerConfigs: { ollama: { keyless: true }, lmstudio: { keyless: true } } }));
    for (const id of ["ollama", "lmstudio"]) {
      assert.ok(on[id], `${id} active once enabled`);
      assert.equal(on[id]!.apiKey, undefined);
      assert.equal(on[id]!.keyless, true);
    }
    assert.equal(on.openai, undefined, "keyed providers still need a key");
    // A registered key activates the route and is injected (hosted Ollama).
    const keyed = buildProviders(config({ providerKeys: { ollama: "ok" }, providerConfigs: {} }));
    assert.equal(keyed.ollama?.apiKey, "ok");
    assert.equal(keyed.ollama?.keyless, undefined);
  });

  it("a custom shape can be keyless too, and github stays non-LLM", () => {
    const providers = buildProviders(
      config({ providerKeys: { github: "gh" }, providerConfigs: { myproxy: { baseUrl: "http://127.0.0.1:9999", keyless: true } } }),
    );
    assert.equal(providers.myproxy?.baseUrl, "http://127.0.0.1:9999");
    assert.equal(providers.myproxy?.keyless, true);
    assert.equal(providers.github?.nonLlm, true);
  });

  it("folds env-spelled names onto dashed route ids", () => {
    assert.equal(canonicalRouteName("KIMI_CODE"), "kimi-code");
    assert.equal(canonicalRouteName("my_proxy"), "my_proxy");
    const providers = buildProviders(config({ providerKeys: { kimi_code: "k", "my-proxy": "p" }, providerConfigs: { my_proxy: { baseUrl: "https://p.test", authHeader: "x-k" } } }));
    assert.equal(providers["kimi-code"]?.apiKey, "k");
    assert.equal(providers.kimi_code, undefined);
    assert.equal(providers["my-proxy"]?.apiKey, "p");
    assert.equal(providers["my-proxy"]?.baseUrl, "https://p.test");
  });

  it("listRoutes reports every route with key/active state and no secret", () => {
    const routes = listRoutes(config({ providerKeys: { openai: "sk" }, providerConfigs: {} }));
    const byName = Object.fromEntries(routes.map((r) => [r.name, r]));
    assert.equal(byName.openai?.active, true);
    assert.equal(byName.openai?.hasKey, true);
    assert.equal((byName.openai as Record<string, unknown>).apiKey, undefined);
    assert.equal(byName.groq?.active, false);
    assert.equal(byName.groq?.inactiveReason, "no key");
    assert.equal(byName.ollama?.active, false);
    assert.equal(byName.ollama?.hasKey, false);
    assert.equal(byName.ollama?.keyOptional, true);
    assert.equal(byName.ollama?.inactiveReason, "not enabled; hotcell keys add ollama");
    assert.equal(byName.lmstudio?.inactiveReason, "not enabled; hotcell keys add lmstudio");
    for (const id of BUILTIN_ROUTE_IDS) assert.ok(byName[id], `listRoutes misses ${id}`);
    const enabled = listRoutes(config({ providerKeys: {}, providerConfigs: { ollama: { keyless: true } } }));
    const ollama = enabled.find((r) => r.name === "ollama");
    assert.equal(ollama?.active, true);
    assert.equal(ollama?.keyless, true);
    assert.equal(ollama?.hasKey, false);
    const raw = resolveRoutes({ openai: "sk" }, {});
    assert.equal(raw.openai?.apiKey, "sk");
  });

  it("egressConfig advertises each route's SDK path", () => {
    const { providers } = egressConfig(
      { egressPort: 4752, egressAdvertiseHost: "h", providerKeys: { groq: "k", "kimi-code": "k", deepseek: "k" }, providerConfigs: { ollama: { keyless: true } } } as Config,
    );
    const byName = Object.fromEntries(providers.map((p) => [p.name, p]));
    assert.equal(byName.groq?.baseUrl, "http://h:4752/groq/openai/v1");
    assert.equal(byName["kimi-code"]?.baseUrl, "http://h:4752/kimi-code/coding/v1");
    assert.equal(byName["kimi-code"]?.keyEnv, "KIMI_API_KEY");
    assert.equal(byName.deepseek?.baseUrl, "http://h:4752/deepseek");
    assert.equal(byName.ollama?.baseUrl, "http://h:4752/ollama/v1", "an enabled keyless route is advertised without a key");
    assert.equal(byName.lmstudio, undefined, "a keyless route that was not enabled is not advertised");
  });
});

// --- gateway forwarding: keyless auth and spend-cap pricing fallbacks -----------

function fakeStore(record: Omit<EgressTokenRecord, "createdAt" | "token">, spendCapUsd?: number): SandboxStore {
  const sandbox = { id: record.sandboxId, driver: "container", egressSpendCapUsd: spendCapUsd, usage: { providerCost: 0 } };
  let spend = record.spendUsd;
  return {
    resolveEgressTokenFull: (token: string) => (token === "tok" ? { ...record, token, createdAt: "", spendUsd: spend } : undefined),
    get: (id: string) => (id === record.sandboxId ? sandbox : undefined),
    touch: () => {},
    addProviderUsage: (_id: string, d: { cost: number }) => { sandbox.usage.providerCost += d.cost; },
    addEgressTokenSpend: (_t: string, usd: number) => { spend += usd; },
  } as unknown as SandboxStore;
}

async function withUpstream(fn: (port: number, seen: () => { headers: Record<string, string | string[] | undefined>; url: string }) => Promise<void>) {
  let last: { headers: Record<string, string | string[] | undefined>; url: string } = { headers: {}, url: "" };
  const upstream: Server = createHttpServer((req, res) => {
    last = { headers: req.headers, url: req.url ?? "" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "local-model", usage: { prompt_tokens: 5, completion_tokens: 7 } }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  try {
    await fn((upstream.address() as { port: number }).port, () => last);
  } finally {
    await new Promise<void>((r) => upstream.close(() => r()));
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as { port: number }).port;
}

describe("gateway forwarding", () => {
  const baseConfig = (providerConfigs: Config["providerConfigs"], providerKeys: Config["providerKeys"]) =>
    ({
      providerKeys,
      providerConfigs,
      maxBodyBytes: 1024 * 1024,
      egressMaxOutputTokens: 8192,
      modelPricesPath: "/tmp/hotcell-test/model-prices.json",
      allowedHosts: [],
    }) as unknown as Config;

  it("forwards a keyless route with no auth header and prices it at $0 under a spend cap", async () => {
    await withUpstream(async (port, seen) => {
      const cfg = baseConfig({ ollama: { baseUrl: `http://127.0.0.1:${port}`, keyless: true } }, {});
      const store = fakeStore({ sandboxId: "sb1", policy: { spendCapUsd: 1 }, spendUsd: 0 });
      const proxy = createEgressProxy({ config: cfg, store, providers: buildProviders(cfg), prices: DEFAULT_MODEL_PRICES, allowlist: new Allowlist([], []) });
      const gw = await listen(proxy);
      try {
        const res = await fetch(`http://127.0.0.1:${gw}/ollama/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: "Bearer tok", "content-type": "application/json" },
          body: JSON.stringify({ model: "llama3.2:3b", messages: [] }),
        });
        assert.equal(res.status, 200, await res.text());
        assert.equal(seen().headers.authorization, undefined, "no auth header reaches a keyless upstream");
        assert.equal(seen().url, "/v1/chat/completions");
        assert.equal(store.get("sb1")?.usage.providerCost, 0);
      } finally {
        await new Promise<void>((r) => proxy.close(() => r()));
      }
    });
  });

  it("injects a registered key on a keyless route", async () => {
    await withUpstream(async (port, seen) => {
      const cfg = baseConfig({ ollama: { baseUrl: `http://127.0.0.1:${port}` } }, { ollama: "hosted-key" });
      const store = fakeStore({ sandboxId: "sb1", policy: {}, spendUsd: 0 });
      const proxy = createEgressProxy({ config: cfg, store, providers: buildProviders(cfg), prices: DEFAULT_MODEL_PRICES, allowlist: new Allowlist([], []) });
      const gw = await listen(proxy);
      try {
        const res = await fetch(`http://127.0.0.1:${gw}/ollama/api/tags`, { headers: { authorization: "Bearer tok" } });
        assert.equal(res.status, 200);
        assert.equal(seen().headers.authorization, "Bearer hosted-key");
      } finally {
        await new Promise<void>((r) => proxy.close(() => r()));
      }
    });
  });

  it("refuses an unpriced model on a paid route under a cap, naming the price file", async () => {
    await withUpstream(async (port) => {
      const cfg = baseConfig({ groq: { baseUrl: `http://127.0.0.1:${port}` } }, { groq: "gk" });
      const store = fakeStore({ sandboxId: "sb1", policy: { spendCapUsd: 1 }, spendUsd: 0 });
      const prices = { ...DEFAULT_MODEL_PRICES, "groq/llama-3.3-70b": { inputPerMTok: 0.59, outputPerMTok: 0.79 } };
      const proxy = createEgressProxy({ config: cfg, store, providers: buildProviders(cfg), prices, allowlist: new Allowlist([], []) });
      const gw = await listen(proxy);
      const call = (model: string) =>
        fetch(`http://127.0.0.1:${gw}/groq/openai/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: "Bearer tok", "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [], max_tokens: 10 }),
        });
      try {
        const refused = await call("mystery-model");
        assert.equal(refused.status, 403);
        const text = await refused.text();
        assert.match(text, /^model not priced: mystery-model/);
        assert.ok(text.includes("/tmp/hotcell-test/model-prices.json"), text);
        assert.ok(text.includes("HOTCELL_MODEL_PRICES"), text);
        // Provider-prefixed table entry prices the bare id; a vendor-qualified id prices by basename.
        assert.equal((await call("llama-3.3-70b")).status, 200);
        assert.equal((await call("meta/llama-3.3-70b")).status, 200);
        assert.equal((await call("openai/gpt-4o")).status, 200);
      } finally {
        await new Promise<void>((r) => proxy.close(() => r()));
      }
    });
  });
});
