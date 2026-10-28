/**
 * DHC CLI: remembers which sessions have a "send now" in flight. The server answers that send by
 * ending the interrupted run with `complete { aborted: true }` before the new turn streams; the
 * realtime handler consumes the mark so that terminal event does not blink the activity indicator
 * off (and clear the optimistic bubble's processing state) for a turn that is already replacing it.
 */
const INTERRUPT_SEND_TTL_MS = 15_000;

const pendingInterruptSends = new Map<string, number>();

export function markInterruptSend(sessionId: string): void {
  pendingInterruptSends.set(sessionId, Date.now());
}

/** True once per mark, and only while the mark is fresh; a stale one is dropped and reported false. */
export function consumeInterruptSend(sessionId: string): boolean {
  const markedAt = pendingInterruptSends.get(sessionId);
  if (markedAt === undefined) {
    return false;
  }
  pendingInterruptSends.delete(sessionId);
  return Date.now() - markedAt <= INTERRUPT_SEND_TTL_MS;
}

export function resetInterruptSends(): void {
  pendingInterruptSends.clear();
}
