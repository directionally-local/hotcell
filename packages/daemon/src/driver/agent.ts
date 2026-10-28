import { connect, type Socket } from "node:net";
import { Duplex } from "node:stream";
import type { ExecEvent, FileChangeEvent, FileInfo } from "../types.js";

/**
 * Host-side client for the in-sandbox `sbx-agent` wire protocol (see `agent/proto`).
 * One `AgentConn` wraps a single byte stream to the agent — a unix socket, a
 * loopback TCP connection for container hosts that cannot forward bind-mounted
 * sockets, or a vsock-relayed unix socket in production — and multiplexes
 * concurrent requests over it by `streamId`, exactly
 * as the Go server expects.
 *
 * Frame: `[u32 length BE][u8 type][u32 streamId BE][payload]`. The agent sends an
 * unsolicited Hello (Control on stream 0) on connect; `connect()` resolves once
 * it arrives, so the caller knows the guest is up and serving.
 */

const FRAME = {
  Control: 1,
  Stdin: 2,
  Stdout: 3,
  Stderr: 4,
  EOF: 5,
  Result: 6,
  Close: 7,
} as const;

const HEADER = 9;
const AGENT_AUTH_PREFIX = "HOTCELL/1 ";
const AGENT_AUTH_ACCEPTED = "HOTCELL/1 OK\n";

export interface AgentHello {
  event: string;
  agent: string;
  version: string;
  proto: number;
}

interface AgentResult {
  ok: boolean;
  error?: string;
  exitCode?: number;
  value?: unknown;
}

interface Pending {
  onStdout?: (b: Buffer) => void;
  onStderr?: (b: Buffer) => void;
  resolve: (r: AgentResult) => void;
  reject: (e: Error) => void;
}

export class AgentConn {
  private socket: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private nextStreamId = 1; // 0 is reserved for the agent's Hello
  private pending = new Map<number, Pending>();
  hello?: AgentHello;

  private constructor(socket: Socket) {
    this.socket = socket;
  }

  /** Connect to the agent (via the helper's unix socket, or a test socket) and
   *  resolve once the Hello greeting arrives. */
  static connect(opts: { path: string; timeoutMs?: number }): Promise<AgentConn> {
    return new Promise((resolve, reject) => {
      const socket = connect(opts.path);
      const conn = new AgentConn(socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`agent connect timed out (${opts.path})`));
      }, opts.timeoutMs ?? 10000);

