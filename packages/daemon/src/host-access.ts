import { realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, sep } from "node:path";

/**
 * Opt-in host access for a container sandbox: one host directory as its
 * `/workspace`, and the Docker networks it joins instead of the default bridge.
 *
 * Both are off by default. A host directory is accepted only under one of the
 * operator's `HOTCELL_WORKSPACE_ROOTS`; a network only when it carries the label
 * `hotcell.attachable=true` (set by whoever created it for sandboxes). The choice
 * is stored on the sandbox as reserved labels, so a stop/start (which recreates
 * the container) brings back the same mount and networks, and the driver checks
 * both again on every launch: a label can't widen what the operator allowed.
 */

/** The host directory bind-mounted at `/workspace` (reserved label, set by the daemon). */
export const WORKSPACE_DIR_LABEL = "hotcell.workspace-dir";
/** Comma-separated Docker networks, the first as the network mode (reserved label). */
export const NETWORKS_LABEL = "hotcell.networks";
/** A Docker network sandboxes may join carries this label set to "true". */
export const ATTACHABLE_LABEL = "hotcell.attachable";

export const RESERVED_LABELS: readonly string[] = [WORKSPACE_DIR_LABEL, NETWORKS_LABEL];

/** `HOTCELL_WORKSPACE_ROOTS`: absolute directories, comma-separated; anything else is dropped. */
export function parseWorkspaceRoots(text: string | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && isAbsolute(part))
    .map((part) => normalize(part).replace(/(.)\/+$/, "$1"));
}

export interface PathOps {
  realpath: (path: string) => string;
  isDirectory: (path: string) => boolean;
}

const realOps: PathOps = {
  realpath: (path) => realpathSync(path),
  isDirectory: (path) => statSync(path).isDirectory(),
};

const within = (path: string, root: string) => path === root || path.startsWith(root === sep ? root : `${root}${sep}`);

/**
 * The real path of a requested workspace directory, or why it is refused. Symlinks
 * are resolved on both sides (Docker follows them when it mounts), so a link inside
 * an allowed root that points elsewhere is refused. `/` is never a workspace.
 */
export function checkWorkspaceDir(dir: unknown, roots: readonly string[], ops: PathOps = realOps): { dir: string } | { error: string } {
  if (typeof dir !== "string" || !dir) return { error: "workspaceDir must be a non-empty string" };
  if (!isAbsolute(dir)) return { error: `workspaceDir must be an absolute path (got "${dir}")` };
  if (/[,:\n]/.test(dir)) return { error: "workspaceDir must not contain ',', ':' or a newline" };
  if (roots.length === 0) return { error: "host workspaces are off on this daemon; the operator allows directories with HOTCELL_WORKSPACE_ROOTS" };
  let real: string;
  try {
    real = ops.realpath(dir);
    if (!ops.isDirectory(real)) return { error: `workspaceDir ${dir} is not a directory` };
  } catch {
    return { error: `workspaceDir ${dir} does not exist or the daemon can't read it` };
  }
  if (real === sep) return { error: "workspaceDir must not be /" };
  const allowed = roots.some((root) => {
    try { return within(real, ops.realpath(root)); } catch { return false; }
  });
  if (!allowed) return { error: `workspaceDir ${real} is not under HOTCELL_WORKSPACE_ROOTS (${roots.join(", ")})` };
  return { dir: real };
}

/** A Docker network name, as Docker accepts them. */
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The requested networks, in order and without repeats, or why they are refused. */
export function checkNetworks(networks: unknown): { networks: string[] } | { error: string } {
  if (!Array.isArray(networks) || networks.length === 0) return { error: "networks must be a non-empty array of Docker network names" };
  const names = [...new Set(networks)];
  const bad = names.find((name) => typeof name !== "string" || !NETWORK_RE.test(name));
  if (bad !== undefined) return { error: `invalid network name ${JSON.stringify(bad)}` };
  if (names.some((name) => ["host", "none", "bridge", "default"].includes(name as string))) {
    return { error: "networks takes user-defined networks labelled hotcell.attachable=true, not host, none or the default bridge" };
  }
  return { networks: names as string[] };
}

/** What the container driver mounts and joins for a sandbox, read from its labels. */
export interface HostAccess {
  workspaceDir?: string;
  networks?: string[];
}

export function hostAccessFromLabels(labels: Record<string, string> | undefined): HostAccess {
  const workspaceDir = labels?.[WORKSPACE_DIR_LABEL];
  const networks = labels?.[NETWORKS_LABEL]?.split(",").filter(Boolean);
  return { ...(workspaceDir ? { workspaceDir } : {}), ...(networks?.length ? { networks } : {}) };
}

export function hostAccessLabels(access: HostAccess): Record<string, string> {
  return {
    ...(access.workspaceDir ? { [WORKSPACE_DIR_LABEL]: access.workspaceDir } : {}),
    ...(access.networks?.length ? { [NETWORKS_LABEL]: access.networks.join(",") } : {}),
  };
}

/**
 * The create body's `workspaceDir` and `networks`, checked against the daemon's
 * settings: container driver only, no repo clone into a host directory, and no
 * custom networks under egress enforcement (which owns the sandbox's network).
 */
export function checkHostAccess(
  body: { workspaceDir?: unknown; networks?: unknown; labels?: unknown; repo?: unknown; persist?: unknown },
  context: { driver: string; workspaceRoots: readonly string[]; egressEnforce: boolean; template?: boolean },
  ops: PathOps = realOps,
): { access: HostAccess } | { error: string } {
  const labels = body.labels && typeof body.labels === "object" ? body.labels as Record<string, unknown> : {};
  const reserved = RESERVED_LABELS.filter((label) => label in labels);
  if (reserved.length) return { error: `labels ${reserved.join(", ")} are set by the daemon (use workspaceDir / networks)` };
  const wantsDir = body.workspaceDir !== undefined;
  const wantsNetworks = body.networks !== undefined;
  if (!wantsDir && !wantsNetworks) return { access: {} };
  if (context.driver !== "container") return { error: "workspaceDir and networks need the container driver" };
  if (context.template) return { error: "workspaceDir and networks can't be combined with a template" };
  const access: HostAccess = {};
  if (wantsDir) {
    if (body.repo) return { error: "workspaceDir can't be combined with repo (the clone would write into the host directory)" };
    if (body.persist === false) return { error: "workspaceDir is persistent by nature; drop persist: false" };
    const checked = checkWorkspaceDir(body.workspaceDir, context.workspaceRoots, ops);
    if ("error" in checked) return checked;
    access.workspaceDir = checked.dir;
  }
  if (wantsNetworks) {
    if (context.egressEnforce) return { error: "networks can't be used while HOTCELL_EGRESS_ENFORCE is on (enforcement puts every sandbox on its own network)" };
    const checked = checkNetworks(body.networks);
    if ("error" in checked) return checked;
    access.networks = checked.networks;
  }
  return { access };
}
