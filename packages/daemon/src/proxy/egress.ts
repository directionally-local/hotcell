import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Config } from "../config.js";
import { audit } from "../audit.js";
import { log } from "../logger.js";
import { computeModelCost, priceFor, type ModelPrice, type ModelPrices } from "../pricing.js";
import type { SandboxStore } from "../store.js";
import type { EgressTokenRecord } from "../types.js";
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
  /**
   * Path the provider's SDK expects its base URL to carry (e.g. `/v1` for the
   * OpenAI SDK, which appends `/chat/completions` without a version prefix).
   * Advertised to sandboxes as part of the auto-wired base URL. Only set when the
   * provider still uses its built-in base URL, so an operator-repointed endpoint
   * (e.g. a Cloudflare AI Gateway prefix) keeps its own path convention.
   */
  sdkBasePath?: string;
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
    sdkBasePath: "/v1",
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
    sdkBasePath: "/v1",
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
      // Only advertise the SDK path when the provider still points at its
      // built-in base URL: an operator override carries its own path convention.
      const sdkBasePath = custom?.baseUrl === undefined ? def?.sdkBasePath : undefined;
      providers[name] = { baseUrl, authHeader, format, apiKey, ...(sdkBasePath ? { sdkBasePath } : {}) };
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
  /** Worst-case cost of admitted, still-running calls (see the spend-cap admission in `handle`). */
  reservations: SpendReservations;
}

/** The egress proxy plus a hot-reload hook for provider keys (see `hotcell keys`). */
export type EgressServer = Server & { reloadProviders: (p: Record<string, ResolvedProvider>) => void };

