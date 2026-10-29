/**
 * The hotcell HTTP API, defined once.
 *
 * This table is the single source of truth for the daemon's routes: `handle()`
 * dispatches through `matchRoute`, and `scripts/generate-api.mjs` emits the
 * OpenAPI document, the TypeScript route helpers, the Python route helpers and
 * the generated API section of `docs/reference.md` from it. Adding a capability
 * means adding an entry here plus its handler — not editing four hand-synced
 * layers.
 *
 * Path templates use `{name}` for a string segment and `{name:int}` for a
 * numeric one. `id` is the stable operation id (also the OpenAPI `operationId`).
 */

export type HttpMethod = "GET" | "POST" | "DELETE";

/** A JSON Schema fragment (draft 2020-12 subset used by the generator). */
export type JsonSchema = Record<string, unknown>;

export interface RouteDef {
  /** Stable operation id, e.g. `sandboxes.exec`. Also the OpenAPI operationId. */
  id: string;
  method: HttpMethod;
  /** Path template, e.g. `/sandboxes/{id}/exec`. */
  path: string;
  /** One-line human summary (OpenAPI `summary`). */
  summary: string;
  /** Grouping tag for the generated docs. */
  tag: string;
  /** Whether the route requires the API key when one is configured. */
  auth: boolean;
  /** Request body schema (routes that read a JSON body). */
  request?: JsonSchema;
  /** Success (2xx) response body schema. */
  response?: JsonSchema;
  /** Streaming response kind, when the route does not return a single JSON body. */
  stream?: "sse" | "websocket" | "html";
}

// --- shared schema fragments -------------------------------------------------

const string: JsonSchema = { type: "string" };
const number: JsonSchema = { type: "number" };
const integer: JsonSchema = { type: "integer" };
const boolean: JsonSchema = { type: "boolean" };
const stringMap: JsonSchema = { type: "object", additionalProperties: { type: "string" } };
const anyObject: JsonSchema = { type: "object", additionalProperties: true };

const errorBody: JsonSchema = {
  type: "object",
  properties: { error: string },
  required: ["error"],
};

const resourceLimits: JsonSchema = {
  type: "object",
  properties: { memoryMb: number, cpus: number, pidsLimit: number },
};

const sandboxUsage: JsonSchema = {
  type: "object",
  properties: {
    cpuSeconds: number,
    memByteSeconds: number,
    egressBytes: number,
    providerCalls: number,
    providerBytes: number,
    providerTokensIn: number,
    providerTokensOut: number,
    providerCost: number,
    lastCpuTotalNs: number,
    lastSampledAt: string,
  },
};

const sandboxRecord: JsonSchema = {
  type: "object",
  properties: {
    id: string,
    image: string,
    status: { type: "string", enum: ["creating", "running", "paused", "stopped", "error"] },
    statusReason: string,
    createdAt: string,
    driver: string,
    labels: stringMap,
    env: stringMap,
    persist: boolean,
    lastActivityAt: string,
    sleepAfterMs: number,
    limits: resourceLimits,
    egressSpendCapUsd: number,
    usage: sandboxUsage,
  },
  required: ["id", "image", "status", "createdAt", "labels", "env", "persist", "lastActivityAt", "sleepAfterMs", "limits", "usage"],
};

const templateRecord: JsonSchema = {
  type: "object",
  properties: {
    name: string,
    driver: string,
    image: string,
    limits: resourceLimits,
    sourceSandboxId: string,
    createdAt: string,
    sizeBytes: number,
  },
  required: ["name", "driver", "image", "limits", "createdAt", "sizeBytes"],
};

const fileInfo: JsonSchema = {
  type: "object",
  properties: {
    path: string,
    name: string,
    isDirectory: boolean,
    size: number,
    modifiedAt: string,
  },
  required: ["path", "name", "isDirectory", "size", "modifiedAt"],
};

const processInfo: JsonSchema = {
  type: "object",
  properties: {
    procId: string,
    pid: integer,
    command: string,
    status: { type: "string", enum: ["running", "exited"] },
    exitCode: { type: ["integer", "null"] },
    startedAt: string,
    logPath: string,
  },
  required: ["procId", "pid", "command", "status", "exitCode", "startedAt", "logPath"],
};

