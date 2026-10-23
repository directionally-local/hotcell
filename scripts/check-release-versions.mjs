/**
 * Release lockstep guard. Fails if the four npm workspaces disagree on version,
 * if any internal `hotcell`/`@hotcell/*` dependency pin doesn't match that
 * version, or (in CI, when RELEASE_TAG or GITHUB_REF_NAME is a v* tag) if the
 * tag doesn't match. RELEASE_TAG wins because release.yml publishes from a push
 * to main, where GITHUB_REF_NAME is the branch. Exists because v0.1.21 shipped
 * the CLI pinned to @hotcell/daemon 0.1.20 — users installed a daemon one
 * release behind the CLI sitting next to it. Runs in release.yml before `npm publish`; run locally with
 * `npm run check:versions`.
 */
import { readFileSync } from "node:fs";

const WORKSPACES = ["sdk", "daemon", "cli", "mastra"];
const INTERNAL = /^(hotcell|@hotcell\/)/;

const pkgs = WORKSPACES.map((dir) => ({
  dir,
  ...JSON.parse(readFileSync(new URL(`../packages/${dir}/package.json`, import.meta.url), "utf8")),
}));

const errors = [];
const version = pkgs[0].version;

for (const pkg of pkgs) {
  if (pkg.version !== version) {
    errors.push(`${pkg.name} is ${pkg.version} but ${pkgs[0].name} is ${version} — bump in lockstep`);
  }
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (INTERNAL.test(dep) && range !== pkg.version) {
        errors.push(`${pkg.name} ${field}.${dep} pins "${range}" but this release is ${pkg.version}`);
      }
    }
  }
}

const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v") && tag !== `v${version}`) {
  errors.push(`tag ${tag} doesn't match package version ${version}`);
}

if (errors.length > 0) {
  console.error("release version check FAILED:");
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`release version check OK: all packages + internal pins at ${version}${tag ? `, tag ${tag}` : ""}`);
