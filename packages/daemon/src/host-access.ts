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
/** The numeric `UID:GID` the container runs as (reserved label, set by the daemon). */
export const USER_LABEL = "hotcell.user";
/** The host directory bind-mounted at `HOME_MOUNT` (reserved label, set by the daemon). */
export const HOME_DIR_LABEL = "hotcell.home-dir";
/** Where a sandbox's host home directory is mounted. */
export const HOME_MOUNT = "/home/agent";

export const RESERVED_LABELS: readonly string[] = [WORKSPACE_DIR_LABEL, NETWORKS_LABEL, USER_LABEL, HOME_DIR_LABEL];

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
  return checkHostDir(dir, roots, { option: "workspaceDir", env: "HOTCELL_WORKSPACE_ROOTS", what: "host workspaces" }, ops);
}

/** The same checks for a sandbox's home directory, against `HOTCELL_HOME_ROOTS`. */
export function checkHomeDir(dir: unknown, roots: readonly string[], ops: PathOps = realOps): { dir: string } | { error: string } {
  return checkHostDir(dir, roots, { option: "homeDir", env: "HOTCELL_HOME_ROOTS", what: "host home directories" }, ops);
}

function checkHostDir(dir: unknown, roots: readonly string[], names: { option: string; env: string; what: string }, ops: PathOps): { dir: string } | { error: string } {
  const { option, env } = names;
  if (typeof dir !== "string" || !dir) return { error: `${option} must be a non-empty string` };
  if (!isAbsolute(dir)) return { error: `${option} must be an absolute path (got "${dir}")` };
  if (/[,:\n]/.test(dir)) return { error: `${option} must not contain ',', ':' or a newline` };
  if (roots.length === 0) return { error: `${names.what} are off on this daemon; the operator allows directories with ${env}` };
  let real: string;
  try {
    real = ops.realpath(dir);
    if (!ops.isDirectory(real)) return { error: `${option} ${dir} is not a directory` };
  } catch {
    return { error: `${option} ${dir} does not exist or the daemon can't read it` };
  }
  if (real === sep) return { error: `${option} must not be /` };
  const allowed = roots.some((root) => {
    try { return within(real, ops.realpath(root)); } catch { return false; }
  });
  if (!allowed) return { error: `${option} ${real} is not under ${env} (${roots.join(", ")})` };
  return { dir: real };
}

/** A home directory and the workspace must not contain one another (each mount shows only itself). */
export function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
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

/** Docker's largest uid/gid (a 32-bit signed id; 4294967295 is "no id"). */
const MAX_ID = 2 ** 31 - 1;

/**
 * The user a sandbox runs as: numeric `UID:GID` only, so it never depends on the image's
 * /etc/passwd (a name could resolve to anything inside the image). `0:0` is root, the same
 * as leaving it out.
 */
export function checkUser(user: unknown): { user: string } | { error: string } {
  const match = typeof user === "string" ? /^(\d{1,10}):(\d{1,10})$/.exec(user) : null;
  if (!match) return { error: `user must be a numeric UID:GID such as 1000:1000 (got ${JSON.stringify(user)})` };
  const [uid, gid] = [Number(match[1]), Number(match[2])];
  if (uid > MAX_ID || gid > MAX_ID) return { error: `user ${user} is out of range (uid and gid go up to ${MAX_ID})` };
  return { user: `${uid}:${gid}` };
}

/** What the container driver mounts and joins for a sandbox, and who it runs as, read from its labels. */
export interface HostAccess {
  workspaceDir?: string;
  networks?: string[];
  user?: string;
  homeDir?: string;
}

export function hostAccessFromLabels(labels: Record<string, string> | undefined): HostAccess {
  const workspaceDir = labels?.[WORKSPACE_DIR_LABEL];
  const networks = labels?.[NETWORKS_LABEL]?.split(",").filter(Boolean);
  const user = labels?.[USER_LABEL];
  const homeDir = labels?.[HOME_DIR_LABEL];
  return { ...(workspaceDir ? { workspaceDir } : {}), ...(networks?.length ? { networks } : {}), ...(user ? { user } : {}), ...(homeDir ? { homeDir } : {}) };
}

export function hostAccessLabels(access: HostAccess): Record<string, string> {
  return {
    ...(access.workspaceDir ? { [WORKSPACE_DIR_LABEL]: access.workspaceDir } : {}),
    ...(access.networks?.length ? { [NETWORKS_LABEL]: access.networks.join(",") } : {}),
    ...(access.user ? { [USER_LABEL]: access.user } : {}),
    ...(access.homeDir ? { [HOME_DIR_LABEL]: access.homeDir } : {}),
  };
}

/**
 * The create body's `workspaceDir`, `networks`, `user` and `homeDir`, checked against the
 * daemon's settings: container driver only, no repo clone into a host directory, no custom
 * networks under egress enforcement (which owns the sandbox's network), and a `user` or a
 * `homeDir` only with a `workspaceDir` (a named volume is root's, so that user couldn't
 * write it). A `homeDir` is mounted at /home/agent, only under `HOTCELL_HOME_ROOTS`.
 */
export function checkHostAccess(
  body: { workspaceDir?: unknown; networks?: unknown; user?: unknown; homeDir?: unknown; labels?: unknown; repo?: unknown; persist?: unknown },
  context: { driver: string; workspaceRoots: readonly string[]; homeRoots?: readonly string[]; egressEnforce: boolean; template?: boolean },
  ops: PathOps = realOps,
): { access: HostAccess } | { error: string } {
  const labels = body.labels && typeof body.labels === "object" ? body.labels as Record<string, unknown> : {};
  const reserved = RESERVED_LABELS.filter((label) => label in labels);
  if (reserved.length) return { error: `labels ${reserved.join(", ")} are set by the daemon (use workspaceDir / networks / user / homeDir)` };
  const wantsDir = body.workspaceDir !== undefined;
  const wantsNetworks = body.networks !== undefined;
  const wantsUser = body.user !== undefined;
  const wantsHome = body.homeDir !== undefined;
  if (!wantsDir && !wantsNetworks && !wantsUser && !wantsHome) return { access: {} };
  if (context.driver !== "container") return { error: "workspaceDir, networks, user and homeDir need the container driver" };
  if (context.template) return { error: "workspaceDir, networks, user and homeDir can't be combined with a template" };
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
  if (wantsUser) {
    if (!wantsDir) return { error: "user needs workspaceDir (the sandbox's own /workspace volume belongs to root)" };
    const checked = checkUser(body.user);
    if ("error" in checked) return checked;
    access.user = checked.user;
  }
  if (wantsHome) {
    if (!wantsDir) return { error: "homeDir needs workspaceDir" };
    const checked = checkHomeDir(body.homeDir, context.homeRoots ?? [], ops);
    if ("error" in checked) return checked;
    if (overlaps(checked.dir, access.workspaceDir!)) return { error: `homeDir ${checked.dir} and workspaceDir ${access.workspaceDir} must not contain one another` };
    access.homeDir = checked.dir;
  }
  return { access };
}
