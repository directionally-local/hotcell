/**
 * Built-in egress routes: the providers the gateway can reach with no operator
 * configuration beyond a key (or, for local runtimes, nothing at all).
 *
 * Pure data, no imports — the CLI loads this same table (`hotcell keys ls`,
 * `hotcell routes`) so the two never drift. The gateway compiles it into
 * `ResolvedProvider`s in `egress.ts`.
 *
 * Route ids match Autopilot's provider preset ids, so a client configured for
 * provider `<id>` can be pointed at `http://<egress>/<id>` + the same trailing
 * path it would use upstream. Each upstream URL is split into a HOST
 * (`baseUrl`) and the path its OpenAI-style SDK expects to carry
 * (`sdkBasePath`): the gateway forwards `baseUrl + "/" + <everything after the
 * route id>`, so `http://<egress>/groq/openai/v1/chat/completions` reaches
 * `https://api.groq.com/openai/v1/chat/completions`.
 *
 * Providers whose base URL is deployment-specific (Azure OpenAI, Cloudflare
 * Workers AI / AI Gateway, Vertex, Bedrock) are not here: register them with
 * `hotcell keys add <name> --base-url <url>` or `HOTCELL_PROVIDER_<NAME>_*`.
 */

export interface BuiltinRoute {
  /** Upstream origin (scheme + host), e.g. `https://api.openai.com`. */
  baseUrl: string;
  /**
   * Path the provider's SDK expects its base URL to carry (`/v1` for the
   * OpenAI SDK, which appends `/chat/completions`). Advertised to sandboxes as
   * part of the auto-wired base URL. Absent when the SDK adds its own version
   * prefix (Anthropic `/v1/messages`, Gemini native `/v1beta/…`).
   */
  sdkBasePath?: string;
  /** Header the provider authenticates with, lower-cased. */
  authHeader: string;
  /** Auth-header value template; `{key}` is replaced with the real key. */
  format: string;
  /**
   * Alternative auth shape for requests whose path (after the route id)
   * matches `pathPattern` (a regex source). Gemini's OpenAI-compatible
   * endpoint (`v1beta/openai/…`) wants `Authorization: Bearer` while its native
   * API wants `x-goog-api-key`.
   */
  pathAuth?: { pathPattern: string; authHeader: string; format: string };
  /**
   * Needs no key — but is NOT active until the operator enables it
   * (`hotcell keys add ollama`, or `HOTCELL_PROVIDER_OLLAMA_KEYLESS=true`):
   * the upstream is the HOST's loopback (which the gateway process reaches even
   * when the sandbox cannot), and Ollama's API can pull and delete models, so
   * exposing it is a choice, not a default. Once enabled the gateway forwards
   * without adding an auth header; a key, if one is registered, is still
   * injected (e.g. a hosted Ollama account).
   */
  keyless?: boolean;
  /** Not an LLM API: never priced, reserved or body-rewritten, and not in the direct-egress deny set. */
  nonLlm?: boolean;
  /** Short human label. */
  label: string;
}

const BEARER = { authHeader: "authorization", format: "Bearer {key}" } as const;

