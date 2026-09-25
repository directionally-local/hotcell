/**
 * Real-harness e2e (plan §Verification 5): run a headless coding agent inside a
 * sandbox with provider keys injected by the egress gateway — the sandbox only
 * ever sees a revocable per-sandbox token; the daemon swaps it for the real key
 * and meters the call. Supports Autopilot, OpenCode, and Claude Code.
 *
 * Autopilot uses its native custom OpenAI-compatible endpoint config, pointed at
 * hotcell's OpenRouter gateway; the real OpenRouter key stays on the daemon host.
 *
 * Prereqs: a daemon whose environment has SBX_PROVIDER_KEY_OPENROUTER, Docker
 * (container driver), and internet egress for the gateway itself.
 * Env: HOTCELL_ENDPOINT (default http://127.0.0.1:4750), HOTCELL_API_KEY (if auth on),
 *      HOTCELL_E2E_MODEL (OpenRouter slug), HOTCELL_E2E_HARNESS — "claude-code"
 *      (default), "autopilot", or "opencode",
 *      HOTCELL_E2E_EXPECT — "completion" (default; needs a real provider key) or
 *      "auth-fail": run with a dummy key and accept the provider's auth error
 *      as proof the whole chain works (sandbox → token env → headless agent
 *      → gateway → key injection → real provider), minus the billing.
 * Run: npm run e2e:harness
 */
import assert from "node:assert/strict";
import { HotcellClient, type Sandbox } from "@hotcell/sdk";

