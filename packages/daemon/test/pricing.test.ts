import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { computeModelCost, loadModelPrices, modelBasename, priceFor, unpricedMessage, type ModelPrices } from "../src/pricing.js";

const table: ModelPrices = {
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "openrouter/anthropic/claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15 },
  "groq/llama-3.3-70b": { inputPerMTok: 0.59, outputPerMTok: 0.79 },
  "fireworks/accounts/fireworks/models/deepseek-v3": { inputPerMTok: 0.9, outputPerMTok: 0.9 },
};

describe("priceFor", () => {
  it("matches the id exactly, then by longest prefix (dated aliases)", () => {
    assert.equal(priceFor("gpt-4o", table)?.inputPerMTok, 2.5);
    assert.equal(priceFor("GPT-4o-2024-08-06", table)?.inputPerMTok, 2.5);
  });

  it("tries <provider>/<model> before the bare id", () => {
    assert.equal(priceFor("llama-3.3-70b", table, "groq")?.inputPerMTok, 0.59);
    assert.equal(priceFor("accounts/fireworks/models/deepseek-v3", table, "fireworks")?.inputPerMTok, 0.9);
    const perProvider: ModelPrices = { "groq/m": { inputPerMTok: 1, outputPerMTok: 1 }, "together/m": { inputPerMTok: 2, outputPerMTok: 2 } };
    assert.equal(priceFor("m", perProvider, "groq")?.inputPerMTok, 1);
    assert.equal(priceFor("m", perProvider, "together")?.inputPerMTok, 2);
  });

  it("falls back to the model's basename (text after the last slash)", () => {
    const t: ModelPrices = { "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15 } };
    assert.equal(priceFor("anthropic/claude-sonnet-4", t)?.outputPerMTok, 15);
    assert.equal(priceFor("vendor/sub/claude-sonnet-4-20250514", t)?.outputPerMTok, 15);
    assert.equal(modelBasename("a/b/c"), "c");
    assert.equal(modelBasename("c"), "c");
  });

  it("matches table keys by their own basename", () => {
    assert.equal(priceFor("claude-sonnet-4", table)?.outputPerMTok, 15);
    assert.equal(priceFor("anthropic/claude-sonnet-4", table)?.outputPerMTok, 15);
    assert.equal(priceFor("deepseek-v3", table, "together")?.inputPerMTok, 0.9);
  });

  it("never resolves Object.prototype members", () => {
    assert.equal(priceFor("constructor", table), undefined);
    assert.equal(priceFor("x/toString", table), undefined);
  });

  it("returns undefined for an unknown model", () => {
    assert.equal(priceFor("nope-9000", table, "openai"), undefined);
  });
});

describe("computeModelCost", () => {
  it("uses the provider-qualified entry when the bare id is unknown", () => {
    assert.equal(computeModelCost("llama-3.3-70b", 1_000_000, 1_000_000, table, "groq"), 0.59 + 0.79);
  });
  it("is 0 for an unpriced model", () => {
    assert.equal(computeModelCost("nope", 10, 10, table), 0);
  });
});

describe("unpricedMessage", () => {
  it("names the exact price file, the entry shape and the alternative keys", () => {
    const msg = unpricedMessage("Foo/Bar-9", "together", "/home/u/.hotcell/model-prices.json");
    assert.match(msg, /^model not priced: Foo\/Bar-9/);
    assert.ok(msg.includes("/home/u/.hotcell/model-prices.json"));
    assert.ok(msg.includes("HOTCELL_MODEL_PRICES"));
    assert.ok(msg.includes('{"foo/bar-9":{"inputPerMTok":'));
    assert.ok(msg.includes('"together/foo/bar-9"'));
  });
  it("falls back to naming the env var when no file is configured", () => {
    const msg = unpricedMessage("m", "openai", "");
    assert.ok(msg.includes("HOTCELL_MODEL_PRICES"));
  });
});

describe("loadModelPrices", () => {
  it("returns the defaults silently when the file does not exist", () => {
    const prices = loadModelPrices(join(mkdtempSync(join(tmpdir(), "hc-prices-")), "missing.json"));
    assert.equal(prices["gpt-4o"]?.inputPerMTok, 2.5);
  });
  it("overlays a file on the defaults with lower-cased keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-prices-"));
    const file = join(dir, "model-prices.json");
    writeFileSync(file, JSON.stringify({ "Groq/Llama-3.3-70b": { inputPerMTok: 1, outputPerMTok: 2 }, bad: { inputPerMTok: "x" } }));
    const prices = loadModelPrices(file);
    assert.equal(prices["groq/llama-3.3-70b"]?.outputPerMTok, 2);
    assert.equal(prices.bad, undefined);
    assert.equal(prices["gpt-4o"]?.inputPerMTok, 2.5);
  });
});
