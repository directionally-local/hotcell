import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BUILTIN_ROUTES as BUILTIN_ROUTE_TABLE,
  canonicalRouteName,
  resolveRoutes,
  type ResolvedRoute,
  type RouteOverride,
} from "@hotcell/daemon/dist/proxy/routes.js";
import { HOME, readConfigFile, writeConfigFile } from "./configfile.js";
import { loadKeys, type KeySource } from "./keystore.js";

export { BUILTIN_ROUTE_TABLE, canonicalRouteName };

/**
 * Where an imported environment goes, and what hotcell is allowed to do with it.
 *
 * hotcell does not decide which of your variables are secrets — that is not
 * decidable from a name, and a wrong guess either leaks a real credential into a
 * sandbox or silently breaks an app. Instead every variable carries an explicit
 * **disposition**, chosen once by the user at import:
 *
 *   gateway — the real key stays on this host; the sandbox gets a per-sandbox
 *             token plus `<PROVIDER>_BASE_URL` pointing at the egress gateway,
 *             which swaps the token for the real key on the way out.
 *   inject  — the real value is copied into every sandbox, verbatim. The only
 *             option for credentials the gateway cannot stand in front of (a
 *             Postgres URL carries its password inside the wire handshake, so
 *             there is no header to substitute).
 *   skip    — never leaves this machine.
 *
 * Two files, split by sensitivity:
 *   `<project>/.hotcell/env.json`   names, dispositions, and provider shapes.
 *                                   Contains NO secret values — safe to commit,
 *                                   which is what makes a teammate's clone
 *                                   inherit every decision without re-reviewing.
 *   `~/.hotcell/env-values.json`    the literal values of `inject` variables,
 *                                   chmod 600, never committed. Kept out of the
 *                                   provider keystore so they never appear as
 *                                   phantom routes in `hotcell keys ls`.
 *
 * `gateway` values are not stored here at all — they go to the provider keystore
 * (`keystore.ts`: macOS keychain, else a chmod-600 file), unchanged.
 */

export type Disposition = "gateway" | "inject" | "skip";

/** A provider route shape: enough for the gateway to forward and authenticate. */
export interface Shape {
  baseUrl: string;
  /** Header the provider authenticates with, lower-cased (`authorization`, `x-api-key`). */
  authHeader: string;
  /** Auth-header value template; `{key}` is replaced with the real key. */
  format: string;
}

export interface VarDecision {
  disposition: Disposition;
  /** For `gateway`: the provider route this variable's key is swapped through. */
  provider?: string;
}

export interface EnvManifest {
  version: 1;
  vars: Record<string, VarDecision>;
  shapes: Record<string, Shape>;
}

export const MANIFEST_DIR = ".hotcell";
export const MANIFEST_NAME = "env.json";
const VALUES_FILE = join(HOME, "env-values.json");

const EMPTY: EnvManifest = { version: 1, vars: {}, shapes: {} };

/**
 * Nearest `.hotcell/env.json` walking up from the cwd, so running hotcell from a
 * subdirectory of a repo finds the same manifest the repo root committed. Falls
 * back to `<cwd>/.hotcell/env.json` when none exists yet (the create path).
 */
export function manifestPath(startDir = process.cwd()): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, MANIFEST_DIR, MANIFEST_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(startDir, MANIFEST_DIR, MANIFEST_NAME);
}

let warnedMalformed = false;

