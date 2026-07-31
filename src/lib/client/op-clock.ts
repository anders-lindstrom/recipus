/**
 * Client timestamps for ops, guaranteed to differ.
 *
 * Last-write-wins cannot order two ops that share a timestamp. `wins()` compares
 * `at`, then falls back to comparing actors — so two ops from the SAME person at
 * the same millisecond tie, and the tie resolves as "the newcomer loses". That is
 * the right call for a genuine conflict between two devices, and quietly wrong
 * for two ops one device dispatched together on purpose.
 *
 * It is easy to hit: undo of a buy-mode scan re-adds the item so the purchase can
 * be retracted, then removes it again so you end up where you started. Both ops
 * touch the same entry, both are dispatched in the same tick, and without this
 * the removal loses — the purchase is correctly retracted and the item is
 * incorrectly left on the list. Two fast taps on one tile are the same shape.
 *
 * So the clock only ever moves forward. Nudging by a millisecond is honest here:
 * these are client clocks used for ordering, deliberately not rewritten to server
 * time (see `OpBase.at`), and a millisecond of drift cannot change the outcome of
 * any comparison that was not already a coin toss.
 */
export function nextOpTimestamp(lastAt: string | null, now: Date): string {
  const at = now.toISOString();
  // ISO-8601 with a fixed shape sorts lexicographically, which is what the
  // reducer compares, so comparing the strings here is comparing the same thing.
  if (lastAt === null || at > lastAt) return at;
  return new Date(new Date(lastAt).getTime() + 1).toISOString();
}
