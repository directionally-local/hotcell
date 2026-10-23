import { HotcellClient, localApiKey } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";

/**
 * hotcell terminal <id> — attach an interactive shell to a sandbox (the "attach" verb).
 *
 * Bridges the daemon's WebSocket PTY (`GET /sandboxes/:id/terminal`) to the local
 * terminal: local stdin → binary frames (keystrokes), output frames → stdout, and
 * window resizes → a control JSON frame. Uses the Node ≥21 global WebSocket so the
 * CLI stays dependency-free like the SDK.
 */
export async function terminalCommand(
  positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const id = positional[0];
  if (!id) {
    console.error("Usage: hotcell terminal <id>");
    return 1;
  }
  const WS = (globalThis as { WebSocket?: any }).WebSocket;
  if (!WS) {
    console.error("sb terminal requires Node >= 21 (global WebSocket)");
    return 1;
  }

  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  const base = client.endpoint.replace(/^http/, "ws");
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  let url = `${base}/sandboxes/${id}/terminal?cols=${cols}&rows=${rows}`;
  const key =
    globals.apiKey || process.env.HOTCELL_API_KEY || process.env.SBX_API_KEY || localApiKey(client.endpoint);
  if (key) url += `&key=${encodeURIComponent(key)}`;

  const stdin = process.stdin;
  const isTTY = Boolean(stdin.isTTY);

  return await new Promise<number>((resolve) => {
    const ws = new WS(url);
    ws.binaryType = "arraybuffer";

    const onStdin = (d: Buffer) => {
      if (ws.readyState === 1) ws.send(d);
    };
    const onResize = () => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "resize", cols: process.stdout.columns, rows: process.stdout.rows }));
      }
    };
    const cleanup = (code: number) => {
      try { if (isTTY) stdin.setRawMode?.(false); } catch {}
      stdin.off("data", onStdin);
      process.stdout.off("resize", onResize);
      stdin.pause();
      resolve(code);
    };

    ws.onopen = () => {
      if (isTTY) {
        try { stdin.setRawMode?.(true); } catch {}
        console.error(`[hotcell] attached to ${id} — Ctrl-C exits the shell, then the session closes`);
      }
      stdin.resume();
      stdin.on("data", onStdin);
      process.stdout.on("resize", onResize);
    };
    ws.onmessage = (e: { data: unknown }) => {
      const data = e.data;
      process.stdout.write(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer));
    };
    ws.onclose = () => cleanup(0);
    ws.onerror = () => {
      console.error("[hotcell] terminal connection error");
      cleanup(1);
    };
  });
}
