import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Metadata for a workspace backup, persisted as a JSON sidecar on the host. */
export interface BackupInfo {
  backupId: string;
  /** Sandbox the backup was taken from (a backup may be restored elsewhere). */
  sandboxId: string;
  createdAt: string;
  /** Size of the tarball in bytes. */
  bytes: number;
}

/**
 * Backup ids are minted by `SandboxStore.newBackupId()`: 12 lowercase hex chars.
 * Anything else is rejected before it can reach a filesystem path, so a
 * client-supplied id (`POST /sandboxes/:id/restore`, `DELETE /backups/:id`)
 * like `../../etc/x` can never escape the backup dir.
 */
const BACKUP_ID_RE = /^[0-9a-f]{12}$/;

export function isValidBackupId(backupId: unknown): backupId is string {
  return typeof backupId === "string" && BACKUP_ID_RE.test(backupId);
}

function assertBackupId(backupId: string): void {
  if (!isValidBackupId(backupId)) throw new Error(`invalid backup id: ${JSON.stringify(String(backupId).slice(0, 64))}`);
}

/**
 * On-disk registry of workspace backups. Unlike the in-memory `SandboxStore`,
 * backups must survive daemon restarts, so each backup is a `<id>.tar` tarball
 * plus a `<id>.json` metadata sidecar in `dir`; `list` rescans the directory.
 */
export class BackupRegistry {
  constructor(private readonly dir: string) {}

  /** Host path of a backup's tarball (managed by the driver). */
  tarPath(backupId: string): string {
    assertBackupId(backupId);
    return join(this.dir, `${backupId}.tar`);
  }

  private metaPath(backupId: string): string {
    assertBackupId(backupId);
    return join(this.dir, `${backupId}.json`);
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Persist a backup's metadata. The tarball is written separately. */
  async save(info: BackupInfo): Promise<void> {
    await this.ensureDir();
    await writeFile(this.metaPath(info.backupId), JSON.stringify(info, null, 2));
  }

  /** A backup's metadata; `undefined` when unknown or not a well-formed id. */
  async get(backupId: string): Promise<BackupInfo | undefined> {
    if (!isValidBackupId(backupId)) return undefined;
    try {
      const raw = await readFile(this.metaPath(backupId), "utf8");
      return JSON.parse(raw) as BackupInfo;
    } catch (err: unknown) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /** List all backups, newest first. */
  async list(): Promise<BackupInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err: unknown) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const infos: BackupInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const info = await this.get(name.slice(0, -".json".length));
      if (info) infos.push(info);
    }
    return infos.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Remove a backup's tarball and metadata. Returns false if unknown. */
  async remove(backupId: string): Promise<boolean> {
    const info = await this.get(backupId);
    if (!info) return false;
    await rm(this.tarPath(backupId), { force: true });
    await rm(this.metaPath(backupId), { force: true });
    return true;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
