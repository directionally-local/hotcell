import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Config } from "../config.js";
import { audit } from "../audit.js";
import { log } from "../logger.js";
import { computeModelCost, type ModelPrices } from "../pricing.js";
import type { SandboxStore } from "../store.js";
import { startSpan } from "../tracing.js";
import { BodyTooLargeError, readBodyCapped, sendJson, sendText } from "../util.js";
import { Allowlist, loadAllowlist, normalizeHost } from "./allowlist.js";
import { RateLimiter } from "./ratelimit.js";

/**
 * Egress credential proxy — an LLM gateway, not a TLS-MITM forward proxy.
 *
 * Sandboxes call `http://<egress>/<provider>/<path>` with a per-sandbox **egress
 * token** in place of a real key (e.g. `OPENAI_BASE_URL=http://egress/openai`,
 * `OPENAI_API_KEY=<egress-token>`). The gateway resolves the token to a sandbox,
 * injects the **real provider key** (held on the daemon host, never inside the
 * sandbox), forwards to the provider, and meters the call (bytes + parsed
 * prompt/completion tokens). This gives "reach any LLM provider without baking in
 * keys" + per-sandbox cost/observability, with no CA/cert install (which a
 * transparent HTTPS forward proxy would require).
 */

export interface ResolvedProvider {
  /** Upstream base URL, e.g. `https://api.openai.com`. */
  baseUrl: string;
  /** Header the provider authenticates with (e.g. `authorization`, `x-api-key`). */
  authHeader: string;
  /** Render the auth header value from the real key (e.g. `Bearer ${k}`). */
  format: (key: string) => string;
  /** The real provider key, injected on every forwarded call. */
  apiKey: string;
}

/**
 * Built-in providers: base URL + auth header shape, keyed by lower-case name.
 * Providers with a fixed public base URL live here; ones whose base URL is
 * deployment-specific (Azure OpenAI, a Cloudflare AI Gateway prefix, a self-hosted
 * endpoint) are added by the operator as **custom providers** via
 * `SBX_PROVIDER_<NAME>_BASEURL` / `_AUTHHEADER` / `_FORMAT` + `SBX_PROVIDER_KEY_<NAME>`.
 *
 * Cloudflare AI Gateway is just a base-URL prefix in front of a real provider, so
 * it needs no special mechanism — point a custom provider's base URL at it and
 * reuse the upstream's auth shape, e.g.:
 *   SBX_PROVIDER_CFOPENAI_BASEURL=https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/openai
 *   SBX_PROVIDER_CFOPENAI_AUTHHEADER=authorization
 *   SBX_PROVIDER_CFOPENAI_FORMAT="Bearer {key}"
 *   SBX_PROVIDER_KEY_CFOPENAI=<the OpenAI key>
 * The sandbox then calls `http://<egress>/cfopenai/...` and the gateway injects the
 * key + meters the call, same as any built-in.
 */
const PROVIDER_DEFAULTS: Record<string, Omit<ResolvedProvider, "apiKey">> = {
  openai: {
    baseUrl: "https://api.openai.com",
    authHeader: "authorization",
    format: (k) => `Bearer ${k}`,
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    authHeader: "x-api-key",
    format: (k) => k,
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api",
    authHeader: "authorization",
    format: (k) => `Bearer ${k}`,
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com",
    authHeader: "x-goog-api-key",
    format: (k) => k,
  },
  // Alias of `google` so either provider name works in the route + key env.
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com",
    authHeader: "x-goog-api-key",
    format: (k) => k,
  },
};

/**
 * Build the provider registry from configured keys. A provider exists only when a
 * key (`SBX_PROVIDER_KEY_<NAME>`) is set AND a shape is known — either a built-in
 * default or an operator-supplied `providerConfigs` entry. Custom config fields
 * override the built-in, so an operator can repoint a built-in (e.g. route
 * `openai` through a Cloudflare AI Gateway prefix) without code.
 */
