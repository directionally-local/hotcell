/**
 * Docker-free, VM-free check of the host↔guest agent protocol. Runs the real Go
 * `sbx-agent` over a unix socket (its dev transport) and drives it through the TS
 * `AgentConn` client — validating the wire protocol end-to-end on macOS with no
 * microVM. The same client + protocol then carry every Driver op once the VZ
 * helper relays a guest vsock to a unix socket. Run: `npm run check:agent`.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentConn } from "./driver/agent.js";

async function main(): Promise<void> {
  const bin = process.env.HOTCELL_AGENT_BIN ?? "/tmp/hotcell-agent-check";
  const dir = mkdtempSync(join(tmpdir(), "hotcell-agent-"));
  const sock = join(dir, "agent.sock");

  const egressTargetSock = join(dir, "egress-target.sock");
  const proc = spawn(bin, [], {
    env: {
      ...process.env,
      HOTCELL_AGENT_LISTEN: `unix://${sock}`,
      // Egress relay test override: instead of vsock (no VM here), the agent
      // dials this unix socket, where the check hosts a mock gateway.
      HOTCELL_EGRESS_DIAL: `unix://${egressTargetSock}`,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`  ✓ ${label}`);
  };

  try {
    for (let i = 0; i < 50 && !existsSync(sock); i++) await sleep(100);
    assert.ok(existsSync(sock), "agent unix socket should appear");

    const conn = await AgentConn.connect({ path: sock });
    assert.equal(conn.hello?.agent, "hotcell-agent", "Hello identifies the agent");
    assert.equal(conn.hello?.proto, 1, "proto version");
    ok(`Hello received (version ${conn.hello?.version})`);

    // exec: stdout + stderr + exit code (cwd set since the guest default /workspace
    // doesn't exist on the mac host running this check).
    let out = "";
    let err = "";
    let execExitCode: number | undefined;
    const code = await conn.exec(
      "echo out-line && echo err-line >&2 && exit 3",
      { cwd: dir },
      (e) => {
        if (e.type === "stdout") out += e.data;
        if (e.type === "stderr") err += e.data;
        if (e.type === "exit") execExitCode = e.exitCode;
      },
    );
    assert.equal(code, 3, "exec exit code");
    assert.equal(execExitCode, 3, "exec emits its terminal exit event");
    assert.match(out, /out-line/, "exec stdout");
    assert.match(err, /err-line/, "exec stderr");
    ok("exec: stdout/stderr streaming + exit code");

    // writeFile / readFile round-trip.
    await conn.writeFile(join(dir, "f.txt"), "data-123");
    assert.equal(await conn.readFile(join(dir, "f.txt")), "data-123");
    ok("writeFile + readFile round-trip");

    // mkdir + listFiles.
    await conn.mkdir(join(dir, "sub"), true);
    const files = await conn.listFiles(dir);
    assert.ok(files.some((f) => f.name === "f.txt"), "listFiles sees the file");
    assert.ok(files.some((f) => f.name === "sub" && f.isDirectory), "listFiles sees the dir");
    ok("mkdir + listFiles");

    // env overlay: setEnv then read it back via exec.
    await conn.setEnv({ SBX_TEST_VAR: "xyz" });
    let envOut = "";
    await conn.exec("echo $SBX_TEST_VAR", { cwd: dir }, (e) => {
      if (e.type === "stdout") envOut += e.data;
    });
    assert.match(envOut, /xyz/, "setEnv applies to subsequent exec");
    ok("setEnv overlay applies to exec");

    // stats returns (a stub off-Linux, but the RPC round-trips).
    assert.ok(await conn.stats(), "stats RPC returns");
    ok("stats RPC");

    // reseed (the fork path's fresh-identity op) round-trips. Only entropy is
    // requested here — hostname/machine-id/clock would mutate the machine this
    // check runs on. In a guest the agent is PID 1 (root) and the reseed
    // succeeds; an unprivileged host (CI) can't issue RNDADDENTROPY, so accept
    // the permission error there rather than requiring root to run the check.
    if (process.platform !== "linux") {
      await assert.rejects(() => conn.reseed({ entropyBytes: 32 }), /only supported in a Linux guest/);
      ok("reseed RPC reaches the handler (reports the non-Linux limitation)");
    } else if (process.getuid?.() === 0) {
      await conn.reseed({ entropyBytes: 32 });
      ok("reseed RPC reseeds the CRNG");
    } else {
      await assert.rejects(
        () => conn.reseed({ entropyBytes: 32 }),
        /operation not permitted|EPERM/,
        "an unprivileged reseed must fail on the entropy step, not silently succeed",
      );
      ok("reseed RPC reaches the handler (unprivileged host: RNDADDENTROPY needs CAP_SYS_ADMIN)");
    }

    // Egress relay: the agent listens on guest-loopback and forwards each
    // connection out its dialer (vsock in production; HOTCELL_EGRESS_DIAL here).
    // The check hosts the "gateway": an HTTP server on the dialed unix socket.
    const gateway = createHttpServer((_req, res) => res.end("egress-pong"));
    await new Promise<void>((r) => gateway.listen(egressTargetSock, r));
    const egressPort = 47521;
    await conn.egressListen(egressPort);
    const pong = await fetch(`http://127.0.0.1:${egressPort}/anything`);
    assert.equal(await pong.text(), "egress-pong", "egress relay round-trip");
    await conn.egressListen(egressPort); // idempotent re-arm (driver re-sends per boot)
    const pong2 = await fetch(`http://127.0.0.1:${egressPort}/again`);
    assert.equal(await pong2.text(), "egress-pong", "relay still serves after re-arm");
    await new Promise<void>((r) => gateway.close(() => r()));
    ok("egress relay: loopback listener → dialer → mock gateway round-trip (idempotent)");

    conn.close();
    await checkAuthenticatedTcpAgent(bin, dir);
    ok("authenticated TCP agent: token validation, exec, and secret env isolation");
    console.log(`\nagent-check: ${passed} checks passed`);
  } finally {
    proc.kill();
  }
}

async function checkAuthenticatedTcpAgent(bin: string, cwd: string): Promise<void> {
  const probe = createNetServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not allocate a TCP agent test port"));
        return;
      }
      probe.close((err) => err ? reject(err) : resolve(address.port));
    });
  });
  const token = randomBytes(32).toString("hex");
  const proc = spawn(bin, [], {
    env: {
      ...process.env,
      HOTCELL_AGENT_LISTEN: `tcp://127.0.0.1:${port}`,
      HOTCELL_AGENT_TOKEN: token,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  try {
    let conn: AgentConn | undefined;
    let lastError: unknown;
    for (let i = 0; i < 50; i++) {
      try {
        conn = await AgentConn.connectTcp({ host: "127.0.0.1", port, token, timeoutMs: 500 });
        break;
      } catch (err) {
        lastError = err;
        await sleep(100);
      }
    }
    assert.ok(conn, `authenticated TCP agent should become ready: ${String(lastError)}`);
    assert.equal(conn.hello?.agent, "hotcell-agent");
    let output = "";
    await conn.exec("printf tcp-agent-ok; printf '%s' \"$HOTCELL_AGENT_TOKEN\"", { cwd }, (event) => {
      if (event.type === "stdout") output += event.data;
    });
    assert.equal(output, "tcp-agent-ok", "the transport token is not inherited by user commands");
    await assert.rejects(
      AgentConn.connectTcp({ host: "127.0.0.1", port, token: "wrong-token", timeoutMs: 2000 }),
      /authentication failed/,
    );
    conn.close();
  } finally {
    proc.kill();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("agent-check FAILED:", err);
    process.exit(1);
  },
);
