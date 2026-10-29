/**
 * Agent-density benchmark — how much RAM, vCPU and disk one *working* agent
 * takes, per workload profile and driver.
 *
 * This is the measurement behind `docs/benchmarks.md` § Per-agent density and
 * the constants in `sizing.ts`. It runs a realistic agent task (install,
 * typecheck, tests) inside real sandboxes and samples each one's RSS and CPU
 * while it works — an idle sandbox is not an agent, and boot-time numbers do
 * not answer this question.
 *
 * Usage (needs a running daemon; the container driver needs Docker):
 *
 *   HOTCELL_ENDPOINT=http://127.0.0.1:4750 HOTCELL_API_KEY=... \
 *     node packages/daemon/dist/agent-density-bench.js --profile light
 *
 *   --profile light|medium|heavy|all   (default: all)
 *   --agents N                         sandboxes to run concurrently (default 1)
 *   --driver container|firecracker|applevz (default container)
 *   --sample-ms N                      sampling interval (default 250)
 *   --json                             machine-readable output only
 *   --density                          step 2: create agents until admission refuses
 *
 * Env:
 *   HOTCELL_DENSITY_IMAGE   sandbox image (default ghcr.io/sinameraji/hotcell-base:latest)
 *   HOTCELL_DENSITY_REPO    git URL for the medium/heavy profiles
 *   HOTCELL_DENSITY_REF     branch/tag to check out (default: default branch)
 *
 * Report the band, not one rep: run it at least three times. The sandbox-dax
 * memory floor moved 11.0–14.2 GiB across byte-identical runs.
 */

const ENDPOINT = (process.env.HOTCELL_ENDPOINT ?? "http://127.0.0.1:4750").replace(/\/$/, "");
const API_KEY = process.env.HOTCELL_API_KEY ?? process.env.SBX_API_KEY ?? "";
const IMAGE = process.env.HOTCELL_DENSITY_IMAGE ?? "ghcr.io/sinameraji/hotcell-base:latest";
const REPO = process.env.HOTCELL_DENSITY_REPO ?? "https://github.com/excalidraw/excalidraw.git";
const REF = process.env.HOTCELL_DENSITY_REF ?? "";

type ProfileName = "light" | "medium" | "heavy";

interface Profile {
  name: ProfileName;
  label: string;
  /** Sandbox cap for the run. Generous: we want the workload's own peak. */
  memoryMb: number;
  cpus: number;
  /** Commands that prepare the workspace. Not measured. */
  setup: string[];
  /** The measured task — what an agent actually does. */
  task: string;
  /** Paths summed for the disk figure. */
  diskPaths: string[];
}

const LIGHT_REPO = `set -e
mkdir -p /workspace/app/src
cd /workspace/app
for i in $(seq 1 40); do
  cat > "src/mod$i.py" <<EOF
def f$i(x):
    return x * $i
EOF
done
cat > main.py <<'EOF'
import glob
import importlib.util
import os

total = 0
for path in sorted(glob.glob("src/*.py")):
    name = os.path.basename(path)[:-3]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    total += getattr(mod, "f" + name[3:])(2)
print("ok", total)
EOF
`;

const PROFILES: Record<ProfileName, Profile> = {
  light: {
    name: "light",
    label: "scripts / small Python repo",
    memoryMb: 1024,
    // Generous caps: a tight cap would measure the cap, not the workload.
    cpus: 4,
    setup: [LIGHT_REPO],
    // Long enough to sample: a real script workload is not a 300 ms blip.
    task: "cd /workspace/app && python3 -m compileall -q src && for i in $(seq 1 200); do python3 main.py > /dev/null; done",
    diskPaths: ["/workspace/app"],
  },
  medium: {
    name: "medium",
    label: "typical TypeScript web app (~92k lines)",
    memoryMb: 6144,
    cpus: 4,
    setup: [
      `set -e
rm -rf /workspace/app
git clone --depth 1 ${REF ? `--branch ${REF} ` : ""}${REPO} /workspace/app
cd /workspace/app
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi`,
    ],
    task: "cd /workspace/app && npx tsc --noEmit -p . || npx tsc --noEmit",
    diskPaths: ["/workspace/app"],
  },
  heavy: {
    name: "heavy",
    label: "large monorepo with slow builds",
    memoryMb: 8192,
    cpus: 4,
    setup: [
      `set -e
rm -rf /workspace/app
git clone --depth 1 ${REF ? `--branch ${REF} ` : ""}${REPO} /workspace/app
cd /workspace/app
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi`,
    ],
    task: "cd /workspace/app && npx tsc --noEmit -p . || npx tsc --noEmit",
    diskPaths: ["/workspace/app"],
  },
};

