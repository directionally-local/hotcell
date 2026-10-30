import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

/**
 * `hotcell keys add --base-url` / `keys ls --json`, against a throwaway
 * HOTCELL_HOME with the file keystore (the macOS keychain is global to the
 * login session, so a test must never touch it). Requires a prior
 * `npm run build` (the CLI reads the daemon's built route table).
 */
const home = mkdtempSync(join(tmpdir(), "hotcell-cli-keys-"));
process.env.HOTCELL_HOME = home;
process.env.HOTCELL_KEYSTORE = "file";
process.chdir(home); // the project manifest (.hotcell/env.json) lands here, not in the repo

const globals = { endpoint: "http://127.0.0.1:1", apiKey: undefined } as never;

type Status = {
  name: string;
  builtin: boolean;
  keyless: boolean;
  keyOptional: boolean;
  hasKey: boolean;
  keySource?: string;
  active: boolean;
  inactiveReason?: string;
  baseUrl?: string;
  sdkBasePath?: string;
  authHeader?: string;
  formatTemplate?: string;
  gatewayPath: string;
};

let keysCommand: typeof import("../src/keys.js").keysCommand;

async function captured(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function routes(): Promise<Record<string, Status>> {
  const r = await captured(() => keysCommand(["ls"], globals, { json: true }));
  assert.equal(r.code, 0, r.err);
  const parsed = JSON.parse(r.out) as { routes: Status[] };
  return Object.fromEntries(parsed.routes.map((s) => [s.name, s]));
}

describe("hotcell keys", () => {
  before(async () => {
    ({ keysCommand } = await import("../src/keys.js"));
  });

  it("ls --json lists every built-in route with key and active state", async () => {
    const r = await routes();
    for (const id of ["openai", "anthropic", "gemini", "google", "deepseek", "groq", "kimi-code", "zai-coding", "requesty", "ollama", "lmstudio", "github"]) {
      assert.ok(r[id], `missing ${id}`);
      assert.equal(r[id]!.builtin, true);
    }
    assert.equal(r.openai!.active, false);
    assert.equal(r.openai!.inactiveReason, "no key");
    assert.equal(r.openai!.gatewayPath, "/openai/v1");
    assert.equal(r.groq!.gatewayPath, "/groq/openai/v1");
    // Keyless built-ins are off until enabled: they expose the host's loopback.
    assert.equal(r.ollama!.active, false);
    assert.equal(r.ollama!.hasKey, false);
    assert.equal(r.ollama!.keyOptional, true);
    assert.equal(r.ollama!.inactiveReason, "not enabled; hotcell keys add ollama");
    assert.equal(r.lmstudio!.inactiveReason, "not enabled; hotcell keys add lmstudio");
    assert.ok(!JSON.stringify(r).includes("apiKey"));
  });

  it("add --value stores a key for a built-in route and activates it", async () => {
    const r = await captured(() => keysCommand(["add", "groq"], globals, { value: "gsk_test_1234567890" }));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /stored/);
    const after = await routes();
    assert.equal(after.groq!.active, true);
    assert.equal(after.groq!.hasKey, true);
    assert.equal(after.groq!.keySource, "file");
    assert.ok(!r.out.includes("gsk_test_1234567890"), "the key is never echoed");
  });

  it("add NAME --base-url registers the shape and key in one command (non-interactive)", async () => {
    const r = await captured(() =>
      keysCommand(["add", "cfgw"], globals, {
        value: "cf-key-000000",
        "base-url": "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/",
        "auth-header": "X-Auth-Key",
        "auth-format": "Token {key}",
      }),
    );
    assert.equal(r.code, 0, r.err);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, string>;
    assert.equal(cfg.HOTCELL_PROVIDER_CFGW_BASEURL, "https://gateway.ai.cloudflare.com/v1/acct/gw/openai");
    assert.equal(cfg.HOTCELL_PROVIDER_CFGW_AUTHHEADER, "x-auth-key");
    assert.equal(cfg.HOTCELL_PROVIDER_CFGW_FORMAT, "Token {key}");
    const after = await routes();
    assert.equal(after.cfgw!.builtin, false);
    assert.equal(after.cfgw!.active, true);
    assert.equal(after.cfgw!.baseUrl, "https://gateway.ai.cloudflare.com/v1/acct/gw/openai");
    assert.equal(after.cfgw!.authHeader, "x-auth-key");
    assert.equal(after.cfgw!.gatewayPath, "/cfgw");
  });

  it("add --base-url defaults to Bearer auth", async () => {
    const r = await captured(() => keysCommand(["add", "myproxy"], globals, { value: "k", "base-url": "http://10.0.0.5:8000/v1" }));
    assert.equal(r.code, 0, r.err);
    const after = await routes();
    assert.equal(after.myproxy!.authHeader, "authorization");
    assert.equal(after.myproxy!.formatTemplate, "Bearer {key}");
  });

  it("add ollama with no key succeeds and enables the route", async () => {
    const r = await captured(() => keysCommand(["add", "ollama"], globals, {}));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /enabled, keyless/);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, string>;
    assert.equal(cfg.HOTCELL_PROVIDER_OLLAMA_KEYLESS, "true");
    const after = await routes();
    assert.equal(after.ollama!.active, true);
    assert.equal(after.ollama!.keyless, true);
    assert.equal(after.ollama!.hasKey, false);
    assert.equal(after.lmstudio!.active, false, "enabling one keyless route does not enable the other");
  });

  it("add --keyless --base-url registers a custom keyless route", async () => {
    const r = await captured(() => keysCommand(["add", "localvllm"], globals, { keyless: true, "base-url": "http://127.0.0.1:8000" }));
    assert.equal(r.code, 0, r.err);
    const after = await routes();
    assert.equal(after.localvllm!.active, true);
    assert.equal(after.localvllm!.keyless, true);
    assert.equal(after.localvllm!.hasKey, false);
  });

  it("add with no key, no route and no terminal fails with a hint", async () => {
    const r = await captured(() => keysCommand(["add", "unknownprov"], globals, { value: "k" }));
    assert.equal(r.code, 1);
    assert.match(r.err, /--base-url/);
    const r2 = await captured(() => keysCommand(["add", "unknownprov"], globals, { keyless: true }));
    assert.equal(r2.code, 1);
    assert.match(r2.err, /--base-url/);
  });

  it("rejects an --auth-format without {key} and a non-HTTP base URL", async () => {
    const r = await captured(() => keysCommand(["add", "p1"], globals, { value: "k", "base-url": "https://p1.test", "auth-format": "Bearer" }));
    assert.equal(r.code, 1);
    assert.match(r.err, /\{key\}/);
    const r2 = await captured(() => keysCommand(["add", "p2"], globals, { value: "k", "base-url": "postgres://db/x" }));
    assert.equal(r2.code, 1);
    assert.match(r2.err, /not an HTTP\(S\) endpoint/);
  });

  it("folds env-style names onto dashed route ids", async () => {
    const r = await captured(() => keysCommand(["add", "KIMI_CODE"], globals, { value: "kimi-key-1234" }));
    assert.equal(r.code, 0, r.err);
    const after = await routes();
    assert.equal(after["kimi-code"]!.active, true);
    assert.equal(after.kimi_code, undefined);
  });
});
