/**
 * Phase 0 smoke test.
 *
 * Starts the daemon, creates a sandbox, runs a command, checks the output,
 * destroys the sandbox, and exits with the command's status.
 */

import { createServer as httpCreateServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BackupRegistry } from "./backups.js";
import { Capacity } from "./capacity.js";
import { createEgressProxy } from "./proxy/egress.js";
import { loadConfig } from "./config.js";
import { createDriver } from "./driver/index.js";
import { createApiServer } from "./api/server.js";
import { reapIdle } from "./lifecycle.js";
import { MetricsHistory, sampleUsage } from "./metrics.js";
import { createProxyServer } from "./proxy/server.js";
import { emptyUsage, SandboxStore } from "./store.js";

async function main(): Promise<number> {
  const config = loadConfig();
  // Use a throwaway backup dir + SQLite file so the smoke run leaves nothing behind.
  config.backupDir = await mkdtemp(join(tmpdir(), "hotcell-smoke-backups-"));
  const dbDir = await mkdtemp(join(tmpdir(), "hotcell-smoke-db-"));
  config.dbPath = join(dbDir, "state.db");
  const driver = createDriver(config);
  const store = new SandboxStore(config.dbPath);
  const backups = new BackupRegistry(config.backupDir);
  const history = new MetricsHistory(config.metricsHistory);

  const server = createApiServer({ config, driver, store, backups, history });
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const endpoint = `http://${config.host}:${config.port}`;
  const proxy = createProxyServer({ config, driver, store });
  await new Promise<void>((resolve) =>
    proxy.listen(config.proxyPort, config.proxyHost, resolve),
  );
  const proxyEndpoint = `http://${config.proxyHost}:${config.proxyPort}`;
  console.error(`[smoke] daemon up at ${endpoint}`);

  try {
    // Create sandbox with a declarative setup command that provisions a marker
    // file (asserted below) — exercises the create-time `setup` path end-to-end.
    const createRes = await fetch(`${endpoint}/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setup: ["echo provisioned > /workspace/setup-marker.txt"] }),
    });
    if (!createRes.ok) throw new Error(`create failed: ${createRes.status}`);
    const { id } = (await createRes.json()) as { id: string };
    console.error(`[smoke] created sandbox ${id}`);

    // Verify the setup command ran (best-effort, but should have succeeded here).
    const markerRes = await fetch(`${endpoint}/sandboxes/${id}/files/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/setup-marker.txt" }),
    });
    if (!markerRes.ok) throw new Error(`setup marker read failed: ${markerRes.status}`);
    const { content: marker } = (await markerRes.json()) as { content: string };
    if (marker.trim() !== "provisioned") {
      throw new Error(`setup command did not run: marker="${marker}"`);
    }
    console.error("[smoke] setup command ran");

    // Detached create: 201 with a `creating` record immediately, ops 409 until
    // provisioning finishes in the background, then the status flips to running.
    const detachRes = await fetch(`${endpoint}/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ detach: true, setup: ["sleep 3"] }),
    });
    if (detachRes.status !== 201) throw new Error(`detach create failed: ${detachRes.status}`);
    const detached = (await detachRes.json()) as { id: string; status: string };
    if (detached.status !== "creating") {
      throw new Error(`detach create returned status "${detached.status}", expected "creating"`);
    }
    const earlyExec = await fetch(`${endpoint}/sandboxes/${detached.id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "true" }),
    });
    if (earlyExec.status !== 409) {
      throw new Error(`exec during creating: ${earlyExec.status}, expected 409`);
    }
    await earlyExec.body?.cancel();
    const detachedFinal = await pollStatus(endpoint, detached.id, 30_000);
    if (detachedFinal.status !== "running") {
      throw new Error(
        `detached create ended as "${detachedFinal.status}" (${detachedFinal.statusReason ?? ""})`,
      );
    }
    console.error(`[smoke] detached create reached running (${detached.id})`);

    // Detached create that fails (unresolvable repo): ends as `error` with a
    // reason, stays listed for inspection, and DELETE cleans it up.
    const badRes = await fetch(`${endpoint}/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ detach: true, repo: "https://invalid.invalid/nope.git" }),
    });
    if (badRes.status !== 201) throw new Error(`failing detach create: ${badRes.status}`);
    const bad = (await badRes.json()) as { id: string };
    const failed = await pollStatus(endpoint, bad.id, 60_000);
    if (failed.status !== "error" || !failed.statusReason) {
      throw new Error(
        `failing detach create ended as "${failed.status}" (${failed.statusReason ?? "no reason"})`,
      );
    }
    for (const sid of [detached.id, bad.id]) {
      const del = await fetch(`${endpoint}/sandboxes/${sid}`, { method: "DELETE" });
      if (!del.ok) throw new Error(`cleanup of ${sid} failed: ${del.status}`);
    }
    console.error("[smoke] failing detached create surfaced its error and cleaned up");

    // Run command.
    const execRes = await fetch(`${endpoint}/sandboxes/${id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo hello from smoke" }),
    });
    if (!execRes.ok || !execRes.body) throw new Error(`exec failed: ${execRes.status}`);

    let stdout = "";
    let exitCode = -1;
    for await (const event of parseSSE(execRes.body)) {
      if (event.type === "stdout") stdout += event.data;
      else if (event.type === "exit") exitCode = event.exitCode ?? 0;
    }

    console.log(stdout.trim());
    if (stdout.trim() !== "hello from smoke") {
      throw new Error(`unexpected output: ${stdout}`);
    }
    if (exitCode !== 0) {
      throw new Error(`non-zero exit: ${exitCode}`);
    }

    // File operations.
    const writeRes = await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/smoke.txt", content: "file ops work" }),
    });
    if (!writeRes.ok) throw new Error(`write failed: ${writeRes.status}`);
    console.error("[smoke] wrote file");

    const readRes = await fetch(`${endpoint}/sandboxes/${id}/files/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/smoke.txt" }),
    });
    if (!readRes.ok) throw new Error(`read failed: ${readRes.status}`);
    const { content } = (await readRes.json()) as { content: string };
    if (content !== "file ops work") {
      throw new Error(`unexpected file content: ${content}`);
    }
    console.error("[smoke] read file");

    const mkdirRes = await fetch(`${endpoint}/sandboxes/${id}/files/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/nested/dir", parents: true }),
    });
    if (!mkdirRes.ok) throw new Error(`mkdir failed: ${mkdirRes.status}`);
    console.error("[smoke] created directory");

    const listRes = await fetch(`${endpoint}/sandboxes/${id}/files/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace" }),
    });
    if (!listRes.ok) throw new Error(`list failed: ${listRes.status}`);
    const { entries } = (await listRes.json()) as {
      entries: { name: string; path: string; isDirectory: boolean; modifiedAt: string }[];
    };
    const names = entries.map((e) => e.name).sort();
    if (!names.includes("smoke.txt") || !names.includes("nested")) {
      throw new Error(`unexpected directory listing: ${names.join(", ")}`);
    }
    if (entries.some((e) => e.path === "/workspace")) {
      throw new Error("directory listing includes the listed directory itself");
    }
    for (const e of entries) {
      if (Number.isNaN(Date.parse(e.modifiedAt)) || !e.modifiedAt.endsWith("Z")) {
        throw new Error(`modifiedAt is not a UTC ISO timestamp: ${e.modifiedAt}`);
      }
    }
    console.error("[smoke] listed files");

    // Background process + port readiness + preview proxy.
    const startRes = await fetch(`${endpoint}/sandboxes/${id}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "python3 -m http.server 8000" }),
    });
    if (!startRes.ok) throw new Error(`startProcess failed: ${startRes.status}`);
    const proc = (await startRes.json()) as { procId: string };
    console.error(`[smoke] started process ${proc.procId}`);

    const waitRes = await fetch(`${endpoint}/sandboxes/${id}/wait-port`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 8000, timeoutMs: 15000 }),
    });
    const { ready } = (await waitRes.json()) as { ready: boolean };
    if (!ready) throw new Error("port 8000 never became ready");
    console.error("[smoke] port 8000 ready");

    const exposeRes = await fetch(`${endpoint}/sandboxes/${id}/expose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 8000 }),
    });
    if (!exposeRes.ok) throw new Error(`expose failed: ${exposeRes.status}`);
    console.error("[smoke] exposed port 8000");

    // Reach the in-sandbox server through the preview proxy (path-based route).
    const previewRes = await fetch(`${proxyEndpoint}/_hotcell/${id}/8000/`);
    const previewBody = await previewRes.text();
    if (!previewBody.includes("Directory listing")) {
      throw new Error(`preview proxy did not serve the sandbox: ${previewBody.slice(0, 80)}`);
    }
    console.error("[smoke] preview proxy served the sandbox");

    // Preview token is exact + case-sensitive: re-expose port 8000 with a token
    // (server still alive here), then a wrong-case token is 403 and the exact
    // token serves the sandbox. Uses node:http to avoid fetch socket pooling.
    await fetch(`${endpoint}/sandboxes/${id}/expose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 8000, token: "AbC123" }),
    });
    const wrongTok = await httpGet(config.proxyHost, config.proxyPort, `/_hotcell/${id}/8000/?token=abc123`);
    if (wrongTok.status !== 403) throw new Error(`wrong-case token should 403, got ${wrongTok.status}`);
    const rightTok = await httpGet(config.proxyHost, config.proxyPort, `/_hotcell/${id}/8000/?token=AbC123`);
    if (!rightTok.body.includes("Directory listing")) {
      throw new Error(`exact token should pass, got ${rightTok.status}`);
    }
    // Drop the token again so the later (post-restart) proxy paths stay simple.
    await fetch(`${endpoint}/sandboxes/${id}/expose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 8000 }),
    });
    console.error("[smoke] preview token is exact + case-sensitive (wrong case 403)");

    // Sandbox env vars apply to subsequent commands.
    const setEnvRes = await fetch(`${endpoint}/sandboxes/${id}/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { SMOKE_VAR: "from-env" } }),
    });
    if (!setEnvRes.ok) throw new Error(`setEnv failed: ${setEnvRes.status}`);
    const envEcho = await execAndCapture(endpoint, id, "echo $SMOKE_VAR");
    if (envEcho !== "from-env") {
      throw new Error(`env var not applied: "${envEcho}"`);
    }
    console.error("[smoke] sandbox env var applied");

    // Sessions: cwd follows `cd` and session env overlays the sandbox env.
    const sessionRes = await fetch(`${endpoint}/sandboxes/${id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { SESS_VAR: "from-session" } }),
    });
    if (!sessionRes.ok) throw new Error(`createSession failed: ${sessionRes.status}`);
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    await execAndCapture(endpoint, id, "cd /tmp", sessionId);
    const sessPwd = await execAndCapture(endpoint, id, "pwd", sessionId);
    if (sessPwd !== "/tmp") {
      throw new Error(`session cwd did not persist: "${sessPwd}"`);
    }
    const sessEcho = await execAndCapture(endpoint, id, "echo $SESS_VAR", sessionId);
    if (sessEcho !== "from-session") {
      throw new Error(`session env var not applied: "${sessEcho}"`);
    }
    console.error("[smoke] session cwd + env persisted");

    // Code interpreter: a stateful Python context (variables persist) plus a
    // one-off run.
    const ctxRes = await fetch(`${endpoint}/sandboxes/${id}/code-contexts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "python" }),
    });
    if (!ctxRes.ok) throw new Error(`createCodeContext failed: ${ctxRes.status}`);
    const { contextId } = (await ctxRes.json()) as { contextId: string };
    console.error(`[smoke] created code context ${contextId}`);

    await runCode(endpoint, id, "x = 41", contextId);
    const exprResult = await runCode(endpoint, id, "x + 1", contextId);
    if (exprResult.results[0]?.text !== "42") {
      throw new Error(`stateful runCode wrong result: ${JSON.stringify(exprResult.results)}`);
    }
    const printResult = await runCode(endpoint, id, "print('hi from kernel')", contextId);
    if (printResult.stdout.trim() !== "hi from kernel") {
      throw new Error(`runCode stdout wrong: "${printResult.stdout}"`);
    }
    const errResult = await runCode(endpoint, id, "1/0", contextId);
    if (!errResult.error || !errResult.error.includes("ZeroDivisionError")) {
      throw new Error(`runCode did not capture error: ${JSON.stringify(errResult)}`);
    }
    console.error("[smoke] stateful python context works (vars persist, stdout, errors)");

    // One-off run with no explicit context.
    const oneOff = await runCode(endpoint, id, "print(6 * 7)");
    if (oneOff.stdout.trim() !== "42") {
      throw new Error(`one-off runCode wrong: "${oneOff.stdout}"`);
    }
    console.error("[smoke] one-off runCode works");

    const delCtxRes = await fetch(
      `${endpoint}/sandboxes/${id}/code-contexts/${contextId}`,
      { method: "DELETE" },
    );
    if (!delCtxRes.ok) throw new Error(`delete context failed: ${delCtxRes.status}`);
    console.error("[smoke] destroyed code context");

    // File watching: open the stream, create a file, expect a change event.
    const watchAbort = new AbortController();
    const watchRes = await fetch(
      `${endpoint}/sandboxes/${id}/watch?path=/workspace&interval=300`,
      { signal: watchAbort.signal },
    );
    if (!watchRes.ok || !watchRes.body) throw new Error(`watch failed: ${watchRes.status}`);
    const sawFile = (async () => {
      for await (const ev of parseSSE(watchRes.body!)) {
        if ((ev as unknown as { path?: string }).path?.endsWith("watched.txt")) {
          return true;
        }
      }
      return false;
    })();
    sawFile.catch(() => false); // avoid an unhandled rejection on abort

    // Let the watcher take its first snapshot, then create a file.
    await setTimeout(600);
    await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/watched.txt", content: "watch me" }),
    });
    const detected = await Promise.race([
      sawFile,
      setTimeout(5000).then(() => false),
    ]);
    watchAbort.abort();
    if (!detected) throw new Error("watch did not report the new file");
    console.error("[smoke] watch reported the new file");

    // Persistence: a file in /workspace survives a stop/start (container is
    // recreated, the named volume is reattached).
    await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/persist.txt", content: "survives restart" }),
    });
    const stopRes = await fetch(`${endpoint}/sandboxes/${id}/stop`, { method: "POST" });
    if (!stopRes.ok) throw new Error(`stop failed: ${stopRes.status}`);
    const stopped = (await stopRes.json()) as { status: string };
    if (stopped.status !== "stopped") throw new Error(`expected stopped, got ${stopped.status}`);
    console.error("[smoke] stopped sandbox");

    const startSbRes = await fetch(`${endpoint}/sandboxes/${id}/start`, { method: "POST" });
    if (!startSbRes.ok) throw new Error(`start failed: ${startSbRes.status}`);
    console.error("[smoke] started sandbox");

    const persistRead = await fetch(`${endpoint}/sandboxes/${id}/files/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/persist.txt" }),
    });
    if (!persistRead.ok) throw new Error(`persist read failed: ${persistRead.status}`);
    const { content: persisted } = (await persistRead.json()) as { content: string };
    if (persisted !== "survives restart") {
      throw new Error(`workspace did not persist across restart: "${persisted}"`);
    }
    console.error("[smoke] workspace persisted across stop/start");

    // Backup + restore: snapshot /workspace, mutate it, restore, confirm rollback.
    await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/backup.txt", content: "v1" }),
    });
    const backupRes = await fetch(`${endpoint}/sandboxes/${id}/backups`, { method: "POST" });
    if (!backupRes.ok) throw new Error(`backup failed: ${backupRes.status}`);
    const { backupId } = (await backupRes.json()) as { backupId: string };
    console.error(`[smoke] created backup ${backupId}`);

    // Mutate after the backup: change a file and add a new one.
    await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/backup.txt", content: "v2" }),
    });
    await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/after-backup.txt", content: "transient" }),
    });

    const restoreRes = await fetch(`${endpoint}/sandboxes/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backupId }),
    });
    if (!restoreRes.ok) throw new Error(`restore failed: ${restoreRes.status}`);
    console.error("[smoke] restored backup");

    const rolledBack = await execAndCapture(endpoint, id, "cat /workspace/backup.txt");
    if (rolledBack !== "v1") {
      throw new Error(`restore did not roll back the file: "${rolledBack}"`);
    }
    // The file added after the backup must be gone (restore is a replacement).
    const gone = await execAndCapture(
      endpoint,
      id,
      "test -e /workspace/after-backup.txt && echo present || echo gone",
    );
    if (gone !== "gone") {
      throw new Error(`restore did not clear post-backup files: "${gone}"`);
    }
    console.error("[smoke] backup/restore rolled the workspace back");

    // Durable state: a fresh store opened on the same SQLite file (as a daemon
    // restart would) must rehydrate the sandbox record and its sessions.
    const reopened = new SandboxStore(config.dbPath);
    try {
      const restored = reopened.get(id);
      if (!restored) throw new Error("sandbox record did not survive restart");
      if (restored.status !== "running") {
        throw new Error(`restored status was "${restored.status}", expected "running"`);
      }
      if (reopened.listSessions(id).length === 0) {
        throw new Error("sessions did not survive restart");
      }
    } finally {
      reopened.close();
    }
    console.error("[smoke] control-plane state survived a simulated restart");

    // Metrics + cost: run the sampler twice (advancing its clock) to integrate
    // CPU-seconds and mem-byte-seconds, then read the metrics endpoint.
    const t0 = Date.now();
    await sampleUsage(driver, store, history, t0);
    await sampleUsage(driver, store, history, t0 + 10_000);
    const metrics = (await (
      await fetch(`${endpoint}/sandboxes/${id}/metrics`)
    ).json()) as {
      live: { memLimitBytes: number } | null;
      usage: { cpuSeconds: number; memByteSeconds: number; egressBytes: number };
      cost: { total: number };
    };
    if (!metrics.live) throw new Error("metrics live snapshot missing for running sandbox");
    if (!(metrics.usage.cpuSeconds > 0)) {
      throw new Error(`expected cpuSeconds > 0, got ${metrics.usage.cpuSeconds}`);
    }
    if (!(metrics.usage.memByteSeconds > 0)) {
      throw new Error(`expected memByteSeconds > 0, got ${metrics.usage.memByteSeconds}`);
    }
    // The earlier preview-proxy fetch should have metered egress bytes.
    if (!(metrics.usage.egressBytes > 0)) {
      throw new Error(`expected egressBytes > 0, got ${metrics.usage.egressBytes}`);
    }
    if (!(metrics.cost.total > 0)) {
      throw new Error(`expected cost.total > 0, got ${metrics.cost.total}`);
    }
    console.error("[smoke] metrics + cost meter integrate CPU/mem usage");

    // Metrics history: the two sampler ticks above recorded live samples that
    // back the dashboard sparklines.
    const histRes = await fetch(`${endpoint}/sandboxes/${id}/metrics/history`);
    const hist = (await histRes.json()) as { samples: { cpuPercent: number }[] };
    if (!Array.isArray(hist.samples) || hist.samples.length < 2) {
      throw new Error(`expected >=2 history samples, got ${hist.samples?.length}`);
    }
    console.error(`[smoke] metrics history recorded ${hist.samples.length} samples`);

    // Tracing: every request opens a server span; recent ones are queryable.
    const tracesRes = await fetch(`${endpoint}/traces`);
    const traces = (await tracesRes.json()) as { spans: { name: string }[] };
    if (!Array.isArray(traces.spans) || traces.spans.length === 0) {
      throw new Error("expected recent spans in /traces, got none");
    }
    if (!traces.spans.some((s) => s.name.includes("/sandboxes/:id"))) {
      throw new Error("expected a normalized /sandboxes/:id span in /traces");
    }
    console.error(`[smoke] tracing recorded ${traces.spans.length} spans`);

    // API-key auth: a second server with a key set rejects keyless calls (401),
    // accepts the right key, and leaves /info open so the dashboard can prompt.
    const authedServer = createApiServer({
      config: { ...config, apiKey: "smoke-secret" },
      driver,
      store,
      backups,
      history,
    });
    const authPort = config.port + 2;
    await new Promise<void>((resolve) => authedServer.listen(authPort, config.host, resolve));
    const authBase = `http://${config.host}:${authPort}`;
    try {
      const noKey = await fetch(`${authBase}/sandboxes`);
      if (noKey.status !== 401) throw new Error(`keyless call should 401, got ${noKey.status}`);
      const wrongKey = await fetch(`${authBase}/sandboxes`, {
        headers: { authorization: "Bearer nope" },
      });
      if (wrongKey.status !== 401) throw new Error(`wrong key should 401, got ${wrongKey.status}`);
      const goodKey = await fetch(`${authBase}/sandboxes`, {
        headers: { authorization: "Bearer smoke-secret" },
      });
      if (!goodKey.ok) throw new Error(`valid key should pass, got ${goodKey.status}`);
      const openInfo = await fetch(`${authBase}/info`);
      if (!openInfo.ok) throw new Error(`/info must stay open under auth, got ${openInfo.status}`);
      const infoBody = (await openInfo.json()) as { auth?: boolean };
      if (infoBody.auth !== true) throw new Error("/info.auth should be true when keyed");
    } finally {
      await new Promise<void>((resolve) => authedServer.close(() => resolve()));
    }
    console.error("[smoke] API-key auth gate enforces key (401) and keeps /info open");

    // Egress credential proxy (LLM gateway): a mock provider upstream proves the
    // daemon injects the real key (held host-side) and meters calls + tokens.
    {
      const REAL_KEY = "REAL-KEY-123";
      const upstream = httpCreateServer((ureq, ures) => {
        const auth = ureq.headers["authorization"] ?? "";
        // Echo the auth header we received + report token usage (OpenAI shape).
        const body = JSON.stringify({
          ok: true,
          receivedAuth: auth,
          usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.0123 },
        });
        ures.writeHead(200, { "content-type": "application/json" });
        ures.end(body);
      });
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
      const upstreamPort = (upstream.address() as { port: number }).port;
      const egressProxy = createEgressProxy({
        config,
        store,
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${upstreamPort}`,
            authHeader: "authorization",
            format: (k: string) => `Bearer ${k}`,
            apiKey: REAL_KEY,
          },
        },
      });
      const egressPort = config.port + 5;
      await new Promise<void>((r) => egressProxy.listen(egressPort, "127.0.0.1", r));
      try {
        // Mint a per-sandbox egress token via REST.
        const mint = (await (
          await fetch(`${endpoint}/sandboxes/${id}/egress-tokens`, { method: "POST" })
        ).json()) as { token: string };
        if (!mint.token) throw new Error("egress mint returned no token");

        // Call the gateway with the token in place of the real provider key.
        const call = (await (
          await fetch(`http://127.0.0.1:${egressPort}/mock/v1/chat`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-hotcell-egress": mint.token },
            body: JSON.stringify({ hello: "world" }),
          })
        ).json()) as { receivedAuth: string };
        if (call.receivedAuth !== `Bearer ${REAL_KEY}`) {
          throw new Error(`expected injected key, upstream saw: ${call.receivedAuth}`);
        }

        // An invalid token is rejected before reaching the provider.
        const bad = await fetch(`http://127.0.0.1:${egressPort}/mock/v1/chat`, {
          method: "POST",
          headers: { "x-hotcell-egress": "nope" },
          body: "{}",
        });
        if (bad.status !== 403) throw new Error(`invalid token should 403, got ${bad.status}`);

        // Metering reflects the call + parsed prompt/completion tokens.
        const mu = (await (
          await fetch(`${endpoint}/sandboxes/${id}/metrics?live=0`)
        ).json()) as {
          usage: {
            providerCalls: number;
            providerTokensIn: number;
            providerTokensOut: number;
            providerCost: number;
          };
          cost: { provider: number; total: number };
        };
        if (mu.usage.providerCalls !== 1) {
          throw new Error(`expected 1 provider call, got ${mu.usage.providerCalls}`);
        }
        if (mu.usage.providerTokensIn !== 11 || mu.usage.providerTokensOut !== 7) {
          throw new Error(
            `expected 11/7 tokens, got ${mu.usage.providerTokensIn}/${mu.usage.providerTokensOut}`,
          );
        }
        // The provider-reported USD cost flows through to usage + the breakdown.
        if (Math.abs(mu.usage.providerCost - 0.0123) > 1e-9) {
          throw new Error(`expected providerCost 0.0123, got ${mu.usage.providerCost}`);
        }
        if (Math.abs(mu.cost.provider - 0.0123) > 1e-9) {
          throw new Error(`expected cost.provider 0.0123, got ${mu.cost.provider}`);
        }
      } finally {
        await new Promise<void>((r) => egressProxy.close(() => r()));
        await new Promise<void>((r) => upstream.close(() => r()));
      }
      console.error("[smoke] egress proxy injects provider key + meters calls/tokens/cost");
    }

    // Auto-egress wiring: a sandbox created with {egress:true} gets the provider
    // base-URL + key env vars injected (token in place of the real key). Configure
    // a provider on the shared config so a route exists, then assert the env.
    config.providerKeys = { ...config.providerKeys, openai: "sk-smoke" };
    {
      const egCreate = (await (
        await fetch(`${endpoint}/sandboxes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ egress: true }),
        })
      ).json()) as { id: string };
      try {
        const baseUrl = await execAndCapture(endpoint, egCreate.id, "printenv OPENAI_BASE_URL");
        const keyVal = await execAndCapture(endpoint, egCreate.id, "printenv OPENAI_API_KEY");
        if (!baseUrl.endsWith("/openai")) {
          throw new Error(`expected OPENAI_BASE_URL .../openai, got "${baseUrl}"`);
        }
        if (!keyVal.startsWith("hc-")) {
          throw new Error(`expected OPENAI_API_KEY to be an egress token, got "${keyVal}"`);
        }
      } finally {
        await fetch(`${endpoint}/sandboxes/${egCreate.id}`, { method: "DELETE" });
      }
      console.error("[smoke] auto-egress wiring injects provider env into the sandbox");
    }

    // Per-sandbox resource limits: hard caps are applied + persisted, the cgroup
    // reflects them, and they survive resume; daemon defaults apply when omitted.
    {
      const MIB = 1024 * 1024;
      const created = (await (
        await fetch(`${endpoint}/sandboxes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ memoryMb: 256, cpus: 0.5, pidsLimit: 128 }),
        })
      ).json()) as { id: string; limits: { memoryMb?: number; cpus?: number; pidsLimit?: number } };
      const limId = created.id;
      try {
        if (
          created.limits.memoryMb !== 256 ||
          created.limits.cpus !== 0.5 ||
          created.limits.pidsLimit !== 128
        ) {
          throw new Error(`limits not persisted on record: ${JSON.stringify(created.limits)}`);
        }
        const mem = await memLimitBytes(endpoint, limId);
        if (mem !== 256 * MIB) throw new Error(`expected 256 MiB cap, got ${mem}`);
        // cgroup v2 reflects the caps (best-effort — tolerate v1 / missing files).
        const pidsMax = await execAndCapture(endpoint, limId, "cat /sys/fs/cgroup/pids.max 2>/dev/null || echo NA");
        if (pidsMax !== "NA" && pidsMax !== "128") throw new Error(`pids.max expected 128, got ${pidsMax}`);
        const cpuMax = await execAndCapture(endpoint, limId, "cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo NA");
        if (cpuMax !== "NA" && cpuMax !== "50000 100000") {
          throw new Error(`cpu.max expected '50000 100000', got '${cpuMax}'`);
        }
        // Caps survive a stop/start (container recreate).
        await fetch(`${endpoint}/sandboxes/${limId}/stop`, { method: "POST" });
        await fetch(`${endpoint}/sandboxes/${limId}/start`, { method: "POST" });
        const memAfter = await memLimitBytes(endpoint, limId);
        if (memAfter !== 256 * MIB) throw new Error(`cap lost after resume, got ${memAfter}`);
      } finally {
        await fetch(`${endpoint}/sandboxes/${limId}`, { method: "DELETE" });
      }

      // Daemon default applies when no per-create value is given.
      const savedDefault = config.defaultMemoryMb;
      config.defaultMemoryMb = 128;
      try {
        const def = (await (
          await fetch(`${endpoint}/sandboxes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).json()) as { id: string };
        try {
          const mem = await memLimitBytes(endpoint, def.id);
          if (mem !== 128 * MIB) throw new Error(`daemon-default cap not applied, got ${mem}`);
        } finally {
          await fetch(`${endpoint}/sandboxes/${def.id}`, { method: "DELETE" });
        }
      } finally {
        config.defaultMemoryMb = savedDefault;
      }
      console.error("[smoke] resource limits enforced (256 MiB cap, survives resume) + daemon default applies");
    }

    // --repo: clone a git repo into /workspace at create. Best-effort (needs
    // network + installs git on the slim image) — logs a skip when offline.
    {
      const repoRes = await fetch(`${endpoint}/sandboxes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "https://github.com/octocat/Hello-World.git" }),
      });
      if (repoRes.ok) {
        const { id: repoId } = (await repoRes.json()) as { id: string };
        try {
          const found = await execAndCapture(
            endpoint,
            repoId,
            "test -e /workspace/Hello-World/README && echo YES || echo NO",
          );
          if (found !== "YES") throw new Error("repo did not clone into /workspace");
          console.error("[smoke] --repo cloned a git repo into /workspace");
        } finally {
          await fetch(`${endpoint}/sandboxes/${repoId}`, { method: "DELETE" });
        }
      } else {
        // 422 = clone failed (likely offline); the wiring + cleanup still ran.
        console.error(`[smoke] --repo clone skipped (status ${repoRes.status}, likely offline)`);
      }
    }

    // Capacity / admission control: with a 700 MiB budget and a 512 MiB default
    // reservation, exactly one uncapped sandbox fits and the second is rejected
    // (503) before any container is created. Uses an isolated store so it doesn't
    // see the main smoke's sandboxes.
    {
      const capConfig = {
        ...config,
        admission: "enforce" as const,
        hostMemoryMb: 700,
        defaultReservationMb: 512,
        overcommit: 1,
      };
      const capStore = new SandboxStore(":memory:");
      const capacity = new Capacity(capStore, capConfig, null);
      const capServer = createApiServer({
        config: capConfig,
        driver,
        store: capStore,
        backups,
        history,
        capacity,
      });
      const capPort = config.port + 6;
      await new Promise<void>((r) => capServer.listen(capPort, config.host, r));
      const capBase = `http://${config.host}:${capPort}`;
      let firstId: string | undefined;
      try {
        const r1 = await fetch(`${capBase}/sandboxes`, { method: "POST" });
        if (!r1.ok) throw new Error(`first create should fit, got ${r1.status}`);
        firstId = ((await r1.json()) as { id: string }).id;
        const r2 = await fetch(`${capBase}/sandboxes`, { method: "POST" });
        if (r2.status !== 503) throw new Error(`over-budget create should 503, got ${r2.status}`);
        const snap = (await (await fetch(`${capBase}/capacity`)).json()) as {
          enforced: boolean;
          memory: { budgetMb: number; committedMb: number };
          fits: number;
        };
        if (!snap.enforced || snap.memory.budgetMb !== 700 || snap.memory.committedMb !== 512 || snap.fits !== 0) {
          throw new Error(`unexpected capacity snapshot: ${JSON.stringify(snap)}`);
        }
      } finally {
        if (firstId) await fetch(`${capBase}/sandboxes/${firstId}`, { method: "DELETE" });
        await new Promise<void>((r) => capServer.close(() => r()));
        capStore.close();
      }
      console.error("[smoke] capacity admission: 1 fits a 700 MiB budget, 2nd rejected (503)");
    }

    // Usage-based admission (deterministic, no containers): two uncapped sandboxes
    // are charged the 256 MiB floor while idle, but when one's measured RSS grows
    // it's charged its actual usage — so a busy box commits more than an idle one.
    {
      const us = new SandboxStore(":memory:");
      const uh = new MetricsHistory(10);
      const rec = (id: string) =>
        us.add({
          id, image: "x", status: "running", createdAt: new Date().toISOString(),
          labels: {}, env: {}, persist: true, lastActivityAt: "", sleepAfterMs: 0,
          limits: {}, usage: emptyUsage(),
        });
      const sample = (id: string, mb: number) =>
        uh.record(id, { at: "", cpuPercent: 0, memBytes: mb * 1024 * 1024, netRxBytes: 0, netTxBytes: 0, pids: 1 });
      rec("aa"); rec("bb");
      sample("aa", 40); sample("bb", 40);
      const uCfg = { ...config, admission: "enforce" as const, hostMemoryMb: 4000, defaultReservationMb: 256, overcommit: 1 };
      const ucap = new Capacity(us, uCfg, null, uh);
      try {
        const idle = ucap.snapshot().memory.committedMb;
        if (idle !== 512) throw new Error(`idle committed should be 2×floor=512, got ${idle}`);
        sample("bb", 900); // bb gets busy
        const busy = ucap.snapshot().memory.committedMb;
        if (busy !== 256 + 900) throw new Error(`busy committed should be 1156, got ${busy}`);
      } finally {
        us.close();
      }
      console.error("[smoke] usage-based admission: idle charges the floor, busy charges measured RSS");
    }

    // Interactive terminal over WebSocket: open a PTY shell, type a command, and
    // read its output back. 6*7 is evaluated by the shell, so seeing the result
    // (not the literal "$((6*7))" that input-echo prints) proves real execution.
    const wsUrl = `${endpoint.replace(/^http/, "ws")}/sandboxes/${id}/terminal?cols=80&rows=24`;
    const termOutput = await new Promise<string>((resolve, reject) => {
      const WS = (globalThis as { WebSocket?: any }).WebSocket;
      if (!WS) return reject(new Error("global WebSocket unavailable (need Node >=21)"));
      const ws = new WS(wsUrl);
      ws.binaryType = "arraybuffer";
      let out = "";
      // NB: this module imports the promise-based setTimeout, so use the globals.
      const timer = globalThis.setTimeout(() => {
        try { ws.close(); } catch {}
        resolve(out);
      }, 6000);
      ws.onopen = () => ws.send(new TextEncoder().encode("echo TERMINAL_OK_$((6*7))\n"));
      ws.onmessage = (e: { data: unknown }) => {
        out += typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer).toString("utf8");
        if (out.includes("TERMINAL_OK_42")) {
          globalThis.clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(out);
        }
      };
      ws.onerror = (e: { message?: string }) => {
        globalThis.clearTimeout(timer);
        reject(new Error(`terminal ws error: ${e?.message ?? "unknown"}`));
      };
    });
    if (!termOutput.includes("TERMINAL_OK_42")) {
      throw new Error(`terminal did not run command; output: ${JSON.stringify(termOutput.slice(0, 200))}`);
    }
    console.error("[smoke] interactive terminal (WebSocket PTY) round-trips a command");

    // --- security hardening (audit remediation) ---------------------------

    // Host-header DNS-rebinding guard: a foreign Host is rejected, loopback is fine.
    const foreignHost = await statusWithHost(config.host, config.port, "/info", "evil.example");
    if (foreignHost !== 403) throw new Error(`foreign Host should 403, got ${foreignHost}`);
    const loopbackHost = await statusWithHost(config.host, config.port, "/info", "127.0.0.1");
    if (loopbackHost !== 200) throw new Error(`loopback Host should 200, got ${loopbackHost}`);
    console.error("[smoke] Host-header guard rejects foreign Host (403), allows loopback");

    // Request-body size cap → 413. Shrink the limit on the live config (read per
    // request), send an over-cap body, then restore it.
    const savedMax = config.maxBodyBytes;
    config.maxBodyBytes = 1024;
    try {
      const big = await fetch(`${endpoint}/sandboxes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labels: { blob: "x".repeat(4096) } }),
      });
      if (big.status !== 413) throw new Error(`oversized body should 413, got ${big.status}`);
    } finally {
      config.maxBodyBytes = savedMax;
    }
    console.error("[smoke] oversized request body rejected with 413");

    // In-container injection is neutralized: a malicious chmod mode is rejected,
    // and a malicious wait-port host is rejected — neither runs a command.
    const badMode = await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/workspace/m.txt",
        content: "x",
        mode: "777; touch /workspace/PWNED #",
      }),
    });
    if (badMode.status === 200) throw new Error("malicious file mode was accepted");
    const badHost = await fetch(`${endpoint}/sandboxes/${id}/wait-port`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 1, host: "127.0.0.1; touch /workspace/PWNED #", timeoutMs: 500 }),
    });
    if (badHost.status === 200) throw new Error("malicious wait-port host was accepted");
    const pwned = await execAndCapture(
      endpoint,
      id,
      "test -e /workspace/PWNED && echo YES || echo NO",
    );
    if (pwned !== "NO") throw new Error("injection created /workspace/PWNED — escaping failed");
    console.error("[smoke] shell-injection via mode/host neutralized (no side effects)");

    // WebSocket message cap: an over-cap inbound frame closes the socket without
    // crashing the daemon (a follow-up request still succeeds).
    await new Promise<void>((resolve) => {
      const WS = (globalThis as { WebSocket?: any }).WebSocket;
      const ws = new WS(`${endpoint.replace(/^http/, "ws")}/sandboxes/${id}/terminal`);
      ws.binaryType = "arraybuffer";
      const done = () => resolve();
      ws.onopen = () => ws.send(new Uint8Array(2 * 1024 * 1024)); // 2 MiB > 1 MiB cap
      ws.onclose = done;
      globalThis.setTimeout(done, 4000);
    });
    const alive = await fetch(`${endpoint}/healthz`);
    if (!alive.ok) throw new Error("daemon did not survive an over-cap WebSocket frame");
    console.error("[smoke] over-cap WebSocket frame closes connection, daemon survives");

    // Dashboard + info endpoints.
    const infoRes = await fetch(`${endpoint}/info`);
    const info = (await infoRes.json()) as { costCpuPerHour?: number; driver?: string };
    if (typeof info.costCpuPerHour !== "number" || !info.driver) {
      throw new Error(`/info missing fields: ${JSON.stringify(info)}`);
    }
    const dashRes = await fetch(`${endpoint}/`);
    const dashHtml = await dashRes.text();
    if (!dashRes.ok || !dashHtml.includes("<title>hotcell dashboard</title>")) {
      throw new Error(`dashboard not served (status ${dashRes.status})`);
    }
    console.error("[smoke] dashboard + /info served");

    // Lifecycle FSM: an idle sandbox auto-pauses, and the next operation
    // transparently auto-resumes it (workspace intact). Use a dedicated sandbox
    // with no exposed ports/processes so the reaper is allowed to pause it.
    const fsmCreate = await fetch(`${endpoint}/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sleepAfter: 60_000 }),
    });
    if (!fsmCreate.ok) throw new Error(`fsm create failed: ${fsmCreate.status}`);
    const { id: fsmId } = (await fsmCreate.json()) as { id: string };
    await fetch(`${endpoint}/sandboxes/${fsmId}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/fsm.txt", content: "survives pause" }),
    });
    // Advance the reaper's clock past sleepAfter to force the idle transition.
    const reaped = await reapIdle(driver, store, Date.now() + 600_000);
    if (!reaped.includes(fsmId)) {
      throw new Error(`reaper did not auto-pause idle sandbox (paused: ${reaped})`);
    }
    const pausedInfo = (await (
      await fetch(`${endpoint}/sandboxes/${fsmId}`)
    ).json()) as { status: string };
    if (pausedInfo.status !== "paused") {
      throw new Error(`expected paused, got "${pausedInfo.status}"`);
    }
    // Next op auto-resumes and the workspace volume is intact.
    const resumed = await execAndCapture(endpoint, fsmId, "cat /workspace/fsm.txt");
    if (resumed !== "survives pause") {
      throw new Error(`auto-resume lost the workspace: "${resumed}"`);
    }
    const runningInfo = (await (
      await fetch(`${endpoint}/sandboxes/${fsmId}`)
    ).json()) as { status: string };
    if (runningInfo.status !== "running") {
      throw new Error(`expected running after resume, got "${runningInfo.status}"`);
    }
    await fetch(`${endpoint}/sandboxes/${fsmId}`, { method: "DELETE" });
    console.error("[smoke] idle sandbox auto-paused and auto-resumed");

    // Destroy sandbox.
    const deleteRes = await fetch(`${endpoint}/sandboxes/${id}`, { method: "DELETE" });
    if (!deleteRes.ok) throw new Error(`destroy failed: ${deleteRes.status}`);
    console.error(`[smoke] destroyed sandbox ${id}`);

    console.error("[smoke] passed");
    return 0;
  } catch (err) {
    console.error(`[smoke] failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    proxy.close();
    server.close();
    store.close();
    await rm(config.backupDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
    await setTimeout(100);
  }
}

