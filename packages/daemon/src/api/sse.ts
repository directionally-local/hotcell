/**
 * Server-Sent Events framing for the daemon's streaming endpoints (exec output,
 * file watch, process logs). Kept in one place so the wire format has a single
 * definition and can be round-trip tested against the SDK's `parseSSE`.
 */
export function formatSseEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
