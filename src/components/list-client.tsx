"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useList } from "@/lib/client/use-list";
import { useMode } from "@/lib/client/use-mode";
import { nextOpTimestamp } from "@/lib/client/op-clock";
import { scanAction } from "@/lib/client/scan-action";
import { resolveScan } from "@/lib/client/scan-resolve";
import { autoMapProductName } from "@/lib/ingredients";
import type { Op } from "@/lib/sync";
import {
  entryId,
  manualContributionId,
  productId,
  type Amount,
  type CatalogItem,
  type Id,
  type List,
  type Priority,
} from "@/lib/domain";
import type { ListSnapshot } from "@/lib/services/list-data";
import { parseAmount } from "@/lib/units";
import { normalizeName, slugify } from "@/lib/utils";
import { splitSortOps, newVaraLike } from "./list-model";
import { ListScreen } from "./list-screen";
import { ListSwitcher } from "./list-switcher";
import { Scanner, type ScanOutcome } from "./scanner";
import { VarorPlaceSheet } from "./varor-place-sheet";

/**
 * Wiring the list screen to the sync layer.
 *
 * Optimistic by construction: every action applies its op locally through the
 * same reducer the server runs, then posts it. The UI never waits on a round
 * trip, which is the whole point — a tap that waits is a tap that fails in a
 * shop.
 *
 * It also has to survive being opened with no server at all. The service worker
 * caches this shell, so the page that renders offline is whatever HTML was
 * cached — which cannot be an auth-gated server render, or a lapsed session
 * gets baked into the cache and served forever. So the shell is auth-agnostic:
 * it renders from IndexedDB and from a small "shell context" (list name,
 * category names) stashed in localStorage on each successful online load, and
 * treats being signed out as a banner rather than a different page.
 */

const SHELL_KEY = "recipus:shell";

/**
 * How long a scan waits for the server before carrying on without it.
 *
 * The same 2.5s the service worker gives a navigation, for the same reason it
 * gives it: when you are genuinely offline the fetch fails on connection setup
 * in milliseconds, so this only bites on a flaky signal — the supermarket
 * basement case, where a slightly slower correct answer would still be worse
 * than getting on with it. Nothing is lost by giving up: the product and its
 * barcode are already written, and the name can arrive later.
 */
const LOOKUP_TIMEOUT_MS = 2500;

interface BarcodeLookup {
  productName: string | null;
  brand: string | null;
}

/**
 * Ask the server what a barcode is, and never let the answer matter enough to
 * block on. Null means "no answer" — offline, unknown to Open Food Facts, or
 * simply slow — and every one of those is the same thing to the caller.
 */
async function lookUpBarcode(ean: string): Promise<BarcodeLookup | null> {
  try {
    const res = await fetch(`/api/barcode/${encodeURIComponent(ean)}`, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<BarcodeLookup>;
    return { productName: body.productName ?? null, brand: body.brand ?? null };
  } catch {
    return null;
  }
}

/** The bits ListScreen needs that do not live in SyncState. */
interface ShellContext {
  listId: Id;
  actor: string;
  list: ListSnapshot["list"];
  categories: ListSnapshot["categories"];
  recipeTitles: Record<Id, string>;
}

function readShellContext(): ShellContext | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SHELL_KEY);
    return raw ? (JSON.parse(raw) as ShellContext) : null;
  } catch {
    return null;
  }
}

/**
 * An op minus the envelope this component fills in.
 *
 * The distribution over the union matters: a plain `Omit<Op, ...>` collapses the
 * twelve op variants into one intersection whose only shared keys are the
 * envelope's, so `listId` and friends stop existing.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type OpDraft = DistributiveOmit<Op, "clientOpId" | "actor" | "at">;

export interface ListClientProps {
  /** Null when the server could not authenticate — the client falls back to IndexedDB. */
  snapshot: ListSnapshot | null;
  /** Every list in the household, for the switcher. Empty when offline. */
  lists: List[];
  actor: string | null;
  members: Array<{ id: string; initials: string; color: string }>;
}