const sessionInfo: JsonSchema = {
  type: "object",
  properties: { sessionId: string, cwd: string, env: stringMap, createdAt: string },
  required: ["sessionId", "cwd", "env", "createdAt"],
};

const codeContextInfo: JsonSchema = {
  type: "object",
  properties: {
    contextId: string,
    language: { type: "string", enum: ["python", "javascript"] },
    createdAt: string,
  },
  required: ["contextId", "language", "createdAt"],
};

const codeResult: JsonSchema = {
  type: "object",
  properties: {
    stdout: string,
    stderr: string,
    results: {
      type: "array",
      items: {
        type: "object",
        properties: { type: { type: "string", enum: ["text"] }, text: string },
        required: ["type", "text"],
      },
    },
    error: { type: ["string", "null"] },
  },
  required: ["stdout", "stderr", "results", "error"],
};

const backupInfo: JsonSchema = {
  type: "object",
  properties: { backupId: string, sandboxId: string, createdAt: string, bytes: number },
  required: ["backupId", "sandboxId", "createdAt", "bytes"],
};

const exposedPort: JsonSchema = {
  type: "object",
  properties: {
    port: integer,
    exposeId: string,
    token: { type: ["string", "null"] },
    createdAt: string,
    url: string,
  },
  required: ["port", "exposeId", "token", "createdAt", "url"],
};

const metricSample: JsonSchema = {
  type: "object",
  properties: {
    at: string,
    cpuPercent: number,
    memBytes: number,
    netRxBytes: number,
    netTxBytes: number,
    pids: integer,
  },
  required: ["at", "cpuPercent", "memBytes", "netRxBytes", "netTxBytes", "pids"],
};

const egressPolicy: JsonSchema = {
  type: "object",
  properties: {
    providers: { type: "array", items: string },
    spendCapUsd: number,
    expiresAt: string,
    rateLimit: anyObject,
  },
};

const execEvent: JsonSchema = {
  oneOf: [
    { type: "object", properties: { type: { const: "stdout" }, data: string }, required: ["type", "data"] },
    { type: "object", properties: { type: { const: "stderr" }, data: string }, required: ["type", "data"] },
    { type: "object", properties: { type: { const: "exit" }, exitCode: integer }, required: ["type", "exitCode"] },
  ],
};

const fileChangeEvent: JsonSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["created", "modified", "deleted"] },
    path: string,
  },
  required: ["type", "path"],
};

// --- the table ---------------------------------------------------------------

