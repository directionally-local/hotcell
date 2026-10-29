import { readFileSync } from "node:fs";
import { HotcellClient } from "@hotcell/sdk";
import { formatError, parseLimitFlags } from "./util.js";
import type { GlobalArgs } from "./cli.js";
import { parseEnvPairs } from "./env.js";
import { injectedEnv } from "./envconfig.js";
import { startProgress } from "./progress.js";

export async function runCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const command = positional[0];
  if (!command) {
    console.error(
      'Usage: hotcell run "<command>" [--image <image>] [--keep] [--env KEY=VAL,...] [--sleep-after <ms>]',
    );
    return 1;
  }

  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  const image = typeof flags.image === "string" ? flags.image : undefined;
  const keep = flags.keep === true;
  const egress = flags.egress === true;
  const egressSpendCapUsd =
    typeof flags["egress-spend-cap"] === "string" ? Number(flags["egress-spend-cap"]) : undefined;
  const sleepAfter =
    typeof flags["sleep-after"] === "string"
      ? Number(flags["sleep-after"])
      : undefined;
  const { memoryMb, cpus, pidsLimit } = parseLimitFlags(flags);
  const setup = typeof flags.setup === "string" ? [flags.setup] : undefined;
  const repo = typeof flags.repo === "string" ? flags.repo : undefined;
  const repoRef = typeof flags.ref === "string" ? flags.ref : undefined;
  const patch =
    typeof flags.patch === "string" ? readFileSync(flags.patch, "utf8") : undefined;
  // Project `inject` variables, overridable per-run by an explicit --env.
  let env: Record<string, string> | undefined;
  try {
    const merged = {
      ...injectedEnv(),
      ...(typeof flags.env === "string" ? parseEnvPairs(flags.env.split(",")) : {}),
    };
    if (Object.keys(merged).length) env = merged;
  } catch (err) {
    console.error(formatError(err));
    return 1;
  }

  // Detached create + live status on TTY stderr, so a slow first run (image
  // conversion, VZ runtime fetch, microVM boot) shows what it's doing instead of
  // a silent hang. On a non-TTY stream startProgress is a no-op (output stays clean).
  let sandbox;
  const progress = startProgress([""]);
  try {
    const hasLimits = memoryMb !== undefined || cpus !== undefined || pidsLimit !== undefined;
    const baseOpts =
      image || env || sleepAfter !== undefined || egress || hasLimits || setup || repo ||
      egressSpendCapUsd !== undefined
        ? { image, env, sleepAfter, egress, egressSpendCapUsd, setup, repo, repoRef, patch, memoryMb, cpus, pidsLimit }
        : {};
    sandbox = await client.getSandbox(undefined, {
      ...baseOpts,
      detach: true,
      onStatus: (status, info) =>
        progress.update(
          0,
          status === "creating"
            ? info.statusReason
              ? `creating (${info.statusReason})`
              : "creating"
            : status,
        ),
    });
    progress.settle(0, true, "ready");
  } catch (err) {
    progress.settle(0, false, formatError(err));
    progress.stop();
    console.error(`Failed to create sandbox: ${formatError(err)}`);
    return 1;
  }
  progress.stop();

  let exitCode = 0;
  try {
    console.error(`[hotcell] sandbox ${sandbox.id} created`);
    for await (const event of sandbox.execStream(command)) {
      if (event.type === "stdout") {
        process.stdout.write(event.data);
      } else if (event.type === "stderr") {
        process.stderr.write(event.data);
      } else if (event.type === "exit") {
        exitCode = event.exitCode;
      }
    }
  } catch (err) {
    console.error(`\n[hotcell] exec failed: ${formatError(err)}`);
    exitCode = 1;
  } finally {
    if (!keep) {
      try {
        await sandbox.destroy();
        console.error(`[hotcell] sandbox ${sandbox.id} destroyed`);
      } catch (err) {
        console.error(`[hotcell] failed to destroy sandbox: ${formatError(err)}`);
      }
    } else {
      console.error(`[hotcell] sandbox ${sandbox.id} kept alive`);
    }
  }

  return exitCode;
}
