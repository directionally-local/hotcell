import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CodeContextInfo,
  EgressPolicy,
  EgressTokenRecord,
  ExposedPort,
  ProcessInfo,
  SandboxRecord,
  SandboxUsage,
  SessionInfo,
  TemplateRecord,
} from "./types.js";
import { restrictMode } from "./util.js";

/** Zero-valued usage accumulator for a fresh sandbox. */
export function emptyUsage(): SandboxUsage {
  return {
    cpuSeconds: 0,
    memByteSeconds: 0,
    egressBytes: 0,
    providerCalls: 0,
    providerBytes: 0,
    providerTokensIn: 0,
    providerTokensOut: 0,
    providerCost: 0,
    lastCpuTotalNs: 0,
    lastSampledAt: "",
  };
}

/** A provider-call's metered usage, accumulated by the egress proxy. */
export interface ProviderUsageDelta {
  bytes: number;
  tokensIn: number;
  tokensOut: number;
  /** Provider-reported cost in USD for this call (0 if not reported). */
  cost: number;
}

/**
 * Make the database private before SQLite opens it: `sandboxes.env` holds
 * egress tokens and injected secrets. The main file is pre-created 0600 (or
 * tightened if an older daemon left it 0644). SQLite's unix VFS creates the
 * `-wal`/`-shm`/`-journal` side files with the main database file's
 * permissions, so new ones inherit 0600 whenever they are (lazily) created; any
 * left over from a crash under an older, looser db are tightened here too.
 */
function restrictDbFiles(dbPath: string): void {
  try {
    closeSync(openSync(dbPath, "a", 0o600)); // creates 0600 if missing; never truncates
  } catch {
    /* unwritable path: let DatabaseSync report it */
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) restrictMode(dbPath + suffix);
}

/** Where a preview route points, resolved by the proxy on each request. */
export interface RouteTarget {
  sandboxId: string;
  port: number;
  token: string | null;
}

/**
 * Durable sandbox registry backed by embedded SQLite (`node:sqlite`, built into
 * Node ≥22 — no external dependency). Alongside the sandbox records it tracks
 * background processes, exposed preview ports, sessions, and code-interpreter
 * contexts so the full control-plane state survives a daemon restart (the
 * lead-in to the lifecycle FSM).
 *
 * The in-memory `Map`s are a hot cache that is the working copy during the
 * daemon's lifetime — they preserve mutate-by-reference semantics for callers
 * that tweak a returned record in place. Every mutating method is write-through
 * to SQLite; on construction the cache is hydrated from the database. Pass
 * `:memory:` (the default) for an ephemeral, in-process store (tests, smoke).
 */
export class SandboxStore {
  private db: DatabaseSync;

  private byId = new Map<string, SandboxRecord>();
  // sandboxId -> procId -> process
  private procs = new Map<string, Map<string, ProcessInfo>>();
  // sandboxId -> port -> exposed port
  private exposed = new Map<string, Map<number, ExposedPort>>();
  // exposeId -> route target (O(1) lookup for the proxy)
  private routes = new Map<string, RouteTarget>();
  // sandboxId -> sessionId -> session
  private sessions = new Map<string, Map<string, SessionInfo>>();
  // sandboxId -> contextId -> code context
  private contexts = new Map<string, Map<string, CodeContextInfo>>();
  // egress token -> record (sandboxId + policy + spend; O(1) lookup for the egress proxy)
  private egressTokens = new Map<string, EgressTokenRecord>();
  // template name -> record (microVM snapshot templates)
  private templates = new Map<string, TemplateRecord>();

  /** sandboxId → open exec streams. Memory-only: streams die with the process. */
  private liveExecs = new Map<string, number>();

  constructor(dbPath = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      restrictDbFiles(dbPath);
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
    this.hydrate();
  }

