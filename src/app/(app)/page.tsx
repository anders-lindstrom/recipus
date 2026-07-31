import { headers } from "next/headers";
import { ListClient } from "@/components/list-client";
import { authenticate, AuthError } from "@/lib/auth";
import { loadListSnapshot, loadLists } from "@/lib/services/list-data";

/**
 * The list page.
 *
 * Server-renders the initial snapshot so a cold open shows a real list rather
 * than a spinner, then hands over to the client, which owns every interaction
 * from that point on.
 */

// Always fresh: this is a shared list, and a cached render would show your
// partner's additions minutes late.
export const dynamic = "force-dynamic";

function initials(user: string): string {
  return user.slice(0, 2).toUpperCase();
}

export default async function ListPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string }>;
}) {
  const { list: requestedList } = await searchParams;
  // Auth failure must NOT render a different page. The service worker caches
  // this HTML, so an auth-gated render bakes "not logged in" into the cache and
  // serves it forever — which is exactly how an app that works offline stops
  // working offline. The shell always renders; being signed out is a banner
  // over a list the client loads from IndexedDB.
  let actor: string | null = null;
  try {
    actor = authenticate(await headers()).autheliaUser;
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
  }

  let snapshot = null;
  let lists: Awaited<ReturnType<typeof loadLists>> = [];
  if (actor) {
    lists = await loadLists();
    // An unknown ?list= falls back to the first rather than erroring — a stale
    // bookmark or a deleted list should open something, not a dead end.
    const chosen = lists.find((l) => l.id === requestedList) ?? lists[0];
    if (chosen) snapshot = await loadListSnapshot(chosen.id, new Date());
  }

  return (
    <main>
      <ListClient
        snapshot={snapshot}
        lists={lists}
        actor={actor}
        members={
          actor
            // Same darkened terracotta as `--color-mode-buy-line`: the initials
            // are white at 10px/700, which is nowhere near "large text", and the
            // old #c8622e carried them at 4.01:1 against a 4.5:1 requirement.
            ? [{ id: actor, initials: initials(actor), color: "#b4551f" }]
            : []
        }
      />
    </main>
  );
}