export function buildProviders(config: Config): Record<string, ResolvedProvider> {
  const providers: Record<string, ResolvedProvider> = {};
  for (const [name, apiKey] of Object.entries(config.providerKeys)) {
    if (!apiKey) continue;
    const def: Omit<ResolvedProvider, "apiKey"> | undefined = PROVIDER_DEFAULTS[name];
    const custom = config.providerConfigs[name];
    const baseUrl = custom?.baseUrl ?? def?.baseUrl;
    const authHeader = custom?.authHeader ?? def?.authHeader;
    let format: ((k: string) => string) | undefined = def?.format;
    if (custom?.formatTemplate) {
      const tmpl = custom.formatTemplate;
      format = (k) => tmpl.replace("{key}", k);
    } else if (format === undefined && custom) {
      // Custom provider without a format template → send the raw key.
      format = (k) => k;
    }
    if (baseUrl && authHeader && format !== undefined) {
      providers[name] = { baseUrl, authHeader, format, apiKey };
    }
  }
  // GitHub as a keyless provider: a sandbox reaches api.github.com through the
  // gateway with its egress token, and the real GitHub token (from `hotcell keys
  // add github`, e.g. `gh auth token`) stays on the host — same as an LLM key.
  // `github-git` (git push to github.com) is derived from the same key in handle().
  // Defined here (not in PROVIDER_DEFAULTS) so api.github.com only joins the
  // direct-egress deny set when github egress is actually configured.
  const githubKey = config.providerKeys.github;
  if (githubKey) {
    providers.github = {
      baseUrl: "https://api.github.com",
      authHeader: "authorization",
      format: (k) => `Bearer ${k}`,
      apiKey: githubKey,
    };
  }
  return providers;
}

interface Deps {
  config: Config;
  store: SandboxStore;
  providers: Record<string, ResolvedProvider>;
  /** Model→price table for computing cost when a provider doesn't report one. */
  prices?: ModelPrices;
  /** Shared per-token rate limiter (created here if not supplied). */
  limiter?: RateLimiter;
  /** Forward-proxy domain allowlist (loaded from config here if not supplied). */
  allowlist?: Allowlist;
}

/** Resolved deps with the always-present pieces filled in. */
interface ResolvedDeps extends Deps {
  limiter: RateLimiter;
  allowlist: Allowlist;
  /** Hostnames of known LLM providers — denied on the forward/CONNECT path. */
  providerHosts: Set<string>;
}

/** The egress proxy plus a hot-reload hook for provider keys (see `hotcell keys`). */
export type EgressServer = Server & { reloadProviders: (p: Record<string, ResolvedProvider>) => void };

export function createEgressProxy(deps: Deps): EgressServer {
  const resolved: ResolvedDeps = {
    ...deps,
    limiter: deps.limiter ?? new RateLimiter(),
    allowlist: deps.allowlist ?? loadAllowlist(deps.config),
    providerHosts: computeProviderHosts(deps.providers),
  };
  const server = createServer((req, res) => {
    handle(req, res, resolved).catch((err) => {
      sendText(res, 500, `egress proxy error: ${String(err?.message ?? err)}`);
    });
  });
  // HTTPS forward-proxy: clients (pip/npm/git via HTTPS_PROXY) open a CONNECT
  // tunnel, which Node surfaces as the `connect` event rather than a request.
  server.on("connect", (req, socket, head) => {
    handleConnect(req, socket as Socket, head, resolved).catch(() => {
      try {
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch {
        /* socket already gone */
      }
      socket.destroy();
    });
  });
  // Live-swap provider keys (the handlers read `resolved` by reference), so
  // `hotcell keys add/rm` applies without restarting the daemon.
  const egress = server as EgressServer;
  egress.reloadProviders = (providers) => {
    resolved.providers = providers;
    resolved.providerHosts = computeProviderHosts(providers);
  };
  return egress;
}

/**
 * Hostnames of every known LLM provider — both configured and the built-in
 * defaults — so the forward/CONNECT path can DENY a direct tunnel to them. LLM
 * traffic must go through the base-URL-rewrite path (where the real key is
 * injected and the call metered); a direct tunnel would bypass both. The sandbox
 * holds no real provider key, so a tunnel is useless to it — we deny+log to make
 * any bypass attempt visible.
 */
function computeProviderHosts(providers: Record<string, ResolvedProvider>): Set<string> {
  const hosts = new Set<string>();
  const add = (baseUrl: string) => {
    try {
      hosts.add(new URL(baseUrl).hostname.toLowerCase());
    } catch {
      /* ignore malformed */
    }
  };
  for (const def of Object.values(PROVIDER_DEFAULTS)) add(def.baseUrl);
  for (const p of Object.values(providers)) add(p.baseUrl);
  return hosts;
}

const HOP_REQUEST = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "x-hotcell-egress",
  "x-sbx-egress",
  "authorization",
]);
const HOP_RESPONSE = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);
const USAGE_PARSE_CAP = 256 * 1024;