export function createEgressProxy(deps: Deps): EgressServer {
  const resolved: ResolvedDeps = {
    ...deps,
    limiter: deps.limiter ?? new RateLimiter(),
    allowlist: deps.allowlist ?? loadAllowlist(deps.config),
    providerHosts: computeProviderHosts(deps.providers),
    reservations: new SpendReservations(),
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
/** Leading response bytes kept for usage parsing (Anthropic's `message_start`). */
const USAGE_HEAD_CAP = 64 * 1024;

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

  // Model allowlist: gate every model the call names — the body's `model` and,
  // on Gemini-native routes (`…/models/<model>:generateContent`), the model in
  // the URL path, which is the one Gemini actually serves and bills. A request
  // naming no model (e.g. a file upload) is allowed even when `models` is set, so
  // non-chat routes aren't broken — only an explicit, disallowed model is rejected.
  const bodyObj = reqBody ? parseJsonObject(reqBody) : undefined;
  const bodyModel = typeof bodyObj?.model === "string" ? bodyObj.model : undefined;
  const pathRoute = parsePathModel(rest);
  const reqModel = pathRoute?.model ?? bodyModel;
  if (policy.models) {
    for (const m of [pathRoute?.model, bodyModel]) {
      if (m && !matchModel(policy.models, m)) {
        audit({ event: "gateway.policy.rejected", sandboxId, driver: sb?.driver ?? undefined, attributes: { "token.raw": token, provider: providerName, model: m.slice(0, 128), reason: "model_scope", status: 403 } });
        return sendText(res, 403, `model not allowed: ${m}`);
      }
    }
  }

  // Spend-cap pricing. When a cap applies (token `spendCapUsd` or sandbox
  // `egressSpendCapUsd`), every LLM call must have a bounded worst-case cost
  // that is reserved against the cap BEFORE it is forwarded — the cap is a hard
  // ceiling, not a check against already-finished calls. So under a cap:
  //  - an unpriced model is refused (its cost would otherwise meter as $0);
  //  - the output limit is bounded: an explicit limit above the per-call
  //    ceiling is clamped, a missing/invalid one on a known generation route is
  //    set to `egressMaxOutputTokens`;
  //  - OpenAI chat streaming is made to report usage (`stream_options.include_usage`).
  // Uncapped calls are forwarded byte-for-byte as before.
  const prices = deps.prices ?? {};
  const capped =
    !NON_LLM_PROVIDERS.has(providerName) &&
    (policy.spendCapUsd !== undefined || Boolean(sb?.egressSpendCapUsd));
  let fwdBody = reqBody;
  let reserveUsd = 0;
  if (capped) {
    let changed = false;
    let maxOut = EGRESS_OUTPUT_TOKEN_CEILING;
    if (bodyObj) {
      const bound = boundOutputTokens(bodyObj, rest, providerName, pathRoute?.method, deps.config.egressMaxOutputTokens);
      maxOut = bound.maxOut;
      changed = bound.changed;
      if (bodyObj.stream === true && CHAT_COMPLETIONS.test(rest)) {
        const so = bodyObj.stream_options;
        if (!(isPlainObject(so) && so.include_usage === true)) {
          bodyObj.stream_options = { ...(isPlainObject(so) ? so : {}), include_usage: true };
          changed = true;
        }
      }
      if (changed) fwdBody = Buffer.from(JSON.stringify(bodyObj));
    }
    if (reqModel && !isFreeRoute(rest, pathRoute?.method)) {
      const price = priceFor(reqModel, prices);
      if (!isValidPrice(price)) {
        audit({ event: "gateway.policy.rejected", sandboxId, driver: sb?.driver ?? undefined, attributes: { "token.raw": token, provider: providerName, model: reqModel.slice(0, 128), reason: "unpriced_model", status: 403 } });
        return sendText(
          res,
          403,
          `model not priced: ${reqModel} — a spend cap applies, so the gateway can only forward models with a known price (add it via HOTCELL_MODEL_PRICES)`,
        );
      }
      // Worst case: every request-body byte is an input token (a byte-level BPE
      // token is ≥1 byte of text, so this bounds text input) + the bounded output.
      reserveUsd = ((fwdBody?.length ?? 0) * price.inputPerMTok + maxOut * price.outputPerMTok) / 1e6;
    }
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

  // Spend-cap admission: recorded spend + every in-flight reservation + this
  // call's worst case must fit under each cap. Check and reserve happen in the
  // same synchronous tick (no await in between), so concurrent calls can't all
  // pass against the same stale total; the reservation is released — and the
  // call's actual cost recorded — in the `finally` below.
  if (reserveUsd > 0) {
    const tokenCap = policy.spendCapUsd;
    if (tokenCap !== undefined) {
      const spent = store.resolveEgressTokenFull(token)?.spendUsd ?? record.spendUsd;
      const inflight = deps.reservations.forToken(token);
      if (spent + inflight + reserveUsd > tokenCap + SPEND_EPSILON) {
        audit({ event: "gateway.policy.rejected", sandboxId, driver: sb?.driver ?? undefined, attributes: { "token.raw": token, provider: providerName, model: reqModel?.slice(0, 128) ?? "", reason: "token_spend_cap", status: 402, spendUsd: spent, inflightUsd: inflight, reserveUsd, spendCapUsd: tokenCap } });
        return sendText(res, 402, `egress spend cap exceeded (token): ${capDetail(reserveUsd, tokenCap - spent - inflight, tokenCap)}`);
      }
    }
    const sbNow = store.get(sandboxId);
    const sandboxCap = sbNow?.egressSpendCapUsd;
    if (sbNow && sandboxCap) {
      const spent = sbNow.usage.providerCost;
      const inflight = deps.reservations.forSandbox(sandboxId);
      if (spent + inflight + reserveUsd > sandboxCap + SPEND_EPSILON) {
        audit({ event: "gateway.policy.rejected", sandboxId, driver: sbNow.driver ?? undefined, attributes: { "token.raw": token, provider: providerName, model: reqModel?.slice(0, 128) ?? "", reason: "sandbox_spend_cap", status: 402, spendUsd: spent, inflightUsd: inflight, reserveUsd, spendCapUsd: sandboxCap } });
        return sendText(res, 402, `egress spend cap exceeded (sandbox): ${capDetail(reserveUsd, sandboxCap - spent - inflight, sandboxCap)}`);
      }
    }
    deps.reservations.add(token, sandboxId, reserveUsd);
  }

  try {
    await forwardAndMeter(req, res, deps, {
      provider,
      providerName,
      rest,
      search: url.search,
      method,
      body: fwdBody,
      token,
      sandboxId,
      policy,
      record,
      reqModel,
      reserveUsd,
      now,
    });
  } finally {
    if (reserveUsd > 0) deps.reservations.release(token, sandboxId, reserveUsd);
  }
}

interface ForwardCall {
  provider: ResolvedProvider;
  providerName: string;
  rest: string;
  search: string;
  method: string;
  body: Buffer | undefined;
  token: string;
  sandboxId: string;
  policy: EgressTokenRecord["policy"];
  record: EgressTokenRecord;
  reqModel: string | undefined;
  /** Worst-case cost reserved for this call (0 when no cap applies or it can't be priced). */
  reserveUsd: number;
  now: number;
}

/**
 * Forward an admitted gateway call upstream, stream the response back, and
 * record its usage + cost. Runs inside the caller's try/finally that releases
 * the call's spend reservation, so the actual cost is recorded in the same tick
 * the reservation is dropped — also when the upstream fails mid-stream.
 */
async function forwardAndMeter(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ResolvedDeps,
  call: ForwardCall,
): Promise<void> {
  const { store } = deps;
  const { provider, providerName, token, sandboxId, policy, record, reqModel, reserveUsd, now } = call;
  store.touch(sandboxId);
  const span = startSpan("egress.provider_call", {
    "sandbox.id": sandboxId,
    "egress.provider": providerName,
  });

  const upstreamUrl = provider.baseUrl.replace(/\/$/, "") + "/" + call.rest + (call.search || "");
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_REQUEST.has(k.toLowerCase()) || v == null) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  headers.set(provider.authHeader, provider.format(provider.apiKey));

  let bytes = call.body?.length ?? 0;

  let upstream: Response;
  try {
    // Never follow a provider redirect: fetch strips only authorization/cookie on
    // a cross-origin hop, so the injected key (x-api-key, x-goog-api-key, custom
    // auth headers) would go to whatever host the Location names. The 3xx is
    // relayed to the sandbox as-is; its client re-requests with its own token.
    upstream = await fetch(upstreamUrl, { method: call.method, headers, body: call.body, redirect: "manual" });
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
  // works) while keeping a HEAD and a rolling TAIL copy to parse usage from —
  // Anthropic reports input tokens in the first SSE frame (`message_start`),
  // while output tokens, the OpenAI/Gemini usage frame and the OpenRouter
  // `usage.cost` arrive at the end.
  const head: Buffer[] = [];
  let headBytes = 0;
  const tail: Buffer[] = [];
  let tailBytes = 0;
  let truncated = false;
  let streamError: unknown;
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        res.write(buf);
        bytes += buf.length;
        if (headBytes < USAGE_HEAD_CAP) {
          head.push(buf);
          headBytes += buf.length;
          continue;
        }
        tail.push(buf);
        tailBytes += buf.length;
        while (tail.length > 1 && tailBytes - (tail[0]?.length ?? 0) >= USAGE_PARSE_CAP) {
          const dropped = tail.shift();
          tailBytes -= dropped?.length ?? 0;
          truncated = true;
        }
      }
    } catch (err) {
      streamError = err;
    }
  }
  if (streamError === undefined) res.end();
  else res.destroy();

  const usage = parseUsage(head, tail, truncated);
  const { tokensIn, tokensOut } = usage;
  const prices = deps.prices ?? {};
  // Cost: the provider's own figure is authoritative (OpenRouter inlines
  // `usage.cost`); otherwise compute it from the model price table (the
  // provider-echoed model, else the requested one). Never sum the two — the
  // result is folded into `providerCost`, keeping one source of truth.
  const model = usage.model ?? reqModel;
  let cost: number;
  let priced: boolean;
  if (usage.cost > 0) {
    cost = usage.cost;
    priced = true;
  } else {
    const pricedModel = [usage.model, reqModel].find((m) => m !== undefined && isValidPrice(priceFor(m, prices)));
    priced = pricedModel !== undefined;
    cost = computeModelCost(pricedModel ?? model, tokensIn, tokensOut, prices);
  }
  if (!Number.isFinite(cost) || cost < 0) cost = 0;
  // Under a cap, an admitted call is never free just because its usage couldn't
  // be read (no usage frame, a truncated body, an unknown response shape, or a
  // stream that died mid-way): it is charged its full reservation. Providers
  // don't bill rejected requests, so a non-2xx response with no usage costs 0.
  let chargedReservation = false;
  if (reserveUsd > 0) {
    const billable = streamError !== undefined || (upstream.status >= 200 && upstream.status < 300);
    if (billable && (!usage.found || !priced)) {
      cost = Math.max(cost, reserveUsd);
      chargedReservation = true;
      log.warn("egress call usage unreadable under a spend cap — charged its reservation", {
        sandbox: sandboxId,
        provider: providerName,
        model,
        status: upstream.status,
        reserveUsd,
      });
    } else if (cost > reserveUsd + SPEND_EPSILON) {
      log.warn("egress call cost exceeded its spend-cap reservation", { sandbox: sandboxId, provider: providerName, model, cost, reserveUsd });
    }
  }

  const sb = store.get(sandboxId);
  const previousTokenSpend = store.resolveEgressTokenFull(token)?.spendUsd ?? record.spendUsd;
  const previousSandboxSpend = sb?.usage.providerCost ?? 0;
  store.addProviderUsage(sandboxId, { bytes, tokensIn, tokensOut, cost });
  if (cost > 0) store.addEgressTokenSpend(token, cost);
  if (policy.rateLimit) deps.limiter!.note(token, policy.rateLimit, tokensIn + tokensOut, now);
  const updatedSandbox = store.get(sandboxId);
  const updatedToken = store.resolveEgressTokenFull(token);
  audit({ event: "gateway.call", sandboxId, driver: updatedSandbox?.driver ?? undefined, attributes: { "token.raw": token, provider: providerName, model: model?.slice(0, 128) ?? "", status: upstream.status, tokensIn, tokensOut, cost, ...(chargedReservation ? { chargedReservation: true } : {}) } });
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
  if (upstream.status >= 500 || streamError !== undefined) span.setStatus("error");
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