/** Run a command (optionally in a session) and return trimmed stdout. */
/**
 * Plain node:http GET (no connection pooling, unlike global fetch — important
 * for the splice-based preview proxy). Optionally overrides the Host header.
 */
function httpGet(
  host: string,
  port: number,
  path: string,
  hostHeader?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { connection: "close" };
    if (hostHeader) headers.host = hostHeader;
    const req = httpRequest({ host, port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** GET with a custom Host header; resolve with just the status code. */
async function statusWithHost(
  host: string,
  port: number,
  path: string,
  hostHeader: string,
): Promise<number> {
  return (await httpGet(host, port, path, hostHeader)).status;
}

/** Read a running sandbox's current memory cap (Docker stats `memory_stats.limit`). */
async function memLimitBytes(endpoint: string, id: string): Promise<number> {
  const m = (await (await fetch(`${endpoint}/sandboxes/${id}/metrics`)).json()) as {
    live: { memLimitBytes: number } | null;
  };
  return m.live?.memLimitBytes ?? 0;
}

async function execAndCapture(
  endpoint: string,
  id: string,
  command: string,
  sessionId?: string,
): Promise<string> {
  const res = await fetch(`${endpoint}/sandboxes/${id}/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, sessionId }),
  });
  if (!res.ok || !res.body) throw new Error(`exec failed: ${res.status}`);
  let out = "";
  for await (const event of parseSSE(res.body)) {
    if (event.type === "stdout") out += event.data;
  }
  return out.trim();
}

interface CodeResult {
  stdout: string;
  stderr: string;
  results: { type: string; text: string }[];
  error: string | null;
}

/** Run a code cell via the run-code endpoint, optionally in a context. */
async function runCode(
  endpoint: string,
  id: string,
  code: string,
  contextId?: string,
): Promise<CodeResult> {
  const res = await fetch(`${endpoint}/sandboxes/${id}/run-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, contextId }),
  });
  if (!res.ok) throw new Error(`run-code failed: ${res.status}`);
  return (await res.json()) as CodeResult;
}

type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number };

/** Poll GET /sandboxes/:id until it leaves `creating` (or the deadline passes). */
async function pollStatus(
  endpoint: string,
  id: string,
  timeoutMs: number,
): Promise<{ status: string; statusReason?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${endpoint}/sandboxes/${id}`);
    if (!res.ok) throw new Error(`poll of ${id} failed: ${res.status}`);
    const record = (await res.json()) as { status: string; statusReason?: string };
    if (record.status !== "creating") return record;
    if (Date.now() > deadline) return record;
    await setTimeout(500);
  }
}

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ExecEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (json) yield JSON.parse(json) as ExecEvent;
    }
  }
}

main().then((code) => process.exit(code));
