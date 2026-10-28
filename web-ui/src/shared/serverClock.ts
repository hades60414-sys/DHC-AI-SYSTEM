/**
 * DHC CLI: the host's clock, as learned from frames the server stamps as it sends them.
 *
 * Rows the browser creates — the optimistic echo of a sent message, the live stream, local notices — are
 * merged and sorted against transcript rows the host stamped, and the optimistic echo is only retired by a
 * persisted copy stamped no more than 10s before it. On 9/16 the host clock ran ~36s slow, so the echo of
 * every sent message never matched its persisted copy and stayed on screen, a second bubble below the reply.
 * Rows the browser stamps are therefore put on the host's clock.
 */

let offsetMs = 0;

/** Records how far the host's clock is from the browser's, from a timestamp the server stamped on sending. */
export function observeServerTime(timestamp: unknown): void {
  const serverTime = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
  if (Number.isFinite(serverTime)) {
    offsetMs = serverTime - Date.now();
  }
}

/** Moves a time read from the browser's clock onto the host's. */
export function toServerTime(browserTime: number): number {
  return browserTime + offsetMs;
}

/** The current time on the host's clock. */
export function serverNow(): number {
  return toServerTime(Date.now());
}
