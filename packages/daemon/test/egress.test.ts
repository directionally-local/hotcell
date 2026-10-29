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