export const ROUTES: readonly RouteDef[] = [
  {
    id: "healthz",
    method: "GET",
    path: "/healthz",
    summary: "Daemon health and active runtime driver",
    tag: "system",
    auth: false,
    response: {
      type: "object",
      properties: { ok: boolean, driver: string, version: string },
      required: ["ok", "driver"],
    },
  },
  {
    id: "info",
    method: "GET",
    path: "/info",
    summary: "Daemon metadata: drivers, default image, ports, providers, cost rates",
    tag: "system",
    auth: false,
    response: {
      type: "object",
      properties: {
        version: string,
        driver: string,
        drivers: { type: "array", items: string },
        defaultImage: string,
        proxyPort: integer,
        costCpuPerHour: number,
        costMemGbPerHour: number,
        costEgressPerGb: number,
        defaultSleepAfterMs: integer,
        auth: boolean,
        otlp: boolean,
        egressPort: integer,
        egressProviders: { type: "array", items: string },
        defaultMemoryMb: number,
        defaultCpus: number,
        defaultPidsLimit: number,
      },
      required: ["driver", "drivers", "defaultImage", "proxyPort", "auth"],
    },
  },
  {
    id: "capacity",
    method: "GET",
    path: "/capacity",
    summary: "Host capacity and admission status",
    tag: "system",
    auth: true,
    response: {
      type: "object",
      properties: {
        enforced: boolean,
        overcommit: number,
        defaultReservationMb: number,
        memory: {
          type: "object",
          properties: { budgetMb: number, committedMb: number, availableMb: number },
        },
        cpu: {
          type: "object",
          properties: { budget: number, committed: number, available: number },
        },
        running: integer,
        fits: integer,
        pool: {
          type: "object",
          properties: { spares: integer, reservedMb: number },
        },
        boot: anyObject,
      },
      required: ["enforced"],
    },
  },
  {
    id: "keys.reload",
    method: "POST",
    path: "/reload-keys",
    summary: "Hot-reload provider keys after `hotcell keys add/rm`",
    tag: "system",
    auth: true,
    response: {
      type: "object",
      properties: { ok: boolean, providers: integer },
      required: ["ok"],
    },
  },
  {
    id: "audit.events",
    method: "POST",
    path: "/audit-events",
    summary: "Record a client-side audit event (key import choices)",
    tag: "system",
    auth: true,
    request: {
      type: "object",
      properties: {
        event: { const: "keys.import" },
        choices: {
          type: "array",
          maxItems: 500,
          items: {
            type: "object",
            properties: {
              name: string,
              disposition: { type: "string", enum: ["gateway", "inject", "skip"] },
            },
            required: ["name", "disposition"],
          },
        },
      },
      required: ["event", "choices"],
    },
    response: {
      type: "object",
      properties: { accepted: boolean },
      required: ["accepted"],
    },
  },
  {
    id: "traces",
    method: "GET",
    path: "/traces",
    summary: "Recent finished spans, newest first",
    tag: "system",
    auth: true,
    response: {
      type: "object",
      properties: { spans: { type: "array", items: anyObject } },
      required: ["spans"],
    },
  },
  {
    id: "dashboard",
    method: "GET",
    path: "/",
    summary: "Embedded single-page dashboard",
    tag: "system",
    auth: false,
    stream: "html",
  },
  {
    id: "dashboard.alias",
    method: "GET",
    path: "/dashboard",
    summary: "Embedded single-page dashboard (alias)",
    tag: "system",
    auth: false,
    stream: "html",
  },

  // --- sandboxes -------------------------------------------------------------
  {
    id: "sandboxes.create",
    method: "POST",
    path: "/sandboxes",
    summary: "Create a sandbox",
    tag: "sandboxes",
    auth: true,
    request: {
      type: "object",
      properties: {
        image: string,
        driver: string,
        template: string,
        repo: string,
        repoRef: string,
        branch: string,
        setup: { type: "array", items: string },
        env: stringMap,
        labels: stringMap,
        persist: boolean,
        sleepAfter: integer,
        networked: boolean,
        writableRootfs: boolean,
        cpuset: string,
        memoryMb: number,
        cpus: number,
        pidsLimit: number,
        egress: { oneOf: [boolean, egressPolicy] },
        detach: boolean,
      },
    },
    response: sandboxRecord,
  },
  {
    id: "sandboxes.list",
    method: "GET",
    path: "/sandboxes",
    summary: "List sandboxes",
    tag: "sandboxes",
    auth: true,
    response: {
      type: "object",
      properties: { sandboxes: { type: "array", items: sandboxRecord } },
      required: ["sandboxes"],
    },
  },
  {
    id: "sandboxes.get",
    method: "GET",
    path: "/sandboxes/{id}",
    summary: "Get a sandbox record",
    tag: "sandboxes",
    auth: true,
    response: sandboxRecord,
  },
  {
    id: "sandboxes.destroy",
    method: "DELETE",
    path: "/sandboxes/{id}",
    summary: "Destroy a sandbox",
    tag: "sandboxes",
    auth: true,
    response: {
      type: "object",
      properties: { id: string, destroyed: boolean },
      required: ["id", "destroyed"],
    },
  },
  {
    id: "sandboxes.stop",
    method: "POST",
    path: "/sandboxes/{id}/stop",
    summary: "Stop a sandbox (workspace volume persists)",
    tag: "sandboxes",
    auth: true,
    response: sandboxRecord,
  },
  {
    id: "sandboxes.pause",
    method: "POST",
    path: "/sandboxes/{id}/pause",
    summary: "Pause a sandbox",
    tag: "sandboxes",
    auth: true,
    response: sandboxRecord,
  },
  {
    id: "sandboxes.start",
    method: "POST",
    path: "/sandboxes/{id}/start",
    summary: "Start a stopped sandbox",
    tag: "sandboxes",
    auth: true,
    response: sandboxRecord,
  },
  {
    id: "sandboxes.exec",
    method: "POST",
    path: "/sandboxes/{id}/exec",
    summary: "Run a shell command, streaming output as SSE",
    tag: "exec",
    auth: true,
    request: {
      type: "object",
      properties: { command: string, cwd: string, env: stringMap, sessionId: string },
      required: ["command"],
    },
    stream: "sse",
    response: execEvent,
  },
  {
    id: "sandboxes.terminal",
    method: "GET",
    path: "/sandboxes/{id}/terminal",
    summary: "Interactive PTY over a WebSocket upgrade",
    tag: "exec",
    auth: true,
    stream: "websocket",
  },
  {
    id: "sandboxes.run-code",
    method: "POST",
    path: "/sandboxes/{id}/run-code",
    summary: "Run a code cell in a persistent interpreter context",
    tag: "exec",
    auth: true,
    request: {
      type: "object",
      properties: {
        code: string,
        language: { type: "string", enum: ["python", "javascript"] },
        contextId: string,
      },
      required: ["code"],
    },
    response: codeResult,
  },

  // --- files -----------------------------------------------------------------
  {
    id: "sandboxes.files.write",
    method: "POST",
    path: "/sandboxes/{id}/files/write",
    summary: "Write a file",
    tag: "files",
    auth: true,
    request: {
      type: "object",
      properties: { path: string, content: string, mode: string },
      required: ["path", "content"],
    },
    response: anyObject,
  },
  {
    id: "sandboxes.files.read",
    method: "POST",
    path: "/sandboxes/{id}/files/read",
    summary: "Read a file",
    tag: "files",
    auth: true,
    request: {
      type: "object",
      properties: { path: string },
      required: ["path"],
    },
    response: { type: "object", properties: { content: string }, required: ["content"] },
  },
  {
    id: "sandboxes.files.mkdir",
    method: "POST",
    path: "/sandboxes/{id}/files/mkdir",
    summary: "Create a directory",
    tag: "files",
    auth: true,
    request: {
      type: "object",
      properties: { path: string, parents: boolean },
      required: ["path"],
    },
    response: anyObject,
  },
  {
    id: "sandboxes.files.list",
    method: "POST",
    path: "/sandboxes/{id}/files/list",
    summary: "List a directory",
    tag: "files",
    auth: true,
    request: {
      type: "object",
      properties: { path: string },
      required: ["path"],
    },
    response: {
      type: "object",
      properties: { files: { type: "array", items: fileInfo } },
      required: ["files"],
    },
  },
  {
    id: "sandboxes.watch",
    method: "GET",
    path: "/sandboxes/{id}/watch",
    summary: "Watch a path for filesystem changes (SSE)",
    tag: "files",
    auth: true,
    stream: "sse",
    response: fileChangeEvent,
  },

  // --- processes -------------------------------------------------------------
  {
    id: "sandboxes.processes.start",
    method: "POST",
    path: "/sandboxes/{id}/processes",
    summary: "Start a background process",
    tag: "processes",
    auth: true,
    request: {
      type: "object",
      properties: { command: string, cwd: string, env: stringMap },
      required: ["command"],
    },
    response: processInfo,
  },
  {
    id: "sandboxes.processes.list",
    method: "GET",
    path: "/sandboxes/{id}/processes",
    summary: "List background processes",
    tag: "processes",
    auth: true,
    response: {
      type: "object",
      properties: { processes: { type: "array", items: processInfo } },
      required: ["processes"],
    },
  },
  {
    id: "sandboxes.processes.kill",
    method: "DELETE",
    path: "/sandboxes/{id}/processes/{procId}",
    summary: "Kill a background process",
    tag: "processes",
    auth: true,
    request: {
      type: "object",
      properties: { signal: string },
    },
    response: anyObject,
  },
  {
    id: "sandboxes.processes.logs",
    method: "GET",
    path: "/sandboxes/{id}/processes/{procId}/logs",
    summary: "Stream a process logfile (SSE)",
    tag: "processes",
    auth: true,
    stream: "sse",
    response: {
      oneOf: [
        { type: "object", properties: { type: { const: "log" }, data: string }, required: ["type", "data"] },
        { type: "object", properties: { type: { const: "end" } }, required: ["type"] },
      ],
    },
  },

  // --- networking ------------------------------------------------------------
  {
    id: "sandboxes.wait-port",
    method: "POST",
    path: "/sandboxes/{id}/wait-port",
    summary: "Wait until a TCP port is listening inside the sandbox",
    tag: "networking",
    auth: true,
    request: {
      type: "object",
      properties: { port: integer, host: string, timeoutMs: integer, intervalMs: integer },
      required: ["port"],
    },
    response: { type: "object", properties: { ok: boolean }, required: ["ok"] },
  },
  {
    id: "sandboxes.expose.create",
    method: "POST",
    path: "/sandboxes/{id}/expose",
    summary: "Expose a port through the preview proxy",
    tag: "networking",
    auth: true,
    request: {
      type: "object",
      properties: { port: integer, token: string },
      required: ["port"],
    },
    response: exposedPort,
  },
  {
    id: "sandboxes.expose.list",
    method: "GET",
    path: "/sandboxes/{id}/expose",
    summary: "List exposed ports",
    tag: "networking",
    auth: true,
    response: {
      type: "object",
      properties: { exposed: { type: "array", items: exposedPort } },
      required: ["exposed"],
    },
  },
  {
    id: "sandboxes.expose.remove",
    method: "DELETE",
    path: "/sandboxes/{id}/expose/{port:int}",
    summary: "Stop exposing a port",
    tag: "networking",
    auth: true,
    response: anyObject,
  },

  // --- env + sessions --------------------------------------------------------
  {
    id: "sandboxes.env.get",
    method: "GET",
    path: "/sandboxes/{id}/env",
    summary: "Get sandbox-level environment variables",
    tag: "sessions",
    auth: true,
    response: { type: "object", properties: { env: stringMap }, required: ["env"] },
  },
  {
    id: "sandboxes.env.set",
    method: "POST",
    path: "/sandboxes/{id}/env",
    summary: "Merge sandbox-level environment variables",
    tag: "sessions",
    auth: true,
    request: {
      type: "object",
      properties: { env: stringMap },
      required: ["env"],
    },
    response: { type: "object", properties: { env: stringMap }, required: ["env"] },
  },
  {
    id: "sandboxes.sessions.create",
    method: "POST",
    path: "/sandboxes/{id}/sessions",
    summary: "Create an execution session (cwd + env)",
    tag: "sessions",
    auth: true,
    request: {
      type: "object",
      properties: { id: string, cwd: string, env: stringMap },
    },
    response: sessionInfo,
  },
  {
    id: "sandboxes.sessions.list",
    method: "GET",
    path: "/sandboxes/{id}/sessions",
    summary: "List sessions",
    tag: "sessions",
    auth: true,
    response: {
      type: "object",
      properties: { sessions: { type: "array", items: sessionInfo } },
      required: ["sessions"],
    },
  },
  {
    id: "sandboxes.sessions.delete",
    method: "DELETE",
    path: "/sandboxes/{id}/sessions/{sessionId}",
    summary: "Delete a session",
    tag: "sessions",
    auth: true,
    response: anyObject,
  },
  {
    id: "sandboxes.sessions.env",
    method: "POST",
    path: "/sandboxes/{id}/sessions/{sessionId}/env",
    summary: "Merge session-level environment variables",
    tag: "sessions",
    auth: true,
    request: {
      type: "object",
      properties: { env: stringMap },
      required: ["env"],
    },
    response: sessionInfo,
  },

  // --- code contexts ---------------------------------------------------------
  {
    id: "sandboxes.code-contexts.create",
    method: "POST",
    path: "/sandboxes/{id}/code-contexts",
    summary: "Create a persistent code-interpreter context",
    tag: "code",
    auth: true,
    request: {
      type: "object",
      properties: { language: { type: "string", enum: ["python", "javascript"] } },
    },
    response: codeContextInfo,
  },
  {
    id: "sandboxes.code-contexts.list",
    method: "GET",
    path: "/sandboxes/{id}/code-contexts",
    summary: "List code contexts",
    tag: "code",
    auth: true,
    response: {
      type: "object",
      properties: { contexts: { type: "array", items: codeContextInfo } },
      required: ["contexts"],
    },
  },
  {
    id: "sandboxes.code-contexts.delete",
    method: "DELETE",
    path: "/sandboxes/{id}/code-contexts/{contextId}",
    summary: "Delete a code context",
    tag: "code",
    auth: true,
    response: anyObject,
  },

  // --- metrics ---------------------------------------------------------------
  {
    id: "sandboxes.metrics",
    method: "GET",
    path: "/sandboxes/{id}/metrics",
    summary: "Live resource metrics for a sandbox",
    tag: "metrics",
    auth: true,
    response: anyObject,
  },
  {
    id: "sandboxes.metrics.history",
    method: "GET",
    path: "/sandboxes/{id}/metrics/history",
    summary: "Sampled metrics history",
    tag: "metrics",
    auth: true,
    response: {
      type: "object",
      properties: { samples: { type: "array", items: metricSample } },
      required: ["samples"],
    },
  },

  // --- backups ---------------------------------------------------------------
  {
    id: "backups.list",
    method: "GET",
    path: "/backups",
    summary: "List all workspace backups",
    tag: "backups",
    auth: true,
    response: {
      type: "object",
      properties: { backups: { type: "array", items: backupInfo } },
      required: ["backups"],
    },
  },
  {
    id: "backups.delete",
    method: "DELETE",
    path: "/backups/{backupId}",
    summary: "Delete a backup",
    tag: "backups",
    auth: true,
    response: {
      type: "object",
      properties: { backupId: string, deleted: boolean },
      required: ["backupId", "deleted"],
    },
  },
  {
    id: "sandboxes.backups.create",
    method: "POST",
    path: "/sandboxes/{id}/backups",
    summary: "Back up a sandbox workspace",
    tag: "backups",
    auth: true,
    response: backupInfo,
  },
  {
    id: "sandboxes.backups.list",
    method: "GET",
    path: "/sandboxes/{id}/backups",
    summary: "List a sandbox's backups",
    tag: "backups",
    auth: true,
    response: {
      type: "object",
      properties: { backups: { type: "array", items: backupInfo } },
      required: ["backups"],
    },
  },
  {
    id: "sandboxes.restore",
    method: "POST",
    path: "/sandboxes/{id}/restore",
    summary: "Restore a backup into a sandbox",
    tag: "backups",
    auth: true,
    request: {
      type: "object",
      properties: { backupId: string },
      required: ["backupId"],
    },
    response: anyObject,
  },

  // --- templates -------------------------------------------------------------
  {
    id: "templates.list",
    method: "GET",
    path: "/templates",
    summary: "List captured microVM templates",
    tag: "templates",
    auth: true,
    response: {
      type: "object",
      properties: { templates: { type: "array", items: templateRecord } },
      required: ["templates"],
    },
  },
  {
    id: "templates.create",
    method: "POST",
    path: "/templates",
    summary: "Capture a running sandbox as a template",
    tag: "templates",
    auth: true,
    request: {
      type: "object",
      properties: { name: string, from: string },
      required: ["name", "from"],
    },
    response: templateRecord,
  },
  {
    id: "templates.delete",
    method: "DELETE",
    path: "/templates/{name}",
    summary: "Delete a template and its snapshot",
    tag: "templates",
    auth: true,
    response: anyObject,
  },

  // --- egress tokens ---------------------------------------------------------
  {
    id: "egress-tokens.create",
    method: "POST",
    path: "/sandboxes/{id}/egress-tokens",
    summary: "Mint an egress-gateway token",
    tag: "egress",
    auth: true,
    request: egressPolicy,
    response: {
      type: "object",
      properties: {
        token: string,
        policy: egressPolicy,
        providers: { type: "array", items: anyObject },
      },
      required: ["token", "policy", "providers"],
    },
  },
  {
    id: "egress-tokens.list",
    method: "GET",
    path: "/sandboxes/{id}/egress-tokens",
    summary: "List egress-gateway tokens",
    tag: "egress",
    auth: true,
    response: {
      type: "object",
      properties: {
        tokens: {
          type: "array",
          items: {
            type: "object",
            properties: {
              token: string,
              policy: egressPolicy,
              spendUsd: number,
              spendRemaining: { type: ["number", "null"] },
            },
            required: ["token", "policy", "spendUsd", "spendRemaining"],
          },
        },
        providers: { type: "array", items: anyObject },
      },
      required: ["tokens", "providers"],
    },
  },
  {
    id: "egress-tokens.revoke",
    method: "DELETE",
    path: "/sandboxes/{id}/egress-tokens/{token}",
    summary: "Revoke an egress-gateway token",
    tag: "egress",
    auth: true,
    response: {
      type: "object",
      properties: { token: string, revoked: boolean },
      required: ["token", "revoked"],
    },
  },
];