export const BUILTIN_ROUTES: Record<string, BuiltinRoute> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com", sdkBasePath: "/v1", ...BEARER },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com", authHeader: "x-api-key", format: "{key}" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api", sdkBasePath: "/v1", ...BEARER },
  requesty: { label: "Requesty", baseUrl: "https://router.requesty.ai", sdkBasePath: "/v1", ...BEARER },
  // Gemini: native API (`/v1beta/models/<m>:generateContent`) authenticates with
  // x-goog-api-key; the OpenAI-compatible surface (`/v1beta/openai/…`) with a
  // Bearer token. `google` is an alias so either name works in the route + key env.
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    authHeader: "x-goog-api-key",
    format: "{key}",
    pathAuth: { pathPattern: "^v1(?:beta|alpha)?/openai(?:/|$)", ...BEARER },
  },
  google: {
    label: "Google Gemini (alias)",
    baseUrl: "https://generativelanguage.googleapis.com",
    authHeader: "x-goog-api-key",
    format: "{key}",
    pathAuth: { pathPattern: "^v1(?:beta|alpha)?/openai(?:/|$)", ...BEARER },
  },
  // DeepSeek serves `/chat/completions` at the origin (and under `/v1`).
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", ...BEARER },
  moonshot: { label: "Moonshot AI", baseUrl: "https://api.moonshot.ai", sdkBasePath: "/v1", ...BEARER },
  "kimi-code": { label: "Kimi Code", baseUrl: "https://api.kimi.ai", sdkBasePath: "/coding/v1", ...BEARER },
  minimax: { label: "MiniMax", baseUrl: "https://api.minimax.io", sdkBasePath: "/v1", ...BEARER },
  xai: { label: "xAI", baseUrl: "https://api.x.ai", sdkBasePath: "/v1", ...BEARER },
  mistral: { label: "Mistral", baseUrl: "https://api.mistral.ai", sdkBasePath: "/v1", ...BEARER },
  groq: { label: "Groq", baseUrl: "https://api.groq.com", sdkBasePath: "/openai/v1", ...BEARER },
  cerebras: { label: "Cerebras", baseUrl: "https://api.cerebras.ai", sdkBasePath: "/v1", ...BEARER },
  together: { label: "Together AI", baseUrl: "https://api.together.xyz", sdkBasePath: "/v1", ...BEARER },
  fireworks: { label: "Fireworks AI", baseUrl: "https://api.fireworks.ai", sdkBasePath: "/inference/v1", ...BEARER },
  deepinfra: { label: "DeepInfra", baseUrl: "https://api.deepinfra.com", sdkBasePath: "/v1/openai", ...BEARER },
  vercel: { label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh", sdkBasePath: "/v1", ...BEARER },
  zai: { label: "Z.ai", baseUrl: "https://api.z.ai", sdkBasePath: "/api/paas/v4", ...BEARER },
  "zai-coding": { label: "Z.ai GLM Coding Plan", baseUrl: "https://api.z.ai", sdkBasePath: "/api/coding/paas/v4", ...BEARER },
  // Local runtimes on the daemon host's loopback: keyless, priced at $0.
  ollama: { label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434", sdkBasePath: "/v1", keyless: true, ...BEARER },
  lmstudio: { label: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234", sdkBasePath: "/v1", keyless: true, ...BEARER },
  // GitHub: a sandbox reaches api.github.com through the gateway with its egress
  // token while the real token (`hotcell keys add github --value "$(gh auth
  // token)"`) stays on the host. `github-git` (git push to github.com) is derived
  // from the same key in the gateway.
  github: { label: "GitHub API", baseUrl: "https://api.github.com", nonLlm: true, ...BEARER },
};

/** Route ids, in table order. */
export const BUILTIN_ROUTE_IDS: readonly string[] = Object.keys(BUILTIN_ROUTES);

/**
 * Canonical spelling of a provider name: lower-case, and when an underscored
 * name is really a dashed built-in id spelled through an env var
 * (`HOTCELL_PROVIDER_KEY_KIMI_CODE` → `kimi_code` → `kimi-code`), the built-in id.
 */
export function canonicalRouteName(name: string): string {
  const lower = name.toLowerCase();
  if (BUILTIN_ROUTES[lower]) return lower;
  const dashed = lower.replace(/_/g, "-");
  return BUILTIN_ROUTES[dashed] ? dashed : lower;
}

/** Render an auth-header value template (`Bearer {key}`) with the real key. */
export function renderAuth(template: string, key: string): string {
  return template.split("{key}").join(key);
}

/**
 * Operator overrides for a route (`HOTCELL_PROVIDER_<NAME>_BASEURL` /
 * `_AUTHHEADER` / `_FORMAT` / `_KEYLESS`, or `hotcell keys add --base-url`).
 * Structurally identical to the daemon's `ProviderConfig`.
 */
export interface RouteOverride {
  baseUrl?: string;
  authHeader?: string;
  formatTemplate?: string;
  /** Explicitly active without a key (`true` enables a keyless built-in or makes a custom route keyless). */
  keyless?: boolean;
}

/** One route's resolved state: what the gateway would do with it, and whether it is live. */
export interface ResolvedRoute {
  name: string;
  label?: string;
  /** From the built-in table (possibly with overrides) vs. operator-defined. */
  builtin: boolean;
  baseUrl?: string;
  sdkBasePath?: string;
  authHeader?: string;
  formatTemplate?: string;
  pathAuth?: BuiltinRoute["pathAuth"];
  /** Enabled to run with no key (forwarded with no auth header). */
  keyless: boolean;
  /** Built to run without a key (ollama, lmstudio): a key is optional, but the route still has to be enabled. */
  keyOptional: boolean;
  nonLlm: boolean;
  hasKey: boolean;
  /** The real key (daemon side only; the CLI never prints it). */
  apiKey?: string;
  /** Live on the gateway: reachable at `http://<egress>/<name>/…`. */
  active: boolean;
  /** Why an inactive route is inactive, e.g. `no key`, `not enabled; hotcell keys add ollama`. */
  inactiveReason?: string;
}

/**
 * Resolve every route the gateway knows about — built-ins, operator shapes, and
 * stored keys — into its live state. A route is ACTIVE when it has a base URL
 * and either a key (plus a header to send it in) or has been explicitly enabled
 * as keyless. A built-in that *can* run keyless (ollama, lmstudio) stays
 * inactive until `hotcell keys add <id>` / `_KEYLESS=true` says so.
 *
 * Names are folded so a key and a shape for the same route meet however they
 * were spelled: env vars can only spell `kimi-code` as `KIMI_CODE`, so an
 * underscored name whose dashed twin exists (built-in or otherwise) is treated
 * as that twin.
 */
export function resolveRoutes(
  keys: Record<string, string | undefined>,
  overrides: Record<string, RouteOverride>,
): Record<string, ResolvedRoute> {
  const raw = new Set<string>();
  for (const n of [...Object.keys(BUILTIN_ROUTES), ...Object.keys(keys), ...Object.keys(overrides)]) raw.add(n.toLowerCase());
  const names = [...raw].filter((n) => !(n.includes("_") && raw.has(n.replace(/_/g, "-"))));
  const pick = <T>(map: Record<string, T | undefined>, name: string): T | undefined =>
    map[name] ?? map[name.replace(/-/g, "_")];

  const out: Record<string, ResolvedRoute> = {};
  for (const name of names) {
    const def = BUILTIN_ROUTES[name];
    const custom = pick(overrides, name);
    const apiKey = pick(keys, name) || undefined;
    const keyOptional = def?.keyless === true;
    const keyless = custom?.keyless === true;
    const baseUrl = custom?.baseUrl ?? def?.baseUrl;
    const authHeader = custom?.authHeader ?? def?.authHeader;
    let formatTemplate = custom?.formatTemplate ?? def?.format;
    if (!formatTemplate && custom) formatTemplate = "{key}"; // custom shape without a template: raw key
    // Only the built-in upstream keeps the SDK path and path-conditional auth; a
    // repointed or re-authed route carries its own conventions.
    const stock = custom?.baseUrl === undefined;
    const route: ResolvedRoute = {
      name,
      builtin: def !== undefined,
      keyless,
      keyOptional,
      nonLlm: def?.nonLlm === true,
      hasKey: apiKey !== undefined,
      active: false,
    };
    if (def?.label) route.label = def.label;
    if (baseUrl) route.baseUrl = baseUrl;
    if (stock && def?.sdkBasePath) route.sdkBasePath = def.sdkBasePath;
    if (authHeader) route.authHeader = authHeader;
    if (formatTemplate) route.formatTemplate = formatTemplate;
    if (stock && custom?.authHeader === undefined && def?.pathAuth) route.pathAuth = def.pathAuth;
    if (apiKey) route.apiKey = apiKey;

    if (!baseUrl) route.inactiveReason = "no base URL";
    else if (!apiKey && !keyless) route.inactiveReason = keyOptional ? `not enabled; hotcell keys add ${name}` : "no key";
    else if (apiKey && !(authHeader && formatTemplate)) route.inactiveReason = "no auth header";
    else route.active = true;
    out[name] = route;
  }
  return out;
}
