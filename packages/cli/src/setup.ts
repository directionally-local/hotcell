import { randomBytes } from "node:crypto";
import { platform, totalmem } from "node:os";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalArgs } from "./cli.js";
import { CONFIG_FILE, configExists, readConfigFile, writeConfigFile } from "./configfile.js";
import { isUp, startEngine, stopEngine } from "./engine.js";
import { importEnvInteractive, keysCommand } from "./keys.js";
import { loadKeys } from "./keystore.js";
import { c, confirm, readKey, select, textInput } from "./prompts.js";
import { HotcellClient } from "@hotcell/sdk";
import { sizeHost } from "@hotcell/daemon/dist/sizing.js";

// Detect a source checkout by the VZ helper's Swift package at the repo root.
// Since 0.1.18/0.1.19 the Apple VZ runtime (ad-hoc-signed helper + guest kernel
// + agent + converter scripts) is fetched from the matching GitHub release on
// first use, so npm installs can run VZ too — the checkout detection now only
// gates Firecracker (whose artifacts still exist only in a source checkout) and
// softens the VZ hint (npm installs still need Docker for OCI→ext4 conversion).
const RUNNING_FROM_SOURCE = existsSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "helpers", "hotcell-vz", "Package.swift"),
);

/**
 * hotcell setup — the guided daemon configuration.
 *
 * The daemon's irreversible, start-time decisions (bind/access, egress posture,
 * isolation driver, default image) surfaced in one place, saved to
 * `~/.hotcell/config.json` (env always overrides). The first screen shows the
 * recommended settings inline — nothing hidden — and one keystroke accepts them;
 * `c` walks through each choice instead. Re-run anytime; applying to a running
 * daemon offers a restart. TTY-only: agents/scripts configure via env/flags.
 */

const REC = {
  access: "this machine only (127.0.0.1)",
  egress: "open (keyless gateway available per sandbox)",
  isolation: "containers (Docker)",
  image: "hotcell-base (git + node + python)",
};

/**
 * "this machine fits ~N agents" — the line the sizing model exists to produce.
 * Uses the medium profile (a typical TypeScript app) and the container driver,
 * which is what the recommended setup runs. Returns null when the model has no
 * measurement to stand on, so the installer stays quiet rather than guessing.
 */
function fitsLine(): string | null {
  const hostMb = Math.round(totalmem() / (1024 * 1024));
  const s = sizeHost({ profile: "medium", driver: "container" });
  const peak = s.perAgent.peakMemoryMb;
  const baseline = s.perAgent.baselineMb;
  if (!s.ok || peak === null || baseline === null) return null;
  const perAgent = (peak + baseline) * s.headroom;
  const fits = Math.floor(hostMb / perAgent);
  return `~${fits} medium agents on this ${(hostMb / 1024).toFixed(0)} GB machine`;
}

export async function setupCommand(
  globals: GlobalArgs,
  _flags: Record<string, string | boolean>,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("hotcell setup needs an interactive terminal — configure via env instead (see docs/reference.md).");
    return 1;
  }
  const out = process.stdout;
  const existing = configExists() ? readConfigFile() : undefined;

  out.write(`\n  ${c.bold}${c.cyan}hotcell setup${c.reset}   ${c.dim}· saved to ${CONFIG_FILE} · env always overrides${c.reset}\n\n`);
  out.write(`  ${c.bold}Recommended${existing ? "" : " for this machine"}:${c.reset}\n`);
  out.write(`    ${c.dim}access${c.reset}      ${REC.access}\n`);
  out.write(`    ${c.dim}egress${c.reset}      ${REC.egress}\n`);
  out.write(`    ${c.dim}isolation${c.reset}   ${REC.isolation}\n`);
  out.write(`    ${c.dim}image${c.reset}       ${REC.image}\n`);
  const fits = fitsLine();
  if (fits) out.write(`    ${c.dim}agents${c.reset}      ${fits}\n`);
  out.write("\n");
  out.write(`  ${c.bold}⏎${c.reset} use recommended   ${c.dim}·${c.reset}   ${c.bold}c${c.reset} customize each   ${c.dim}·${c.reset}   ${c.bold}q${c.reset} cancel\n`);

  let chosen: Record<string, string> = {};
  let generatedKey: string | undefined;

  for (;;) {
    const k = await readKey();
    if (k === "\r" || k === "\n") break; // recommended → empty overrides
    if (k === "q" || k === "Q" || k === "\x1b") {
      out.write(`  ${c.dim}cancelled — nothing written${c.reset}\n`);
      return 0;
    }
    if (k === "c" || k === "C") {
      out.write("\n");
      const custom = await customize();
      chosen = custom.values;
      generatedKey = custom.generatedKey;
      break;
    }
  }

  // MERGE, don't replace: the wizard owns exactly five keys; anything else in the
  // file (hand-added HOTCELL_PORT, spend caps, …) survives a re-run untouched.
  // Dropping a previously stored API key (access back to local-only) is loud —
  // that key was shown once and lives nowhere else.
  const WIZARD_KEYS = [
    "HOTCELL_HOST",
    "HOTCELL_API_KEY",
    "HOTCELL_EGRESS_ENFORCE",
    "HOTCELL_DRIVER",
    "HOTCELL_IMAGE",
  ];
  const merged: Record<string, string> = { ...(existing ?? {}) };
  const droppingKey = Boolean(existing?.HOTCELL_API_KEY) && !chosen.HOTCELL_API_KEY;
  for (const k of WIZARD_KEYS) delete merged[k];
  Object.assign(merged, chosen);
  if (droppingKey) {
    if (!(await confirm("this removes the stored API key (network access off) — continue?", false))) {
      out.write(`  ${c.dim}cancelled — nothing written${c.reset}\n`);
      return 0;
    }
  }
  writeConfigFile(merged);
  out.write(`\n  ${c.green}✓ saved${c.reset} ${c.dim}${CONFIG_FILE}${c.reset}\n`);
  if (generatedKey) {
    out.write(`  ${c.yellow}API key (shown once — the CLI reads it from the config file automatically):${c.reset}\n`);
    out.write(`    ${generatedKey}\n`);
  }
  const envPairs = Object.entries(chosen).filter(([k]) => k !== "HOTCELL_API_KEY");
  if (envPairs.length) {
    out.write(`  ${c.dim}equivalent env: ${envPairs.map(([k, v]) => `${k}=${v}`).join(" ")}${c.reset}\n`);
  }

  // Provider keys — the third setup-critical fact: without one, egress/agents
  // are dead on arrival. Reuses `hotcell keys add` (hidden input, keychain, hot-reload).
  const keys = loadKeys();
  if (Object.keys(keys).length === 0) {
    out.write("\n");
    const which = await select(
      "add a provider key now?",
      [
        { label: "type one in", hint: "any provider — openrouter, anthropic, stripe, …" },
        { label: "import a .env", hint: "file path or paste — stores every KEY=VALUE" },
        { label: "skip", hint: "add later: hotcell keys add <provider>" },
      ],
      2, // default = skip; an explicit choice, never forced
    );
    if (which === 0) {
      const name = await textInput("provider name");
      if (name) await keysCommand(["add", name], globals, {});
    } else if (which === 1) {
      await importEnvInteractive(globals);
    }
  }

  // Start (or restart) the daemon so the config actually applies.
  // The new key (if any) must be used by THIS process from here on — the daemon
  // we start/restart will require it, and globals was resolved before it existed.
  if (generatedKey) globals.apiKey = generatedKey;

  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  out.write("\n");
  if (await isUp(client.endpoint)) {
    if (await confirm("daemon is running — restart now to apply?", false)) {
      // Only proceed when the old daemon is confirmed DOWN — otherwise
      // startEngine's idempotency check would see the dying one and "succeed".
      const rc = await stopEngine(globals);
      if (rc !== 0 || (await isUp(client.endpoint))) {
        out.write(`  ${c.red}old daemon still up — config saved but NOT applied; run: hotcell stop && hotcell start${c.reset}\n`);
        return 1;
      }
      return startEngine(globals, {});
    }
    out.write(`  ${c.dim}config saved — applies on the next restart (hotcell stop && hotcell start)${c.reset}\n`);
    return 0;
  }
  if (await confirm("start the daemon now?", true)) return startEngine(globals, {});
  out.write(`  ${c.dim}when ready: hotcell start${c.reset}\n`);
  return 0;
}