// --- matching ----------------------------------------------------------------

export type RouteId = (typeof ROUTES)[number]["id"];

export interface RouteMatch {
  route: RouteDef;
  params: Record<string, string>;
}

interface CompiledRoute {
  route: RouteDef;
  regex: RegExp;
  names: string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(route: RouteDef): CompiledRoute {
  const names: string[] = [];
  let pattern = "";
  let cursor = 0;
  for (;;) {
    const open = route.path.indexOf("{", cursor);
    if (open === -1) {
      pattern += escapeRegex(route.path.slice(cursor));
      break;
    }
    pattern += escapeRegex(route.path.slice(cursor, open));
    const close = route.path.indexOf("}", open);
    if (close === -1) throw new Error(`unclosed path param in route "${route.id}"`);
    const [name, type] = route.path.slice(open + 1, close).split(":");
    names.push(name);
    pattern += type === "int" ? "(\\d+)" : "([^/]+)";
    cursor = close + 1;
  }
  return { route, regex: new RegExp(`^${pattern}$`), names };
}

// Literal routes win over parameterised ones with the same segment count, so a
// future `/sandboxes/{id}/files/{action}` can never shadow `/files/write`.
const COMPILED: readonly CompiledRoute[] = ROUTES.map(compile).sort((a, b) => {
  if (a.names.length !== b.names.length) return a.names.length - b.names.length;
  return b.route.path.length - a.route.path.length;
});

const BY_ID = new Map<string, RouteDef>(ROUTES.map((route) => [route.id, route]));

/** Resolve a method + concrete path to a route and its path params. */
export function matchRoute(method: string, path: string): RouteMatch | undefined {
  for (const compiled of COMPILED) {
    if (compiled.route.method !== method) continue;
    const match = compiled.regex.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    compiled.names.forEach((name, index) => {
      params[name] = match[index + 1];
    });
    return { route: compiled.route, params };
  }
  return undefined;
}

/** Resolve a concrete path to a route regardless of method (for span names). */
export function matchPath(path: string): RouteDef | undefined {
  for (const compiled of COMPILED) {
    if (compiled.regex.test(path)) return compiled.route;
  }
  return undefined;
}

/** Look up a route by its stable id. Throws on an unknown id. */
export function routeById(id: string): RouteDef {
  const route = BY_ID.get(id);
  if (!route) throw new Error(`unknown route id "${id}"`);
  return route;
}

/** Build a concrete path for a route id, URL-encoding each param. */
export function buildPath(id: string, params: Record<string, string | number> = {}): string {
  const route = routeById(id);
  return route.path.replace(/\{([^}:]+)(?::[a-z]+)?\}/g, (_whole, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`missing path param "${name}" for route "${id}"`);
    }
    return encodeURIComponent(String(value));
  });
}

/** The path params a route expects, in template order. */
export function routeParams(route: RouteDef): string[] {
  return [...route.path.matchAll(/\{([^}:]+)(?::[a-z]+)?\}/g)].map((m) => m[1]);
}