// --- spend-cap helpers -------------------------------------------------------

/**
 * Per-call output-token ceiling under a spend cap: an explicit output limit above
 * it is clamped down to it in the forwarded body, and a call on a route whose
 * output limit the gateway can't bound is reserved at it. At or above every
 * current model's maximum output, so a legitimate request is not cut short.
 */
export const EGRESS_OUTPUT_TOKEN_CEILING = 128_000;

/** Float slack for cap comparisons (an exactly-fitting reservation is admitted). */
const SPEND_EPSILON = 1e-9;

/** Gateway providers that aren't LLMs: never priced, reserved or rewritten. */
const NON_LLM_PROVIDERS = new Set(["github", "github-git"]);

const CHAT_COMPLETIONS = /(?:^|\/)chat\/completions\/?$/;

/**
 * In-flight spend: the summed worst-case cost of calls admitted under a cap
 * and not yet finished, per egress token and per sandbox. In-memory only — a
 * daemon restart drops in-flight calls along with their reservations.
 */
class SpendReservations {
  private readonly byToken = new Map<string, number>();
  private readonly bySandbox = new Map<string, number>();

  forToken(token: string): number {
    return this.byToken.get(token) ?? 0;
  }

  forSandbox(sandboxId: string): number {
    return this.bySandbox.get(sandboxId) ?? 0;
  }

