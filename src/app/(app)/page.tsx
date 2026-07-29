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

export default async function ListPage() {
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
  if (actor) {
    const lists = await loadLists();
    const first = lists[0];
    if (first) snapshot = await loadListSnapshot(first.id, new Date());
  }

  return (
    <main>
      <ListClient
        snapshot={snapshot}
        actor={actor}
        members={
          actor
            ? [{ id: actor, initials: initials(actor), color: "#c8622e" }]
            : []
        }
      />
    </main>
  );
}
