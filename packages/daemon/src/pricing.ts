import { readFileSync } from "node:fs";
import { log } from "./logger.js";

/**
 * Model price table — USD per million tokens, input/output. Used to compute an
 * LLM call's cost when the provider does **not** report one itself (OpenAI,
 * Anthropic, Google all return token counts but no dollar figure; only OpenRouter
 * inlines `usage.cost`). When a provider *does* report cost, that figure is
 * authoritative and this table is not consulted — see `proxy/egress.ts`.
 *
 * Prices are a best-effort default snapshot and are meant to be overridden in
 * production via `HOTCELL_MODEL_PRICES` (a JSON file of the same shape; default
 * `~/.hotcell/model-prices.json`, applied when it exists). Keys are lower-cased;
 * lookup also tries prefix matches so dated aliases (`gpt-4o-2024-08-06` →
 * `gpt-4o`) resolve without an exact entry — see `priceFor` for the full order.
 */
export interface ModelPrice {
  /** USD per 1M input/prompt tokens. */
  inputPerMTok: number;
  /** USD per 1M output/completion tokens. */
  outputPerMTok: number;
}

export type ModelPrices = Record<string, ModelPrice>;

/** The price of a model served by a keyless local runtime: nothing. */
export const FREE_PRICE: ModelPrice = { inputPerMTok: 0, outputPerMTok: 0 };

/** Built-in default prices (USD / 1M tokens). Override via `HOTCELL_MODEL_PRICES`. */
export const DEFAULT_MODEL_PRICES: ModelPrices = {
  // OpenAI
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  "gpt-4.1-nano": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  "o3": { inputPerMTok: 2, outputPerMTok: 8 },
  "o4-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  // Anthropic
  "claude-3-5-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4 },
  "claude-3-7-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-3-opus": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4": { inputPerMTok: 15, outputPerMTok: 75 },
  // Google Gemini
  "gemini-1.5-pro": { inputPerMTok: 1.25, outputPerMTok: 5 },
  "gemini-1.5-flash": { inputPerMTok: 0.075, outputPerMTok: 0.3 },
  "gemini-2.0-flash": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 },
};

/**
 * Load the model price table: built-in defaults overlaid with a JSON file at
 * `path` (the `HOTCELL_MODEL_PRICES` config), so operators can reprice without a
 * rebuild. A missing file is the normal case (the default path is optional) and
 * yields the defaults silently; an unreadable/malformed one logs a warning and
 * falls back to defaults — pricing must never crash the daemon.
 */
export function loadModelPrices(path: string): ModelPrices {
  if (!path) return { ...DEFAULT_MODEL_PRICES };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn("model prices: failed to read overrides, using defaults", { path, error: String((err as Error)?.message ?? err) });
    }
    return { ...DEFAULT_MODEL_PRICES };
  }
  try {
    const overrides = JSON.parse(raw) as ModelPrices;
    const merged: ModelPrices = { ...DEFAULT_MODEL_PRICES };
    for (const [name, price] of Object.entries(overrides)) {
      if (price && typeof price.inputPerMTok === "number" && typeof price.outputPerMTok === "number") {
        merged[name.toLowerCase()] = price;
      }
    }
    return merged;
  } catch (err) {
    log.warn("model prices: failed to parse overrides, using defaults", {
      path,
      error: String((err as Error)?.message ?? err),
    });
    return { ...DEFAULT_MODEL_PRICES };
  }
}

/** Text after the last `/` (`anthropic/claude-sonnet-4` → `claude-sonnet-4`); the whole id when there is none. */
export function modelBasename(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * Resolve a model's price. Lookups, in order, each as exact (lower-cased) match
 * then longest prefix match against the table keys:
 *   1. `<provider>/<model>`      — a provider-qualified entry, when `provider` is given
 *   2. `<model>`                 — the id as the sandbox sent it
 *   3. the model's basename      — text after its last `/` (`anthropic/claude-sonnet-4` → `claude-sonnet-4`)
 *   4. table keys by THEIR basename — an entry written as `openrouter/anthropic/claude-sonnet-4`
 *      also prices a request for `claude-sonnet-4` or `anthropic/claude-sonnet-4`.
 */
export function priceFor(model: string, prices: ModelPrices, provider?: string): ModelPrice | undefined {
  const key = model.toLowerCase();
  const base = modelBasename(key);
  const candidates = provider ? [`${provider.toLowerCase()}/${key}`, key] : [key];
  if (base !== key) candidates.push(base);
  for (const candidate of candidates) {
    const hit = lookupPrice(candidate, prices);
    if (hit) return hit;
  }
  return lookupByKeyBasename(base, prices);
}

function lookupPrice(key: string, prices: ModelPrices): ModelPrice | undefined {
  if (!key) return undefined;
  // Own properties only: a model id like `constructor` must not resolve to an
  // Object.prototype member (a non-price that would compute NaN cost).
  if (Object.hasOwn(prices, key)) return prices[key];
  let best: { name: string; price: ModelPrice } | undefined;
  for (const [name, price] of Object.entries(prices)) {
    if (name && key.startsWith(name) && (!best || name.length > best.name.length)) {
      best = { name, price };
    }
  }
  return best?.price;
}

/** Match `base` against the basename of every slash-qualified table key: exact first, else longest prefix. */
function lookupByKeyBasename(base: string, prices: ModelPrices): ModelPrice | undefined {
  if (!base) return undefined;
  let best: { name: string; price: ModelPrice } | undefined;
  for (const [name, price] of Object.entries(prices)) {
    if (!name.includes("/")) continue;
    const nameBase = modelBasename(name);
    if (!nameBase) continue;
    if (nameBase === base) return price;
    if (base.startsWith(nameBase) && (!best || nameBase.length > best.name.length)) best = { name: nameBase, price };
  }
  return best?.price;
}

/**
 * The 403 body for an unpriced model under a spend cap: names the exact file to
 * add the price to (the configured `HOTCELL_MODEL_PRICES` path, which defaults
 * to `~/.hotcell/model-prices.json`) and the entry shape, so the fix is
 * mechanical for a human or an installer.
 */
export function unpricedMessage(model: string, provider: string, pricesPath: string | undefined): string {
  const where = pricesPath
    ? `the model price file ${pricesPath} (HOTCELL_MODEL_PRICES)`
    : "the JSON file HOTCELL_MODEL_PRICES points at";
  const entry = `{"${model.toLowerCase()}":{"inputPerMTok":<usd per 1M input tokens>,"outputPerMTok":<usd per 1M output tokens>}}`;
  return (
    `model not priced: ${model} — a spend cap applies, so the gateway can only forward models with a known price. ` +
    `Add it to ${where} as ${entry} ` +
    `(a key of "${provider}/${model.toLowerCase()}" or the model's basename also matches), then POST /reload-keys or restart the daemon.`
  );
}

/**
 * Compute an LLM call's USD cost from token counts. Returns 0 (and warns) when the
 * model isn't priced — so a gap is observable. Under a spend cap the egress
 * gateway never relies on that 0: it refuses unpriced models up front (see
 * `proxy/egress.ts`).
 */
export function computeModelCost(
  model: string | undefined,
  tokensIn: number,
  tokensOut: number,
  prices: ModelPrices,
  provider?: string,
): number {
  if (!model) return 0;
  const price = priceFor(model, prices, provider);
  if (!price) {
    log.warn("no price for model — cost computed as 0", { model, provider });
    return 0;
  }
  return (tokensIn / 1e6) * price.inputPerMTok + (tokensOut / 1e6) * price.outputPerMTok;
}
