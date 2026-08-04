"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type {
  Amount,
  CatalogItem,
  CatalogItemAlias,
  Id,
  List,
  Recipe,
} from "@/lib/domain";
import type { CadenceStats } from "@/lib/cadence";
import type { Op } from "@/lib/sync";
import { cn, normalizeName } from "@/lib/utils";
import { ItemIcon } from "./icon";
import { type PendingVara, resolveRecipeVaror } from "./recipe-model";
import { RecipeAddSheet } from "./recipe-add-sheet";
import { RecipeEditSheet, type RecipeEdit } from "./recipe-edit-sheet";
import { ScreenHeader } from "./screen-header";
import { Sheet } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * The recipe detail screen.
 *
 * Shows the recipe exactly as imported — `rawText` verbatim, unmatched
 * ingredients flagged NY VARA — and hands the actual scaling and staple
 * exclusion off to the existing RecipeAddSheet. This screen's own job is
 * everything around that: picking which list (when there is more than one),
 * creating catalog items for ingredients the matcher never resolved, and
 * turning the result into the `add_recipe` op.
 */

interface ApiRecipeIngredient {
  id: Id;
  position: number;
  rawText: string;
  amount: Amount | null;
  catalogItemId: Id | null;
}

interface ApiRecipe {
  id: Id;
  title: string;
  sourceUrl: string | null;
  servings: number;
  servingsUnit: string;
  imageUrl: string | null;
  instructions: string[];
  notes: string | null;
  ingredients: ApiRecipeIngredient[];
}

function toDomainRecipe(api: ApiRecipe): Recipe {
  return {
    ...api,
    ingredients: api.ingredients.map((ing) => ({ ...ing, recipeId: api.id })),
  };
}

/** Ties the `<ol>` of steps to the heading above it, which is not a heading element. */
const METHOD_HEADING_ID = "recipe-method-heading";

type LoadStatus = "loading" | "error" | "ready";

/** One fetch attempt's outcome, tagged with which attempt it answers. */
type LoadResult =
  | { attempt: number; kind: "ready"; recipe: Recipe }
  | { attempt: number; kind: "error"; message: string };

type AddFlow =
  | { step: "idle" }
  | { step: "choosing-list"; lists: List[] }
  | { step: "preparing" }
  | {
      step: "sheet";
      list: List;
      /** Household cadence, for the "you probably still have this" guess. */
      purchaseStats: Record<Id, CadenceStats>;
      recipe: Recipe;
      catalog: Record<Id, CatalogItem>;
      pendingCreates: PendingVara[];
      submitting: boolean;
    };

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string" &&
      (body as { error: string }).error.trim()
    ) {
      return (body as { error: string }).error;
    }
  } catch {
    // Not JSON — fall through to the default.
  }
  return fallback;
}

function hostnameOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The photo, faded into the page at its foot.
 *
 * The title sits below rather than over the image: these photos come from
 * whatever site the recipe was imported from, so there is no way to guarantee
 * a legible contrast ratio behind overlaid text. A scrim deep enough to be safe
 * on every possible photo would be deep enough to hide most of them.
 */
function RecipeHero({ title, imageUrl }: { title: string; imageUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !failed;

  return (
    <div className="relative flex h-56 w-full items-center justify-center overflow-hidden bg-brand-tint">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- recipe photos come from arbitrary external sites; next/image would need every source domain allow-listed.
        <img
          src={imageUrl!}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden className="text-6xl font-bold text-brand-ink">
          {(title.trim()[0] ?? "?").toUpperCase()}
        </span>
      )}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-surface"
      />
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div>
      <div className="h-56 w-full animate-pulse bg-line" />
      <div className="space-y-2 px-4 pt-4">
        <div className="h-6 w-2/3 animate-pulse rounded bg-line" />
        <div className="h-3.5 w-1/3 animate-pulse rounded bg-line" />
      </div>
      <div className="mt-6 space-y-4 px-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-4 animate-pulse rounded bg-line" />
        ))}
      </div>
    </div>
  );
}

export interface RecipeDetailProps {
  recipeId: Id;
  /** Authelia username, when signed in. Null just means "browse only" — adding to a list needs one. */
  actor: string | null;
}

