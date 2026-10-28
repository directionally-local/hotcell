# OpenCode provider benchmark — hotcell evidence

Raw results and the harness for running dax's OpenCode provider benchmark
(`anomalyco/opencode` @ `provider-benchmark`, `script/provider-benchmark.sh`) on
hotcell Firecracker microVMs. Everything here is measured; nothing is
extrapolated. Full raw stdout for every run is preserved under `raw/`.

dax's script runs **verbatim, unmodified** — same commit, same toolchain versions.
Our guest *image* differs from stock in exactly one way (the node-gyp workaround,
disclosed below); the script itself is never touched. It clones a
pinned OpenCode commit, `bun install`s it, and `bun typecheck`s it (a *build*
workload; OpenCode is never executed as an agent, no LLM calls). It reports
`BENCH_META` / `BENCH_CACHE` / `BENCH_DISK` / `BENCH_PHASE` lines and a markdown
table. Workload total = clone + install + typecheck.

## What "good" means here

This is a filter, not a leaderboard. A green row from one big config is
cherry-picking; the useful artifact is the **demand curve** — the memory floor
below which the workload dies at typecheck, the CPU knee beyond which more cores
stop helping, and the at-rest economics dax actually needs for a large, spiky
userbase. Every rung, including every failure, is published.

**Status:** Part A's ladder is complete — full grid in
`raw/hetzner-5950x/demand-curve-ladder.tsv`, per-run stdout in `ladder-runs/`
(plus an earlier, messier session in `session-1547Z-runs/`). Measured headlines:

- **The memory floor is a band, not a line.** Peak working set swings run to
  run — 11.0–14.2 GiB even across five byte-identical 32-vCPU reps — so rungs
  from 12–16 GiB flip: 12 GiB is 1/3 PASS in the clean ladder and 0/3 in the
  earlier session; 16 GiB is 3/3 in the ladder but **OOM'd once** in the earlier
  session (peak 15.65 GiB). ≤ 8 GiB always OOMs; only ≥ 24 GiB never has
  (`memory-floor.txt`, `ladder-runs/`, `session-1547Z-runs/`).
- **CPU knee (typecheck median at 32 GiB):** 2 vCPU 102.8 s → 4 53.9 s →
  8 30.7 s → 16 20.2 s → 32 17.4 s. Gains per doubling: 1.91× → 1.76× →
  1.52× → 1.16× — the workload stops scaling past 8–16 vCPU.
- The published max-config row: 32 vCPU / 32 GiB, Workload total 35.385 s
  (median of 5 cold reps, `32vcpu-5reps.txt`), vs the host control
  (`control-bare-host.txt`) and the bare-metal proof (`host-proof.txt`).
- Parts B–D raws are in the same directory (`partB-*`, `partC-*`,
  `partD-economics.txt`) — they are the subject of a separate follow-up.

## Layout

- `harness/bench-suite.sh` — runs a list of `MEM:CPU` guest configs, `REPS` times
  each, cold (fresh microVM per run), samples peak guest memory, and classifies
  each outcome: `PASS` / `OOM` / `INSTALL_FLAKE` / `ADMISSION` / `OTHER`. Writes
  full raw stdout per run + a `summary.tsv`. Never retries-until-green.
- `harness/runbench.sh` — guest-side wrapper: runs the benchmark while sampling
  `/proc/meminfo` `MemAvailable` every 0.3 s, so peak working set is measured.
- `raw/<host>/` — curated per-part evidence (`partA-*` … `partD-*`,
  `host-proof.txt`), the `demand-curve-ladder.tsv` summary, and full per-run
  stdout under `ladder-runs/` (clean ladder) + `session-1547Z-runs/` (earlier
  session), each named `mem<MB>_cpu<N>_r<REP>.txt`.

## Host requirements & not-nested proof

The headline runs are on **bare metal** (real KVM, NVMe physically in the box).
Before any run, record and commit:

```bash
lscpu; free -h; uname -r
lsblk -d -o NAME,MODEL,TRAN,SIZE          # TRAN=nvme, disk in-chassis
ls -l /dev/kvm                            # must exist
systemd-detect-virt                       # must print: none  (bare metal)
```