  /** Close the underlying database handle (call on daemon shutdown). */
  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sandboxes (
        id             TEXT PRIMARY KEY,
        image          TEXT NOT NULL,
        status         TEXT NOT NULL,
        createdAt      TEXT NOT NULL,
        driver         TEXT NOT NULL DEFAULT '',
        labels         TEXT NOT NULL,
        env            TEXT NOT NULL,
        persist        INTEGER NOT NULL,
        lastActivityAt TEXT NOT NULL DEFAULT '',
        sleepAfterMs   INTEGER NOT NULL DEFAULT 0,
        usage          TEXT NOT NULL DEFAULT '{}',
        limits         TEXT NOT NULL DEFAULT '{}',
        egressSpendCap REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS processes (
        sandboxId TEXT NOT NULL,
        procId    TEXT NOT NULL,
        pid       INTEGER NOT NULL,
        command   TEXT NOT NULL,
        status    TEXT NOT NULL,
        exitCode  INTEGER,
        startedAt TEXT NOT NULL,
        logPath   TEXT NOT NULL,
        PRIMARY KEY (sandboxId, procId)
      );
      CREATE TABLE IF NOT EXISTS exposed_ports (
        sandboxId TEXT NOT NULL,
        port      INTEGER NOT NULL,
        exposeId  TEXT NOT NULL,
        token     TEXT,
        createdAt TEXT NOT NULL,
        url       TEXT NOT NULL,
        PRIMARY KEY (sandboxId, port)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        sandboxId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        cwd       TEXT NOT NULL,
        env       TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (sandboxId, sessionId)
      );
      CREATE TABLE IF NOT EXISTS code_contexts (
        sandboxId TEXT NOT NULL,
        contextId TEXT NOT NULL,
        language  TEXT NOT NULL,
        dir       TEXT NOT NULL,
        procId    TEXT NOT NULL,
        pid       INTEGER NOT NULL,
        seq       INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (sandboxId, contextId)
      );
      CREATE TABLE IF NOT EXISTS egress_tokens (
        token     TEXT PRIMARY KEY,
        sandboxId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        policy    TEXT NOT NULL DEFAULT '{}',
        spendUsd  REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS templates (
        name            TEXT PRIMARY KEY,
        driver          TEXT NOT NULL,
        image           TEXT NOT NULL,
        limits          TEXT NOT NULL DEFAULT '{}',
        sourceSandboxId TEXT NOT NULL DEFAULT '',
        createdAt       TEXT NOT NULL,
        sizeBytes       INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Backfill columns added after the first release on databases created by an
    // older daemon (CREATE TABLE IF NOT EXISTS leaves existing tables untouched).
    this.ensureColumn("sandboxes", "lastActivityAt", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("sandboxes", "sleepAfterMs", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sandboxes", "usage", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("sandboxes", "limits", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("sandboxes", "egressSpendCap", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("sandboxes", "driver", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("sandboxes", "statusReason", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("egress_tokens", "policy", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("egress_tokens", "spendUsd", "REAL NOT NULL DEFAULT 0");
  }

  /** Add a column to a table if it isn't already present (idempotent migration). */
  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  /** Load all persisted rows into the in-memory cache on startup. */
  private hydrate(): void {
    for (const row of this.db.prepare("SELECT * FROM sandboxes").all() as any[]) {
      this.byId.set(row.id, rowToSandbox(row));
    }
    for (const row of this.db.prepare("SELECT * FROM processes").all() as any[]) {
      mapIn(this.procs, row.sandboxId).set(row.procId, rowToProcess(row));
    }
    for (const row of this.db.prepare("SELECT * FROM exposed_ports").all() as any[]) {
      const exposed = rowToExposed(row);
      mapIn(this.exposed, row.sandboxId).set(exposed.port, exposed);
      this.routes.set(exposed.exposeId, {
        sandboxId: row.sandboxId,
        port: exposed.port,
        token: exposed.token,
      });
    }
    for (const row of this.db.prepare("SELECT * FROM sessions").all() as any[]) {
      mapIn(this.sessions, row.sandboxId).set(row.sessionId, rowToSession(row));
    }
    for (const row of this.db.prepare("SELECT * FROM code_contexts").all() as any[]) {
      mapIn(this.contexts, row.sandboxId).set(row.contextId, rowToContext(row));
    }
    for (const row of this.db.prepare("SELECT * FROM egress_tokens").all() as any[]) {
      this.egressTokens.set(row.token, rowToEgressToken(row));
    }
    for (const row of this.db.prepare("SELECT * FROM templates").all() as any[]) {
      this.templates.set(row.name, rowToTemplate(row));
    }
  }

  static newId(): string {
    return randomBytes(6).toString("hex");
  }

  static newContextId(): string {
    return randomBytes(4).toString("hex");
  }

  static newProcId(): string {
    return randomBytes(4).toString("hex");
  }

  static newSessionId(): string {
    return randomBytes(4).toString("hex");
  }

  static newBackupId(): string {
    return randomBytes(6).toString("hex");
  }

  /** Mint an opaque per-sandbox egress token (used as the gateway's API key). */
  static newEgressToken(): string {
    return "hc-" + randomBytes(24).toString("hex");
  }

  // --- sandboxes -----------------------------------------------------------

  /** Insert or update a sandbox record (write-through; also use to persist
   * in-place edits to a record returned by `get`). */
  add(record: SandboxRecord): void {
    this.byId.set(record.id, record);
    this.db
      .prepare(
        `INSERT INTO sandboxes
           (id, image, status, statusReason, createdAt, driver, labels, env, persist, lastActivityAt, sleepAfterMs, usage, limits, egressSpendCap)
         VALUES
           ($id, $image, $status, $statusReason, $createdAt, $driver, $labels, $env, $persist, $lastActivityAt, $sleepAfterMs, $usage, $limits, $egressSpendCap)
         ON CONFLICT(id) DO UPDATE SET
           image=$image, status=$status, statusReason=$statusReason, createdAt=$createdAt, driver=$driver,
           labels=$labels, env=$env, persist=$persist,
           lastActivityAt=$lastActivityAt, sleepAfterMs=$sleepAfterMs, usage=$usage, limits=$limits,
           egressSpendCap=$egressSpendCap`,
      )
      .run({
        id: record.id,
        image: record.image,
        status: record.status,
        statusReason: record.statusReason ?? "",
        createdAt: record.createdAt,
        driver: record.driver ?? "",
        labels: JSON.stringify(record.labels),
        env: JSON.stringify(record.env),
        persist: record.persist ? 1 : 0,
        lastActivityAt: record.lastActivityAt,
        sleepAfterMs: record.sleepAfterMs,
        usage: JSON.stringify(record.usage),
        limits: JSON.stringify(record.limits ?? {}),
        egressSpendCap: record.egressSpendCapUsd ?? 0,
      });
  }

  /**
   * Persist updated cumulative usage for a sandbox (write-through). Cheap single
   * column used by the metrics sampler on every tick. No-op for an unknown id.
   */
  setUsage(id: string, usage: SandboxUsage): void {
    const rec = this.byId.get(id);
    if (!rec) return;
    rec.usage = usage;
    this.db
      .prepare("UPDATE sandboxes SET usage = ? WHERE id = ?")
      .run(JSON.stringify(usage), id);
  }

  /**
   * Add to a sandbox's cumulative egress byte counter (write-through). Called by
   * the preview proxy as connections close. No-op for an unknown id.
   */
  addEgress(id: string, bytes: number): void {
    const rec = this.byId.get(id);
    if (!rec || bytes <= 0) return;
    rec.usage.egressBytes += bytes;
    this.db
      .prepare("UPDATE sandboxes SET usage = ? WHERE id = ?")
      .run(JSON.stringify(rec.usage), id);
  }

  /**
   * Record one LLM-provider call's usage (write-through). Called by the egress
   * credential proxy as each provider response completes. No-op for unknown id.
   */
  addProviderUsage(id: string, delta: ProviderUsageDelta): void {
    const rec = this.byId.get(id);
    if (!rec) return;
    rec.usage.providerCalls += 1;
    rec.usage.providerBytes += Math.max(0, delta.bytes);
    rec.usage.providerTokensIn += Math.max(0, delta.tokensIn);
    rec.usage.providerTokensOut += Math.max(0, delta.tokensOut);
    rec.usage.providerCost += Math.max(0, delta.cost);
    this.db
      .prepare("UPDATE sandboxes SET usage = ? WHERE id = ?")
      .run(JSON.stringify(rec.usage), id);
  }

  // --- egress tokens -------------------------------------------------------

  /** Bind an egress token to a sandbox with an optional policy (write-through). */
  addEgressToken(token: string, sandboxId: string, policy: EgressPolicy = {}): void {
    const record: EgressTokenRecord = {
      token,
      sandboxId,
      policy,
      createdAt: new Date().toISOString(),
      spendUsd: 0,
    };
    this.egressTokens.set(token, record);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO egress_tokens (token, sandboxId, createdAt, policy, spendUsd) VALUES (?, ?, ?, ?, ?)",
      )
      .run(token, sandboxId, record.createdAt, JSON.stringify(policy), 0);
  }

  /** Resolve an egress token to its sandbox id (O(1)). Back-compat shorthand. */
  resolveEgressToken(token: string): string | undefined {
    return this.egressTokens.get(token)?.sandboxId;
  }

  /** Resolve an egress token to its full record (sandbox + policy + spend). */
  resolveEgressTokenFull(token: string): EgressTokenRecord | undefined {
    return this.egressTokens.get(token);
  }

  /** Add to a token's cumulative spend (write-through). Drives the spend cap. */
  addEgressTokenSpend(token: string, usd: number): void {
    const rec = this.egressTokens.get(token);
    if (!rec || !(usd > 0)) return;
    rec.spendUsd += usd;
    this.db
      .prepare("UPDATE egress_tokens SET spendUsd = ? WHERE token = ?")
      .run(rec.spendUsd, token);
  }

  /** List the egress token records minted for a sandbox. */
  listEgressTokens(sandboxId: string): EgressTokenRecord[] {
    return [...this.egressTokens.values()].filter((r) => r.sandboxId === sandboxId);
  }

  /** Revoke a single egress token. Returns whether it existed. */
  removeEgressToken(token: string): boolean {
    this.db.prepare("DELETE FROM egress_tokens WHERE token = ?").run(token);
    return this.egressTokens.delete(token);
  }

  /**
   * Mark a sandbox as just-active (refresh `lastActivityAt`). Cheap single-column
   * write-through used on every operation that runs work in the sandbox, so the
   * idle reaper sees recent use. No-op for an unknown id.
   */
  touch(id: string): void {
    const rec = this.byId.get(id);
    if (!rec) return;
    rec.lastActivityAt = new Date().toISOString();
    this.db
      .prepare("UPDATE sandboxes SET lastActivityAt = ? WHERE id = ?")
      .run(rec.lastActivityAt, id);
  }

  // ----- in-flight exec streams (memory-only) -----
  //
  // `touch` marks the MOMENT a request arrives, so a long-running exec looks
  // idle to the reaper while it is still streaming — which once let the reaper
  // SIGKILL an agent eleven minutes into its work. An open exec stream IS
  // activity; the reaper must ask, not infer from timestamps.

  /** Mark an exec stream as open on this sandbox. */
  beginExec(id: string): void {
    this.liveExecs.set(id, (this.liveExecs.get(id) ?? 0) + 1);
  }

  /** Mark an exec stream as closed; the idle clock restarts as the work ends. */
  endExec(id: string): void {
    const n = (this.liveExecs.get(id) ?? 0) - 1;
    if (n > 0) this.liveExecs.set(id, n);
    else this.liveExecs.delete(id);
    this.touch(id);
  }

  /** How many exec streams are open on this sandbox right now. */
  openExecs(id: string): number {
    return this.liveExecs.get(id) ?? 0;
  }

  get(id: string): SandboxRecord | undefined {
    return this.byId.get(id);
  }

  remove(id: string): boolean {
    this.db.prepare("DELETE FROM sandboxes WHERE id = ?").run(id);
    return this.byId.delete(id);
  }

  list(): SandboxRecord[] {
    return [...this.byId.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  // --- processes -----------------------------------------------------------

  /** Insert or update a background-process record (write-through). */
  addProcess(sandboxId: string, proc: ProcessInfo): void {
    mapIn(this.procs, sandboxId).set(proc.procId, proc);
    this.db
      .prepare(
        `INSERT INTO processes (sandboxId, procId, pid, command, status, exitCode, startedAt, logPath)
         VALUES ($sandboxId, $procId, $pid, $command, $status, $exitCode, $startedAt, $logPath)
         ON CONFLICT(sandboxId, procId) DO UPDATE SET
           pid=$pid, command=$command, status=$status, exitCode=$exitCode,
           startedAt=$startedAt, logPath=$logPath`,
      )
      .run({
        sandboxId,
        procId: proc.procId,
        pid: proc.pid,
        command: proc.command,
        status: proc.status,
        exitCode: proc.exitCode,
        startedAt: proc.startedAt,
        logPath: proc.logPath,
      });
  }

  getProcess(sandboxId: string, procId: string): ProcessInfo | undefined {
    return this.procs.get(sandboxId)?.get(procId);
  }

  listProcesses(sandboxId: string): ProcessInfo[] {
    return [...(this.procs.get(sandboxId)?.values() ?? [])].sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : -1,
    );
  }

  // --- exposed ports -------------------------------------------------------

  addExposed(sandboxId: string, exposed: ExposedPort): void {
    mapIn(this.exposed, sandboxId).set(exposed.port, exposed);
    this.routes.set(exposed.exposeId, {
      sandboxId,
      port: exposed.port,
      token: exposed.token,
    });
    this.db
      .prepare(
        `INSERT INTO exposed_ports (sandboxId, port, exposeId, token, createdAt, url)
         VALUES ($sandboxId, $port, $exposeId, $token, $createdAt, $url)
         ON CONFLICT(sandboxId, port) DO UPDATE SET
           exposeId=$exposeId, token=$token, createdAt=$createdAt, url=$url`,
      )
      .run({
        sandboxId,
        port: exposed.port,
        exposeId: exposed.exposeId,
        token: exposed.token,
        createdAt: exposed.createdAt,
        url: exposed.url,
      });
  }

  removeExposed(sandboxId: string, port: number): boolean {
    const map = this.exposed.get(sandboxId);
    const exposed = map?.get(port);
    if (!map || !exposed) return false;
    map.delete(port);
    this.routes.delete(exposed.exposeId);
    this.db
      .prepare("DELETE FROM exposed_ports WHERE sandboxId = ? AND port = ?")
      .run(sandboxId, port);
    return true;
  }

  listExposed(sandboxId: string): ExposedPort[] {
    return [...(this.exposed.get(sandboxId)?.values() ?? [])].sort(
      (a, b) => a.port - b.port,
    );
  }

  /** Resolve a preview route label (`<sandboxId>-<port>`) to its target. */
  resolveRoute(exposeId: string): RouteTarget | undefined {
    return this.routes.get(exposeId);
  }

  // --- sessions ------------------------------------------------------------

  /** Insert or update a session record (write-through; also use to persist
   * in-place edits to cwd/env on a session returned by `getSession`). */
  addSession(sandboxId: string, session: SessionInfo): void {
    mapIn(this.sessions, sandboxId).set(session.sessionId, session);
    this.db
      .prepare(
        `INSERT INTO sessions (sandboxId, sessionId, cwd, env, createdAt)
         VALUES ($sandboxId, $sessionId, $cwd, $env, $createdAt)
         ON CONFLICT(sandboxId, sessionId) DO UPDATE SET
           cwd=$cwd, env=$env, createdAt=$createdAt`,
      )
      .run({
        sandboxId,
        sessionId: session.sessionId,
        cwd: session.cwd,
        env: JSON.stringify(session.env),
        createdAt: session.createdAt,
      });
  }

  getSession(sandboxId: string, sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sandboxId)?.get(sessionId);
  }

  listSessions(sandboxId: string): SessionInfo[] {
    return [...(this.sessions.get(sandboxId)?.values() ?? [])].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  removeSession(sandboxId: string, sessionId: string): boolean {
    this.db
      .prepare("DELETE FROM sessions WHERE sandboxId = ? AND sessionId = ?")
      .run(sandboxId, sessionId);
    return this.sessions.get(sandboxId)?.delete(sessionId) ?? false;
  }

  // --- code contexts -------------------------------------------------------

  /** Insert or update a code-interpreter context record (write-through; also
   * use to persist the bumped `seq` after running a cell). */
  addContext(sandboxId: string, ctx: CodeContextInfo): void {
    mapIn(this.contexts, sandboxId).set(ctx.contextId, ctx);
    this.db
      .prepare(
        `INSERT INTO code_contexts (sandboxId, contextId, language, dir, procId, pid, seq, createdAt)
         VALUES ($sandboxId, $contextId, $language, $dir, $procId, $pid, $seq, $createdAt)
         ON CONFLICT(sandboxId, contextId) DO UPDATE SET
           language=$language, dir=$dir, procId=$procId, pid=$pid,
           seq=$seq, createdAt=$createdAt`,
      )
      .run({
        sandboxId,
        contextId: ctx.contextId,
        language: ctx.language,
        dir: ctx.dir,
        procId: ctx.procId,
        pid: ctx.pid,
        seq: ctx.seq,
        createdAt: ctx.createdAt,
      });
  }

  getContext(sandboxId: string, contextId: string): CodeContextInfo | undefined {
    return this.contexts.get(sandboxId)?.get(contextId);
  }

  listContexts(sandboxId: string): CodeContextInfo[] {
    return [...(this.contexts.get(sandboxId)?.values() ?? [])].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  removeContext(sandboxId: string, contextId: string): boolean {
    this.db
      .prepare("DELETE FROM code_contexts WHERE sandboxId = ? AND contextId = ?")
      .run(sandboxId, contextId);
    return this.contexts.get(sandboxId)?.delete(contextId) ?? false;
  }

  /** Drop all process + exposed-port + session + context + egress-token state for a destroyed sandbox. */
  clearSandbox(sandboxId: string): void {
    this.clearRuntimeState(sandboxId);
    this.sessions.delete(sandboxId);
    this.db.prepare("DELETE FROM sessions WHERE sandboxId = ?").run(sandboxId);
    for (const rec of this.listEgressTokens(sandboxId)) this.egressTokens.delete(rec.token);
    this.db.prepare("DELETE FROM egress_tokens WHERE sandboxId = ?").run(sandboxId);
  }

  /**
   * Drop the state tied to a live container — background processes, exposed
   * ports, and code-interpreter contexts (their kernels die with the
   * container) — when a sandbox is stopped. Sessions (just cwd/env strings) and
   * the sandbox record are kept so `start` resumes with them intact.
   */
  clearRuntimeState(sandboxId: string): void {
    this.procs.delete(sandboxId);
    this.contexts.delete(sandboxId);
    const ports = this.exposed.get(sandboxId);
    if (ports) {
      for (const exposed of ports.values()) this.routes.delete(exposed.exposeId);
      this.exposed.delete(sandboxId);
    }
    this.db.prepare("DELETE FROM processes WHERE sandboxId = ?").run(sandboxId);
    this.db.prepare("DELETE FROM code_contexts WHERE sandboxId = ?").run(sandboxId);
    this.db.prepare("DELETE FROM exposed_ports WHERE sandboxId = ?").run(sandboxId);
  }

  // --- templates -----------------------------------------------------------

  /** Insert or replace a template record (write-through). */
  addTemplate(record: TemplateRecord): void {
    this.templates.set(record.name, record);
    this.db
      .prepare(
        `INSERT INTO templates (name, driver, image, limits, sourceSandboxId, createdAt, sizeBytes)
         VALUES ($name, $driver, $image, $limits, $sourceSandboxId, $createdAt, $sizeBytes)
         ON CONFLICT(name) DO UPDATE SET
           driver=$driver, image=$image, limits=$limits,
           sourceSandboxId=$sourceSandboxId, createdAt=$createdAt, sizeBytes=$sizeBytes`,
      )
      .run({
        name: record.name,
        driver: record.driver,
        image: record.image,
        limits: JSON.stringify(record.limits ?? {}),
        sourceSandboxId: record.sourceSandboxId ?? "",
        createdAt: record.createdAt,
        sizeBytes: record.sizeBytes,
      });
  }

  getTemplate(name: string): TemplateRecord | undefined {
    return this.templates.get(name);
  }

  /** All templates, newest first. */
  listTemplates(): TemplateRecord[] {
    return [...this.templates.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  removeTemplate(name: string): boolean {
    this.db.prepare("DELETE FROM templates WHERE name = ?").run(name);
    return this.templates.delete(name);
  }
}

/** Get-or-create the inner per-sandbox map for a two-level cache. */
function mapIn<V>(outer: Map<string, Map<any, V>>, key: string): Map<any, V> {
  let inner = outer.get(key);
  if (!inner) {
    inner = new Map();
    outer.set(key, inner);
  }
  return inner;
}

function rowToTemplate(row: any): TemplateRecord {
  return {
    name: row.name,
    driver: row.driver,
    image: row.image,
    limits: parseJsonObject(row.limits),
    sourceSandboxId: row.sourceSandboxId || undefined,
    createdAt: row.createdAt,
    sizeBytes: row.sizeBytes ?? 0,
  };
}

function rowToSandbox(row: any): SandboxRecord {
  return {
    id: row.id,
    image: row.image,
    status: row.status,
    statusReason: row.statusReason || undefined,
    createdAt: row.createdAt,
    driver: row.driver || undefined,
    labels: JSON.parse(row.labels),
    env: JSON.parse(row.env),
    persist: row.persist === 1,
    lastActivityAt: row.lastActivityAt || row.createdAt,
    sleepAfterMs: row.sleepAfterMs ?? 0,
    limits: parseJsonObject(row.limits),
    egressSpendCapUsd: typeof row.egressSpendCap === "number" ? row.egressSpendCap : 0,
    usage: { ...emptyUsage(), ...parseUsage(row.usage) },
  };
}

function parseUsage(raw: unknown): Partial<SandboxUsage> {
  return parseJsonObject(raw);
}

/** Parse a JSON-object column, tolerating null/empty/malformed values. */
function parseJsonObject(raw: unknown): any {
  if (typeof raw !== "string" || !raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function rowToEgressToken(row: any): EgressTokenRecord {
  return {
    token: row.token,
    sandboxId: row.sandboxId,
    policy: parseJsonObject(row.policy) as EgressPolicy,
    createdAt: row.createdAt,
    spendUsd: typeof row.spendUsd === "number" ? row.spendUsd : 0,
  };
}

function rowToProcess(row: any): ProcessInfo {
  return {
    procId: row.procId,
    pid: row.pid,
    command: row.command,
    status: row.status,
    exitCode: row.exitCode,
    startedAt: row.startedAt,
    logPath: row.logPath,
  };
}

function rowToExposed(row: any): ExposedPort {
  return {
    port: row.port,
    exposeId: row.exposeId,
    token: row.token,
    createdAt: row.createdAt,
    url: row.url,
  };
}

function rowToSession(row: any): SessionInfo {
  return {
    sessionId: row.sessionId,
    cwd: row.cwd,
    env: JSON.parse(row.env),
    createdAt: row.createdAt,
  };
}

function rowToContext(row: any): CodeContextInfo {
  return {
    contextId: row.contextId,
    language: row.language,
    dir: row.dir,
    procId: row.procId,
    pid: row.pid,
    seq: row.seq,
    createdAt: row.createdAt,
  };
}