      conn.onHello = (hello) => {
        clearTimeout(timer);
        conn.hello = hello;
        resolve(conn);
      };
      socket.on("data", (d) => conn.feed(d));
      socket.on("error", (e) => {
        clearTimeout(timer);
        conn.failAll(e);
        reject(e);
      });
      socket.on("close", () => conn.failAll(new Error("agent connection closed")));
    });
  }

  /** Connect to a TCP agent using the container's per-sandbox transport token. */
  static connectTcp(opts: {
    host: string;
    port: number;
    token: string;
    timeoutMs?: number;
  }): Promise<AgentConn> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: opts.host, port: opts.port });
      const timeoutMs = opts.timeoutMs ?? 10000;
      let buffer: Buffer = Buffer.alloc(0);
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket.off("data", onData);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.destroy();
        reject(err);
      };
      const onError = (err: Error) => fail(err);
      const onClose = () => fail(new Error("agent TCP connection closed during authentication"));
      const onConnect = () => socket.write(`${AGENT_AUTH_PREFIX}${opts.token}\n`);
      const onData = (chunk: Buffer) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) {
          if (buffer.length > 256) fail(new Error("agent TCP authentication response is too large"));
          return;
        }
        const response = buffer.subarray(0, newline + 1).toString("utf8");
        if (response !== AGENT_AUTH_ACCEPTED) {
          fail(new Error(`agent TCP authentication failed: ${response.trim()}`));
          return;
        }
        const leftover = buffer.subarray(newline + 1);
        settled = true;
        if (timer) clearTimeout(timer);
        socket.off("data", onData);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
        AgentConn.attach(socket, leftover, timeoutMs).then(resolve, reject);
      };
      timer = setTimeout(
        () => fail(new Error(`agent TCP authentication timed out (${opts.host}:${opts.port})`)),
        timeoutMs,
      );
      socket.on("data", onData);
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  /**
   * Wrap an already-connected byte stream (e.g. a Firecracker vsock socket after
   * its `CONNECT` handshake) and resolve once the agent's Hello arrives. `leftover`
   * is any bytes that arrived with the handshake reply but belong to the agent
   * stream (possibly the Hello itself), fed in before live data.
   */
  static attach(socket: Socket, leftover?: Buffer, timeoutMs = 10000): Promise<AgentConn> {
    return new Promise((resolve, reject) => {
      const conn = new AgentConn(socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("agent hello timed out"));
      }, timeoutMs);
      conn.onHello = (hello) => {
        clearTimeout(timer);
        conn.hello = hello;
        resolve(conn);
      };
      socket.on("data", (d) => conn.feed(d));
      socket.on("error", (e) => {
        clearTimeout(timer);
        conn.failAll(e);
        reject(e);
      });
      socket.on("close", () => conn.failAll(new Error("agent connection closed")));
      if (leftover && leftover.length) conn.feed(leftover);
    });
  }

  private onHello?: (h: AgentHello) => void;

  /** Accumulate bytes and dispatch whole frames. */
  private feed(data: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    while (this.buf.length >= HEADER) {
      const length = this.buf.readUInt32BE(0);
      if (this.buf.length < HEADER + length) break;
      const type = this.buf[4]!;
      const streamId = this.buf.readUInt32BE(5);
      const payload = this.buf.subarray(HEADER, HEADER + length);
      this.handleFrame(type, streamId, payload);
      this.buf = this.buf.subarray(HEADER + length);
    }
  }

  private handleFrame(type: number, streamId: number, payload: Buffer): void {
    if (streamId === 0 && type === FRAME.Control) {
      try {
        this.onHello?.(JSON.parse(payload.toString("utf8")) as AgentHello);
      } catch {
        /* ignore a malformed hello */
      }
      return;
    }
    const p = this.pending.get(streamId);
    if (!p) return;
    switch (type) {
      case FRAME.Stdout:
        p.onStdout?.(Buffer.from(payload));
        break;
      case FRAME.Stderr:
        p.onStderr?.(Buffer.from(payload));
        break;
      case FRAME.Result: {
        this.pending.delete(streamId);
        let r: AgentResult;
        try {
          r = JSON.parse(payload.toString("utf8")) as AgentResult;
        } catch (e) {
          return p.reject(new Error(`bad result json: ${String(e)}`));
        }
        if (!r.ok) p.reject(new Error(r.error || "agent error"));
        else p.resolve(r);
        break;
      }
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private writeFrame(type: number, streamId: number, payload: Buffer): void {
    const hdr = Buffer.allocUnsafe(HEADER);
    hdr.writeUInt32BE(payload.length, 0);
    hdr[4] = type;
    hdr.writeUInt32BE(streamId, 5);
    this.socket.write(hdr);
    if (payload.length) this.socket.write(payload);
  }

  /** Send a Control request on a fresh stream; resolve on its Result frame. */
  private request(
    req: Record<string, unknown>,
    handlers?: { onStdout?: (b: Buffer) => void; onStderr?: (b: Buffer) => void },
  ): { streamId: number; done: Promise<AgentResult> } {
    const streamId = this.nextStreamId++;
    const done = new Promise<AgentResult>((resolve, reject) => {
      this.pending.set(streamId, { resolve, reject, ...handlers });
    });
    this.writeFrame(FRAME.Control, streamId, Buffer.from(JSON.stringify(req), "utf8"));
    return { streamId, done };
  }

  // --- Driver-surface RPCs --------------------------------------------------

  /** Run a command, streaming stdout/stderr and the terminal exit event. */
  async exec(
    command: string,
    opts: { cwd?: string; env?: Record<string, string> },
    onEvent: (e: ExecEvent) => void,
  ): Promise<number> {
    const { done } = this.request(
      { method: "exec", command, cwd: opts.cwd, env: opts.env },
      {
        onStdout: (b) => onEvent({ type: "stdout", data: b.toString("utf8") }),
        onStderr: (b) => onEvent({ type: "stderr", data: b.toString("utf8") }),
      },
    );
    const r = await done;
    const exitCode = r.exitCode ?? 0;
    onEvent({ type: "exit", exitCode });
    return exitCode;
  }

  async writeFile(path: string, content: string, mode?: string): Promise<void> {
    await this.request({ method: "writeFile", path, content, mode }).done;
  }

  async readFile(path: string): Promise<string> {
    const r = await this.request({ method: "readFile", path }).done;
    return String(r.value ?? "");
  }

  async mkdir(path: string, parents = true): Promise<void> {
    await this.request({ method: "mkdir", path, parents }).done;
  }

  async listFiles(path: string): Promise<FileInfo[]> {
    const r = await this.request({ method: "listFiles", path }).done;
    return (r.value as FileInfo[]) ?? [];
  }

  async waitForPort(port: number, opts: { host?: string; timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
    const r = await this.request({
      method: "waitForPort",
      port,
      host: opts.host,
      timeoutMs: opts.timeoutMs,
      intervalMs: opts.intervalMs,
    }).done;
    return Boolean(r.value);
  }

  async setEnv(env: Record<string, string>): Promise<void> {
    await this.request({ method: "setEnv", env }).done;
  }

  /** Start the in-guest loopback→vsock egress relay (idempotent per port): the
   *  agent listens on 127.0.0.1:`port` and forwards each connection over vsock
   *  to the host, which relays it to the egress gateway. */
  async egressListen(port: number, vsockPort?: number): Promise<void> {
    await this.request({ method: "egressListen", port, vsockPort }).done;
  }

  /**
   * Watch `path` recursively, invoking `onEvent` per change until `signal`
   * aborts (which sends a Close frame; the agent stops and replies Result).
   * The agent streams `<type>\t<path>` lines as Stdout frames.
   */
  async watch(
    path: string,
    intervalMs: number,
    signal: AbortSignal,
    onEvent: (e: FileChangeEvent) => void,
  ): Promise<void> {
    const streamId = this.nextStreamId++;
    let lineBuf = "";
    const parse = (b: Buffer): void => {
      lineBuf += b.toString("utf8");
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        const tab = line.indexOf("\t");
        if (tab === -1) continue;
        const type = line.slice(0, tab);
        if (type === "created" || type === "modified" || type === "deleted") {
          onEvent({ type, path: line.slice(tab + 1) });
        }
      }
    };
    await new Promise<void>((resolve, reject) => {
      this.pending.set(streamId, { onStdout: parse, resolve: () => resolve(), reject });
      // Open the watch stream first, then arm cancellation, so the Control frame
      // always precedes any Close frame.
      this.writeFrame(
        FRAME.Control,
        streamId,
        Buffer.from(JSON.stringify({ method: "watch", path, intervalMs }), "utf8"),
      );
      const onAbort = (): void => {
        if (this.pending.has(streamId)) this.writeFrame(FRAME.Close, streamId, Buffer.alloc(0));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Open a bidirectional stream for a method that bridges raw bytes (tcpConnect /
   * pty): writes become Stdin frames host→guest, guest Stdout frames become
   * readable data, the terminal Result frame ends the readable side, and
   * destroying the Duplex sends a Close frame. Returns a Node Duplex the caller
   * (preview proxy / terminal WS) pipes like any socket.
   */
  openStream(req: Record<string, unknown>): { stream: Duplex; streamId: number } {
    const streamId = this.nextStreamId++;
    const writeFrame = this.writeFrame.bind(this);
    const pending = this.pending;
    const duplex = new Duplex({
      write(chunk, _enc, cb) {
        writeFrame(FRAME.Stdin, streamId, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
      read() {
        /* data is pushed as Stdout frames arrive */
      },
      destroy(err, cb) {
        if (pending.has(streamId)) {
          writeFrame(FRAME.Close, streamId, Buffer.alloc(0));
          pending.delete(streamId);
        }
        cb(err);
      },
    });
    this.pending.set(streamId, {
      onStdout: (b) => duplex.push(b),
      onStderr: (b) => duplex.push(b),
      resolve: () => duplex.push(null), // Result frame → readable EOF
      reject: (e) => duplex.destroy(e),
    });
    this.writeFrame(FRAME.Control, streamId, Buffer.from(JSON.stringify(req), "utf8"));
    return { stream: duplex, streamId };
  }

  /**
   * Receive a guest→host byte stream for `req` (e.g. tarWorkspace): each Stdout
   * frame's raw bytes are handed to `onChunk` (binary-safe — Buffers, no UTF-8
   * decode), and the promise resolves on the terminal Result (rejects on error).
   */
  async readStream(req: Record<string, unknown>, onChunk: (b: Buffer) => void): Promise<void> {
    const streamId = this.nextStreamId++;
    await new Promise<void>((resolve, reject) => {
      this.pending.set(streamId, { onStdout: onChunk, resolve: () => resolve(), reject });
      this.writeFrame(FRAME.Control, streamId, Buffer.from(JSON.stringify(req), "utf8"));
    });
  }

  /**
   * Send a host→guest byte stream for `req` (e.g. untarWorkspace): write payload
   * chunks with `write`, signal end-of-input with `end`, and await `done` for the
   * terminal Result. Bytes go as raw Stdin frames; EOF as an EOF frame.
   */
  writeStream(req: Record<string, unknown>): {
    write: (b: Buffer) => void;
    end: () => void;
    done: Promise<void>;
  } {
    const streamId = this.nextStreamId++;
    const done = new Promise<void>((resolve, reject) => {
      this.pending.set(streamId, { resolve: () => resolve(), reject });
    });
    this.writeFrame(FRAME.Control, streamId, Buffer.from(JSON.stringify(req), "utf8"));
    return {
      write: (b) => this.writeFrame(FRAME.Stdin, streamId, b),
      end: () => this.writeFrame(FRAME.EOF, streamId, Buffer.alloc(0)),
      done,
    };
  }

  /** Send a control message (e.g. pty resize) on an existing stream. */
  controlStream(streamId: number, msg: Record<string, unknown>): void {
    this.writeFrame(FRAME.Control, streamId, Buffer.from(JSON.stringify(msg), "utf8"));
  }

  async stats(): Promise<unknown> {
    const r = await this.request({ method: "stats" }).done;
    return r.value;
  }

  close(): void {
    this.socket.destroy();
  }
}
