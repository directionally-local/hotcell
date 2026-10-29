import { HotcellClient } from "@hotcell/sdk";
import type { SizingDriver, SizingInput, WorkloadProfile } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";
import { formatError } from "./util.js";

/** Parse a numeric flag, or undefined when absent. */
function num(flags: Record<string, string | boolean>, key: string): number | undefined {
  const raw = flags[key];
  if (raw === undefined || raw === true) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number`);
  return value;
}

/** hotcell capacity — show host memory budget, what's committed, and how many more fit. */
export async function capacityCommand(
  _positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean> = {},
): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });

  if (flags.sizing) {
    const input: SizingInput = {
      people: num(flags, "people"),
      agentsPerPerson: num(flags, "agents"),
      profile: typeof flags.profile === "string" ? (flags.profile as WorkloadProfile) : undefined,
      driver: typeof flags.driver === "string" ? (flags.driver as SizingDriver) : undefined,
      peakFraction: num(flags, "peak"),
      headroom: num(flags, "headroom"),
    };
    try {
      const s = await client.sizing(input);
      // Small footprints are the common case; "0.0 GB" is not a useful answer.
      const mem = (mb: number | null) =>
        mb === null ? "not measured" : mb < 1024 ? `${mb} MiB` : `${(mb / 1024).toFixed(1)} GB`;
      const disk = (gb: number | null) =>
        gb === null ? "not measured" : gb < 1 ? `${Math.round(gb * 1024)} MiB` : `${gb} GB`;
      const cores = (value: number | null) =>
        value === null ? "not measured" : `${value} cores`;
      console.log(`Sizing:     ${s.agents} agent(s) · profile ${s.profile} · driver ${s.driver}`);
      console.log(
        `Per agent:  peak ${mem(s.perAgent.peakMemoryMb)}` +
          ` · burst ${cores(s.perAgent.burstCpus)}` +
          ` · disk ${disk(s.perAgent.diskGb)}`,
      );
      console.log(
        `Provision:  memory ${mem(s.totals.memoryMb)}` +
          ` · vCPU ${cores(s.totals.vcpus)}` +
          ` · disk ${disk(s.totals.diskGb)}`,
      );
      if (!s.ok) {
        console.log(`Incomplete: ${s.missing.join(", ")} — see docs/benchmarks.md § Per-agent density`);
      }
      return 0;
    } catch (err) {
      console.error(`Failed to size host: ${formatError(err)}`);
      return 1;
    }
  }

  try {
    const c = await client.capacity();
    if (!c.enforced && c.memory.budgetMb === 0) {
      console.log("Admission control: off (host capacity unknown)");
      return 0;
    }
    const gb = (mb: number) => (mb / 1024).toFixed(1);
    console.log(`Admission:  ${c.enforced ? "enforce" : "off"}  (overcommit ${c.overcommit}x)`);
    console.log(
      `Memory:     ${gb(c.memory.committedMb)} / ${gb(c.memory.budgetMb)} GB committed` +
        `  (${gb(c.memory.availableMb)} GB free)`,
    );
    if (c.cpu.budget) {
      console.log(`CPU:        ${c.cpu.committed} / ${c.cpu.budget} cores committed`);
    }
    console.log(`Running:    ${c.running} sandboxes`);
    console.log(`Headroom:   ~${c.fits} more (at ${c.defaultReservationMb} MiB each)`);
    return 0;
  } catch (err) {
    console.error(`Failed to read capacity: ${formatError(err)}`);
    return 1;
  }
}
