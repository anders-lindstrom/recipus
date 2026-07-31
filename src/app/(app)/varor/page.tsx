import { headers } from "next/headers";
import { VarorClient } from "@/components/varor-client";
import { authenticate, AuthError } from "@/lib/auth";
import { loadListSnapshot, loadLists } from "@/lib/services/list-data";

/**
 * The registry page.
 *
 * It server-renders almost nothing on purpose. The registry lives in the client
 * store — products, aliases and barcodes all arrive through the op log — so the
 * screen has everything it needs from IndexedDB, and this page only has to say
 * WHICH list's store to open and who is editing.
 *
 * Auth failure must not render a different page, for the same reason the list
 * page's must not: the service worker caches this HTML, so an auth-gated render
 * bakes "not logged in" into the cache and serves it forever. Being signed out is
 * a state the client already knows how to show.
 */

// The catalog is shared and edited by two people; a cached render would show
// yesterday's words.
export const dynamic = "force-dynamic";

export default async function VarorPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string; vara?: string }>;
}) {
  const { list: requestedList, vara: openVaraId } = await searchParams;

  let actor: string | null = null;
  try {
    actor = authenticate(await headers()).autheliaUser;
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
  }

  let lists: Awaited<ReturnType<typeof loadLists>> = [];
  if (actor) lists = await loadLists();

  // Which list this screen borrows its store and its aisle order from. The
  // registry itself is household-wide, but the client store is keyed by list, so
  // opening the wrong one would show an empty catalog and a stale walking order.
  const chosen = lists.find((l) => l.id === requestedList) ?? lists[0] ?? null;

  // The one thing this screen genuinely cannot derive from the client store:
  // aisle NAMES. Categories are seeded rows that no op ever creates, so they
  // reach the client only through a snapshot. Loading a whole snapshot for four
  // columns is more work than it looks, and it is still the right trade — the
  // alternative is every aisle heading on the screen reading "Övrigt" on a
  // device that has not opened the list first. The snapshot is deliberately NOT
  // handed to the store; see `varor-client.tsx` for why hydrating here would be
  // a way to lose registry rows.
  const snapshot = chosen ? await loadListSnapshot(chosen.id, new Date()) : null;
  // Empty rather than a failure: the client falls back to the categories the
  // list screen cached, and an aisle heading reading "Övrigt" is a far better
  // outcome than a screen that will not open.
  const categories = snapshot?.categories ?? [];

  return (
    <main>
      <VarorClient
        listId={chosen?.id ?? null}
        actor={actor}
        list={chosen}
        categories={categories}
        openVaraId={openVaraId ?? null}
      />
    </main>
  );
}