export function ListClient({ snapshot, lists, actor, members }: ListClientProps) {
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanOutcome | null>(null);
  const [switching, setSwitching] = useState(false);
  /**
   * A scanned product waiting to be told what it is.
   *
   * Held by id rather than by value so the sheet re-reads the product out of
   * state on every render: the lookup that follows an unknown scan patches the
   * name a moment later, and a snapshot taken at open would leave the sheet
   * offering "7310865004703" after the app had learned it was Mellanmjölk.
   */
  const [placing, setPlacing] = useState<{ ean: string; productId: Id } | null>(
    null,
  );

  // Read once, on first render, so the offline path has a list name and
  // category names before anything async resolves.
  const [cached] = useState<ShellContext | null>(() =>
    snapshot ? null : readShellContext(),
  );

  // Remember enough to render the shell next time the server is unreachable.
  useEffect(() => {
    if (!snapshot || !actor) return;
    try {
      const ctx: ShellContext = {
        listId: snapshot.list.id,
        actor,
        list: snapshot.list,
        categories: snapshot.categories,
        recipeTitles: snapshot.recipeTitles,
      };
      window.localStorage.setItem(SHELL_KEY, JSON.stringify(ctx));
    } catch {
      // A full or disabled localStorage costs offline chrome, nothing more.
    }
  }, [snapshot, actor]);

  const listId = snapshot?.list.id ?? cached?.listId ?? null;
  const effectiveActor = actor ?? cached?.actor ?? null;
  const categories = snapshot?.categories ?? cached?.categories ?? [];
  // Memoised, not a bare `?? {}`: that allocates a fresh object every render,
  // so the useMemo below would recompute on every render and never memoise
  // anything.
  const recipeTitles = useMemo(
    () => snapshot?.recipeTitles ?? cached?.recipeTitles ?? {},
    [snapshot?.recipeTitles, cached?.recipeTitles],
  );

  // The store owns state, persistence and sync. It applies each op locally
  // before the network hears about it, keeps everything in IndexedDB, and
  // drains its outbox when a connection comes back — so the list opens and
  // works in a shop with no signal.
  const { state, status, dispatch: dispatchOp } = useList(
    listId ?? "__none__",
    effectiveActor ?? "__none__",
    snapshot ?? undefined,
  );

  /**
   * The list as the STORE has it, falling back to the render the server sent.
   *
   * It used to read `snapshot.list` and nothing else, which was fine while the
   * only editable thing about a list was its name — and stopped being fine the
   * moment the walking order became editable. `update_list` is applied
   * optimistically into `state` like every other op, so reading the frozen
   * snapshot here meant re-ordering the aisles did nothing visible until a
   * reload: the op was in flight, the server had it, and the screen was still
   * rendering the order it was born with. It also meant a partner's re-order
   * arriving over SSE was applied to the store and never drawn.
   *
   * The fallbacks stay for the two states where the store has no row yet: the
   * very first paint before hydrate, and an offline launch rendering from the
   * cached shell.
   */
  const list =
    (listId ? state.lists[listId] : undefined) ??
    snapshot?.list ??
    cached?.list ??
    null;

  // Titles come from the snapshot; scale factors from live state, so a recipe
  // added since hydration still labels its tiles correctly.
  const recipeAdditionInfo = useMemo(() => {
    const out: Record<Id, { recipeTitle: string; scaleFactor: number }> = {};
    for (const addition of Object.values(state.recipeAdditions)) {
      out[addition.id] = {
        recipeTitle: recipeTitles[addition.recipeId] ?? "Recept",
        scaleFactor: addition.scaleFactor,
      };
    }
    return out;
  }, [state.recipeAdditions, recipeTitles]);

  /**
   * Strictly increasing per session — see `nextOpTimestamp`. Two ops sharing a
   * timestamp cannot be ordered by last-write-wins, so the second silently loses.
   */
  const lastAt = useRef<string | null>(null);

  /** Returns the op's `clientOpId`, which undo needs to name what it retracts. */
  /**
   * Stamp a draft into a real op.
   *
   * Lifted out so the fire-and-forget path and the awaitable one below cannot
   * drift: `nextOpTimestamp` against `lastAt` is what keeps two ops dispatched
   * in the same tick strictly ordered, and a second copy of that would be a
   * second clock nobody declared.
   */
  const buildOp = useCallback(
    (partial: OpDraft): Op => {
      const at = nextOpTimestamp(lastAt.current, new Date());
      lastAt.current = at;
      return {
        ...partial,
        clientOpId: crypto.randomUUID(),
        actor: effectiveActor ?? "okand",
        at,
      } as Op;
    },
    [effectiveActor],
  );

  const dispatch = useCallback(
    (partial: OpDraft): string => {
      const op = buildOp(partial);
      void dispatchOp(op).catch(() =>
        // A lapsed session is reported through status.signedOut, not thrown —
        // anything reaching here is a genuine failure worth surfacing.
        toast.error("Kunde inte spara ändringen"),
      );
      return op.clientOpId;
    },
    [buildOp, dispatchOp],
  );

  /**
   * Dispatch, and resolve once the op is actually written down.
   *
   * For the one caller that then tears the page down. `dispatch` above returns
   * the instant the op is built and lets the outbox write settle whenever it
   * settles, which is right for every tap that leaves the page standing — but
   * assigning `window.location.href` can abort an IndexedDB transaction that
   * has not committed, and an op lost there is lost silently: no outbox row to
   * retry, no error, just a list you made that is not there after the reload.
   */
  const dispatchAndWait = useCallback(
    async (partial: OpDraft): Promise<void> => {
      try {
        await dispatchOp(buildOp(partial));
      } catch {
        toast.error("Kunde inte spara ändringen");
      }
    },
    [buildOp, dispatchOp],
  );

  // Device-local, never synced and never an op: one of you is in the shop while
  // the other plans at home, so a shared mode would make the planner's taps
  // write purchases. See lib/client/use-mode.ts for the full argument.
  const { mode, setMode, touch } = useMode();

  /*
   * Nothing to render — and more than one reason arrives at this one screen.
   *
   * The copy used to name only the least likely of them ("öppna en gång med
   * täckning"), so an online user with an empty database was told their problem
   * was the network. What actually gets here is either that the server could not
   * say who you are — a lapsed Authelia session, or a first launch with no signal
   * and nothing cached yet — or that it could, and the household has no list at
   * all. `page.tsx` sends a null snapshot for both, so the actor is what tells
   * them apart; the snapshot cannot.
   *
   * Reloading is a genuine exit for the first: the request goes back through the
   * proxy, which either re-authenticates you or hands you the login page. It is
   * the honest one for the second too — nothing on this device can conjure a
   * list, and in production `instrumentation.ts` seeds one on boot, so this state
   * means the server is not ready rather than that you did something wrong.
   * Either way it beats what was here before, which offered no control at all.
   */
  if (!list || !listId) {
    const unknownUser = !effectiveActor;
    return (
      <main className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="max-w-xs">
          {/* A heading, not a styled paragraph. This screen has no header and no
              nav — it is the whole page — so the one thing on it that names the
              problem should be the thing a screen reader can jump to. */}
          <h1 className="text-title text-ink">
            {unknownUser ? "Vi vet inte vem du är" : "Ingen lista än"}
          </h1>
          <p className="mt-2 text-body-sm text-ink-soft">
            {unknownUser
              ? "Sessionen kan ha gått ut, eller så saknades nätet första gången appen öppnades. Ladda om, så skickas du till inloggningen om det behövs."
              : "Du är inloggad och servern svarar. Hushållet har bara ingen lista ännu — servern skapar en när katalogen seedas."}
          </p>
          <button
            type="button"
            onClick={() => location.reload()}
            className="mt-5 inline-flex min-h-11 items-center rounded-control bg-brand px-4 text-body font-semibold text-on-brand"
          >
            Försök igen
          </button>
        </div>
      </main>
    );
  }

  /**
   * The vara behind a typed name, creating it only if there is not one already.
   *
   * The guard is the point. Ids are `slugify(name)`, so "Blåbär mogna" typed
   * twice is one id — and `create_catalog_item` REPLACES the row wholesale when
   * it wins on clock. Re-creating an existing vara would therefore reset its
   * aisle, its icon and its hidden flag to whatever this call happened to infer,
   * silently undoing a re-filing somebody did on /varor. The case is not
   * hypothetical: hidden varor sort last in search rather than vanishing, but a
   * six-result cap can still push one off the end, and then "create it" is
   * exactly what the add bar offers for a word that already exists.
   *
   * So an existing vara is reused, and un-hidden if it was hidden — typing a
   * name is the household asking for that thing, which is the same signal
   * picking it out of search is.
   */
  function ensureVara(name: string, likeItem?: CatalogItem): Id | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const id = slugify(trimmed);

    const existing = state.catalog[id];
    if (existing) {
      if (existing.hidden) {
        dispatch({
          kind: "update_catalog_item",
          itemId: id,
          patch: { hidden: false },
        });
      }
      return id;
    }

    dispatch({
      kind: "create_catalog_item",
      item: newVaraLike(id, trimmed, likeItem),
    });
    return id;
  }

  const actions = {
    /**
     * `keepsPurchase` is the scanner's opt-out and nobody else's — see the op's
     * own comment. Every other add that puts a vara BACK on the list takes a
     * purchase of it from the last half hour with it, decided on the server
     * where both phones can see it, so there is nothing to pass and no call site
     * that can forget to.
     */
    addItem: (
      catalogItemId: Id,
      amountText?: string,
      undoesClientOpId?: string,
      keepsPurchase?: boolean,
    ) => {
      dispatch({
        kind: "add_item",
        listId,
        catalogItemId,
        undoesClientOpId,
        keepsPurchase,
      });
      if (amountText) {
        const amount = parseAmount(amountText);
        if (amount) dispatch({ kind: "set_amount", listId, catalogItemId, amount });
      }
    },
    removeItem: (catalogItemId: Id, bought: boolean) => {
      // Buy mode's idle clock measures shopping, not staring at the screen, so
      // it is a removal that counts as activity — not a render or a scroll.
      if (bought) touch();
      return dispatch({ kind: "remove_item", listId, catalogItemId, bought });
    },
    setAmount: (catalogItemId: Id, amount: Amount | null) =>
      dispatch({ kind: "set_amount", listId, catalogItemId, amount }),
    setModifier: (catalogItemId: Id, modifier: string | null) =>
      dispatch({ kind: "set_modifier", listId, catalogItemId, modifier }),
    setPriority: (catalogItemId: Id, priority: Priority) =>
      dispatch({ kind: "set_priority", listId, catalogItemId, priority }),
    /**
     * `likeItem` is the vara the query already resolved to — banan, when what
     * was typed is "mogen banan".
     *
     * Its aisle and icon are inherited, and that is what makes a household's own
     * kinds worth having. Wanting ripe bananas AND ordinary ones tracked apart is
     * legitimate and the answer has always been a second vara: one vara appears
     * at most once per list, so two kinds sharing a tile would mean one of them
     * has no amount of its own. But the only way to make one filed it under
     * Övrigt with a box icon, and Övrigt sorts LAST — so taking the supported
     * path put the thing at the wrong end of the shop, permanently, and the
     * penalty fell hardest on exactly the person who knew what they wanted.
     *
     * Inheriting is a guess, but not a blind one: it is the aisle of a vara the
     * matcher just resolved this same query to. "mogen banan" belongs wherever
     * banan belongs. With nothing to inherit from it still falls back to Övrigt,
     * which is the honest answer for a word the app has never seen.
     */
    createItem: (name: string, amountText: string, likeItem?: CatalogItem) => {
      const id = ensureVara(name, likeItem);
      if (id) actions.addItem(id, amountText);
    },
    /**
     * Two kinds of one thing, made into two varor.
     *
     * The whole plan lives in `splitSortOps` — pure, ordered, and tested —
     * because the cases worth arguing about (a recipe still wanting the plain
     * kind, a name that is already a vara, clearing the original's ask BEFORE
     * removing it) are ones that fail silently rather than loudly. Same division
     * of labour as `mergeVaror` on the registry screen.
     */
    splitSort: (
      baseItemId: Id,
      newName: string,
      options: { keepPlain: boolean; plainAmountText?: string },
    ) => {
      for (const op of splitSortOps(state, listId, baseItemId, newName, options)) {
        dispatch(op);
      }
    },
    /**
     * A vara created beside another one and put on the list with a draft's
     * details — the add-details sheet's "egen vara".
     *
     * Not a split: nothing is being moved off an existing ask, so there is
     * nothing to tidy afterwards and no ordering to get wrong. The amount and
     * priority come from the sheet rather than from the store.
     */
    createVaraLike: (params: {
      name: string;
      likeItem: CatalogItem;
      amount: Amount | null;
      priority: Priority;
    }): Id | null => {
      const id = ensureVara(params.name, params.likeItem);
      if (!id) return null;
      actions.addItem(id);
      if (params.amount) actions.setAmount(id, params.amount);
      if (params.priority !== "normal") actions.setPriority(id, params.priority);
      return id;
    },
    /**
     * Out of search, the catalog well and "Vanligast" — and nothing else.
     *
     * Its own field with its own clock rather than the soft delete next to it:
     * `delete_catalog_item` means "we do not buy this", is refused while the vara
     * is on a list or carries products, and turns a live tile into a stand-in.
     * This makes no claim about the thing at all, so it needs no blockers and is
     * reversible from `/varor` — or simply by typing the name, which is what
     * makes it safe to reach for.
     */
    setHidden: (catalogItemId: Id, hidden: boolean) =>
      dispatch({
        kind: "update_catalog_item",
        itemId: catalogItemId,
        patch: { hidden },
      }),
    removeRecipe: (recipeAdditionId: Id) =>
      dispatch({ kind: "remove_recipe", listId, recipeAdditionId }),
    /**
     * The payload is read out of the store HERE, not in the reducer.
     *
     * `move_item` carries what it moves — priority, and the manual
     * amount/note/modifier — because a reducer that read the source instead
     * could not be order-independent, and two phones would settle on different
     * amounts at the destination. See the op's own comment. This is the one
     * place that read happens, on the device that is actually looking at the
     * item.
     */
    moveItem: (catalogItemId: Id, toListId: Id) => {
      const eid = entryId(listId, catalogItemId);
      const entry = state.entries[eid];
      const manual = state.contributions[manualContributionId(eid)];
      dispatch({
        kind: "move_item",
        fromListId: listId,
        toListId,
        catalogItemId,
        priority: entry?.priority ?? "normal",
        // Null when there is nothing of your own to take — which is different
        // from "all three fields are empty", and the reducer treats it as such:
        // it makes no claim about those fields at either end.
        manual: manual
          ? {
              amount: manual.amount,
              note: manual.note,
              modifier: manual.modifier,
            }
          : null,
      });
    },
    /**
     * Fire-and-forget, and deliberately not through the outbox.
     *
     * A dismissal cannot conflict — the server key is (item, day) — so it needs
     * neither an op nor last-write-wins. The screen has already hidden the tile
     * by the time this runs, so a failure costs nothing visible now: the
     * suggestion simply comes back after the next hydrate. Worth no toast, since
     * the user's instruction was "not this time", not "record this forever".
     */
    dismissSuggestion: (catalogItemId: Id) => {
      void fetch("/api/suggestions/dismissals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalogItemId }),
      }).catch(() => {});
    },
    restoreSuggestion: (catalogItemId: Id) => {
      void fetch(
        `/api/suggestions/dismissals/${encodeURIComponent(catalogItemId)}`,
        { method: "DELETE" },
      ).catch(() => {});
    },
    openScanner: () => {
      setScanResult(null);
      setScanning(true);
    },
    switchList: () => setSwitching(true),
    /**
     * The walk round this shop, as an ordinary `update_list` patch.
     *
     * Whole rather than a move instruction, and that is forced by the clock:
     * `category_order` is one jsonb value with one last-write-wins timestamp, so
     * "put mejeri before bröd" would have to READ the order it rewrites, and a
     * read-modify-write cannot be order-independent — two people tidying the
     * same shop would settle on a sequence neither of them arranged. Naming the
     * whole order makes the op a statement rather than an instruction, which is
     * the same reason `move_item` carries its own payload.
     */
    setCategoryOrder: (categoryOrder: Id[]) =>
      dispatch({ kind: "update_list", listId, patch: { categoryOrder } }),
    /**
     * Saying which vara a scanned product is — the same two ops `/varor` uses
     * for the same answer, deliberately, so a placement made at the till and one
     * made at the kitchen table are the same event to every other device.
     */
    placeProduct: (id: Id, catalogItemId: Id) =>
      dispatch({
        kind: "update_product",
        productId: id,
        patch: { catalogItemId },
      }),
    createVaraAndPlace: (id: Id, name: string): Id | null => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const catalogItemId = slugify(trimmed);
      dispatch({
        kind: "create_catalog_item",
        item: {
          id: catalogItemId,
          name: trimmed,
          nameNorm: normalizeName(trimmed),
          // Unsorted until somebody says otherwise, exactly as the add bar and
          // the registry both do it — guessing an aisle from a product name
          // sends you to the wrong end of the shop, permanently.
          categoryId: "ovrigt",
          iconRef: "1F4E6",
          isCustom: true,
          hasAtHome: false,
          hidden: false,
          useCount: 0,
          lastUsedAt: null,
        },
      });
      dispatch({
        kind: "update_product",
        productId: id,
        patch: { catalogItemId },
      });
      return catalogItemId;
    },
  };

  /**
   * Act on a barcode we can name.
   *
   * Split out because three routes reach it — a local hit, an auto-mapped new
   * product, and a placement the user just made — and every one of them must
   * run the same four-cell table. An `add_and_buy` that only some paths could
   * reach is how a scan silently stops recording purchases.
   */
  function actOnVara(catalogItemId: Id, name: string) {
    if (!listId) return;
    const entry = state.entries[entryId(listId, catalogItemId)];
    const onList = Boolean(entry && entry.removedAt === null);

    // Which of the four things a scan means lives in `scanAction`, tested
    // there. This only turns the decision into ops and Swedish.
    switch (scanAction(mode, onList).kind) {
      case "buy": {
        const clientOpId = actions.removeItem(catalogItemId, true);
        setScanResult({
          text: `${name} köpt`,
          undo: () => {
            actions.addItem(catalogItemId, undefined, clientOpId);
            setScanResult({ text: `${name} tillbaka på listan` });
          },
        });
        return;
      }

      case "add_and_buy": {
        // Keeps its purchase, unlike every other add. A scan asserts the product
        // is in your hand, so scanning the same vara twice is two bottles — and
        // without this the add half would take back the first bottle a minute
        // before the remove half wrote the second, leaving one where there were
        // two.
        actions.addItem(catalogItemId, undefined, undefined, true);
        const clientOpId = actions.removeItem(catalogItemId, true);
        setScanResult({
          text: `${name} tillagd och köpt`,
          undo: () => {
            // Two halves: put it back so the purchase can be retracted against
            // the op that wrote it, then take it off again WITHOUT recording a
            // purchase — landing back where you were before the scan.
            actions.addItem(catalogItemId, undefined, clientOpId);
            actions.removeItem(catalogItemId, false);
            setScanResult({ text: `${name} ångrad` });
          },
        });
        return;
      }

      case "already_on_list": {
        // No op, and so no undo: there is nothing to take back. Saying so is
        // still worth a line — otherwise a scan that changed nothing looks
        // identical to one the camera never read.
        setScanResult({ text: `${name} finns redan på listan` });
        return;
      }

      case "add": {
        actions.addItem(catalogItemId);
        setScanResult({
          text: `${name} tillagd`,
          undo: () => {
            actions.removeItem(catalogItemId, false);
            setScanResult({ text: `${name} borttagen igen` });
          },
        });
        return;
      }
    }
  }

  /**
   * A scan, answered from this device first.
   *
   * The order is the design doc's, and only the first step is new: the local EAN
   * map, then the server, then Open Food Facts, then ask. What shipped went
   * straight to `/api/barcode` and did nothing else, so every scan — including
   * one for a barcode this household had already answered for — died with the
   * signal, in the shop, which is the only place anybody scans anything.
   *
   * Nothing here awaits the network before acting. A known barcode resolves out
   * of `SyncState` and is on the list before the camera has stopped shaking; an
   * unknown one is *written* before anything is fetched, so the scan survives
   * having no signal at all. The lookup that follows only ever improves a row
   * that already exists.
   */
  async function handleScan(ean: string) {
    // `listId` is guaranteed by the guard above, but this function is hoisted
    // out of that narrowing. The old code interpolated the id by hand, which
    // accepted null and would have produced a "null:banan" key; deriving it with
    // `entryId` closes the last place in the codebase that built an entry id
    // itself, at the cost of this one honest guard.
    if (!listId) return;

    const resolved = resolveScan(state, ean);

    if (resolved.kind === "vara") {
      actOnVara(resolved.catalogItemId, resolved.name);
      return;
    }

    if (resolved.kind === "unplaced") {
      setPlacing({ ean, productId: resolved.productId });
      return;
    }

    /*
     * A barcode nobody has met. Write it down BEFORE looking it up.
     *
     * This is the ordering the whole feature turns on. `create_product` and
     * `link_barcode` go through the outbox, so a shop with no signal queues them
     * and they land when it has one — which is what the op comment has promised
     * since the registry shipped ("unknown barcodes are created in a shop,
     * offline… only the outbox can fix that"). Fetching first and writing on
     * success inverts it, and that is what dropped the scan.
     *
     * The EAN stands in as the name, exactly as the PUT route and drizzle/0005
     * both do for a nameless product, and it is what the review queue shows
     * until something better arrives.
     */
    const id = productId(ean);
    dispatch({
      kind: "create_product",
      product: {
        id,
        name: ean,
        brand: null,
        catalogItemId: null,
        defaultSize: null,
        sourceSizeText: null,
        imageUrl: null,
        createdAt: new Date().toISOString(),
        createdBy: effectiveActor ?? "okand",
      },
    });
    dispatch({ kind: "link_barcode", ean, productId: id, source: "off" });

    const found = await lookUpBarcode(ean);
    if (found?.productName) {
      // One patch, naming only the fields this lookup actually learned. Each of
      // `update_product`'s four clocks is independent precisely so a patch that
      // is silent about the mapping cannot beat one that sets it.
      dispatch({
        kind: "update_product",
        productId: id,
        patch: { name: found.productName, brand: found.brand ?? null },
      });

      /*
       * Auto-map, at 0.8 and never 0.7 — the threshold's own module explains
       * why (0.7 put "Kaffe Gevalia Mellanrost" onto *ost*). A confident match
       * is the difference between a scan that just works and one that asks a
       * question in front of a till, and anything less confident belongs in the
       * review queue where somebody can look at it properly.
       */
      const guess = autoMapProductName(
        found.productName,
        Object.values(state.catalog),
      );
      const vara = guess ? state.catalog[guess.id] : undefined;
      if (vara) {
        dispatch({
          kind: "update_product",
          productId: id,
          patch: { catalogItemId: vara.id },
        });
        actOnVara(vara.id, vara.name);
        return;
      }
    }

    setPlacing({ ean, productId: id });
  }

  return (
    <>
      <ListScreen
        list={list}
        // Offline the server sent no lists; the one you are on is still a valid
        // (and the only sensible) choice, matching the switcher's own fallback.
        lists={lists.length ? lists : [list]}
        categories={categories}
        catalog={Object.values(state.catalog)}
        // Filtered to this list, which matters only because of `move_item`: it
        // is the one op that writes an entry belonging to a DIFFERENT list, and
        // that entry is live. Unfiltered, moving an item left it sitting on the
        // source list exactly as before — a move that looked like it had done
        // nothing at all.
        entries={Object.values(state.entries).filter((e) => e.listId === listId)}
        contributions={Object.values(state.contributions)}
        recipeAdditions={recipeAdditionInfo}
        suggestions={snapshot?.suggestions ?? []}
        members={members}
        mode={mode}
        onModeChange={setMode}
        sync={{
          online: status.online,
          pendingCount: status.pendingCount,
          signedOut: status.signedOut,
        }}
        onReauthenticate={() => location.reload()}
        actions={actions}
      />
      {switching && (
        <ListSwitcher
          // Offline the server sent no lists, but the one you are looking at is
          // always a valid choice — better than an empty sheet.
          lists={lists.length ? lists : [list]}
          currentId={listId}
          onSelect={(id) => {
            setSwitching(false);
            if (id !== listId) window.location.href = `/?list=${encodeURIComponent(id)}`;
          }}
          onCreate={(name) => {
            /*
             * A list's id is `slugify(name)`, so naming a new list what an old
             * one is already called does not make a second list — it addresses
             * the first one. And `create_list` in the reducer REPLACES the
             * whole record on a newer clock: name, icon, position and
             * `categoryOrder`. So typing "Hemköp" a second time used to
             * overwrite that shop's walking order with the order of whichever
             * list happened to be open — destroying, in one tap and with no
             * warning, the edit this app treats as its most valuable.
             *
             * `ensureVara` 400 lines up already answers exactly this question
             * for varor. Here the honest answer is to open the list you named
             * rather than to invent a second one that cannot exist.
             */
            const id = slugify(name);
            if (!id) {
              // slugify keeps letters and digits, so an emoji-only or
              // punctuation-only name yields "" — an id that would collide with
              // itself forever and address nothing.
              toast.error("Listan behöver ett namn med bokstäver i");
              return;
            }

            // `delete_list` omits the list from this map outright, so presence
            // here means live — a deleted list's id is free to be taken again,
            // and its own tombstone in `meta` decides whether the new create
            // wins.
            const existing = state.lists[id];
            if (existing) {
              setSwitching(false);
              toast.info(`Du har redan «${existing.name}» — öppnar den`);
              window.location.href = `/?list=${encodeURIComponent(id)}`;
              return;
            }

            setSwitching(false);
            // Awaited: the navigation below tears this page down, and an op
            // still in flight to IndexedDB goes with it.
            void dispatchAndWait({
              kind: "create_list",
              listId: id,
              name,
              icon: "1F6D2",
              position: lists.length,
              // Inherited rather than empty: a new shop with no aisle order
              // sorts everything into Övrigt, and copying the order you are
              // standing in is a better first guess than none.
              categoryOrder: list.categoryOrder,
            }).then(() => {
              window.location.href = `/?list=${encodeURIComponent(id)}`;
            });
          }}
          onClose={() => setSwitching(false)}
        />
      )}
      {scanning && (
        <Scanner
          onScan={handleScan}
          onClose={() => setScanning(false)}
          lastResult={scanResult}
          // The camera keeps firing behind an open sheet otherwise, and the
          // per-code cooldown only suppresses the SAME barcode — a second
          // product drifting through the viewfinder would replace the question
          // you are halfway through answering.
          paused={placing !== null}
        />
      )}
      {placing && (
        <VarorPlaceSheet
          /* Re-read every render: the lookup patches the name a moment after
             this opens, so a value captured at open would keep offering the
             bare EAN after the app had learned the product's real name. */
          product={
            state.products[placing.productId] ?? {
              id: placing.productId,
              name: placing.ean,
              brand: null,
              catalogItemId: null,
              defaultSize: null,
              sourceSizeText: null,
              imageUrl: null,
              createdAt: new Date().toISOString(),
              createdBy: effectiveActor ?? "okand",
            }
          }
          catalog={Object.values(state.catalog)}
          current={null}
          onPlace={(catalogItemId) => {
            actions.placeProduct(placing.productId, catalogItemId);
            setPlacing(null);
            const vara = state.catalog[catalogItemId];
            // Placing is the answer to "what did I just scan", so the scan then
            // completes — the alternative is telling someone at a till that
            // their answer was recorded and their item was not.
            if (vara) actOnVara(vara.id, vara.name);
          }}
          onCreateAndPlace={(name) => {
            const catalogItemId = actions.createVaraAndPlace(
              placing.productId,
              name,
            );
            setPlacing(null);
            if (catalogItemId) actOnVara(catalogItemId, name.trim());
          }}
          /* Nothing to send back to the queue: this product has no vara to
             leave, which is the entire reason the sheet is open. */
          onUnplace={() => setPlacing(null)}
          onClose={() => {
            /*
             * Dismissing answers nothing, and that is allowed to cost the
             * purchase.
             *
             * The product and its barcode are already written, so the scan is
             * not lost — it lands in the review queue on /varor. What does not
             * happen is a purchase, because there is no vara to attribute one
             * to and inventing an attribution is the same class of error as
             * inventing the purchase itself. Under-record, never invent.
             */
            setPlacing(null);
            setScanResult({ text: "Sparad i granskningskön" });
          }}
        />
      )}
    </>
  );
}
