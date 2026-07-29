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
  let actor: string;
  try {
    actor = authenticate(await headers()).autheliaUser;
  } catch (err) {
    if (err instanceof AuthError) {
      return (
        <main className="grid min-h-dvh place-items-center p-6 text-center">
          <div>
            <p className="text-base font-bold">Inte inloggad</p>
            <p className="mt-2 text-sm text-ink-soft">
              Recipus nås genom hushållets proxy. Logga in där och försök igen.
            </p>
          </div>
        </main>
      );
    }
    throw err;
  }

  const lists = await loadLists();
  const first = lists[0];

  if (!first) {
    return (
      <main className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <p className="text-base font-bold">Ingen lista än</p>
          <p className="mt-2 text-sm text-ink-soft">
            Kör <code>pnpm db:seed</code> för att skapa katalogen och en
            startlista.
          </p>
        </div>
      </main>
    );
  }

  const snapshot = await loadListSnapshot(first.id, new Date());
  if (!snapshot) throw new Error(`List ${first.id} vanished between queries`);

  return (
    <main>
      <ListClient
        snapshot={snapshot}
        actor={actor}
        members={[{ id: actor, initials: initials(actor), color: "#c8622e" }]}
      />
    </main>
  );
}
