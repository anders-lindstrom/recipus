"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Amount, CatalogItem, Id, List, Recipe, RecipeIngredient } from "@/lib/domain";
import { parseIngredientLine } from "@/lib/ingredients";
import type { Op } from "@/lib/sync";
import { codepointToEmoji, normalizeName, slugify } from "@/lib/utils";
import { RecipeAddSheet } from "./recipe-add-sheet";

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

function RecipeHero({ title, imageUrl }: { title: string; imageUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !failed;

  return (
    <div className="flex h-48 w-full items-center justify-center overflow-hidden bg-brand-tint">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- recipe photos come from arbitrary external sites; next/image would need every source domain allow-listed.
        <img
          src={imageUrl!}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden className="text-6xl font-extrabold text-brand">
          {(title.trim()[0] ?? "?").toUpperCase()}
        </span>
      )}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div>
      <div className="h-48 w-full animate-pulse bg-line" />
      <div className="space-y-2 px-4 pt-4">
        <div className="h-5 w-2/3 animate-pulse rounded bg-line" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-line" />
      </div>
      <div className="mt-4 space-y-1.5 px-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded-[10px] bg-line" />
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
      const snapshot = (await res.json()) as { catalog: CatalogItem[] };
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
      <header className="safe-top sticky top-0 z-30 flex items-center gap-2 bg-brand px-4 py-3 text-white">
        <Link href="/recept" aria-label="Till recepten" className="text-lg font-bold">
          ‹
        </Link>
        <span className="flex-1 truncate text-[15px] font-bold tracking-tight">
          {recipe?.title ?? "Recept"}
        </span>
      </header>

      {status === "loading" && <DetailSkeleton />}

      {status === "error" && (
        <div className="px-6 py-16 text-center">
          <p className="text-[13px] font-semibold text-danger">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded-full border border-line px-4 py-2 text-[12.5px] font-bold text-ink"
          >
            Försök igen
          </button>
        </div>
      )}

      {status === "ready" && recipe && (
        <>
          <RecipeHero title={recipe.title} imageUrl={recipe.imageUrl} />

          <div className="px-4 pt-3">
            <h1 className="text-[19px] font-extrabold tracking-tight text-ink">
              {recipe.title}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-soft">
              <span>
                {recipe.servings} {recipe.servingsUnit}
              </span>
              {recipe.sourceUrl && (
                <>
                  <span aria-hidden>·</span>
                  <a
                    href={recipe.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-brand underline underline-offset-2"
                  >
                    {hostnameOf(recipe.sourceUrl)}
                  </a>
                </>
              )}
            </div>
          </div>

          <div className="mx-4 mt-4 mb-2 flex justify-between text-[10.5px] font-extrabold tracking-[0.1em] text-ink-faint uppercase">
            <span>Ingredienser</span>
            <span>{recipe.ingredients.length}</span>
          </div>

          {recipe.ingredients.map((ing) => (
            <div
              key={ing.id}
              className="mx-3 mb-1.5 flex items-center gap-2.5 rounded-[10px] border border-line bg-paper-raised px-3 py-2.5"
            >
              <span className="flex-1 text-[13px] font-semibold text-ink">
                {ing.rawText}
                {ing.catalogItemId === null && (
                  <span className="ml-1.5 rounded-lg bg-warn/20 px-1.5 py-0.5 text-[9px] font-extrabold text-warn">
                    NY VARA
                  </span>
                )}
              </span>
            </div>
          ))}
        </>
      )}

      {status === "ready" && recipe && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper p-3">
          <button
            type="button"
            disabled={flow.step === "preparing"}
            onClick={startAddFlow}
            className="w-full rounded-card bg-brand py-3.5 text-center text-sm font-extrabold text-white disabled:opacity-60"
          >
            {flow.step === "preparing" ? "Förbereder…" : "Lägg till i lista"}
          </button>
        </div>
      )}

      {flow.step === "choosing-list" && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/30"
          role="dialog"
          aria-modal="true"
          aria-label="Välj lista"
          onClick={() => setFlow({ step: "idle" })}
        >
          <div
            className="safe-bottom w-full rounded-t-2xl border-t border-line bg-paper-raised"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-line px-4 pt-4 pb-3 text-[15px] font-extrabold text-ink">
              Lägg till i vilken lista?
            </div>
            <ul>
              {flow.lists.map((list) => (
                <li key={list.id}>
                  <button
                    type="button"
                    onClick={() => chooseList(list)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-brand-tint"
                  >
                    <span aria-hidden className="text-lg">
                      {codepointToEmoji(list.icon)}
                    </span>
                    <span className="flex-1 text-[13.5px] font-semibold text-ink">
                      {list.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {flow.step === "sheet" && (
        <RecipeAddSheet
          recipe={flow.recipe}
          catalog={flow.catalog}
          listName={flow.list.name}
          onCancel={() => setFlow({ step: "idle" })}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}