export function RecipeDetail({ recipeId, actor }: RecipeDetailProps) {
  const router = useRouter();
  const [armedForDelete, setArmedForDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  /**
   * Retire the recipe.
   *
   * `deletedAt` and the prune job were built for this and nothing ever wrote
   * the column, so a paywalled half-import sat at the top of the only browse
   * surface forever. Deliberately does NOT take its ingredients off any list:
   * they were added because the household wanted them, and retiring the recipe
   * is a statement about the library rather than about tonight's shopping.
   */
  async function deleteRecipe() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/recipes/${encodeURIComponent(recipeId)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("delete failed");
      router.push("/recept");
    } catch {
      // Needs the network, and says so rather than pretending. Unlike a list
      // edit there is no op log behind this — recipes never went through it.
      toast.error("Kunde inte ta bort receptet. Prova igen när du har nät.");
      setDeleting(false);
      setArmedForDelete(false);
    }
  }
  // As in recipe-list.tsx: `status`/`recipe`/`error` are derived from
  // `result` rather than set directly in the effect, so the effect's body
  // never calls setState outside the fetch's own async continuation. That is
  // what actually stops a response for a stale recipeId/attempt — or one that
  // resolves after the component unmounted — from landing on the wrong state,
  // not just a way to satisfy the linter.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LoadResult | null>(null);
  const [flow, setFlow] = useState<AddFlow>({ step: "idle" });

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/recipes/${encodeURIComponent(recipeId)}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "Receptet kunde inte hittas."
              : await readError(res, "Kunde inte hämta receptet."),
          );
        }
        return (await res.json()) as ApiRecipe;
      })
      .then((data) => {
        if (cancelled) return;
        setResult({ attempt, kind: "ready", recipe: toDomainRecipe(data) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult({
          attempt,
          kind: "error",
          message: err instanceof Error ? err.message : "Kunde inte hämta receptet.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [recipeId, attempt]);

  const retry = () => setAttempt((n) => n + 1);

  /**
   * Save an edit, and adopt what the server says the recipe now is.
   *
   * The response is re-read rather than merged locally, so a field this request
   * said nothing about cannot be quietly replaced by a stale copy of it — and
   * so the screen shows what was actually stored rather than what was typed.
   *
   * No optimistic update, deliberately, and this is the one place in the app
   * where that is right: the list is optimistic because it is used in a shop
   * with no signal, and a recipe is edited at a table. Showing a saved method
   * that never reached the server would be the worse failure, because nothing
   * else on this screen would ever contradict it.
   */
  async function saveEdit(edit: RecipeEdit) {
    setSaving(true);
    try {
      const res = await fetch(`/api/recipes/${encodeURIComponent(recipeId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(edit),
      });
      if (!res.ok) throw new Error(await readError(res, "Kunde inte spara."));
      const data = (await res.json()) as ApiRecipe;
      setResult({ attempt, kind: "ready", recipe: toDomainRecipe(data) });
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Kunde inte spara.");
    } finally {
      setSaving(false);
    }
  }

  const status: LoadStatus = !result || result.attempt !== attempt ? "loading" : result.kind;
  const recipe = result?.kind === "ready" ? result.recipe : null;
  const error = result?.kind === "error" ? result.message : "";

  async function startAddFlow() {
    if (!recipe) return;
    try {
      const res = await fetch("/api/lists");
      if (!res.ok) throw new Error(await readError(res, "Kunde inte hämta listorna."));
      const lists = (await res.json()) as List[];
      if (lists.length === 0) {
        toast.error("Det finns ingen lista att lägga till i ännu.");
        return;
      }
      if (lists.length === 1) {
        await chooseList(lists[0]);
      } else {
        setFlow({ step: "choosing-list", lists });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Kunde inte hämta listorna.");
    }
  }

  async function chooseList(list: List) {
    if (!recipe) return;
    setFlow({ step: "preparing" });
    try {
      const res = await fetch(`/api/lists/${encodeURIComponent(list.id)}/snapshot`);
      if (!res.ok) throw new Error(await readError(res, "Kunde inte förbereda listan."));
      const snapshot = (await res.json()) as {
        catalog: CatalogItem[];
        aliases?: CatalogItemAlias[];
        purchaseStats?: Record<Id, CadenceStats>;
      };
      const catalog: Record<Id, CatalogItem> = {};
      for (const item of snapshot.catalog) catalog[item.id] = item;

      // Which vara each line means, given the catalog and the words the
      // household has merged away — see `resolveRecipeVaror`, which is where all
      // the judgement lives. Anything it could not resolve comes back as a
      // pending create, made only if the sheet is confirmed with that line still
      // ticked: RecipeAddSheet's own handler drops rows whose id is null, so a
      // null here would silently lose the ingredient rather than add it.
      //
      // A pending id is deliberately NOT added to `catalog`: RecipeAddSheet's
      // "isNew" check is just `!catalog[id]`, so leaving it absent is what makes
      // the NY VARA badge show.
      const { ingredients: patchedIngredients, pending } = resolveRecipeVaror(
        recipe.ingredients,
        catalog,
        snapshot.aliases ?? [],
      );

      setFlow({
        step: "sheet",
        list,
        purchaseStats: snapshot.purchaseStats ?? {},
        recipe: { ...recipe, ingredients: patchedIngredients },
        catalog,
        pendingCreates: pending,
        submitting: false,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Kunde inte förbereda listan.");
      setFlow({ step: "idle" });
    }
  }

  /**
   * Write the decision down, so the next add does not have to make it again.
   *
   * The line that reaches this point resolved to a vara — matched at import,
   * reached through a merge's alias, or invented a moment ago — and until now
   * nothing kept that answer. `recipe_ingredients.catalogItemId` stayed null,
   * and a null row is a row `repointMergedCatalogItem` cannot follow: merge the
   * vara away and the server re-points every recipe line EXCEPT the ones that
   * never said which vara they meant. Recording it here is what puts this
   * recipe inside the reach of the next merge.
   *
   * Only rows still null are filled, server-side, so this cannot re-aim a line
   * the household has since corrected — and a failure is deliberately not
   * fatal. The shopping is already on the list at this point; the mapping is
   * bookkeeping, and losing it costs exactly what today costs, which is that
   * the next add decides again.
   */
  async function rememberIngredientVaror(
    recipe: Recipe,
    usedIds: Set<Id>,
  ): Promise<void> {
    const mappings = recipe.ingredients
      .filter((ing) => ing.catalogItemId && usedIds.has(ing.catalogItemId))
      .map((ing) => ({
        ingredientId: ing.id,
        catalogItemId: ing.catalogItemId as Id,
      }));
    if (mappings.length === 0) return;

    try {
      await fetch(`/api/recipes/${encodeURIComponent(recipe.id)}/ingredients`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings }),
      });
    } catch {
      // Deliberately swallowed — see above. Nothing the person just asked for
      // depends on it.
    }
  }

  async function handleConfirm(
    scaleFactor: number,
    items: Array<{ catalogItemId: Id; amount: Amount | null }>,
  ) {
    if (flow.step !== "sheet" || flow.submitting) return;
    const current = flow;
    setFlow({ ...current, submitting: true });

    const usedIds = new Set(items.map((i) => i.catalogItemId));
    const createsNeeded = current.pendingCreates.filter((c) => usedIds.has(c.id));
    const who = actor ?? "okand";
    const at = new Date().toISOString();

    const ops: Op[] = [
      ...createsNeeded.map(
        (c): Op => ({
          clientOpId: crypto.randomUUID(),
          actor: who,
          at,
          kind: "create_catalog_item",
          item: {
            id: c.id,
            name: c.name,
            nameNorm: normalizeName(c.name),
            // Unsorted until someone says otherwise — better than guessing an
            // aisle and sending the household to the wrong end of the shop.
            categoryId: "ovrigt",
            iconRef: "1F4E6",
            isCustom: true,
            hasAtHome: false,
            hidden: false,
            useCount: 0,
            lastUsedAt: null,
          },
        }),
      ),
      {
        clientOpId: crypto.randomUUID(),
        actor: who,
        at,
        kind: "add_recipe",
        listId: current.list.id,
        recipeId: current.recipe.id,
        recipeAdditionId: crypto.randomUUID(),
        scaleFactor,
        items,
      },
    ];

    try {
      const res = await fetch("/api/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops }),
      });
      if (!res.ok) throw new Error(await readError(res, "Kunde inte lägga till i listan."));
      const body = (await res.json()) as {
        results: Array<{ clientOpId: string; error?: string }>;
      };
      const failed = body.results.find((r) => r.error);
      if (failed) throw new Error(failed.error ?? "Kunde inte lägga till i listan.");

      await rememberIngredientVaror(current.recipe, usedIds);

      // Sidesteps agreeing "tillagd"/"tillagt" with an arbitrary recipe
      // title's grammatical gender/number — "Blåbärsmuffins", "Pannkakor",
      // "Pytt i panna" all read fine after a fixed lead-in.
      toast(`Tillagt i ${current.list.name}`, { description: current.recipe.title });
      router.push("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Kunde inte lägga till i listan.");
      setFlow({ ...current, submitting: false });
    }
  }

  return (
    <div className="min-h-dvh pb-28">
      <ScreenHeader
        title={recipe?.title ?? "Recept"}
        backHref="/recept"
        backLabel="Till recepten"
        action={
          recipe && (
            /*
             * Two taps, not a dialog. The app already answers destructive
             * questions this way — the long-press "ta bort, kopte inte" acts on
             * the second gesture rather than raising a sheet — and a recipe is
             * recoverable in principle (the delete is soft) but not from any
             * screen, so the confirmation has to be real.
             *
             * The armed state says what will happen rather than "Ar du saker?",
             * which is a question nobody reads.
             */
            <button
              type="button"
              onClick={() => (armedForDelete ? deleteRecipe() : setArmedForDelete(true))}
              onBlur={() => setArmedForDelete(false)}
              disabled={deleting}
              className={cn(
                "flex h-11 items-center gap-1.5 rounded-full px-3 text-caption font-semibold",
                armedForDelete ? "bg-danger text-white" : "text-ink-soft",
              )}
            >
              <UiIcon name="remove" size={16} />
              {armedForDelete ? "Ta bort receptet" : "Ta bort"}
            </button>
          )
        }
      />

      {status === "loading" && <DetailSkeleton />}

      {/* Always mounted, holding a card that is not — see the identical note in
          `recipe-list.tsx`. The flip from skeleton to error announces nothing
          otherwise, and this screen is often reached from a shared link, so the
          failure can be the first thing the app ever says to someone. */}
      <div role="alert">
        {status === "error" && (
          <div className="px-6 py-16 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-danger-tint text-danger">
              <UiIcon name="warning" size={26} />
            </div>
            <p className="mt-4 text-body font-semibold text-ink">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-line-strong px-4 py-2.5 text-body-sm font-semibold text-ink"
            >
              <UiIcon name="retry" size={15} />
              Försök igen
            </button>
          </div>
        )}
      </div>

      {status === "ready" && recipe && (
        <>
          <RecipeHero title={recipe.title} imageUrl={recipe.imageUrl} />

          <div className="px-4 pt-1">
            <h1 className="text-display text-ink">{recipe.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink-soft">
              <span>
                {recipe.servings} {recipe.servingsUnit}
              </span>
              <span aria-hidden>·</span>
              <span>{recipe.ingredients.length} ingredienser</span>
              {recipe.sourceUrl && (
                <a
                  href={recipe.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-brand"
                >
                  {hostnameOf(recipe.sourceUrl)}
                  <UiIcon name="external" size={13} />
                </a>
              )}
            </div>
          </div>

          <div className="mx-4 mt-6 mb-1 text-overline text-ink-faint uppercase">
            Ingredienser
          </div>

          {/* One hairline between lines, none around them. Twenty bordered
              cards made a shopping-list-shaped thing out of what is really
              just a paragraph broken into lines.

              Named, because the heading above it is a styled div rather than a
              heading element, so nothing tied the two together — the list was
              announced as an unnamed list of twenty things. It also gives the
              e2e suite something to scope to: `getByRole("listitem")` on this
              page matches the ingredients AND any sonner toast still on screen,
              which are `<li>` too, and that made a test pass or fail on how long
              the run before it had taken. */}
          <ul aria-label="Ingredienser" className="mx-4 divide-y divide-line">
            {recipe.ingredients.map((ing) => (
              <li
                key={ing.id}
                className="flex items-baseline gap-2 py-2.5 text-body text-ink"
              >
                <span className="flex-1">{ing.rawText}</span>
                {ing.catalogItemId === null && (
                  <span className="flex-none rounded-full bg-warn-tint px-2 py-0.5 text-badge text-warn uppercase">
                    Ny vara
                  </span>
                )}
              </li>
            ))}
          </ul>

          {/* The half of a recipe this app did not have.
              Everything above is what to buy; this is what to do with it, and
              without it the screen answers a question nobody asks twice — you
              already know what is in pannkakor by the time you are cooking
              them. An `<ol>` because the order is the instruction. */}
          <div className="mx-4 mt-7 mb-1 flex items-baseline gap-2">
            <span
              id={METHOD_HEADING_ID}
              className="flex-1 text-overline text-ink-faint uppercase"
            >
              Gör så här
            </span>
          </div>

          {recipe.instructions.length > 0 ? (
            <ol
              aria-labelledby={METHOD_HEADING_ID}
              className="mx-4 flex flex-col gap-3"
            >
              {recipe.instructions.map((step, i) => (
                <li key={i} className="flex gap-3 text-body text-ink">
                  {/* The number is drawn rather than left to the list marker, so
                      it can sit in its own column and the step's second line
                      lines up under its first rather than under the digit. */}
                  <span
                    aria-hidden
                    className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-surface-sunken text-caption font-bold text-ink-soft tabular-nums"
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1 whitespace-pre-line">{step}</span>
                </li>
              ))}
            </ol>
          ) : (
            /* Said plainly rather than left blank. Most Swedish recipe sites
               publish their ingredients as schema.org markup and their method as
               unmarked prose, so "no steps" is the common case for an import
               rather than a failure — and the way out of it is one tap away. */
            <p className="mx-4 text-body-sm text-ink-soft">
              Inga steg än. Skriv dem själv, eller läs dem på källan.
            </p>
          )}

          {/* The household's own note, which is the only part of a recipe that
              is theirs — "dubbla såsen", "barnen äter inte kapris". Below the
              method because it is a comment ON it, and visually set apart so it
              never reads as a step. */}
          {recipe.notes && (
            <div className="mx-4 mt-6 rounded-card border-l-[3px] border-brand bg-surface-raised px-3.5 py-3">
              <p className="text-overline text-ink-faint uppercase">
                Er anteckning
              </p>
              <p className="mt-1 text-body whitespace-pre-line text-ink">
                {recipe.notes}
              </p>
            </div>
          )}

          <div className="mx-4 mt-6">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-control bg-surface px-3 text-body font-semibold text-ink"
            >
              <UiIcon name="edit" size={16} />
              Redigera recept
            </button>
          </div>
        </>
      )}

      {status === "ready" && recipe && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface p-3">
          <button
            type="button"
            disabled={flow.step === "preparing"}
            onClick={startAddFlow}
            className="flex w-full items-center justify-center gap-2 rounded-card bg-brand py-3.5 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.99] disabled:opacity-60"
          >
            {flow.step === "preparing" ? (
              <>
                <UiIcon name="spinner" size={17} className="animate-spin" />
                Förbereder…
              </>
            ) : (
              <>
                <UiIcon name="toList" size={17} />
                Lägg till i lista
              </>
            )}
          </button>
        </div>
      )}

      {editing && recipe && (
        <RecipeEditSheet
          recipe={recipe}
          saving={saving}
          onSave={saveEdit}
          onClose={() => setEditing(false)}
        />
      )}

      {flow.step === "choosing-list" && (
        <Sheet
          title="Lägg till i vilken lista?"
          onClose={() => setFlow({ step: "idle" })}
        >
          <ul className="px-2 pb-2">
            {flow.lists.map((list) => (
              <li key={list.id}>
                <button
                  type="button"
                  onClick={() => chooseList(list)}
                  className="flex w-full items-center gap-3 rounded-control px-2 py-3 text-left active:bg-brand-tint"
                >
                  <ItemIcon iconRef={list.icon} className="text-2xl" />
                  <span className="flex-1 text-body font-semibold text-ink">
                    {list.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      {flow.step === "sheet" && (
        <RecipeAddSheet
          recipe={flow.recipe}
          catalog={flow.catalog}
          purchaseStats={flow.purchaseStats}
          listName={flow.list.name}
          onCancel={() => setFlow({ step: "idle" })}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}
