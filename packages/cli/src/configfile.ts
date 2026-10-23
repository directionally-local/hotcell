import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The persisted daemon config (`${HOTCELL_HOME || ~/.hotcell}/config.json`) from
 * the CLI's side: the setup wizard writes it, `hotcell start` keys first-run
 * detection off its existence, and the CLI reads it so `--api-key`/`--endpoint`
 * defaults survive a network-bound daemon (env still overrides everything).
 *
 * Format: env-style keys with string values — "persisted env". The daemon reads
 * the same file in its own config loader with precedence env > file > defaults.
 */

export const HOME = process.env.HOTCELL_HOME || join(homedir(), ".hotcell");
export const CONFIG_FILE = join(HOME, "config.json");

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

let warnedMalformed = false;

/** Read the config file; missing → {}, malformed → warn once + {} (never throws). */
export function readConfigFile(): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return {};
  }
  restrictMode(CONFIG_FILE); // tighten a file written by an older version
  try {
    const parsed: unknown = JSON.parse(raw);
    const out: Record<string, string> = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          out[k] = String(v);
        }
      }
    }
    return out;
  } catch {
    if (!warnedMalformed) {
      warnedMalformed = true;
      console.error(`hotcell: ignoring malformed ${CONFIG_FILE} (not valid JSON)`);
    }
    return {};
  }
}

/**
 * Write (overwrite) the config file. `{}` is meaningful: "defaults, by choice".
 * Atomic (tmp + rename) so a daemon reading mid-write sees old-or-new, never a
 * truncated file it would discard as malformed.
 */
export function writeConfigFile(values: Record<string, string>): void {
  // The file can hold secrets (HOTCELL_API_KEY from the wizard's network path,
  // provider keys set by hand), so: home dir 0700, file 0600. The tmp file is
  // created fresh with 0600 so the secret is never on disk with a looser mode.
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  restrictMode(HOME);
  const tmp = CONFIG_FILE + ".tmp";
  rmSync(tmp, { force: true }); // `mode` only applies on create: never reuse a stale tmp
  writeFileSync(tmp, JSON.stringify(values, null, 2) + "\n", { mode: 0o600 });
  restrictMode(tmp);
  renameSync(tmp, CONFIG_FILE);
}

/**
 * Drop group/other permission bits from `path` (0644 → 0600, 0755 → 0700; no-op
 * when already private or missing). Best-effort: a file we don't own, or Windows
 * (where chmod is mostly a no-op and the user-profile ACL applies), is left as is.
 */
export function restrictMode(path: string): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) chmodSync(path, mode & 0o700);
  } catch {
    /* missing, not ours, or Windows */
  }
}

/**
 * CLI-side value resolution mirroring the daemon's: env (HOTCELL_ then legacy
 * SBX_) > config file. Used for the API key and port so the CLI keeps working
 * when the wizard turned auth on.
 */
export function resolveSetting(name: string): string | undefined {
  return (
    process.env[`HOTCELL_${name}`] ??
    process.env[`SBX_${name}`] ??
    readConfigFile()[`HOTCELL_${name}`]
  );
}

/**
 * Default endpoint for the CLI: an explicit endpoint (env or file) wins, else
 * the configured port — resolved with the SAME precedence as everything else
 * (env > legacy env > file) — on loopback.
 */
export function defaultEndpoint(): string | undefined {
  const explicit = resolveSetting("ENDPOINT");
  if (explicit) return explicit;
  const port = resolveSetting("PORT");
  return port ? `http://127.0.0.1:${port}` : undefined;
}
