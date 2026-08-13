/**
 * A shared image, held just long enough to be looked at.
 *
 * Android's share target is a POST navigation, so the image arrives at the
 * server before the app is even open — but the parse belongs to the dialog the
 * person is about to see, not to the redirect. So the bytes wait here under a
 * random token, and the page fetches them back through `/api/ai/parse` a moment
 * later.
 *
 * In memory, deliberately. The household runs one container; a token that does
 * not survive a restart costs one re-share, and the alternative — a screenshot
 * of your shopping written to disk or to Postgres — is a durable copy of
 * something nobody asked to keep. Ten minutes and five slots is well past what
 * a share-then-open takes and nowhere near a leak.
 *
 * `take` empties the slot and checks the actor. Neither guard is theatre: the
 * app is behind Authelia, but a token in a URL is the one part of this that
 * lands in browser history and could be pasted into a chat.
 */

import { randomBytes } from "node:crypto";

export const SHARE_TTL_MS = 10 * 60 * 1000;
export const SHARE_CAPACITY = 5;

export interface SharedImage {
  /** base64, no data-URL prefix. */
  data: string;
  mediaType: string;
}

interface Slot extends SharedImage {
  actor: string;
  at: number;
}

const slots = new Map<string, Slot>();

/** Test seam. Not called by the app — the store is process-lifetime. */
export function resetSharedImages(): void {
  slots.clear();
}

function evictStale(now: number): void {
  for (const [token, slot] of slots) {
    if (now - slot.at > SHARE_TTL_MS) slots.delete(token);
  }
  // Map preserves insertion order, so the first key is the oldest put.
  while (slots.size >= SHARE_CAPACITY) {
    const oldest = slots.keys().next();
    if (oldest.done) break;
    slots.delete(oldest.value);
  }
}

export function putSharedImage(
  image: SharedImage & { actor: string },
  now: Date = new Date(),
): string {
  evictStale(now.getTime());
  const token = randomBytes(24).toString("base64url");
  slots.set(token, {
    data: image.data,
    mediaType: image.mediaType,
    actor: image.actor,
    at: now.getTime(),
  });
  return token;
}

export function takeSharedImage(
  token: string,
  actor: string,
  now: Date = new Date(),
): SharedImage | null {
  const slot = slots.get(token);
  if (!slot) return null;
  if (now.getTime() - slot.at > SHARE_TTL_MS) {
    slots.delete(token);
    return null;
  }
  // Deliberately not consumed on a mismatch: the rightful owner is probably
  // mid-open, and punishing them for someone else's bad token is worse.
  if (slot.actor !== actor) return null;
  slots.delete(token);
  return { data: slot.data, mediaType: slot.mediaType };
}
