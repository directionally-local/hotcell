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
      const gb = (mb: number) => (mb / 1024).toFixed(1);
      const show = (value: number | null, unit: string) =>
        value === null ? "not measured" : `${value} ${unit}`;
      console.log(`Sizing:     ${s.agents} agent(s) · profile ${s.profile} · driver ${s.driver}`);
      console.log(
        `Per agent:  peak ${s.perAgent.peakMemoryMb === null ? "not measured" : `${gb(s.perAgent.peakMemoryMb)} GB`}` +
          ` · burst ${show(s.perAgent.burstCpus, "cores")}` +
          ` · disk ${show(s.perAgent.diskGb, "GB")}`,
      );
      console.log(
        `Provision:  memory ${s.totals.memoryMb === null ? "not measured" : `${gb(s.totals.memoryMb)} GB`}` +
          ` · vCPU ${show(s.totals.vcpus, "cores")}` +
          ` · disk ${show(s.totals.diskGb, "GB")}`,
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