If `systemd-detect-virt` is anything but `none`, the run is labeled as such. The
`gcp-n2-nested/` rows are exactly that — a couple of configs (not the full ladder)
on a **nested-virt** shared cloud VM, kept only as a labeled comparison point.

## Reproduce

On a fresh Ubuntu bare-metal host with Docker, Node ≥22, Firecracker + `/dev/kvm`:

```bash
# one-time: clone hotcell, build the guest agent to a reboot-persistent path
git clone https://github.com/directionally-local/hotcell.git ~/hotcell
(cd ~/hotcell/agent && GOOS=linux GOARCH=amd64 go build -o ~/hotcell-agent-linux-amd64 ./cmd/hotcell-agent)

# memory ladder (fixed 8 vCPU), 3 cold runs per rung (14336 = the 14 GiB rung):
CONFIGS="4096:8 6144:8 8192:8 12288:8 14336:8 16384:8 32768:8" REPS=3 REGION=hetzner-5950x-baremetal \
  bash ~/hotcell/evidence/opencode-benchmark/harness/bench-suite.sh

# CPU ladder (fixed 32 GiB, above the floor):
CONFIGS="32768:2 32768:4 32768:8 32768:16" REPS=3 REGION=hetzner-5950x-baremetal \
  bash ~/hotcell/evidence/opencode-benchmark/harness/bench-suite.sh

# the published 32 vCPU max-config row is its OWN 5-rep session (not the REPS=3 ladder):
CONFIGS="32768:32" REPS=5 REGION=hetzner-5950x-baremetal \
  bash ~/hotcell/evidence/opencode-benchmark/harness/bench-suite.sh
```

Results land in `/tmp/bench-suite/` (raw per run + `summary.tsv`); copy them into
`raw/<host>/` and commit.

**The published tweet row is the `32768:32` rung** (32 vCPU / 32 GiB, all 16 cores +
SMT) — its own 5-rep session from the command above, raw in
`raw/hetzner-5950x/32vcpu-5reps.txt`.

**Part A3 — default-deny egress ON (guest has no NIC; all egress via the vsock
gateway):** done — 3/3 PASS at **46.211 s** median Workload total, no measurable
cost vs the NAT rung at the same config. The `ALLOWLIST_EXTRA` delta this workload
needs was measured from the denial evidence over five attempts (which also surfaced
two product bugs, since fixed): `nodejs.org,api.github.com,pkg.pr.new`. Raw + the
full iteration history: `raw/hetzner-5950x/partA-egress-enforced.txt`.

## Disclosure

- **Cold caches.** The benchmark drops the guest page cache (`echo 3 >
  /proc/sys/vm/drop_caches`) and prints `BENCH_CACHE guest_page_cache dropped`.
  On a real kernel (Firecracker microVM) this succeeds — the numbers are truly
  cold. A container that can't drop caches prints `unavailable`; its "cold"
  number is warmed by the host page cache. Confirm every run shows `dropped`.
- **node-gyp workaround (a hotcell bug, not a benchmark issue).** In our microVM
  guest, `bun install` source-builds `tree-sitter-powershell` instead of using the
  prebuilt that ships in the tarball — the prebuilt is present and verified in the
  guest (952 KB) — and then crashes because `node-gyp` isn't on PATH. The identical
  stock script on the bare host completes fine, with `node-gyp` equally absent.
  Platform, arch, Node ABI and libc are byte-identical between host and guest. Root
  cause is open. Workaround: the hotcell guest image puts npm's bundled `node-gyp`
  on PATH (`helpers/hotcell-vz/convert-image.sh` — the OCI→rootfs converter shared by
both microVM drivers; the `hotcell-vz` dir name is legacy from the sbx-vz era). Cost: install is ~1.3s slower than
  our own host (guest median 13.437s vs host 12.112s). The memory floor is unaffected — the source build
  is install-phase; the OOM is typecheck-phase. Details: `raw/hetzner-5950x/nodegyp-diagnostic.txt`.
- **Guest specs are the guest's.** The table reads the guest's own `/proc`, so
  `CPU / RAM` is the microVM's, never the host's. The host is deliberately larger.
