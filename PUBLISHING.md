# Publishing hotcell

The goal UX: `npm install -g hotcell` gives the CLI (`hotcell`, alias `hc`) and
the daemon (`hotcelld`) in one install. Four packages ship from this monorepo,
in dependency order:

| Package           | What                                        | Publish order |
|-------------------|---------------------------------------------|:---:|
| `@hotcell/sdk`    | zero-dependency TS client                   | 1 |
| `@hotcell/daemon` | the daemon (containers + microVM drivers)   | 2 |
| `hotcell`         | flagship: CLI + bundled daemon bins         | 3 |
| `@hotcell/mastra` | Mastra tool integration                     | 4 |

## Releasing (automated, every release)

**Merge PRs. That's it.** `.github/workflows/release.yml` runs
[release-please](https://github.com/googleapis/release-please) on every push to
`main`:

1. release-please keeps one open **`release: vX.Y.Z`** PR up to date. It bumps
   all four workspaces, their exact internal pins (cli → daemon/sdk, mastra → sdk,
   daemon devDep → sdk), `package-lock.json` and `sdk/python/pyproject.toml` in
   lockstep, and writes `CHANGELOG.md`. Which files and fields it touches is set
   in `release-please-config.json`. The current version is in
   `.release-please-manifest.json`.
2. **Merge that PR when you want to ship.** release-please then tags `vX.Y.Z` and
   creates the GitHub release. The same workflow run publishes npm (dependency
   order, provenance), PyPI, the macOS VZ helper and the arm64 guest tarball.
   `check:versions` runs before `npm publish`, so the pins can't drift.

What the PR title decides (squash-merge uses it as the commit, and the
`pr title` check rejects titles release-please can't parse):

| Title type | Effect |
|---|---|
| `feat`, `fix`, `perf`, `daemon`, `cli`, `sdk`, `mastra`, `agent`, `build`, `deps`, `refactor`, `revert` | goes in the changelog and triggers a release (patch bump while < 1.0) |
| `docs`, `test`, `bench`, `ci`, `chore` | no release |
| any type with `!` (`feat!:`) or a `BREAKING CHANGE:` footer | minor bump while < 1.0 |

To force a specific version, add a `Release-As: 0.2.0` line to a commit body on
`main`. The release PR is opened with `GITHUB_TOKEN`, so CI does not run on it.
It only changes version fields and the changelog.

Repo settings this depends on (already set): Settings → Actions → General →
"Allow GitHub Actions to create and approve pull requests" on, and Settings →
General → squash-merge commit title = "Pull request title".

### Manual fallback

Pushing a tag still publishes it, skipping release-please. Bump first (see
`check:versions`), then: `git tag v0.2.0 && git push origin v0.2.0`.

### Trusted publishing (OIDC, no tokens)

npm and PyPI get no stored token. Both publish over GitHub OIDC, bound to
repo `sinameraji/hotcell` + workflow `release.yml`. **Don't rename
`release.yml`**, or both publishers stop matching. A new package needs one
manual first publish, then npmjs.com → package → Settings → Publishing access →
add Trusted Publisher with that repo and workflow.

npm is deprecating 2FA-bypass tokens (direct publish: Jan 2027), so if you ever
publish from a terminal, do it interactively with 2FA (`--otp=<code>`, one per
publish). Don't use automation tokens.

### Preflight for risky releases

CI runs on every PR. MicroVM gates are hardware-bound and do not run in CI, so
run them before merging the release PR when a change touched those paths:
`check:applevz` / `smoke:vz` on a Mac, `smoke:fc` on the KVM box.

## Verify the install story

```bash
npm install -g hotcell
hotcell --help                     # CLI up
hotcelld &                         # daemon starts (needs Docker for containers)
hotcell run "python3 -c 'print(2+2)'"
```

## Python SDK (PyPI)

`sdk/python` (`hotcell` on PyPI) has zero runtime dependencies. It ships in the
same release, versioned in lockstep, through PyPI trusted publishing (OIDC). No
API token is stored anywhere.

## Later: one-command install

- Homebrew tap (`brew install sinameraji/tap/hotcell`) wrapping the npm install
  or a bundled binary.
- `curl -fsSL https://hotcell-bw3.pages.dev/install.sh | sh` on the landing page.

## Name registry status (checked 2026-07-17)

- npm `hotcell`: **available** (404).
- npm `@hotcell/*`: scope unclaimed — create the org before publishing.
- The old `sbx` name is taken on npm; everything here already uses hotcell.
