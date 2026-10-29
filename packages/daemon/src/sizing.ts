/**
 * Per-agent density sizing — one model shared by the installer, the dashboard
 * and the website calculator, so none of them invents its own "this server fits
 * ~N agents" arithmetic.
 *
 * The model is deliberately boring: `people × agents per person × peak fraction
 * × profile footprint`, plus the driver's per-sandbox baseline, plus headroom.
 * What it is *not* is a guess. Every footprint field carries the evidence it
 * came from, and a field with no measurement is `null` rather than a plausible
 * number. `sizeHost()` reports those gaps in `missing` and sets `ok: false`, so
 * a caller can render "not measured yet" instead of a confident lie.
 *
 * See `docs/benchmarks.md` ("Per-agent density") for the table this feeds and
 * the procedure that fills it in.
 */

/** Workload profiles the density benchmark measures. */
export type WorkloadProfile = "light" | "medium" | "heavy";

/** Runtime drivers with a distinct per-sandbox baseline. */
export type SizingDriver = "container" | "firecracker" | "applevz";

/** One agent's footprint for a workload profile, excluding the driver baseline. */
export interface ProfileFootprint {
  profile: WorkloadProfile;
  label: string;
  /** Peak resident memory for one agent, MiB. `null` = not measured. */
  peakMemoryMb: number | null;
  /** Average resident memory for one agent, MiB. `null` = not measured. */
  avgMemoryMb: number | null;
  /** Burst vCPU for one agent (what a typecheck or build actually takes). */
  burstCpus: number | null;
  /** Average vCPU for one agent over a task. */
  avgCpus: number | null;
  /** Disk for one agent, GiB: repo + dependencies + caches. */
  diskGb: number | null;
  /** Where these numbers come from, in one line. */
  basis: string;
  /** True only when every field above came from a measurement on a real host. */
  measured: boolean;
}

/** Per-sandbox overhead the runtime adds on top of the workload itself. */
export interface DriverBaseline {
  driver: SizingDriver;
  label: string;
  /** Host memory per live sandbox, MiB. `null` = not measured. */
  memoryMb: number | null;
  basis: string;
  measured: boolean;
}

/**
 * Measured footprints. Only `heavy` has any measurement today (the sandbox-dax
 * demand curve); the other two are `null` on purpose — see the issue this
 * implements. Fill them in from a measured run (see docs/benchmarks.md).
 */
export const SIZING_PROFILES: Readonly<Record<WorkloadProfile, ProfileFootprint>> = {
  light: {
    profile: "light",
    label: "scripts / small Python repo",
    peakMemoryMb: null,
    avgMemoryMb: null,
    burstCpus: null,
    avgCpus: null,
    diskGb: null,
    basis: "not measured — see docs/benchmarks.md § Per-agent density for the procedure",
    measured: false,
  },
  medium: {
    profile: "medium",
    label: "typical TypeScript web app (~92k lines)",
    peakMemoryMb: null,
    avgMemoryMb: null,
    burstCpus: null,
    avgCpus: null,
    diskGb: null,
    basis: "not measured — see docs/benchmarks.md § Per-agent density for the procedure",
    measured: false,
  },
  heavy: {
    profile: "heavy",
    label: "large monorepo with slow builds",
    // sandbox-dax: peak working set 11.0–14.2 GiB across byte-identical reps;
    // 16 GiB flipped between pass and OOM, ≥ 24 GiB never failed.
    peakMemoryMb: 24 * 1024,
    avgMemoryMb: null,
    // CPU knee: 30.7 s at 8 vCPU, 20.2 s at 16, 17.4 s at 32 — past 16 buys little.
    burstCpus: 16,
    avgCpus: null,
    diskGb: null,
    basis:
      "peak memory floor and CPU knee measured (sandbox-dax, docs/benchmarks.md); " +
      "average memory, average CPU and disk not measured",
    measured: false,
  },
};

/** Measured per-sandbox runtime overhead. */
export const DRIVER_BASELINES: Readonly<Record<SizingDriver, DriverBaseline>> = {
  container: {
    driver: "container",
    label: "Docker container",
    // Shared kernel: the runtime's own per-sandbox cost is a few MiB and has not
    // been isolated from the workload. Counting 0 under-reports slightly; it is
    // the honest choice until the benchmark separates the two.
    memoryMb: 0,
    basis: "shared kernel; per-sandbox runtime overhead not separately measured (counted as 0)",
    measured: false,
  },
  firecracker: {
    driver: "firecracker",
    label: "Firecracker microVM",
    // npm run bench:density, 2026-07-17, n2-standard-4 nested-virt: ~54 MiB host
    // memory per live idle microVM.
    memoryMb: 54,
    basis: "measured 2026-07-17 via `npm run bench:density` (n2-standard-4 nested-virt): ~54 MiB per live idle microVM",
    measured: true,
  },
  applevz: {
    driver: "applevz",
    label: "Apple Virtualization microVM",
    memoryMb: null,
    basis: "not measured — see docs/benchmarks.md § Per-agent density for the procedure",
    measured: false,
  },
};

export interface SizingInput {
  /** People sharing the host. Default 1. */
  people?: number;
  /** Agents each person runs at once. Default 1. */
  agentsPerPerson?: number;
  /** Workload profile. Default `medium`. */
  profile?: WorkloadProfile;
  /** Runtime driver. Default `container`. */
  driver?: SizingDriver;
  /**
   * Fraction of agents at peak at the same moment, 0 < f ≤ 1. Default 1 —
   * assume they all peak together, which is what admission control must survive.
   */
  peakFraction?: number;
  /** Multiplier for OS, page cache and the daemon itself. Default 1.25. */
  headroom?: number;
}