async function handle(req: IncomingMessage, res: ServerResponse, deps: ResolvedDeps): Promise<void> {
  const { store, providers } = deps;

  // Forward-proxy (plaintext HTTP via HTTP_PROXY): the request target is an
  // absolute URL (`GET http://host/path`) rather than an origin-form path. This is
  // the non-LLM allowlist path — no key injection.
  if (req.url && /^https?:\/\//i.test(req.url)) {
    return handleForwardHttp(req, res, deps);
  }

  const url = new URL(req.url ?? "/", "http://egress.local");

  if (url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, providers: Object.keys(providers) });
  }

  const match = url.pathname.match(/^\/([^/]+)\/(.*)$/);
  if (!match) {
    return sendText(res, 404, "route: /<provider>/<path>");
  }
  const [, providerName, rest] = match;

  const token = extractToken(req);
  if (!token) {
    // git probes info/refs anonymously first and only retries with the URL creds
    // after a Basic challenge — so answer with one. (LLM SDKs send the token
    // preemptively and never hit this.)
    res.setHeader("www-authenticate", 'Basic realm="hotcell-egress"');
    return sendText(res, 401, "missing egress token");
  }
  const record = store.resolveEgressTokenFull(token);
  if (!record) return sendText(res, 403, "invalid egress token");
  const sandboxId = record.sandboxId;
  const policy = record.policy;

  let provider = providers[providerName];
  // git push to GitHub: same real key as the `github` API provider, but requests
  // go to github.com (not api.github.com) with git's Basic-auth shape
  // (`x-access-token:<token>`). The sandbox's git remote points here; the real
  // token is injected below, so it never lives in the sandbox.
  if (!provider && providerName === "github-git" && providers.github) {
    provider = {
      baseUrl: "https://github.com",
      authHeader: "authorization",
      format: (k) => "Basic " + Buffer.from(`x-access-token:${k}`).toString("base64"),
      apiKey: providers.github.apiKey,
    };
  }
  if (!provider) return sendText(res, 404, `unknown provider: ${providerName}`);

  const now = Date.now();

  // --- policy enforcement (cheapest, most-decisive checks first) -----------
  if (policy.expiresAt && now > Date.parse(policy.expiresAt)) {
    audit({ event: "gateway.token.expired", sandboxId, driver: store.get(sandboxId)?.driver, attributes: { "token.raw": token, provider: providerName, status: 403 } });
    return sendText(res, 403, "egress token expired");
  }
  if (policy.providers && !policy.providers.includes(providerName)) {
    audit({ event: "gateway.policy.rejected", sandboxId, driver: store.get(sandboxId)?.driver, attributes: { "token.raw": token, provider: providerName, reason: "provider_scope", status: 403 } });
    return sendText(res, 403, `provider not in token scope: ${providerName}`);
  }
  if (policy.spendCapUsd !== undefined && record.spendUsd >= policy.spendCapUsd) {
    audit({ event: "gateway.policy.rejected", sandboxId, driver: store.get(sandboxId)?.driver, attributes: { "token.raw": token, provider: providerName, reason: "token_spend_cap", status: 402, spendUsd: record.spendUsd, spendCapUsd: policy.spendCapUsd } });
    return sendText(res, 402, "egress spend cap exceeded (token)");
  }
  // Per-sandbox ceiling: a hard cap across ALL of the sandbox's tokens, so an
  // abused token can't exceed it even before it's revoked.
  const sb = store.get(sandboxId);
  if (sb?.egressSpendCapUsd && sb.usage.providerCost >= sb.egressSpendCapUsd) {
    audit({ event: "gateway.policy.rejected", sandboxId, driver: sb.driver ?? undefined, attributes: { "token.raw": token, provider: providerName, reason: "sandbox_spend_cap", status: 402, spendUsd: sb.usage.providerCost, spendCapUsd: sb.egressSpendCapUsd } });
    return sendText(res, 402, "egress spend cap exceeded (sandbox)");
  }

  const method = req.method ?? "GET";
  let reqBody: Buffer | undefined;
  try {
    reqBody =
      method === "GET" || method === "HEAD"
        ? undefined
        : await readBodyCapped(req, deps.config.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return sendText(res, 413, "request body too large");
    throw err;
  }

  // Model allowlist: parse the request's `model` and gate it. A request with no
  // model field (e.g. embeddings without one) is allowed even when `models` is
  // set, so non-chat routes aren't broken — only an explicit, disallowed model
  // is rejected.
  const reqModel = reqBody ? parseModel(reqBody) : undefined;
  if (policy.models && reqModel && !matchModel(policy.models, reqModel)) {
    audit({ event: "gateway.policy.rejected", sandboxId, driver: sb?.driver ?? undefined, attributes: { "token.raw": token, provider: providerName, model: reqModel.slice(0, 128), reason: "model_scope", status: 403 } });
    return sendText(res, 403, `model not allowed: ${reqModel}`);
  }

  // Rate limit: check the token budget (read-only) before consuming a call slot,
  // so a token-exhausted call doesn't burn the call budget too.
  if (policy.rateLimit) {
    const tok = deps.limiter!.checkTokens(token, policy.rateLimit, now);
    if (!tok.ok) {
      res.setHeader("retry-after", Math.ceil(tok.retryAfterMs / 1000));
      audit({ event: "gateway.policy.rejected", sandboxId, driver: sb?.driver ?? undefined, attributes: { "token.raw": token, provider: providerName, reason: "token_rate_limit", status: 429 } });
      return sendText(res, 429, "egress rate limit (tokens) exceeded");
    }
    const call = deps.limiter!.allow(token, policy.rateLimit, now);
    if (!call.ok) {
      res.setHeader("retry-after", Math.ceil(call.retryAfterMs / 1000));
      audit({ event: "gateway.policy.rejected", sandboxId, driver: sb?.driver ?? undefined, attributes: { "token.raw": token, provider: providerName, reason: "call_rate_limit", status: 429 } });
      return sendText(res, 429, "egress rate limit (calls) exceeded");
    }
  }

  store.touch(sandboxId);
  const span = startSpan("egress.provider_call", {
    "sandbox.id": sandboxId,
    "egress.provider": providerName,
  });

  const upstreamUrl = provider.baseUrl.replace(/\/$/, "") + "/" + rest + (url.search || "");
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_REQUEST.has(k.toLowerCase()) || v == null) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  headers.set(provider.authHeader, provider.format(provider.apiKey));

  let bytes = reqBody?.length ?? 0;

  let upstream: Response;
  try {
    // Never follow a provider redirect: fetch strips only authorization/cookie on
    // a cross-origin hop, so the injected key (x-api-key, x-goog-api-key, custom
    // auth headers) would go to whatever host the Location names. The 3xx is
    // relayed to the sandbox as-is; its client re-requests with its own token.
    upstream = await fetch(upstreamUrl, { method, headers, body: reqBody, redirect: "manual" });
  } catch (err) {
    span.setStatus("error").end();
    return sendText(res, 502, `upstream fetch failed: ${String(err)}`);
  }

  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_RESPONSE.has(key.toLowerCase())) respHeaders[key] = value;
  });
  res.writeHead(upstream.status, respHeaders);

  // Stream the response through to the sandbox (so token-by-token streaming still
  // works) while keeping a rolling TAIL copy to parse usage from — token counts
  // and the OpenRouter `usage.cost` live in the final chunk (the last SSE frame
  // for streaming, the end of the body for a JSON response), so the tail, not the
  // head, is what we need.
  const tail: Buffer[] = [];
  let tailBytes = 0;
  if (upstream.body) {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      res.write(buf);
      bytes += buf.length;
      tail.push(buf);
      tailBytes += buf.length;
      while (tail.length > 1 && tailBytes - (tail[0]?.length ?? 0) >= USAGE_PARSE_CAP) {
        const dropped = tail.shift();
        tailBytes -= dropped?.length ?? 0;
      }
    }
  }
  res.end();

  const { tokensIn, tokensOut, cost: reportedCost, model: respModel } = parseUsage(Buffer.concat(tail));
  // Cost: the provider's own figure is authoritative (OpenRouter inlines
  // `usage.cost`); otherwise compute it from the model price table. Never sum the
  // two — the result is folded into `providerCost`, keeping one source of truth.
  const model = respModel ?? reqModel;
  const cost =
    reportedCost > 0 ? reportedCost : computeModelCost(model, tokensIn, tokensOut, deps.prices ?? {});

  const previousTokenSpend = record.spendUsd;
  const previousSandboxSpend = sb?.usage.providerCost ?? 0;
  store.addProviderUsage(sandboxId, { bytes, tokensIn, tokensOut, cost });
  if (cost > 0) store.addEgressTokenSpend(token, cost);
  if (policy.rateLimit) deps.limiter!.note(token, policy.rateLimit, tokensIn + tokensOut, now);
  const updatedSandbox = store.get(sandboxId);
  const updatedToken = store.resolveEgressTokenFull(token);
  audit({ event: "gateway.call", sandboxId, driver: updatedSandbox?.driver ?? undefined, attributes: { "token.raw": token, provider: providerName, model: model?.slice(0, 128) ?? "", status: upstream.status, tokensIn, tokensOut, cost } });
  if (policy.spendCapUsd !== undefined && previousTokenSpend < policy.spendCapUsd && (updatedToken?.spendUsd ?? previousTokenSpend) >= policy.spendCapUsd) {
    audit({ event: "gateway.spend_cap_reached", sandboxId, driver: updatedSandbox?.driver ?? undefined, attributes: { "token.raw": token, scope: "token", spendUsd: updatedToken?.spendUsd ?? previousTokenSpend, spendCapUsd: policy.spendCapUsd } });
  }
  if (updatedSandbox?.egressSpendCapUsd && previousSandboxSpend < updatedSandbox.egressSpendCapUsd && updatedSandbox.usage.providerCost >= updatedSandbox.egressSpendCapUsd) {
    audit({ event: "gateway.spend_cap_reached", sandboxId, driver: updatedSandbox.driver ?? undefined, attributes: { "token.raw": token, scope: "sandbox", spendUsd: updatedSandbox.usage.providerCost, spendCapUsd: updatedSandbox.egressSpendCapUsd } });
  }
  span
    .setAttribute("http.status_code", upstream.status)
    .setAttribute("egress.tokens_in", tokensIn)
    .setAttribute("egress.tokens_out", tokensOut)
    .setAttribute("egress.cost", cost);
  if (model) span.setAttribute("egress.model", model);
  if (upstream.status >= 500) span.setStatus("error");
  span.end();
  log.info("egress call", {
    sandbox: sandboxId,
    provider: providerName,
    status: upstream.status,
    model,
    bytes,
    tokensIn,
    tokensOut,
    cost,
    traceId: span.traceId,
  });
}

