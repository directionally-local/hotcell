/**
 * CVE-2026-111497 ("Node2Shell"): an out-of-bounds write in the Brotli decoder
 * bundled with Node.js. fetch() decodes a `Content-Encoding: br` response with
 * it, so a malicious server can run code in the process that fetches from it.
 * The daemon fetches from LLM providers (egress gateway), GitHub and OTLP
 * endpoints, so it warns at startup on an exposed runtime.
 *
 * Fixed in Node 22.23.4, 24.22.1 and 26.12.1; 23, 25 and older lines get no fix.
 */
const NODE_FIXED: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };

/** Why this Node is exposed to CVE-2026-111497, or null when it is fixed (27+ counts as fixed). */
export function brotliRuntimeAdvisory(nodeVersion: string = process.versions.node): string | null {
  const [major = 0, minor = 0, patch = 0] = nodeVersion
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const newest = Math.max(...Object.keys(NODE_FIXED).map(Number));
  if (major > newest) return null;
  const fixed = NODE_FIXED[major];
  if (fixed && (minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1]))) return null;
  const upgrade = fixed
    ? `upgrade to Node ${major}.${fixed[0]}.${fixed[1]} or later`
    : `Node ${major} gets no fix; upgrade to Node 22.23.4, 24.22.1 or 26.12.1 or later`;
  return `Node ${nodeVersion} has the Brotli decoder bug CVE-2026-111497 (remote code execution via a compressed HTTP response): ${upgrade}`;
}
