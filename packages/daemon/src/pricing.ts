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
 * production via `SBX_MODEL_PRICES` (a JSON file of the same shape). Keys are
 * lower-cased; lookup also tries prefix matches so dated aliases
 * (`gpt-4o-2024-08-06` → `gpt-4o`) resolve without an exact entry.
 */
export interface ModelPrice {
  /** USD per 1M input/prompt tokens. */
  inputPerMTok: number;
  /** USD per 1M output/completion tokens. */
  outputPerMTok: number;
}

export type ModelPrices = Record<string, ModelPrice>;

/** Built-in default prices (USD / 1M tokens). Override via `SBX_MODEL_PRICES`. */
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
 * `path` (the `SBX_MODEL_PRICES` config), so operators can reprice without a
 * rebuild. A missing/unreadable/malformed file logs a warning and falls back to
 * defaults — pricing must never crash the daemon.
 */
export function loadModelPrices(path: string): ModelPrices {
  if (!path) return { ...DEFAULT_MODEL_PRICES };
  try {
    const overrides = JSON.parse(readFileSync(path, "utf8")) as ModelPrices;
    const merged: ModelPrices = { ...DEFAULT_MODEL_PRICES };
    for (const [name, price] of Object.entries(overrides)) {
      if (price && typeof price.inputPerMTok === "number" && typeof price.outputPerMTok === "number") {
        merged[name.toLowerCase()] = price;
      }
    }
    return merged;
  } catch (err) {
    log.warn("model prices: failed to load overrides, using defaults", {
      path,
      error: String((err as Error)?.message ?? err),
    });
    return { ...DEFAULT_MODEL_PRICES };
  }
}

/**
 * Resolve a model's price: exact (lower-cased) match, else longest prefix match.
 * A vendor-qualified id (`anthropic/claude-sonnet-4`, `models/gemini-2.5-pro`)
 * that matches nothing as-is is retried without its `vendor/` prefix.
 */
export function priceFor(model: string, prices: ModelPrices): ModelPrice | undefined {
  const key = model.toLowerCase();
  const hit = lookupPrice(key, prices);
  if (hit) return hit;
  const slash = key.lastIndexOf("/");
  return slash >= 0 ? lookupPrice(key.slice(slash + 1), prices) : undefined;
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
): number {
  if (!model) return 0;
  const price = priceFor(model, prices);
  if (!price) {
    log.warn("no price for model — cost computed as 0", { model });
    return 0;
  }
  return (tokensIn / 1e6) * price.inputPerMTok + (tokensOut / 1e6) * price.outputPerMTok;
}