  add(token: string, sandboxId: string, usd: number): void {
    this.byToken.set(token, this.forToken(token) + usd);
    this.bySandbox.set(sandboxId, this.forSandbox(sandboxId) + usd);
  }

  release(token: string, sandboxId: string, usd: number): void {
    const bump = (m: Map<string, number>, k: string) => {
      const left = (m.get(k) ?? 0) - usd;
      if (left > SPEND_EPSILON) m.set(k, left);
      else m.delete(k);
    };
    bump(this.byToken, token);
    bump(this.bySandbox, sandboxId);
  }
}

function capDetail(reserveUsd: number, remainingUsd: number, capUsd: number): string {
  const usd = (n: number) => `$${Math.max(0, n).toFixed(4)}`;
  return (
    `this call could cost up to ${usd(reserveUsd)} (request size + output limit at the model's price) ` +
    `but only ${usd(remainingUsd)} of the ${usd(capUsd)} cap is left after spent and in-flight calls — ` +
    `lower max_tokens / shorten the prompt, or raise the cap`
  );
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidPrice(p: ModelPrice | undefined): p is ModelPrice {
  return (
    p !== undefined &&
    typeof p.inputPerMTok === "number" &&
    typeof p.outputPerMTok === "number" &&
    Number.isFinite(p.inputPerMTok) &&
    Number.isFinite(p.outputPerMTok) &&
    p.inputPerMTok >= 0 &&
    p.outputPerMTok >= 0
  );
}

/** Parse a JSON-object request body (best-effort; undefined for anything else). */
function parseJsonObject(body: Buffer): Record<string, any> | undefined {
  try {
    const o = JSON.parse(body.toString("utf8"));
    return isPlainObject(o) ? o : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Gemini-native routes carry the model in the path, not the body:
 * `v1beta/models/<model>:generateContent` (also `tunedModels/…`, and
 * `streamGenerateContent`, `countTokens`, `embedContent`, …).
 */
function parsePathModel(rest: string): { model: string; method: string } | undefined {
  let path = rest;
  try {
    path = decodeURIComponent(rest);
  } catch {
    /* keep the raw path */
  }
  const m = path.match(/(?:^|\/)(models|tunedModels)\/([^/:]+):([A-Za-z]+)\/?$/);
  if (!m) return undefined;
  return { model: m[1] === "tunedModels" ? `tunedModels/${m[2]}` : m[2]!, method: m[3]! };
}

/** Token-counting endpoints are free: never reserved or charged. */
function isFreeRoute(rest: string, pathMethod: string | undefined): boolean {
  return pathMethod === "countTokens" || /(?:^|\/)count_tokens\/?$/.test(rest);
}

/** A non-negative integer output limit, or undefined when absent/invalid (`null` = provider default). */
function limitValue(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.ceil(v);
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return Number(v.trim());
  return undefined;
}

/**
 * Bound a capped call's output tokens, rewriting `body` in place when needed.
 * Only the limit field(s) the route's provider honors count: on a known route
 * (OpenAI-style chat/completions, Responses, Anthropic messages, legacy
 * completions, Gemini generateContent) a present limit above the ceiling — or
 * one that isn't a number, e.g. `null` = "provider default" — is rewritten, and
 * a missing one is set to `defaultMax`. Embeddings produce no output tokens. On
 * any other route nothing is rewritten and the ceiling is assumed. The result
 * is multiplied by the number of completions requested (`n`, `best_of`,
 * `candidateCount`), which providers bill separately.
 */
function boundOutputTokens(
  body: Record<string, any>,
  rest: string,
  providerName: string,
  pathMethod: string | undefined,
  defaultMax: number,
): { maxOut: number; changed: boolean } {
  const dflt = Math.min(EGRESS_OUTPUT_TOKEN_CEILING, Math.max(1, Math.floor(defaultMax) || 8192));
  const path = rest.replace(/\/+$/, "");
  let changed = false;

  const geminiConfigs = [body.generationConfig, body.generation_config].filter(isPlainObject);
  const multiplier = Math.max(
    1,
    ...[body.n, body.best_of, ...geminiConfigs.flatMap((g) => [g.candidateCount, g.candidate_count])]
      .map((v) => limitValue(v) ?? 1),
  );

  // Where the route's provider reads its output limit from: [object, key] pairs,
  // plus where to put one when none is given.
  let fields: Array<[Record<string, any>, string]>;
  let inject: () => void;
  if (pathMethod === "embedContent" || pathMethod === "batchEmbedContents" || /(?:^|\/)embeddings$/.test(path)) {
    return { maxOut: 0, changed: false };
  } else if (pathMethod === "generateContent" || pathMethod === "streamGenerateContent") {
    fields = geminiConfigs.flatMap((g): Array<[Record<string, any>, string]> => [
      [g, "maxOutputTokens"],
      [g, "max_output_tokens"],
    ]);
    inject = () => {
      const target = geminiConfigs[0] ?? (body.generationConfig = {});
      target.maxOutputTokens = dflt;
    };
  } else if (CHAT_COMPLETIONS.test(path)) {
    fields = [
      [body, "max_tokens"],
      [body, "max_completion_tokens"],
    ];
    // OpenAI's reasoning models reject `max_tokens`; OpenAI-compatible
    // providers universally accept it.
    inject = () => {
      body[providerName === "openai" ? "max_completion_tokens" : "max_tokens"] = dflt;
    };
  } else if (/(?:^|\/)responses$/.test(path)) {
    fields = [[body, "max_output_tokens"]];
    inject = () => {
      body.max_output_tokens = dflt;
    };
  } else if (/(?:^|\/)(?:messages|completions)$/.test(path)) {
    fields = [[body, "max_tokens"]];
    inject = () => {
      body.max_tokens = dflt;
    };
  } else {
    return { maxOut: EGRESS_OUTPUT_TOKEN_CEILING * multiplier, changed: false };
  }

  let maxOut = -1;
  for (const [obj, key] of fields) {
    if (!Object.hasOwn(obj, key)) continue;
    let v = limitValue(obj[key]);
    if (v === undefined) {
      obj[key] = v = dflt;
      changed = true;
    } else if (v > EGRESS_OUTPUT_TOKEN_CEILING) {
      obj[key] = v = EGRESS_OUTPUT_TOKEN_CEILING;
      changed = true;
    }
    maxOut = Math.max(maxOut, v);
  }
  if (maxOut < 0) {
    inject();
    maxOut = dflt;
    changed = true;
  }
  return { maxOut: maxOut * multiplier, changed };
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

export interface ParsedUsage {
  tokensIn: number;
  tokensOut: number;
  /** Provider-reported cost in USD (OpenRouter `usage.cost`); 0 if not reported. */
  cost: number;
  /** Model echoed by the provider (preferred for pricing); undefined if absent. */
  model?: string;
  /** Whether any usage report was found at all (vs. a response with none). */
  found: boolean;
}

/**
 * Best-effort usage accounting from the provider's response, read from a JSON
 * body (object, or Gemini's JSON-array stream) or from SSE `data:` frames:
 *  - OpenAI / OpenRouter / Anthropic `usage` (`prompt_tokens`/`completion_tokens`
 *    or `input_tokens`/`output_tokens`, plus Anthropic's separately-reported
 *    `cache_creation_input_tokens`/`cache_read_input_tokens`, counted as input),
 *    also when nested as `message.usage` (Anthropic `message_start`) or
 *    `response.usage` (OpenAI Responses stream `response.completed`);
 *  - Gemini `usageMetadata` (`promptTokenCount` + `toolUsePromptTokenCount` in,
 *    `candidatesTokenCount` + `thoughtsTokenCount` out);
 *  - the **authoritative USD cost** OpenRouter reports as `usage.cost`;
 *  - the resolved `model` (`model`, or Gemini's `modelVersion`).
 * Streamed usage is cumulative, so each field keeps the largest value seen
 * across frames. `truncated` = the middle of the body was dropped, so only the
 * SSE frames in `head` and `tail` can be read.
 */
export function parseUsage(head: Buffer[], tail: Buffer[], truncated: boolean): ParsedUsage {
  const acc: ParsedUsage = { tokensIn: 0, tokensOut: 0, cost: 0, found: false };
  if (!truncated) {
    const text = Buffer.concat([...head, ...tail]).toString("utf8");
    let whole: unknown;
    let isJson = false;
    try {
      whole = JSON.parse(text);
      isJson = true;
    } catch {
      // not a single JSON document; fall through to the SSE scan
    }
    if (isJson) {
      scanUsage(acc, whole);
      return acc;
    }
    scanSse(acc, text);
    return acc;
  }
  scanSse(acc, Buffer.concat(head).toString("utf8"));
  scanSse(acc, Buffer.concat(tail).toString("utf8"));
  return acc;
}

function scanSse(acc: ParsedUsage, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      scanUsage(acc, JSON.parse(payload));
    } catch {
      // skip non-JSON (or cut-off) frames
    }
  }
}

function scanUsage(acc: ParsedUsage, o: unknown): void {
  if (Array.isArray(o)) {
    for (const item of o) scanUsage(acc, item);
    return;
  }
  if (!isPlainObject(o)) return;
  const model = [o.model, o.modelVersion, o.response?.model, o.message?.model].find((m) => typeof m === "string");
  if (model) acc.model = model;
  const u = [o.usage, o.response?.usage, o.message?.usage].find(isPlainObject);
  if (u) {
    const inn = u.prompt_tokens ?? u.input_tokens;
    const out = u.completion_tokens ?? u.output_tokens;
    if (inn != null || out != null || u.cost != null) {
      acc.found = true;
      acc.tokensIn = Math.max(acc.tokensIn, count(inn) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens));
      acc.tokensOut = Math.max(acc.tokensOut, count(out));
      acc.cost = Math.max(acc.cost, count(u.cost)); // OpenRouter: real USD cost, inline
    }
  }
  const g = o.usageMetadata;
  if (isPlainObject(g) && (g.promptTokenCount != null || g.candidatesTokenCount != null || g.totalTokenCount != null)) {
    acc.found = true;
    acc.tokensIn = Math.max(acc.tokensIn, count(g.promptTokenCount) + count(g.toolUsePromptTokenCount));
    acc.tokensOut = Math.max(acc.tokensOut, count(g.candidatesTokenCount) + count(g.thoughtsTokenCount));
  }
}

/** A usage figure as a finite, non-negative number (0 for anything else). */
function count(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
