"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Amount, CatalogItem, Id, List, Recipe, RecipeIngredient } from "@/lib/domain";
import type { CadenceStats } from "@/lib/cadence";
import { parseIngredientLine } from "@/lib/ingredients";
import type { Op } from "@/lib/sync";
import { normalizeName, slugify } from "@/lib/utils";
import { ItemIcon } from "./icon";
import { RecipeAddSheet } from "./recipe-add-sheet";
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
  ingredients: ApiRecipeIngredient[];
}

function toDomainRecipe(api: ApiRecipe): Recipe {
  return {
    ...api,
    ingredients: api.ingredients.map((ing) => ({ ...ing, recipeId: api.id })),
  };
}

type LoadStatus = "loading" | "error" | "ready";

/** One fetch attempt's outcome, tagged with which attempt it answers. */
type LoadResult =
  | { attempt: number; kind: "ready"; recipe: Recipe }
  | { attempt: number; kind: "error"; message: string };

/** A catalog item this screen is about to create for an unmatched ingredient. */
interface PendingCreate {
  id: Id;
  name: string;
}

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
      pendingCreates: PendingCreate[];
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
        purchaseStats?: Record<Id, CadenceStats>;
      };
      const catalog: Record<Id, CatalogItem> = {};
      for (const item of snapshot.catalog) catalog[item.id] = item;

      // Every unmatched ingredient becomes a brand-new catalog item, created
      // before the sheet ever opens — RecipeAddSheet's own confirm handler
      // drops any row still null at that point, so a null id here would
      // silently lose the ingredient rather than add it. The new id is
      // deliberately NOT added to `catalog`: RecipeAddSheet's "isNew" check is
      // just `!catalog[id]`, so leaving it absent is what makes the NY VARA
      // badge show, exactly as if the server matcher had never resolved it.
      const pending = new Map<string, PendingCreate>();
      const patchedIngredients: RecipeIngredient[] = recipe.ingredients.map((ing) => {
        if (ing.catalogItemId) return ing;
        const parsed = parseIngredientLine(ing.rawText);
        const name = parsed.name.trim() || ing.rawText.trim();
        const key = normalizeName(name);
        let entry = pending.get(key);
        if (!entry) {
          entry = { id: slugify(name) || `vara-${ing.id}`, name };
          pending.set(key, entry);
        }
        return { ...ing, catalogItemId: entry.id };
      });

      setFlow({
        step: "sheet",
        list,
        purchaseStats: snapshot.purchaseStats ?? {},
        recipe: { ...recipe, ingredients: patchedIngredients },
        catalog,
        pendingCreates: [...pending.values()],
        submitting: false,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Kunde inte förbereda listan.");
      setFlow({ step: "idle" });
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
      />

      {status === "loading" && <DetailSkeleton />}

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