// --- tiny API client ---------------------------------------------------------

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

interface ExecResult {
  code: number;
  out: string;
}

/** Run a command, consuming the exec SSE stream until the exit event. */
async function exec(id: string, command: string, cwd?: string): Promise<ExecResult> {
  const res = await fetch(`${ENDPOINT}/sandboxes/${id}/exec`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({ command, ...(cwd ? { cwd } : {}) }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`exec → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  let out = "";
  let code = -1;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as
        | { type: "stdout" | "stderr"; data: string }
        | { type: "exit"; exitCode: number };
      if (event.type === "exit") code = event.exitCode;
      else out += event.data;
    }
  }
  return { code, out };
}

interface LiveStats {
  cpuTotalUsageNs: number;
  memBytes: number;
}

async function stats(id: string): Promise<LiveStats | null> {
  const body = await api<{ live: LiveStats | null }>("GET", `/sandboxes/${id}/metrics`);
  return body.live;
}

// --- measurement -------------------------------------------------------------

interface Sample {
  at: number;
  memBytes: number;
  cores: number;
}

interface AgentResult {
  id: string;
  peakMemMb: number;
  avgMemMb: number;
  burstCores: number;
  avgCores: number;
  diskMb: number;
  taskMs: number;
  exitCode: number;
  /** Tail of the task's output, kept so a non-zero exit is diagnosable. */
  output: string;
}

async function measureAgent(profile: Profile, index: number, sampleMs: number): Promise<AgentResult> {
  // The daemon assigns the id; use whatever it returns.
  const created = await api<{ id: string }>("POST", "/sandboxes", {
    image: IMAGE,
    driver: DRIVER,
    memoryMb: profile.memoryMb,
    cpus: profile.cpus,
    persist: false,
    networked: true,
  });
  const id = created.id;

  try {
    for (const command of profile.setup) {
      const setup = await exec(id, command);
      if (setup.code !== 0) {
        throw new Error(`setup failed (${setup.code}): ${setup.out.slice(-400)}`);
      }
    }

    const samples: Sample[] = [];
    let prev: { at: number; cpuNs: number } | null = null;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const live = await stats(id);
          if (!live) return;
          const now = Date.now();
          const cores =
            prev === null
              ? 0
              : (live.cpuTotalUsageNs - prev.cpuNs) / 1e9 / ((now - prev.at) / 1000);
          prev = { at: now, cpuNs: live.cpuTotalUsageNs };
          samples.push({ at: now, memBytes: live.memBytes, cores: Math.max(0, cores) });
        } catch {
          // Sandbox may be mid-restart; skip this sample.
        }
      })();
    }, sampleMs);

    const started = Date.now();
    const task = await exec(id, profile.task);
    const taskMs = Date.now() - started;
    clearInterval(timer);

    const disk = await exec(id, `du -sm ${profile.diskPaths.join(" ")} 2>/dev/null | awk '{s+=$1} END {print s+0}'`);
    const diskMb = Number(disk.out.trim()) || 0;

    const mems = samples.map((s) => s.memBytes / (1024 * 1024));
    const cores = samples.map((s) => s.cores);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

    return {
      id,
      peakMemMb: Math.round(mems.length ? Math.max(...mems) : 0),
      avgMemMb: Math.round(mean(mems)),
      burstCores: Math.round(Math.max(0, ...cores) * 100) / 100,
      avgCores: Math.round(mean(cores) * 100) / 100,
      diskMb,
      taskMs,
      exitCode: task.code,
      output: task.out.slice(-600),
    };
  } finally {
    await api("DELETE", `/sandboxes/${id}`).catch(() => {});
  }
}

/** Idle footprint of a bare sandbox — the driver baseline, no workload. */
async function measureBaseline(sampleMs: number): Promise<{ peakMemMb: number; avgMemMb: number }> {
  const created = await api<{ id: string }>("POST", "/sandboxes", {
    image: IMAGE,
    driver: DRIVER,
    memoryMb: 512,
    cpus: 1,
    persist: false,
    networked: true,
  });
  const id = created.id;
  try {
    const mems: number[] = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, sampleMs));
      const live = await stats(id);
      if (live) mems.push(live.memBytes / (1024 * 1024));
    }
    const mean = mems.length ? mems.reduce((a, b) => a + b, 0) / mems.length : 0;
    return {
      peakMemMb: Math.round(mems.length ? Math.max(...mems) : 0),
      avgMemMb: Math.round(mean),
    };
  } finally {
    await api("DELETE", `/sandboxes/${id}`).catch(() => {});
  }
}

/**
 * Step 2 of the density question: on one fixed host, how many agents run before
 * admission control refuses the next create? Sandboxes are created one at a
 * time and each starts the profile's task immediately, so the host carries a
 * growing set of *working* agents rather than a pile of idle ones.
 */
async function runDensity(
  profile: Profile,
  sampleMs: number,
): Promise<{ created: number; refused: boolean; capacity: unknown }> {
  const ids: string[] = [];
  const running: Array<Promise<unknown>> = [];
  let refused = false;

  for (let i = 0; i < 64; i++) {
    let id: string;
    try {
      const created = await api<{ id: string }>("POST", "/sandboxes", {
        image: IMAGE,
        driver: DRIVER,
        memoryMb: profile.memoryMb,
        cpus: profile.cpus,
        persist: false,
        networked: true,
      });
      id = created.id;
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 503 || status === 429) {
        refused = true;
        break;
      }
      throw err;
    }
    ids.push(id);
    // Fire the task and move on: the point is concurrent working agents.
    running.push(exec(id, profile.task).catch(() => undefined));
    if (!JSON_ONLY) console.error(`[density]   agent ${ids.length} up (${id})`);
    // Give the sampler time to see this agent's real footprint before the next
    // create, otherwise admission only ever sees the reservation floor.
    await new Promise((r) => setTimeout(r, Math.max(sampleMs * 8, 4000)));
  }

  const capacity = await api<unknown>("GET", "/capacity").catch(() => null);
  for (const id of ids) await api("DELETE", `/sandboxes/${id}`).catch(() => {});
  await Promise.allSettled(running);
  return { created: ids.length, refused, capacity };
}

// --- main --------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const DRIVER = flag("driver") ?? "container";
const AGENTS = Number(flag("agents") ?? "1");
const SAMPLE_MS = Number(flag("sample-ms") ?? "250");
const JSON_ONLY = argv.includes("--json");
const DENSITY = argv.includes("--density");
const requested = flag("profile") ?? "all";
const names: ProfileName[] =
  requested === "all" ? ["light", "medium", "heavy"] : [requested as ProfileName];

async function main(): Promise<number> {
  for (const name of names) {
    if (!PROFILES[name]) {
      console.error(`[density] unknown profile "${name}" (light, medium, heavy, all)`);
      return 2;
    }
  }

  if (DENSITY) {
    const profile = PROFILES[names[0]];
    if (!JSON_ONLY) {
      console.error(
        `[density] density mode: ${profile.name} agents until admission refuses ` +
          `(driver=${DRIVER}, image=${IMAGE})`,
      );
    }
    const result = await runDensity(profile, SAMPLE_MS);
    if (!JSON_ONLY) {
      console.error(
        `[density] ${result.created} agent(s) ran concurrently` +
          (result.refused ? "; the next create was refused" : "; never refused (hit the 64 cap)"),
      );
    }
    console.log(JSON.stringify({ driver: DRIVER, image: IMAGE, profile: profile.name, ...result }, null, 2));
    return 0;
  }

  const baseline = await measureBaseline(SAMPLE_MS);
  if (!JSON_ONLY) {
    console.error(
      `[density] driver=${DRIVER} image=${IMAGE} agents=${AGENTS} sample=${SAMPLE_MS}ms`,
    );
    console.error(
      `[density] idle sandbox baseline: peak ${baseline.peakMemMb} MiB, avg ${baseline.avgMemMb} MiB`,
    );
  }

  const rows: Array<{ profile: ProfileName; label: string; agents: AgentResult[] }> = [];
  for (const name of names) {
    const profile = PROFILES[name];
    if (!JSON_ONLY) console.error(`[density] ${name}: ${profile.label} — ${AGENTS} agent(s)…`);
    const agents = await Promise.all(
      Array.from({ length: AGENTS }, (_, i) => measureAgent(profile, i, SAMPLE_MS)),
    );
    rows.push({ profile: name, label: profile.label, agents });
    if (!JSON_ONLY) {
      for (const a of agents) {
        console.error(
          `[density]   ${a.id}: peak ${a.peakMemMb} MiB · avg ${a.avgMemMb} MiB · ` +
            `burst ${a.burstCores} cores · avg ${a.avgCores} cores · disk ${a.diskMb} MiB · ` +
            `${(a.taskMs / 1000).toFixed(1)}s · exit ${a.exitCode}`,
        );
        if (a.exitCode !== 0) console.error(`[density]     output: ${a.output.trim()}`);
      }
    }
  }

  const report = {
    driver: DRIVER,
    image: IMAGE,
    agents: AGENTS,
    sampleMs: SAMPLE_MS,
    baseline,
    rows,
  };
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[density] ${(err as Error).message}`);
    process.exit(1);
  },
);
