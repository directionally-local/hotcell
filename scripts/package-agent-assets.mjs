import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(repoRoot, "agent", "dist");
const targetDir = join(repoRoot, "packages", "daemon", "dist", "agent-assets");
const names = ["hotcell-agent-linux-amd64", "hotcell-agent-linux-arm64"];

for (const name of names) {
  const source = join(sourceDir, name);
  if (!existsSync(source)) {
    throw new Error(`missing ${source}; run npm run build:agent before packing @hotcell/daemon`);
  }
}

mkdirSync(targetDir, { recursive: true });
for (const name of names) {
  const target = join(targetDir, name);
  copyFileSync(join(sourceDir, name), target);
  chmodSync(target, 0o755);
}