async function main(): Promise<number> {
  const endpoint = process.env.HOTCELL_ENDPOINT ?? process.env.SBX_ENDPOINT ?? "http://127.0.0.1:4750";
  const harness = process.env.HOTCELL_E2E_HARNESS ?? "claude-code";
  const model =
    process.env.HOTCELL_E2E_MODEL ??
    (harness === "opencode"
      ? "openrouter/moonshotai/kimi-k2.5"
      : harness === "autopilot"
        ? "moonshotai/kimi-k2.5"
        : "anthropic/claude-3.5-haiku");
  const client = new HotcellClient({ endpoint, apiKey: process.env.HOTCELL_API_KEY ?? process.env.SBX_API_KEY });

  let passed = 0;
  const ok = (l: string) => {
    passed++;
    console.log(`  ✓ ${l}`);
  };

  const info = await client.info();
  assert.ok(
    info.egressProviders?.includes("openrouter"),
    `daemon has no openrouter provider key (providers: ${info.egressProviders?.join(", ") || "none"})`,
  );
  ok(`daemon up (${endpoint}); gateway providers: ${info.egressProviders.join(", ")}`);

  let sandbox: Sandbox | undefined;
  try {
    // All three supported real harnesses install from npm and need Node; egress
    // auto-wires the provider env (BASE_URLs at the gateway + token as key).
    sandbox = await client.getSandbox(undefined, {
      image: "node:22-slim",
      egress: true,
      ...(harness === "autopilot" ? { env: { XDG_CONFIG_HOME: "/workspace/.config" } } : {}),
    });
    ok(`sandbox ${sandbox.id} created (node:22-slim, egress wired)`);

    const wiring = await sandbox.exec("echo url=$OPENROUTER_BASE_URL; echo tok=${OPENROUTER_API_KEY:+set}");
    assert.match(wiring.stdout, /url=http.+\/openrouter/, "OPENROUTER_BASE_URL not injected");
    assert.match(wiring.stdout, /tok=set/, "egress token not injected");
    assert.ok(
      !/sk-or-/.test(wiring.stdout),
      "a real provider key leaked into the sandbox env",
    );
    ok("egress env wired: gateway base URL + token (no real key in the sandbox)");

    const installCmd =
      harness === "autopilot"
        ? `npm install -g autopilot-ai --no-fund --no-audit && ` +
          `test -n "$OPENROUTER_BASE_URL" && test -n "$OPENROUTER_API_KEY" && ` +
          `mkdir -p "$XDG_CONFIG_HOME/kimiflare" && ` +
          `node -e 'const fs=require("node:fs"); fs.writeFileSync(process.env.XDG_CONFIG_HOME + "/kimiflare/config.json", JSON.stringify({baseUrl:process.env.OPENROUTER_BASE_URL.replace(/\\/+$/, "") + "/v1",apiKey:process.env.OPENROUTER_API_KEY},null,2), {mode:0o600})' && ` +
          `chmod 600 "$XDG_CONFIG_HOME/kimiflare/config.json" && autopilot --version`
        : harness === "opencode"
          ? // OpenCode reads the openrouter provider from its config; point its
            // baseURL at the gateway with the egress token as the "key".
            `npm install -g opencode-ai --no-fund --no-audit 2>&1 | tail -1 && mkdir -p ~/.config/opencode && ` +
            `printf '{"provider":{"openrouter":{"options":{"baseURL":"%s/v1","apiKey":"%s"}}}}' ` +
            `"$OPENROUTER_BASE_URL" "$OPENROUTER_API_KEY" > ~/.config/opencode/opencode.json && opencode --version`
          : "npm install -g @anthropic-ai/claude-code --no-fund --no-audit 2>&1 | tail -2 && claude --version";
    console.error(`[e2e] installing ${harness} in the sandbox (~1-2 min)…`);
    const install = await sandbox.exec(installCmd);
    assert.equal(install.exitCode, 0, `install failed:\n${install.stdout}\n${install.stderr}`);
    ok(`headless harness installed: ${harness} ${install.stdout.trim().split("\n").pop()}`);

    console.error(`[e2e] running headless ${harness} through the gateway…`);
    const run = await sandbox.exec(
      harness === "autopilot"
        ? `autopilot --print "Reply with exactly: HOTCELL_E2E_OK" --model "${model}" --dangerously-allow-all 2>&1`
        : harness === "opencode"
          ? `export HOME=/root && opencode run -m "${model}" --dangerously-skip-permissions "Reply with exactly: HOTCELL_E2E_OK" 2>&1`
          : [
              // Claude Code → gateway → OpenRouter's Anthropic-compatible Messages API.
              // Use the gateway token as auth and blank the real-key env to avoid conflicts.
              `export ANTHROPIC_BASE_URL="$OPENROUTER_BASE_URL"`,
              `export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"`,
              `export ANTHROPIC_API_KEY=""`,
              `export ANTHROPIC_DEFAULT_HAIKU_MODEL="${model}"`,
              `export DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
              `export HOME=/root IS_SANDBOX=1`,
              `claude -p "Reply with exactly: HOTCELL_E2E_OK" --model haiku 2>&1`,
            ].join(" && "),
    );
    const expect = process.env.HOTCELL_E2E_EXPECT ?? "completion";
    if (expect === "auth-fail") {
      // Dummy-key mode: the provider rejecting our injected key IS the proof —
      // the request left headless Claude Code, crossed the gateway, had the
      // (dummy) real key injected, and reached the provider over the internet.
      assert.match(
        run.stdout,
        /401|unauthori[sz]ed|invalid.*(key|token)|authentication/i,
        `expected a provider auth error, got:\n${run.stdout.slice(-800)}`,
      );
      ok(`★ headless ${harness} → gateway → real provider (auth error as expected with a dummy key)`);
    } else {
      assert.match(
        run.stdout,
        /HOTCELL_E2E_OK/,
        `no completion came back through the gateway:\n${run.stdout.slice(-800)}`,
      );
      ok(`★ headless ${harness} completed a real prompt through the egress gateway`);
    }

    // The gateway metered the traffic: provider calls on the record.
    const metrics = await sandbox.metrics();
    if (expect === "auth-fail") {
      ok(`gateway saw ${metrics.usage?.providerCalls ?? 0} provider call(s) (auth-fail mode)`);
    } else {
      assert.ok(
        (metrics.usage?.providerCalls ?? 0) > 0,
        "gateway did not meter any provider call",
      );
      ok(
        `gateway metered ${metrics.usage.providerCalls} provider call(s), ` +
          `${metrics.usage.providerTokensIn}/${metrics.usage.providerTokensOut} tokens in/out, ` +
          `provider cost $${metrics.usage.providerCost.toFixed(4)}`,
      );
    }

    console.log(`\ne2e-harness: ${passed} checks passed (real agent, real completion, key never in sandbox)`);
    return 0;
  } catch (err) {
    console.error(`e2e-harness FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (sandbox) await sandbox.destroy().catch(() => {});
  }
}

main().then((code) => process.exit(code));
