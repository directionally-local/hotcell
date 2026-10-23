import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The daemon's API key is always on. An unauthenticated API was reachable by
 * code inside sandboxes (containers get `host.docker.internal`, which on Docker
 * Desktop reaches every host loopback port) and by any web page the operator
 * opened (no CORS preflight is needed for a `no-cors` POST). Either could then
 * read other sandboxes' egress tokens, exec into them, or create sandboxes that
 * spend the host's provider keys.
 *
 * An explicit `HOTCELL_API_KEY` (env or config.json) wins. Otherwise a random
 * key is generated once and kept in `${HOTCELL_HOME || ~/.hotcell}/api-key`
 * (0600), where the local CLI and SDKs pick it up for loopback endpoints.
 * Sandboxes can't read that file and browsers can't attach it.
 */
export function apiKeyFile(): string {
  return join(process.env.HOTCELL_HOME || join(homedir(), ".hotcell"), "api-key");
}

export interface ResolvedApiKey {
  key: string;
  source: "config" | "file" | "generated";
  /** Set when the key lives in (or was written to) the local key file. */
  file?: string;
}

const MIN_FILE_KEY_LENGTH = 32;

export function ensureApiKey(configured: string, file: string = apiKeyFile()): ResolvedApiKey {
  if (configured) return { key: configured, source: "config" };

  const existing = readKeyFile(file);
  if (existing) return { key: existing, source: "file", file };

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  try {
    // `wx`: never clobber a key another daemon start wrote a moment ago.
    writeFileSync(file, key + "\n", { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const raced = readKeyFile(file);
    if (raced) return { key: raced, source: "file", file };
    throw new Error(`${file} exists but holds no usable API key; delete it to generate a new one`);
  }
  return { key, source: "generated", file };
}

function readKeyFile(file: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const key = raw.trim();
  if (key.length < MIN_FILE_KEY_LENGTH) return null;
  // Tighten a key file someone copied in with looser permissions.
  try {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
    // best effort: reading worked, so the key is still usable
  }
  return key;
}