/** Parse the `model` field from a JSON request body (best-effort). */
function parseModel(body: Buffer): string | undefined {
  try {
    const o = JSON.parse(body.toString("utf8"));
    return typeof o?.model === "string" ? o.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Match a model id against an allowlist. An entry ending in `*` is a prefix glob
 * (`gpt-4*` matches `gpt-4o`); otherwise it's an exact, case-insensitive match.
 */
function matchModel(patterns: string[], model: string): boolean {
  const m = model.toLowerCase();
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    return pat.endsWith("*") ? m.startsWith(pat.slice(0, -1)) : m === pat;
  });
}

/** Pull the egress token from `X-Hotcell-Egress` (legacy `X-Sbx-Egress`) or a Bearer Authorization header. */
function extractToken(req: IncomingMessage): string | undefined {
  const direct = req.headers["x-hotcell-egress"] ?? req.headers["x-sbx-egress"];
  if (typeof direct === "string" && direct) return direct;
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    if (auth.startsWith("Bearer ")) return auth.slice(7);
    // git authenticates over HTTP Basic (`http://x-access-token:<token>@…`); the
    // egress token is the password half.
    if (auth.startsWith("Basic ")) {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const i = decoded.indexOf(":");
      const pass = i >= 0 ? decoded.slice(i + 1) : "";
      const user = i >= 0 ? decoded.slice(0, i) : decoded;
      return pass || user || undefined;
    }
  }
  return undefined;
}

