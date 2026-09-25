/**
 * Canned `--setup` snippets the CLI can wire for you (`--autopilot` and
 * `--opencode` today; more agents later). Kept apart from the wizard so flag and
 * wizard paths share one copy. examples/agent.mjs carries an independent copy on
 * purpose — a standalone zero-import example can't reach CLI internals.
 */

export const AUTOPILOT_SETUP =
  `(npm i -g --no-fund --no-audit autopilot-ai >/dev/null 2>&1 || npm i -g --prefix /workspace/.npm-global --no-fund --no-audit autopilot-ai >/dev/null 2>&1) && ` +
  `(test -n "$OPENROUTER_BASE_URL" && test -n "$OPENROUTER_API_KEY" || { echo 'Autopilot needs an OpenRouter key on the host (hotcell keys add openrouter)' >&2; exit 1; }) && ` +
  `export XDG_CONFIG_HOME="\${XDG_CONFIG_HOME:-/workspace/.config}" && mkdir -p "$XDG_CONFIG_HOME/kimiflare" && ` +
  // OpenRouter's gateway route maps its API root to `/api`; Autopilot appends
  // `/chat/completions`, so its custom base needs the `/v1` suffix.
  `node -e 'const fs=require("node:fs"); fs.writeFileSync(process.env.XDG_CONFIG_HOME + "/kimiflare/config.json", JSON.stringify({baseUrl:process.env.OPENROUTER_BASE_URL.replace(/\\/+$/, "") + "/v1",apiKey:process.env.OPENROUTER_API_KEY},null,2), {mode:0o600})' && chmod 600 "$XDG_CONFIG_HOME/kimiflare/config.json" && ` +
  `autopilot --version`;

// Verified OpenCode wiring (same as examples/agents.sh): install, then point its
// openrouter provider at the egress gateway env the daemon injects. Global
// install first; on the microVM drivers /usr lives on the shared read-only
// rootfs, so fall back to a prefix on the writable workspace disk (init.sh puts
// /workspace/.npm-global/bin on PATH). Config lands in ~/.config (transient on
// VZ, where /root is tmpfs) AND /workspace/opencode.json (project-scoped,
// survives stop/start on the persistent workspace disk).
export const OPENCODE_SETUP =
  `(npm i -g opencode-ai >/dev/null 2>&1 || npm i -g --prefix /workspace/.npm-global opencode-ai >/dev/null 2>&1) && ` +
  `mkdir -p ~/.config/opencode && ` +
  `printf '{"provider":{"openrouter":{"options":{"baseURL":"%s/v1","apiKey":"%s"}}}}' ` +
  `"$OPENROUTER_BASE_URL" "$OPENROUTER_API_KEY" | tee ~/.config/opencode/opencode.json > /workspace/opencode.json && ` +
  // Pre-seed opencode's models.dev snapshot through the gateway (curl honors
  // HTTP(S)_PROXY; opencode's own runtime fetch does not, and stalls hard on
  // NIC-less microVM guests when the cache is cold). Best-effort: a miss just
  // means opencode fetches for itself where it can.
  `{ mkdir -p "\${XDG_CACHE_HOME:-$HOME/.cache}/opencode" && ` +
  `curl -fsSL -m 30 https://models.dev/api.json -o "\${XDG_CACHE_HOME:-$HOME/.cache}/opencode/models.json" || true; }`;

/** Whether an image (undefined = the node-capable default) can run `npm i -g`. */
export function nodeCapableImage(image: string | undefined): boolean {
  return image === undefined || /node|hotcell[-/]base/.test(image);
}
