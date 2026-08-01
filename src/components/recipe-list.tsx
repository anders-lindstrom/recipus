"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Id } from "@/lib/domain";
import { ScreenHeader } from "./screen-header";
import { UiIcon } from "./ui-icon";

/**
 * The recipe list.
 *
 * Unlike the shopping list, recipes have no offline-first store to hydrate
 * from — importing one requires the network anyway — so this fetches once,
 * client-side, and owns its own loading/error/empty states rather than
 * borrowing a server-rendered snapshot the way the list page does.
 */

interface RecipeSummary {
  id: Id;
  title: string;
  imageUrl: string | null;
  servings: number;
  servingsUnit: string;
  sourceUrl: string | null;
  ingredientCount: number;
}

type Status = "loading" | "error" | "ready";

/** One fetch attempt's outcome, tagged with which attempt it answers. */
type Result =
  | { attempt: number; kind: "ready"; recipes: RecipeSummary[] }
  | { attempt: number; kind: "error"; message: string };

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
    // A bare 404/500 page isn't JSON at all — fall through to the default.
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

/** The image, or a tinted placeholder with the recipe's first letter — never a broken-image icon. */
function RecipeThumb({ title, imageUrl }: { title: string; imageUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !failed;

  return (
    <div className="flex h-16 w-16 flex-none items-center justify-center overflow-hidden rounded-tile bg-brand-tint">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- recipe photos come from arbitrary external sites; next/image would need every source domain allow-listed.
        <img
          src={imageUrl!}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden className="text-display text-brand-ink">
          {(title.trim()[0] ?? "?").toUpperCase()}
        </span>
      )}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="h-16 w-16 flex-none animate-pulse rounded-tile bg-line" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-3/4 animate-pulse rounded bg-line" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-line" />
      </div>
    </div>
  );
}

export function RecipeList() {
  // Bumped by the retry button to re-run the effect below. `status` is
  // derived from `result` rather than written directly from the effect: the
  // effect's body only ever sets state from inside the fetch's own
  // continuation (a genuinely async callback), never synchronously at the
  // top, which is what actually made a stale response — or one that resolves
  // after the component unmounted — impossible to land on the wrong state.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/recipes")
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res, "Kunde inte hämta recepten."));
        return (await res.json()) as RecipeSummary[];
      })
      .then((data) => {
        if (cancelled) return;
        setResult({ attempt, kind: "ready", recipes: data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult({
          attempt,
          kind: "error",
          message: err instanceof Error ? err.message : "Kunde inte hämta recepten.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = () => setAttempt((n) => n + 1);

  // A result answering a superseded attempt reads as still loading — this is
  // what makes hammering "Försök igen" safe without an extra guard.
  const status: Status = !result || result.attempt !== attempt ? "loading" : result.kind;
  const recipes = result?.kind === "ready" ? result.recipes : [];
  const error = result?.kind === "error" ? result.message : "";

  return (
    <div className="min-h-dvh pb-10">
      <ScreenHeader
        title="Recept"
        backHref="/"
        backLabel="Till handlingslistan"
        action={
          status === "ready" && recipes.length > 0 ? (
            <Link
              href="/recept/importera"
              className="mr-1 flex flex-none items-center gap-1.5 rounded-full bg-brand px-3.5 py-2 text-caption font-semibold text-on-brand"
            >
              <UiIcon name="plus" size={15} />
              Importera
            </Link>
          ) : undefined
        }
      />

      {status === "loading" && (
        <div className="divide-y divide-line px-3 pt-2">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      )}

      {/* A live region that is always mounted, holding a card that is not.
          The same treatment `recipe-import.tsx` already gives its failure, and
          for the same reason: a flip from the loading skeleton to this card is
          completely silent to a screen reader — nothing is focused, and nothing
          announces. The region has to exist BEFORE the text does, because a
          live region inserted together with its own content is a coin flip
          across screen readers. `role="alert"` rather than a polite region
          because the person is standing there waiting for this exact answer.

          It was fixed once, on the import screen, and the identical
          loading/error/ready block was then copied here and into
          `recipe-detail.tsx` without it. */}
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

      {status === "ready" && recipes.length === 0 && (
        <div className="px-6 py-16 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-tint text-brand-ink">
            <UiIcon name="recipes" size={30} />
          </div>
          <p className="mt-4 text-display text-ink">Inga recept ännu</p>
          <p className="mx-auto mt-2 max-w-[34ch] text-body text-ink-soft">
            Klistra in en länk till ett recept, till exempel från ica.se,
            koket.se, arla.se eller coop.se, så hämtar vi ingredienserna åt dig.
          </p>
          <Link
            href="/recept/importera"
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-brand px-5 py-3 text-body font-semibold text-on-brand"
          >
            <UiIcon name="plus" size={17} />
            Importera recept
          </Link>
        </div>
      )}

      {status === "ready" && recipes.length > 0 && (
        // Rows separated by hairlines rather than boxed in cards. Every recipe
        // is the same kind of thing at the same level, so there is no hierarchy
        // for a card's elevation to communicate.
        <ul className="divide-y divide-line px-3">
          {recipes.map((r) => {
            const hostname = hostnameOf(r.sourceUrl);
            return (
              <li key={r.id}>
                <Link
                  href={`/recept/${r.id}`}
                  className="flex items-center gap-3 py-3 active:opacity-70"
                >
                  <RecipeThumb title={r.title} imageUrl={r.imageUrl} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body font-bold text-ink">
                      {r.title}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-caption text-ink-soft">
                      <span>
                        {r.servings} {r.servingsUnit}
                      </span>
                      <span aria-hidden>·</span>
                      <span>
                        {r.ingredientCount}{" "}
                        {r.ingredientCount === 1 ? "ingrediens" : "ingredienser"}
                      </span>
                    </div>
                    {hostname && (
                      <div className="mt-0.5 truncate text-caption text-ink-faint">
                        {hostname}
                      </div>
                    )}
                  </div>
                  <UiIcon
                    name="chevronDown"
                    size={16}
                    className="-rotate-90 flex-none text-ink-faint"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