/**
 * Pull the egress token from a forward-proxy request: `Proxy-Authorization`
 * (`Bearer <token>` or `Basic base64(<token>:)` — what `HTTPS_PROXY=http://<token>@host`
 * sends) or the `X-Hotcell-Egress` (legacy `X-Sbx-Egress`) header.
 */
function extractProxyToken(req: IncomingMessage): string | undefined {
  const pa = req.headers["proxy-authorization"];
  if (typeof pa === "string") {
    if (pa.startsWith("Bearer ")) return pa.slice(7);
    if (pa.startsWith("Basic ")) {
      const decoded = Buffer.from(pa.slice(6), "base64").toString("utf8");
      const user = decoded.split(":")[0];
      if (user) return user;
    }
  }
  const direct = req.headers["x-hotcell-egress"] ?? req.headers["x-sbx-egress"];
  if (typeof direct === "string" && direct) return direct;
  return undefined;
}

/** Split a CONNECT authority (`host:port`, `[v6]:port`) into host + port. */
function parseAuthority(s: string): { host: string; port: number } {
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    const host = s.slice(1, end);
    const port = Number(s.slice(end + 2)) || 443;
    return { host, port };
  }
  const i = s.lastIndexOf(":");
  if (i === -1) return { host: s, port: 443 };
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) || 443 };
}