/** Walk each decision; returns only NON-default values (defaults stay implicit). */
async function customize(): Promise<{ values: Record<string, string>; generatedKey?: string }> {
  const values: Record<string, string> = {};
  let generatedKey: string | undefined;
  const mac = platform() === "darwin";

  // Esc inside customize = "keep the recommended choice" (index 0), not abort —
  // the whole-wizard abort lives on the first screen.
  const access = Math.max(0, await select("access — who can reach the daemon's API?", [
    { label: "this machine only", hint: "binds 127.0.0.1 — recommended" },
    { label: "my network", hint: "binds 0.0.0.0 + generates an API key" },
  ]));
  if (access === 1) {
    values["HOTCELL_HOST"] = "0.0.0.0";
    generatedKey = randomBytes(24).toString("hex");
    values["HOTCELL_API_KEY"] = generatedKey;
  }

  const egress = Math.max(0, await select("egress — what can sandboxes reach?", [
    { label: "open", hint: "normal network; keyless gateway per sandbox" },
    {
      label: "locked down (default-deny)",
      hint: mac ? "advisory on macOS Docker (see docs/egress.md)" : "gateway + allowlist only (CAP_NET_ADMIN)",
    },
  ]));
  if (egress === 1) values["HOTCELL_EGRESS_ENFORCE"] = "true";

  const isoOptions = mac
    ? [
        { label: "containers (Docker)", hint: "recommended — needs Docker Desktop/colima" },
        ...(RUNNING_FROM_SOURCE || process.arch === "arm64"
          ? [{
              label: "Apple VZ microVMs",
              hint: RUNNING_FROM_SOURCE
                ? "VM-grade isolation, no NIC by default"
                : "VM-grade isolation — runtime fetched on first run; image conversion still needs Docker",
            }]
          : []),
      ]
    : [
        { label: "containers (Docker)", hint: "recommended" },
        ...(RUNNING_FROM_SOURCE
          ? [{
              label: "Firecracker microVMs",
              hint: existsSync("/dev/kvm") ? "VM-grade isolation (KVM detected)" : "needs /dev/kvm — not detected!",
            }]
          : []),
      ];
  // Only ask when there's a real choice; an install offers Docker only.
  const iso =
    isoOptions.length > 1
      ? Math.max(0, await select("isolation — default driver for new sandboxes?", isoOptions))
      : 0;
  if (iso === 1) values["HOTCELL_DRIVER"] = mac ? "applevz" : "firecracker";

  const img = Math.max(0, await select("default image for new sandboxes?", [
    { label: "hotcell-base", hint: "git + node + python — recommended for agents" },
    { label: "custom…", hint: "any public OCI image" },
  ]));
  if (img === 1) {
    const custom = await textInput("image", "");
    if (custom) values["HOTCELL_IMAGE"] = custom;
  }

  return { values, generatedKey };
}
