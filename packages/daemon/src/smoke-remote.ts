/**
 * Remote end-to-end smoke test.
 *
 * Unlike `smoke.ts` (which boots an in-process daemon and drives it over raw
 * HTTP), this script drives a *live, already-running* daemon over the network
 * via the public TypeScript SDK — exercising the same surface an external
 * operator would. It proves the egress policy round-trips through the live
 * daemon, that egress env auto-wiring landed, and (optionally) that a real
 * provider call meters cost.
 *
 * Required env:
 *   SBX_ENDPOINT            daemon base URL, e.g. https://sbx.example.com:4750
 * Optional env:
 *   SBX_API_KEY             bearer key (when the daemon is started with one)
 *   SBX_SMOKE_REAL_PROVIDER provider name (e.g. "openai") to enable a live LLM call
 *   SBX_SMOKE_MODEL         model id for the real call (default "gpt-4o-mini")
 *
 * Usage: SBX_ENDPOINT=... [SBX_API_KEY=...] node dist/smoke-remote.js
 */

import { HotcellClient, type Sandbox } from "@hotcell/sdk";

async function main(): Promise<number> {
  const endpoint = process.env.SBX_ENDPOINT;
  if (!endpoint) {
    console.error(
      "[smoke-remote] SBX_ENDPOINT is required (the live daemon base URL, e.g. http://127.0.0.1:4750)",
    );
    return 1;
  }
  const apiKey = process.env.SBX_API_KEY;
  const client = new HotcellClient({ endpoint, apiKey });

  // 1. Health + info: confirm the daemon is reachable and learn its driver +
  //    which egress providers it has configured.
  const health = await client.health();
  if (!health.ok) throw new Error(`daemon health not ok: ${JSON.stringify(health)}`);
  const info = await client.info();
  console.error(
    `[smoke-remote] daemon up at ${endpoint} — driver=${info.driver}, ` +
      `egressProviders=[${info.egressProviders.join(", ") || "<none>"}]`,
  );

  let sandbox: Sandbox | undefined;
  try {
    // 2. Create a sandbox with a scoped egress policy (no id => provision new).
    //    The ttlMs sugar should resolve to a concrete `expiresAt` on the daemon.
    sandbox = await client.getSandbox(undefined, {
      egress: { spendCapUsd: 1, models: ["gpt-4o"], ttlMs: 3600_000 },
    });
    console.error(`[smoke-remote] created sandbox ${sandbox.id} with scoped egress policy`);

    // 3. Assert the policy round-trips through the live daemon: exactly one token
    //    is bound to the sandbox, carrying the policy we minted it with.
    const { tokens } = await sandbox.listEgressTokens();
    if (tokens.length !== 1) {
      throw new Error(`expected exactly 1 egress token, got ${tokens.length}`);
    }
    const policy = tokens[0]!.policy;
    if (policy.spendCapUsd !== 1) {
      throw new Error(`expected policy.spendCapUsd === 1, got ${policy.spendCapUsd}`);
    }
    if (!policy.models || !policy.models.includes("gpt-4o")) {
      throw new Error(
        `expected policy.models to include "gpt-4o", got ${JSON.stringify(policy.models)}`,
      );
    }
    if (!policy.expiresAt) {
      throw new Error("expected ttlMs sugar to resolve to a concrete policy.expiresAt");
    }
    console.error(
      `[smoke-remote] egress policy round-trips (spendCapUsd=1, models=[gpt-4o], expiresAt=${policy.expiresAt})`,
    );

    // 4. Egress env auto-wiring: the provider base URL is injected into the
    //    sandbox so an LLM SDK routes through the gateway with no real key.
    const baseUrlRes = await sandbox.exec("printenv OPENAI_BASE_URL");
    const baseUrl = baseUrlRes.stdout.trim();
    if (!baseUrl.endsWith("/openai/v1")) {
      throw new Error(`expected OPENAI_BASE_URL to end with "/openai/v1", got "${baseUrl}"`);
    }
    console.error(`[smoke-remote] OPENAI_BASE_URL auto-wired to ${baseUrl}`);

    // HTTP_PROXY is only injected once the operator enables fail-closed egress
    // enforcement, which may not be on yet — treat a missing value as a soft skip.
    const proxyRes = await sandbox.exec("printenv HTTP_PROXY");
    const httpProxy = proxyRes.stdout.trim();
    if (httpProxy) {
      console.error(`[smoke-remote] HTTP_PROXY set to ${httpProxy} (fail-closed networking enabled)`);
    } else {
      console.error("[smoke-remote] HTTP_PROXY not set (fail-closed networking not enabled)");
    }

    // 5. Allowlisted-registry reachability: report only — allowlist behaviour
    //    depends on the deployment's egress config, so do not hard-assert. Uses
    //    `pip` (always present in the python image, and proxy-auth-capable so the
    //    signal is truthful even under fail-closed enforcement, unlike curl/urllib).
    const reach = await sandbox.exec(
      "pip download --no-deps --progress-bar off --dest /tmp/sbx-reach six >/dev/null 2>&1 && echo OK || echo BLOCKED",
    );
    const reachVerdict = reach.stdout.trim() || "(no output)";
    console.error(`[smoke-remote] allowlisted registry (pypi/pythonhosted) reachability: ${reachVerdict}`);

    // 6. Optional real-provider LLM call, gated on SBX_SMOKE_REAL_PROVIDER. When
    //    set, drive a minimal chat-completion from inside the sandbox through the
    //    egress gateway (no real key in the sandbox) and assert it meters cost.
    const realProvider = process.env.SBX_SMOKE_REAL_PROVIDER;
    if (realProvider) {
      const model = process.env.SBX_SMOKE_MODEL ?? "gpt-4o-mini";
      console.error(
        `[smoke-remote] real-provider call enabled (provider=${realProvider}, model=${model})`,
      );
      // Build the request body in JSON (single-quoted in the shell so the inner
      // double quotes survive); read the HTTP status code separately from the body.
      const body = JSON.stringify({
        model,
        messages: [{ role: "user", content: "say hi" }],
        max_tokens: 8,
      });
      const curl =
        `curl -sS -o /dev/null -w '%{http_code}' --max-time 30 ` +
        `-X POST "$OPENAI_BASE_URL/chat/completions" ` +
        `-H "content-type: application/json" ` +
        `-H "authorization: Bearer $OPENAI_API_KEY" ` +
        `-d '${body}'`;
      const callRes = await sandbox.exec(curl);
      const httpCode = callRes.stdout.trim();
      if (!/^2\d\d$/.test(httpCode)) {
        throw new Error(
          `real-provider call did not succeed: HTTP ${httpCode || "(none)"} stderr=${callRes.stderr.trim()}`,
        );
      }
      console.error(`[smoke-remote] real-provider call returned HTTP ${httpCode}`);

      // The gateway should have metered the call + its cost.
      const metrics = await sandbox.metrics();
      if (!(metrics.usage.providerCalls >= 1)) {
        throw new Error(
          `expected usage.providerCalls >= 1, got ${metrics.usage.providerCalls}`,
        );
      }
      if (!(metrics.cost.provider > 0)) {
        throw new Error(`expected cost.provider > 0, got ${metrics.cost.provider}`);
      }
      console.error(
        `[smoke-remote] metering: providerCalls=${metrics.usage.providerCalls}, ` +
          `cost.provider=${metrics.cost.provider}`,
      );
    } else {
      console.error(
        "[smoke-remote] real-provider call skipped (set SBX_SMOKE_REAL_PROVIDER=openai to enable)",
      );
    }

    // 7. Revoke the egress token, then verify it's gone.
    const tokenToRevoke = tokens[0]!.token;
    await sandbox.revokeEgressToken(tokenToRevoke);
    const after = await sandbox.listEgressTokens();
    if (after.tokens.some((t) => t.token === tokenToRevoke)) {
      throw new Error("egress token still present after revoke");
    }
    console.error("[smoke-remote] revoked egress token");

    console.error("[smoke-remote] passed");
    return 0;
  } catch (err) {
    console.error(
      `[smoke-remote] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    // Always tear the sandbox down, even on assertion failure.
    if (sandbox) {
      try {
        await sandbox.destroy();
        console.error(`[smoke-remote] destroyed sandbox ${sandbox.id}`);
      } catch (err) {
        console.error(
          `[smoke-remote] cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

main().then((code) => process.exit(code));