/**
 * Plaintext-HTTP forward-proxy path (apt/pip over http://, via `HTTP_PROXY`):
 * resolve the token, deny LLM-provider hosts (those go through the gateway path)
 * and any host not on the allowlist, then forward + meter bytes. No key injection.
 */
async function handleForwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ResolvedDeps,
): Promise<void> {
  let target: URL;
  try {
    target = new URL(req.url!);
  } catch {
    return sendText(res, 400, "bad forward-proxy target");
  }
  const host = normalizeHost(target.host);

  const token = extractProxyToken(req);
  const rec = token ? deps.store.resolveEgressTokenFull(token) : undefined;
  if (!rec) {
    res.setHeader("proxy-authenticate", 'Basic realm="hotcell-egress"');
    return sendText(res, 407, "proxy authentication required");
  }
  if (deps.providerHosts.has(host)) {
    log.warn("egress forward denied: LLM provider host", { sandbox: rec.sandboxId, host });
    audit({ event: "egress.connection.denied", sandboxId: rec.sandboxId, driver: deps.store.get(rec.sandboxId)?.driver, attributes: { host, port: Number(target.port) || (target.protocol === "https:" ? 443 : 80), rule: "provider_gateway_required", protocol: target.protocol } });
    return sendText(res, 403, `direct egress to LLM provider blocked: ${host} — use the gateway path`);
  }
  const decision = deps.allowlist.check(host);
  if (!decision.allow) {
    log.warn("egress forward denied", { sandbox: rec.sandboxId, host, reason: decision.reason });
    audit({ event: "egress.connection.denied", sandboxId: rec.sandboxId, driver: deps.store.get(rec.sandboxId)?.driver, attributes: { host, port: Number(target.port) || (target.protocol === "https:" ? 443 : 80), rule: decision.reason, protocol: target.protocol } });
    return sendText(res, 403, `egress to ${host} denied (${decision.reason})`);
  }

  const method = req.method ?? "GET";
  let reqBody: Buffer | undefined;
  try {
    reqBody =
      method === "GET" || method === "HEAD"
        ? undefined
        : await readBodyCapped(req, deps.config.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return sendText(res, 413, "request body too large");
    throw err;
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (
      v == null ||
      lk === "proxy-authorization" ||
      lk === "proxy-connection" ||
      lk === "x-hotcell-egress" ||
      lk === "x-sbx-egress" ||
      HOP_REQUEST.has(lk)
    ) {
      continue;
    }
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }

  let bytes = reqBody?.length ?? 0;
  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body: reqBody, redirect: "manual" });
  } catch (err) {
    return sendText(res, 502, `forward fetch failed: ${String(err)}`);
  }
  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_RESPONSE.has(key.toLowerCase())) respHeaders[key] = value;
  });
  res.writeHead(upstream.status, respHeaders);
  if (upstream.body) {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      res.write(buf);
      bytes += buf.length;
    }
  }
  res.end();
  deps.store.addEgress(rec.sandboxId, bytes);
  audit({ event: "egress.connection.allowed", sandboxId: rec.sandboxId, driver: deps.store.get(rec.sandboxId)?.driver, attributes: { host, port: Number(target.port) || (target.protocol === "https:" ? 443 : 80), rule: decision.reason, protocol: target.protocol, method, status: upstream.status, bytes } });
  log.info("egress forward", { sandbox: rec.sandboxId, host, status: upstream.status, bytes });
}