export interface SizingResult {
  /** False when any footprint field needed for the totals is unmeasured. */
  ok: boolean;
  profile: WorkloadProfile;
  driver: SizingDriver;
  agents: number;
  peakFraction: number;
  headroom: number;
  perAgent: {
    peakMemoryMb: number | null;
    avgMemoryMb: number | null;
    burstCpus: number | null;
    avgCpus: number | null;
    diskGb: number | null;
    baselineMb: number | null;
  };
  /** Host resources to provision. `null` where the inputs are unmeasured. */
  totals: {
    memoryMb: number | null;
    /** Peak vCPU: what the host must absorb when every agent bursts at once. */
    vcpus: number | null;
    /** Average vCPU: what the host sustains over a task. */
    vcpusAverage: number | null;
    diskGb: number | null;
  };
  /** Footprint fields with no measurement behind them. */
  missing: string[];
  /** Human-readable provenance for the numbers above. */
  notes: string[];
}

const PROFILES: readonly WorkloadProfile[] = ["light", "medium", "heavy"];
const DRIVERS: readonly SizingDriver[] = ["container", "firecracker", "applevz"];

export function isWorkloadProfile(value: unknown): value is WorkloadProfile {
  return typeof value === "string" && (PROFILES as readonly string[]).includes(value);
}

export function isSizingDriver(value: unknown): value is SizingDriver {
  return typeof value === "string" && (DRIVERS as readonly string[]).includes(value);
}

/** Round up to a whole MiB / vCPU / GiB — you cannot provision a fraction. */
function ceil(value: number): number {
  return Math.ceil(value);
}

/**
 * Size a host for `people × agentsPerPerson` agents on one profile and driver.
 *
 * Throws on out-of-range input (negative counts, `peakFraction` outside (0, 1],
 * `headroom` below 1) rather than silently clamping — a calculator that quietly
 * fixes your numbers is worse than one that refuses them.
 */
export function sizeHost(input: SizingInput = {}): SizingResult {
  const people = input.people ?? 1;
  const agentsPerPerson = input.agentsPerPerson ?? 1;
  const profile = input.profile ?? "medium";
  const driver = input.driver ?? "container";
  const peakFraction = input.peakFraction ?? 1;
  const headroom = input.headroom ?? 1.25;

  if (!isWorkloadProfile(profile)) {
    throw new Error(`unknown profile "${String(profile)}" (expected ${PROFILES.join(", ")})`);
  }
  if (!isSizingDriver(driver)) {
    throw new Error(`unknown driver "${String(driver)}" (expected ${DRIVERS.join(", ")})`);
  }
  if (!Number.isFinite(people) || people < 0) throw new Error("people must be a number ≥ 0");
  if (!Number.isFinite(agentsPerPerson) || agentsPerPerson < 0) {
    throw new Error("agentsPerPerson must be a number ≥ 0");
  }
  if (!Number.isFinite(peakFraction) || peakFraction <= 0 || peakFraction > 1) {
    throw new Error("peakFraction must be > 0 and ≤ 1");
  }
  if (!Number.isFinite(headroom) || headroom < 1) throw new Error("headroom must be ≥ 1");

  const footprint = SIZING_PROFILES[profile];
  const baseline = DRIVER_BASELINES[driver];
  const agents = Math.floor(people * agentsPerPerson);
  const concurrent = agents * peakFraction;

  const missing: string[] = [];
  const notes: string[] = [];

  const peakMemoryMb = footprint.peakMemoryMb;
  const baselineMb = baseline.memoryMb;
  if (peakMemoryMb === null) missing.push("peakMemoryMb");
  if (baselineMb === null) missing.push("baselineMb");
  if (footprint.burstCpus === null) missing.push("burstCpus");
  if (footprint.avgCpus === null) missing.push("avgCpus");
  if (footprint.diskGb === null) missing.push("diskGb");

  const memoryMb =
    peakMemoryMb === null || baselineMb === null
      ? null
      : ceil(concurrent * (peakMemoryMb + baselineMb) * headroom);
  const vcpus = footprint.burstCpus === null ? null : ceil(concurrent * footprint.burstCpus);
  const vcpusAverage = footprint.avgCpus === null ? null : ceil(concurrent * footprint.avgCpus);
  const diskGb = footprint.diskGb === null ? null : ceil(agents * footprint.diskGb * headroom);

  notes.push(`profile ${profile} (${footprint.label}): ${footprint.basis}`);
  notes.push(`driver ${driver} (${baseline.label}): ${baseline.basis}`);
  notes.push(
    `${agents} agent(s) × ${peakFraction} peak fraction × ${headroom} headroom; ` +
      "memory is the admission-control gate, CPU is throttled rather than fatal",
  );
  if (!footprint.measured) notes.push(`profile ${profile} is not fully measured — totals are incomplete`);
  if (!baseline.measured) notes.push(`driver ${driver} baseline is not fully measured`);

  return {
    ok: missing.length === 0,
    profile,
    driver,
    agents,
    peakFraction,
    headroom,
    perAgent: {
      peakMemoryMb,
      avgMemoryMb: footprint.avgMemoryMb,
      burstCpus: footprint.burstCpus,
      avgCpus: footprint.avgCpus,
      diskGb: footprint.diskGb,
      baselineMb,
    },
    totals: { memoryMb, vcpus, vcpusAverage, diskGb },
    missing,
    notes,
  };
}
