import type { GlobalArgs } from "./cli.js";

/**
 * hotcell images — a curated, honest list of base images to run sandboxes on.
 *
 * We reuse trusted public images for almost everything and own exactly one thin
 * image (ghcr.io/sinameraji/hotcell-base, the default) for the python+node combo. Any
 * public image works via `--image`; this is just the "what are my options?"
 * answer that was otherwise invisible.
 *
 * Human (TTY): a readable list. Agent (piped / `--json`): machine-readable JSON.
 */
interface BaseImage {
  image: string;
  has: string;
  use: string;
  note?: string;
}

const CURATED: BaseImage[] = [
  {
    image: "ghcr.io/sinameraji/hotcell-base",
    has: "python + node + git + build tools",
    use: "the default — mixed stacks & coding agents",
  },
  { image: "node:22", has: "node + npm + git", use: "JS/TS + most agent CLIs (npm i -g …)" },
  { image: "python:3.11", has: "python3 + pip + git + build tools", use: "Python projects (non-slim = has git)" },
  { image: "mcr.microsoft.com/devcontainers/base:ubuntu", has: "ubuntu + git + tools (no runtimes)", use: "bring your own languages" },
  { image: "python:3.11-slim", has: "python3 + pip only", use: "minimal / CI (no git, no node)" },
  { image: "ubuntu:24.04", has: "bare OS", use: "full control (apt install what you need)" },
];

export async function imagesCommand(
  _positional: string[],
  _globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  if (flags.json === true || !process.stdout.isTTY) {
    console.log(JSON.stringify(CURATED, null, 2));
    return 0;
  }
  const ESC = "\x1b";
  const bold = (s: string) => `${ESC}[1m${ESC}[38;5;80m${s}${ESC}[0m`;
  const dim = (s: string) => `${ESC}[38;5;244m${s}${ESC}[0m`;
  console.log(`\n  ${dim("Base images for")} hotcell create --image <name> ${dim("— any public image works too.")}\n`);
  for (const b of CURATED) {
    console.log(`  ${bold(b.image)}`);
    console.log(`      ${b.has}  ${dim("·")}  ${b.use}`);
    if (b.note) console.log(`      ${dim("↳ " + b.note)}`);
  }
  console.log(`\n  ${dim("No --image? The daemon default applies — see:")} hotcell info\n`);
  return 0;
}