/**
 * HTTPS forward-proxy path (`CONNECT host:443`, via `HTTPS_PROXY`): resolve the
 * token, deny LLM-provider hosts + non-allowlisted hosts (by SNI/authority — the
 * TLS body stays opaque, no MITM), then open a raw TCP tunnel and meter the bytes
 * both ways. This is the main path for pip/npm/git, which use HTTPS.
 */
async function handleConnect(
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  deps: ResolvedDeps,
): Promise<void> {
  const { host, port } = parseAuthority(req.url ?? "");
  const nhost = normalizeHost(host);

  const token = extractProxyToken(req);
  const rec = token ? deps.store.resolveEgressTokenFull(token) : undefined;
  if (!rec) {
    // Graceful close, and say so: git (unlike curl/pip/apt) does not send
    // Proxy-Authorization preemptively — it expects the 407, then retries with
    // credentials. Without `Connection: close` + a clean FIN it retries the
    // CONNECT on this same socket and dies on "Proxy CONNECT aborted".
    clientSocket.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="hotcell-egress"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
    return;
  }
  // Provider-domain guard MUST precede the allowlist: a wide allowlist entry must
  // never re-open a key-bypass tunnel to an LLM provider.
  if (deps.providerHosts.has(nhost)) {
    log.warn("egress CONNECT denied: LLM provider host", { sandbox: rec.sandboxId, host: nhost });
    audit({ event: "egress.connection.denied", sandboxId: rec.sandboxId, driver: deps.store.get(rec.sandboxId)?.driver, attributes: { host: nhost, port, rule: "provider_gateway_required", protocol: "connect" } });
    clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const decision = deps.allowlist.check(nhost);
  if (!decision.allow) {
    log.warn("egress CONNECT denied", { sandbox: rec.sandboxId, host: nhost, reason: decision.reason });
    audit({ event: "egress.connection.denied", sandboxId: rec.sandboxId, driver: deps.store.get(rec.sandboxId)?.driver, attributes: { host: nhost, port, rule: decision.reason, protocol: "connect" } });
    clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }

  const upstream = netConnect(port, host);
  let bytes = head?.length ?? 0;
  let metered = false;
  const finish = () => {
    if (metered) return;
    metered = true;
    deps.store.addEgress(rec.sandboxId, bytes);
  };
  const teardown = () => {
    finish();
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    clientSocket.on("data", (c: Buffer) => (bytes += c.length));
    upstream.on("data", (c: Buffer) => (bytes += c.length));
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    audit({ event: "egress.connection.allowed", sandboxId: rec.sandboxId, driver: deps.store.get(rec.sandboxId)?.driver, attributes: { host: nhost, port, rule: decision.reason, protocol: "connect" } });
    log.info("egress CONNECT", { sandbox: rec.sandboxId, host: nhost, port });
  });
  upstream.on("error", () => {
    if (!metered) {
      try {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch {
        /* client gone */
      }
    }
    teardown();
  });
  upstream.on("close", teardown);
  clientSocket.on("error", teardown);
  clientSocket.on("close", teardown);
}

interface ParsedUsage {
  tokensIn: number;
  tokensOut: number;
  /** Provider-reported cost in USD (OpenRouter `usage.cost`); 0 if not reported. */
  cost: number;
  /** Model echoed by the provider (preferred for pricing); undefined if absent. */
  model?: string;
}

/**
 * Best-effort usage accounting from the provider's response. Reads the `usage`
 * object — token counts (OpenAI `prompt_tokens`/`completion_tokens` or Anthropic
 * `input_tokens`/`output_tokens`), the **authoritative USD cost** OpenRouter
 * reports as `usage.cost`, and the resolved `model` — from a JSON body or the last
 * SSE `data:` frame.
 */
function parseUsage(buf: Buffer): ParsedUsage {
  const text = buf.toString("utf8");
  const fromObj = (o: any): ParsedUsage | null => {
    const u = o?.usage;
    const model = typeof o?.model === "string" ? o.model : undefined;
    if (!u) return null;
    const inn = u.prompt_tokens ?? u.input_tokens;
    const out = u.completion_tokens ?? u.output_tokens;
    const cost = u.cost; // OpenRouter: real USD cost, inline in every response
    if (inn == null && out == null && cost == null) return null;
    return {
      tokensIn: Number(inn || 0),
      tokensOut: Number(out || 0),
      cost: Number(cost || 0),
      model,
    };
  };
  try {
    const whole = fromObj(JSON.parse(text));
    if (whole) return whole;
  } catch {
    // not a single JSON object; fall through to SSE scan
  }
  // SSE: the usage frame and the model often arrive in different frames, so keep
  // the last seen of each independently.
  let best: ParsedUsage | null = null;
  let lastModel: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const o = JSON.parse(payload);
      if (typeof o?.model === "string") lastModel = o.model;
      const r = fromObj(o);
      if (r) best = r;
    } catch {
      // skip non-JSON frames
    }
  }
  if (best) return { ...best, model: best.model ?? lastModel };
  return { tokensIn: 0, tokensOut: 0, cost: 0, model: lastModel };
}

