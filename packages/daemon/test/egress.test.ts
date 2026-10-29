import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Config } from "../src/config.js";
import { buildProviders } from "../src/proxy/egress.js";

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
