# Benchmarks

hotcell measured with [computesdk/benchmarks](https://github.com/computesdk/benchmarks) — the same open-source harness behind the public [sandbox provider leaderboard](https://www.computesdk.com/benchmarks/sandboxes/).

Run on 2026-07-19/20 against hotcell v0.1.10 (`main@d897b0c`). Provider numbers quoted for context are from that project's published run of 2026-07-17.

The four TTI benchmarks were run through the ComputeSDK harness unmodified. The container-agent operation table is a separate same-host microbenchmark. The [real-workload benchmark](#sandbox-dax) is the same underlying script run through hotcell's own harness on bare metal — that section says so and links the raw output.

## Read this before quoting any number

**hotcell's numbers have no network in them; the leaderboard's do.** The public benchmark runs on a US CI runner and calls each provider's cloud API over the internet. hotcell is self-hosted, so the harness ran on the same machine as the daemon. That is the honest operating condition for a self-hosted sandbox — and it is *not* an apples-to-apples comparison with a hosted provider's number. Where this page compares, it says so explicitly.

Nothing here is an official leaderboard result. hotcell is not listed on that leaderboard (see [Getting officially listed](#getting-officially-listed)).

## The benchmarks

The suite measures **TTI (Time to Interactive)**: wall-clock from `create()` to the first successful `runCommand("node -v")`. Teardown is not timed. Scoring is `(0.60·median + 0.25·p95 + 0.15·p99)` scored against a 10-second ceiling, multiplied by success rate — 0–100, higher is better.

| Benchmark | What it does | What it exposes |
| --- | --- | --- |
| [Sequential TTI](#sequential-tti) | 100 sandboxes, one at a time | Cold-start latency with no contention |
| [Staggered TTI](#staggered-tti) | 100 sandboxes launched 200 ms apart | Degradation as load ramps |
| [Burst TTI](#burst-tti) | 100 sandboxes created simultaneously | Behaviour under a thundering herd |
| [Warm-pool adopt](#warm-pool-adopt) | Create against a pre-booted pool | The floor when a microVM is already running |
| [Container-agent operations](#container-agent-operations) | Repeated exec and file operations through old Docker exec and the guest agent | Per-operation driver overhead; supplemental, not TTI |
| [Container warm-pool burst](#container-warm-pool-burst) | 25 concurrent create+probe calls, pool depth 25 | Burst improvement and the cost of holding ready containers |
| [sandbox-dax](#sandbox-dax) | Clone + install + typecheck a real repo | Real dev-workload throughput, and the memory/CPU a real build actually demands |

Hardware: **Mac** = M-series, 8 cores / 16 GB, Docker Desktop with an 8 GB VM. **GCP** = 8 vCPU / 32 GB, nested virtualisation.

### Container-agent operations

Supplemental same-host microbenchmark, separate from the ComputeSDK TTI suite. The baseline reproduces the pre-agent `ContainerDriver` Docker-exec implementations at `288e7d4`; the agent column uses the current `ContainerDriver`. Both use `python:3.11-slim-bookworm`, persistent Docker volumes, the same Docker Desktop host, and 126-byte file contents. Each operation had 5 warmups and 50 measured samples; baseline and agent samples alternated to reduce order bias. Container startup is excluded. `exec` runs `true`; `writeFile` and `readFile` operate on the same file.

| Operation | Docker exec median | Docker exec P95 | Guest agent median | Guest agent P95 | Median speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| `exec` | 53.63 ms | 77.88 ms | **6.44 ms** | 16.05 ms | **8.33×** |
| `writeFile` | 54.51 ms | 70.67 ms | **3.47 ms** | 11.57 ms | **15.71×** |
| `readFile` | 46.77 ms | 66.25 ms | **2.92 ms** | 7.20 ms | **16.02×** |

Measured 2026-10-28 on macOS arm64 with Docker Desktop 29.5.2 (Docker engine aarch64, 8 vCPU, 7,936 MiB). Because Docker Desktop does not forward the host-mounted Unix socket used on Linux, the current agent column uses the new authenticated loopback TCP transport. These figures are specific to this host/runtime and are not a Linux Unix-socket measurement or a TTI score.

Reproduce with `HOTCELL_BENCH_ITERATIONS=50 npm run bench:container-agent` (requires Docker; the script builds the guest binary/daemon and removes its temporary containers and volumes).

### Container warm-pool burst

Supplemental driver-level burst measurement, not an official ComputeSDK TTI row. On 2026-10-28, 25 concurrent `ContainerDriver.create()` calls were followed by `exec("python3 -V")`; the cold path had no pool and the warm path adopted 25 pre-started containers. Both used `python:3.11-slim-bookworm` with an exact 64 MiB memory shape. The pool target therefore reserved 1,600 MiB, and the 25 active sandboxes were also capped at 64 MiB. Each path had two unmeasured warm-up bursts; the reported sample is one 25-wide burst.

| Path | Concurrency | Median create+probe | P95 | Success | Median speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold create | 25 | 1,844.58 ms | 2,391.57 ms | 25/25 | — |
| Warm-pool adopt | 25 | **517.42 ms** | **719.06 ms** | 25/25 | **3.56×** |

Host: macOS arm64, Docker Desktop 29.5.2 (Docker engine aarch64, 8 vCPU, 7,936 MiB). This is a direct driver create+probe measurement, not REST/SDK TTI; it demonstrates a 25-wide burst on this host, not the issue's 100-wide target. A pool only accelerates eligible requests while a spare is ready.

Reproduce with `HOTCELL_BENCH_POOL_DEPTH=25 HOTCELL_BENCH_MEMORY_MB=64 HOTCELL_BENCH_REPETITIONS=1 npm run bench:container-warm-pool` (requires Docker; the script cleans up temporary sandboxes and spares).

### Sequential TTI

100 iterations, one sandbox at a time. The leaderboard's headline metric.

| Driver | Host | Median | P95 | P99 | Success | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Container (Docker) | Mac | **210 ms** | 237 ms | 240 ms | 100/100 | 97.8 |
| Firecracker microVM (cold) | GCP | 2,559 ms | 2,568 ms | 2,573 ms | 100/100 | 74.4 |
| Apple VZ microVM (cold) | Mac | 2,618 ms | 2,712 ms | 2,724 ms | 100/100 | 73.4 |

The container driver's 210 ms is quick in absolute terms — the published leaderboard's mid-pack sits between 190 ms and 460 ms, with E2B at 373 ms and Modal at 458 ms, network included. If hotcell were hosted next to the benchmark's CI runners, a network allowance of roughly 20–80 ms would still leave it ahead of most of that pack. That allowance is an estimate, not a measurement: from the machine used for these runs, the round-trip to a cloud daemon was ~192 ms, which would erase the gap entirely. **Where you run it decides the number.**

Cold microVM boots are the opposite story: ~2.6 s is second-slowest against the published field, because every boot here is a real kernel boot with no pre-warming, while fast hosted providers serve from warm capacity. The fix is hotcell's own warm pool — see below.

Worth noting on its own: p95 lands 9 ms above the median on Firecracker and 94 ms on Apple VZ, across 100 cold boots. Boot time is highly predictable.

### Staggered TTI

100 sandboxes, one launched every 200 ms.

| Driver | Host | Concurrency | Median | P95 | Success | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Container | Mac | 100 | 300 ms | 347 ms | 100/100 | 96.8 |
| Apple VZ | Mac | 25 | 2,603 ms | 2,618 ms | 25/25 | 73.9 |
| Firecracker | GCP | 100 | 14,081 ms | 16,281 ms | 100/100 | 0 |

The container driver barely moves under a ramp (210 ms → 300 ms). Firecracker at 100 concurrent kernel boots on 8 vCPUs is CPU-bound — every sandbox came up, but the queue is the machine, not the driver. Apple VZ was capped at 25 because 100 microVMs exceed a 16 GB laptop; those rows are not comparable to a 100-wide run.

### Burst TTI

All sandboxes requested at once.

| Driver | Host | Concurrency | Median | P95 | Success | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Container | Mac | 25 | 1,796 ms | 2,412 ms | 25/25 | 79.5 |
| Container | Mac | 100 | 10,115 ms | 12,778 ms | 100/100 | 0 |
| Apple VZ | Mac | 25 | 3,176 ms | 3,382 ms | 25/25 | 67.4 |
| Firecracker | GCP | 100 | 32,027 ms | 32,626 ms | 97/100 | 0 |

**This is hotcell's weakest result, and it is structural.** A 100-wide burst measures how much capacity sits behind an API. Hosted providers spread it across a fleet; a self-hosted daemon has one machine, and 100 simultaneous kernel boots serialise on its CPUs. The leaderboard's fastest burst numbers (tens to hundreds of milliseconds) are fleet numbers. If you need a 100-wide burst to be fast on one box, size a warm pool to cover it.

The three Firecracker failures were typed `422 agent never came up` — vsock handshake timeouts during the boot storm, not hangs or crashes.

One earlier container burst-100 run, with the daemon's default 256 MiB per-sandbox reservation, completed only **30/100**: admission control refused 70 creates with a fast, typed `503 host memory budget exhausted` rather than over-subscribing the box. Re-running with a smaller reservation completed 100/100. That refusal is the designed behaviour — hotcell will not OOM the host to look good on a burst — but it is a real number and it belongs here.

### Warm-pool adopt

hotcell can keep pre-started container spares (`HOTCELL_CONTAINER_WARM_POOL`) and microVM guests (`HOTCELL_VZ_WARM_POOL`, `HOTCELL_FC_WARM_POOL`). Containers are adopted only for the exact pool image/resource shape; the microVM floor measured below is specifically Apple VZ.

**Measured floor: 24 ms median** (10 iterations: 33, 28, 21, 23, 27, 19, 24, 16, 24, 23 ms; min 16, max 33). Apple VZ, all ten confirmed adopted from the pool.

Caveats, because this number is attractive and easy to misuse:

- It is **not an official TTI measurement**. It used hotcell's Alpine base image and an `echo` probe with a custom timer, not the harness's `node:22-slim` + `node -v`. `node -v` alone adds process-spawn cost.
- n = 10, localhost.
- The documented defects that blocked normal adoption have since been fixed in the current code: daemon defaults are matched against pool limits, Apple VZ follows the configured pool image, refill is bounded-parallel, and pool reservations are included in admission accounting. The result above predates those fixes and must not be used as a current warm-pool TTI row.
- **Pool depth, not adopt latency, is the real constraint.** Refill is bounded-parallel, but still competes for host CPU and memory with foreground boots. A microVM pool only wins while an eligible spare is available; beyond pool depth, the request follows the cold path. Sizing a 100-wide microVM pool means holding 100 guests' worth of RAM, which no laptop has. Container pools have a different per-spare footprint; see the container burst measurement above.

Treat 24 ms as evidence that the adopt path itself is fast, not as a current official TTI result. Rerun the ComputeSDK harness with a matching image and resource shape, and set `WARM_POOL_DEPTH` in `evidence/opencode-benchmark/harness/bench-suite.sh` so the harness waits for the pool to fill before measuring.

### sandbox-dax

The suite's real-workload benchmark: inside one sandbox, download Bun, clone the OpenCode repo, `bun install`, `bun typecheck` — seven timed phases. The `sandbox-dax` mode runs [dax's OpenCode provider benchmark](https://github.com/anomalyco/opencode) (`script/provider-benchmark.sh` on the `provider-benchmark` branch).

**hotcell has run this workload extensively** — the same script, unmodified, on Firecracker microVMs. Full raw output for every run, including every failure, is in [`evidence/opencode-benchmark/`](../evidence/opencode-benchmark/). What follows is the summary; that directory is the source of truth.

One difference in provenance matters: those runs used hotcell's own harness (`bench-suite.sh` — cold microVM per run, sampled peak guest memory, outcomes classified `PASS`/`OOM`/`INSTALL_FLAKE`/`ADMISSION`), *not* ComputeSDK's `--mode sandbox-dax` wrapper. So there is no ComputeSDK-format score row for hotcell here. The underlying workload and its phase timings are the same; the reporting is deeper.

**Bare metal, Ryzen 9 5950X, 5 cold reps at 32 vCPU / 32 GiB** ([`32vcpu-5reps.txt`](../evidence/opencode-benchmark/raw/hetzner-5950x/32vcpu-5reps.txt)):

| Phase | Median |
| --- | --- |
| Clone | 4.34 s |
| Install | 13.44 s |
| Typecheck | 17.42 s |
| **Workload total** (clone + install + typecheck) | **35.385 s** |
| Full script total (all seven phases) | 58.45 s |

The same script on the bare host, no VM at all, totals 30.411 s ([`control-bare-host.txt`](../evidence/opencode-benchmark/raw/hetzner-5950x/control-bare-host.txt)) — so the microVM costs about 16 % on this workload, which is the honest price of the isolation.

Against the published 2026-07-17 run, where **only one of nineteen providers (Modal) completed all seven phases** — full-script total 62.594 s, install 20.361 s, typecheck 24.896 s, from a single iteration:

- At **32 vCPU** hotcell's full-script total is 58.45 s, about 7 % faster than Modal's — but on 32 dedicated bare-metal cores, which is almost certainly a larger machine than Modal's sandbox. Not a like-for-like win.
- At **8 vCPU** hotcell totals ~70 s, about 12 % *slower* than Modal.
- **Install came in under Modal's 20.4 s at every rung tested** (11.7–19.4 s), though only marginally so at 2 vCPU — it is bound more by disk than by cores.
- **Typecheck tracks cores**: 30.7 s at 8 vCPU, 20.2 s at 16, 17.4 s at 32 — so Modal's 24.9 s sits between hotcell's 8- and 16-vCPU rungs.

The more useful result is not a single row but the **demand curve** — what this workload actually requires, which no leaderboard reports:

- **Memory floor is a band, not a line.** Peak working set varies 11.0–14.2 GiB across byte-identical reps, so rungs near the edge flip: ≤ 8 GiB always OOMs, 12 GiB passed 1 of 3, 16 GiB passed 3 of 3 in one session but OOM'd in an earlier one, ≥ 24 GiB has never failed. Provision ≥ 24 GiB for this workload, not 16.
- **CPU knee at 8–16 vCPU.** Typecheck median at 32 GiB: 102.8 s (2 vCPU) → 53.9 s (4) → 30.7 s (8) → 20.2 s (16) → 17.4 s (32). Gains per doubling fall 1.91× → 1.76× → 1.52× → 1.16×. Past 16 cores you are buying very little.
- **Default-deny egress is free.** With the guest holding no NIC and all traffic crossing the vsock gateway, the same workload ran 3/3 at 46.211 s median at 8 vCPU — no measurable cost against the NAT rung at the same config. The workload needs exactly three allowlist entries (`nodejs.org`, `api.github.com`, `pkg.pr.new`), measured from denial logs.

Measuring this also surfaced and fixed three product bugs (a `writableRootfs` gap, a git 407-CONNECT failure, and a resume-path admission gap), and one open one: in the microVM guest `bun install` source-builds `tree-sitter-powershell` instead of using the shipped prebuilt, worked around by putting npm's bundled `node-gyp` on PATH at a cost of ~1.3 s. Root cause still open, documented in [`nodegyp-diagnostic.txt`](../evidence/opencode-benchmark/raw/hetzner-5950x/nodegyp-diagnostic.txt).

### Per-agent density

This is the number the installer's "this server fits ~N agents" line and any public "X more agents per machine" claim depend on: how much RAM, vCPU and disk one *working* agent takes. The boot-time and TTI numbers above do not answer it — an idle sandbox is not an agent.

**Status: partially measured.** Only the heavy profile has numbers, and only for memory and CPU. Empty cells are empty on purpose; nothing here is estimated.

| Profile | Driver | Peak RAM / agent | Avg RAM / agent | Burst vCPU | Avg vCPU | Disk / agent |
|---|---|---|---|---|---|---|
| light — scripts / small Python repo | container | — | — | — | — | — |
| light | firecracker | — | — | — | — | — |
| light | Apple VZ | — | — | — | — | — |
| medium — typical TS web app (~92k lines) | container | — | — | — | — | — |
| medium | firecracker | — | — | — | — | — |
| medium | Apple VZ | — | — | — | — | — |
| heavy — large monorepo, slow builds | container | 24 GiB floor | — | 16 | — | — |
| heavy | firecracker | 24 GiB floor + 54 MiB baseline | — | 16 | — | — |
| heavy | Apple VZ | — | — | — | — | — |

The heavy row comes from the sandbox-dax demand curve above: peak working set 11.0–14.2 GiB across byte-identical reps, 16 GiB flipping between pass and OOM, ≥ 24 GiB never failing; and the CPU knee at 8–16 vCPU (30.7 s at 8, 20.2 s at 16, 17.4 s at 32).

Per-sandbox runtime baseline, measured separately from the workload:

| Driver | Host RAM per live sandbox | Source |
|---|---|---|
| container | ~0 (shared kernel; not isolated from the workload) | not measured |
| firecracker | ~54 MiB | `npm run bench:density`, 2026-07-17, n2-standard-4 nested-virt |
| Apple VZ | — | not measured |

#### The model

`packages/daemon/src/sizing.ts` is the single implementation, so the installer, the dashboard and the website calculator cannot drift apart:

```
agents     = people × agentsPerPerson
concurrent = agents × peakFraction
memory     = ceil(concurrent × (peakMemoryMb + baselineMb) × headroom)
vcpus      = ceil(concurrent × burstCpus)
disk       = ceil(agents × diskGb × headroom)
```

Defaults are `peakFraction = 1` (assume every agent peaks at the same moment — that is what admission control has to survive) and `headroom = 1.25` (OS, page cache, the daemon itself).

An unmeasured input is `null`, never a plausible-looking number. `sizeHost()` then returns `ok: false` with a `missing` list, and every caller is expected to render "not measured" instead of a total. That is the point of the exercise: the alternative was a guess.

Surfaces: `POST /capacity/sizing`, `client.sizing()` in the TypeScript SDK, and `hotcell capacity --sizing`.

#### How to fill the table

Needs a Linux host with Docker and KVM (Firecracker), or macOS with the Apple VZ artifacts.

1. Run a realistic agent task per profile — install, typecheck, tests, build — not an idle loop.
2. Sample per-sandbox RSS and CPU at least once a second for the whole task (`GET /sandboxes/{id}/metrics`); record peak and mean.
3. Record disk after the task: workspace + dependencies + caches.
4. Repeat at least three times and report the band, not one rep — the sandbox-dax memory floor moved 11.0–14.2 GiB across byte-identical runs.
5. Paste the numbers into `SIZING_PROFILES` / `DRIVER_BASELINES` and set `measured: true` only when every field in that row is filled.

End-to-end density (the issue's step 2) is the same task repeated on one fixed host until admission control refuses the next create; record the host spec and the count.

## Summary

- **Cold-start latency for one sandbox is good** — 210 ms on the container driver, competitive with the hosted mid-pack even after a hosting allowance, provided you host it comparably.
- **Boot times are consistent** — microVM p95 within 9–94 ms of median over 100 cold boots.
- **Cold microVM boots are slow** — ~2.6 s, second-slowest against the published field, until warm pools cover real images.
- **Single-host burst is the weak spot** — one machine is one machine.
- **MicroVM boot concurrency is bounded by default** — `HOTCELL_MICROVM_BOOT_CONCURRENCY` defaults to 4 and queued creates are visible through `/capacity.boot`; tune this per host rather than launching an unbounded boot storm.
- **Failures are clean** — typed 4xx/5xx from admission control, no hangs; 11 of 13 runs at 100 % success, worst case 30/100 under deliberate memory pressure.
- **Real build workloads run at roughly a 16 % virtualisation cost**, with default-deny egress adding nothing measurable — and the demand curve behind that number (memory floor, CPU knee) is published rather than reduced to one row.

## Reproducing this

The harness talks to any endpoint, so a local daemon works:

```bash
git clone https://github.com/computesdk/benchmarks && cd benchmarks && npm install
```

Add a provider that wraps the hotcell SDK (`src/sandbox/hotcell-provider.ts`):

```ts
import { HotcellClient } from '@hotcell/sdk';

export function hotcell(opts: { endpoint: string; apiKey?: string; image?: string; driver?: string }) {
  const client = new HotcellClient({ endpoint: opts.endpoint, apiKey: opts.apiKey });
  return {
    sandbox: {
      create: async () => {
        const sb = await client.getSandbox(undefined, { image: opts.image, driver: opts.driver });
        return {
          sandboxId: sb.id,
          runCommand: async (cmd: string) => {
            const r = await sb.exec(cmd);
            return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
          },
          destroy: () => sb.destroy(),
        };
      },
    },
  };
}
```

Register it in `src/sandbox/providers.ts`, then:

```bash
HOTCELL_IMAGE=node:22-slim hotcelld &          # the probe is `node -v` — the image needs Node
export HOTCELL_ENDPOINT=http://127.0.0.1:4750

npx tsx src/run.ts --provider hotcell --mode sequential --iterations 100
npx tsx src/run.ts --provider hotcell --mode staggered --concurrency 100 --stagger-delay 200
npx tsx src/run.ts --provider hotcell --mode burst      --concurrency 100
```

Pick concurrency your host can actually hold — the numbers above show what happens when you don't.

## Getting officially listed

hotcell does not appear on the public leaderboard. That requires a `@computesdk/<provider>` package merged into [computesdk/computesdk](https://github.com/computesdk/computesdk) (they publish it), a publicly reachable production endpoint, and credentials handed to the maintainers for the weekly run. Until then, everything here is self-reported and reproducible with the commands above.