/** Read the manifest; missing → empty, malformed → warn once + empty (never throws). */
export function readManifest(path = manifestPath()): EnvManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ...EMPTY, vars: {}, shapes: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EnvManifest>;
    return {
      version: 1,
      vars: isRecord(parsed.vars) ? (parsed.vars as Record<string, VarDecision>) : {},
      shapes: isRecord(parsed.shapes) ? (parsed.shapes as Record<string, Shape>) : {},
    };
  } catch {
    if (!warnedMalformed) {
      warnedMalformed = true;
      console.error(`hotcell: ignoring malformed ${path} (not valid JSON)`);
    }
    return { ...EMPTY, vars: {}, shapes: {} };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Write the manifest atomically (tmp + rename), creating `.hotcell/` as needed. */
export function writeManifest(manifest: EnvManifest, path = manifestPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Values of `inject` variables, chmod 600, host-only. */
export function readValues(): Record<string, string> {
  try {
    return existsSync(VALUES_FILE)
      ? (JSON.parse(readFileSync(VALUES_FILE, "utf8")) as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function writeValues(values: Record<string, string>): void {
  mkdirSync(HOME, { recursive: true });
  const tmp = VALUES_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(values, null, 2) + "\n");
  renameSync(tmp, VALUES_FILE);
  try {
    chmodSync(VALUES_FILE, 0o600);
  } catch {
    /* Windows: relies on the user-profile ACL */
  }
}

/**
 * The env vars a new sandbox should receive verbatim: every `inject` decision in
 * the project manifest that still has a stored value. Returns `{}` when a project
 * has no manifest, so sandboxes outside a configured project are unaffected.
 */
export function injectedEnv(): Record<string, string> {
  const { vars } = readManifest();
  const values = readValues();
  const out: Record<string, string> = {};
  for (const [name, decision] of Object.entries(vars)) {
    if (decision.disposition !== "inject") continue;
    const value = values[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Env-var names the daemon already routes, mapped to their provider. This is the
 * inverse of `ENV_HINT` in `daemon/src/api/server.ts` — the table that decides
 * which vars the gateway injects — so it is a lookup of existing state, not a
 * guess about what a name means. A route provably exists for exactly these, so
 * exactly these can be preselected `gateway` without asking the user anything.
 *
 * Keep in sync with `ENV_HINT`; every other provider on earth is reached by the
 * user supplying a shape once (see `shapePrompt`), not by growing this table.
 */
export const ROUTED_ENV_VARS: Record<string, string> = {
  OPENAI_API_KEY: "openai",
  ANTHROPIC_API_KEY: "anthropic",
  OPENROUTER_API_KEY: "openrouter",
  REQUESTY_API_KEY: "requesty",
  GOOGLE_API_KEY: "google",
  GEMINI_API_KEY: "gemini",
  DEEPSEEK_API_KEY: "deepseek",
  MOONSHOT_API_KEY: "moonshot",
  KIMI_API_KEY: "kimi-code",
  MINIMAX_API_KEY: "minimax",
  XAI_API_KEY: "xai",
  MISTRAL_API_KEY: "mistral",
  GROQ_API_KEY: "groq",
  CEREBRAS_API_KEY: "cerebras",
  TOGETHER_API_KEY: "together",
  FIREWORKS_API_KEY: "fireworks",
  DEEPINFRA_API_KEY: "deepinfra",
  AI_GATEWAY_API_KEY: "vercel",
  ZAI_API_KEY: "zai",
  OLLAMA_API_KEY: "ollama",
  LMSTUDIO_API_KEY: "lmstudio",
  GITHUB_API_KEY: "github",
};

/**
 * Routes the daemon already knows how to reach: the built-in table in
 * `daemon/src/proxy/routes.ts` (LLM providers, the keyless local runtimes, and
 * `github`). A key for one of these needs no shape; anything else does.
 */
export const BUILTIN_ROUTES = new Set(Object.keys(BUILTIN_ROUTE_TABLE));

/** `kimi-code` → `KIMI_CODE`: the env-var spelling of a route name. */
export function envRouteName(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Operator route shapes as the daemon sees them: `HOTCELL_PROVIDER_<NAME>_*`
 * from the persisted config (`~/.hotcell/config.json`) overridden by env (same
 * precedence as the daemon's `loadProviderConfigs`), with the project
 * manifest's shapes as the fallback for routes not yet synced to the daemon.
 */
export function loadShapes(manifest: EnvManifest = readManifest()): Record<string, RouteOverride> {
  const out: Record<string, RouteOverride> = {};
  for (const [provider, shape] of Object.entries(manifest.shapes)) {
    out[provider.toLowerCase()] = { baseUrl: shape.baseUrl, authHeader: shape.authHeader, formatTemplate: shape.format };
  }
  for (const source of [readConfigFile(), process.env as Record<string, string | undefined>]) {
    for (const prefix of ["SBX_PROVIDER_", "HOTCELL_PROVIDER_"]) {
      for (const [name, value] of Object.entries(source)) {
        if (!name.startsWith(prefix) || !value) continue;
        if (name.startsWith(`${prefix}KEY_`)) continue;
        const rest = name.slice(prefix.length);
        const us = rest.lastIndexOf("_");
        if (us <= 0) continue;
        const provider = canonicalRouteName(rest.slice(0, us));
        const field = rest.slice(us + 1).toUpperCase();
        const cfg = (out[provider] ??= {});
        if (field === "BASEURL") cfg.baseUrl = value;
        else if (field === "AUTHHEADER") cfg.authHeader = value.toLowerCase();
        else if (field === "FORMAT") cfg.formatTemplate = value;
        else if (field === "KEYLESS") cfg.keyless = /^(1|true|yes)$/i.test(value.trim());
      }
    }
  }
  return out;
}

/** Whether the gateway has (or will have, once a key arrives) a way to reach `provider`. */
export function knownRoute(provider: string, shapes: Record<string, RouteOverride> = loadShapes()): boolean {
  const name = canonicalRouteName(provider);
  return BUILTIN_ROUTES.has(name) || Boolean(shapes[name]?.baseUrl);
}

/**
 * Persist a route shape where the daemon reads it (`~/.hotcell/config.json` as
 * `HOTCELL_PROVIDER_<NAME>_*`); `keyless` marks a route live with no key.
 * Applied on the daemon's next hot-reload (`POST /reload-keys`).
 */
export function writeShape(provider: string, shape: Partial<Shape> & { keyless?: boolean }): void {
  const cfg = readConfigFile();
  const name = envRouteName(provider);
  if (shape.baseUrl !== undefined) cfg[`HOTCELL_PROVIDER_${name}_BASEURL`] = shape.baseUrl;
  if (shape.authHeader !== undefined) cfg[`HOTCELL_PROVIDER_${name}_AUTHHEADER`] = shape.authHeader;
  if (shape.format !== undefined) cfg[`HOTCELL_PROVIDER_${name}_FORMAT`] = shape.format;
  if (shape.keyless !== undefined) cfg[`HOTCELL_PROVIDER_${name}_KEYLESS`] = shape.keyless ? "true" : "false";
  writeConfigFile(cfg);
}

/** A route's state as `hotcell keys ls` / `hotcell routes` report it (no secret values). */
export interface RouteStatus extends Omit<ResolvedRoute, "apiKey"> {
  /** Where the key came from, when there is one. */
  keySource?: KeySource;
  /** The path a sandbox points its SDK at, relative to the gateway: `/<name><sdkBasePath>`. */
  gatewayPath: string;
}

/**
 * Every route — built-in, operator-defined, or a stored key with no route —
 * resolved the way the daemon resolves them, from the same keystore and shapes.
 * Works with the daemon down, so an installer can check readiness before start.
 */
export function routeStatuses(): RouteStatus[] {
  const keys = loadKeys();
  const keyMap: Record<string, string> = {};
  const sourceFor: Record<string, KeySource> = {};
  for (const [name, { value, source }] of Object.entries(keys)) {
    const canonical = canonicalRouteName(name);
    keyMap[canonical] = value;
    sourceFor[canonical] = source;
  }
  const resolved = resolveRoutes(keyMap, loadShapes());
  return Object.values(resolved)
    .map(({ apiKey: _key, ...route }): RouteStatus => ({
      ...route,
      ...(route.hasKey && sourceFor[route.name] ? { keySource: sourceFor[route.name] } : {}),
      gatewayPath: `/${route.name}${route.sdkBasePath ?? ""}`,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

/** Common auth shapes, offered as presets so the usual case is one keypress. */
export const AUTH_PRESETS: { label: string; authHeader: string; format: string }[] = [
  { label: "Authorization: Bearer <key>", authHeader: "authorization", format: "Bearer {key}" },
  { label: "X-API-Key: <key>", authHeader: "x-api-key", format: "{key}" },
  { label: "Authorization: <key>  (no scheme)", authHeader: "authorization", format: "{key}" },
];

/**
 * Prefill for the route-name field when a variable has no known route. This is a
 * suggestion rendered into an editable text input the user confirms — not a
 * silent classification — so a bad suggestion costs a keystroke, not a wrong
 * decision made on the user's behalf.
 */
export function suggestRouteName(envName: string): string {
  return envName
    .trim()
    .toLowerCase()
    .replace(/_(api_key|api_token|access_token|secret_key|api_secret|key|token|secret)$/, "");
}

/**
 * Validate a base URL for gateway routing. The gateway substitutes a credential
 * in an HTTP request header, so a route must be http(s); `postgres://` and
 * friends carry their credential inside a protocol handshake and have no header
 * to swap. This parse IS the routability test — there is no keyword matching or
 * name heuristic anywhere in the import path.
 */
export function validateBaseUrl(input: string): { url: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: "a base URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: `"${raw}" is not a URL` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      error: `${parsed.protocol}// is not an HTTP(S) endpoint — the gateway swaps a credential in a request header, and this protocol carries its credential elsewhere`,
    };
  }
  return { url: raw.replace(/\/+$/, "") };
}
