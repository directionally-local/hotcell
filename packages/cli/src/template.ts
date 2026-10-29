import { HotcellClient } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";
import { formatError } from "./util.js";

/**
 * hotcell template create <name> --from <sandboxId>
 * hotcell template ls
 * hotcell template rm <name>
 *
 * Templates are captured microVM snapshots: `hotcell create --template <name>`
 * restores one into a fresh sandbox in milliseconds instead of booting a kernel
 * and re-running setup. Capturing pauses the source guest for a moment and then
 * resumes it, so the sandbox keeps running.
 */
export async function templateCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  const [sub, ...rest] = positional;

  try {
    if (sub === "create") {
      const name = rest[0];
      const from = typeof flags.from === "string" ? flags.from : rest[1];
      if (!name || !from) {
        console.error("usage: hotcell template create <name> --from <sandboxId>");
        return 1;
      }
      const t = await client.createTemplate(name, from);
      console.log(t.name);
      if (process.stderr.isTTY) {
        console.error(
          `✓ captured ${t.name} from ${from}  ·  ${t.image}  ·  ${(t.sizeBytes / 1024 ** 2).toFixed(0)} MiB`,
        );
        console.error(`  fork it   hotcell create --template ${t.name}`);
      }
      return 0;
    }

    if (sub === "ls" || sub === "list" || sub === undefined) {
      const templates = await client.listTemplates();
      if (flags.json === true) {
        console.log(JSON.stringify({ templates }, null, 2));
        return 0;
      }
      if (!templates.length) {
        console.error("No templates. Capture one with: hotcell template create <name> --from <sandboxId>");
        return 0;
      }
      for (const t of templates) {
        const lim = t.limits ?? {};
        const shape = [lim.cpus ? `${lim.cpus} cpu` : null, lim.memoryMb ? `${lim.memoryMb} MiB` : null]
          .filter(Boolean)
          .join(" · ");
        console.log(
          `${t.name.padEnd(20)} ${t.driver.padEnd(12)} ${t.image}${shape ? `  (${shape})` : ""}`,
        );
      }
      return 0;
    }

    if (sub === "rm" || sub === "remove") {
      const name = rest[0];
      if (!name) {
        console.error("usage: hotcell template rm <name>");
        return 1;
      }
      await client.deleteTemplate(name);
      console.error(`✓ deleted template ${name}`);
      return 0;
    }

    console.error(`Unknown template subcommand: ${sub}`);
    console.error("usage: hotcell template create <name> --from <sandboxId> | ls | rm <name>");
    return 1;
  } catch (err) {
    console.error(`template ${sub ?? "ls"} failed: ${formatError(err)}`);
    return 1;
  }
}
