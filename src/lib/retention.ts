/**
 * How long a tombstone, and the op log, are kept.
 *
 * One number, imported by both sides, because the two prunes are only safe
 * together. A tombstone exists so a stale op LOSES; once it is gone,
 * `wins(op, undefined)` returns true whatever the op's timestamp says, and the
 * next straggler to arrive resurrects something you already bought. So the
 * window has to be at least as long as the oldest op that could still turn up
 * from a phone that has been in a drawer — 30 days is the household-scale
 * answer, and it is what src/db/schema.ts has claimed all along.
 *
 * Deliberately not two constants that "happen to agree": a client pruning on a
 * shorter window than the server is exactly the resurrection bug above, and it
 * would show up as items reappearing on one phone only.
 */
export const RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Anything last touched before this is beyond recall and safe to forget. */
export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
}
