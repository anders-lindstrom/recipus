"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Id } from "@/lib/domain";

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
    <div className="flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-[10px] bg-brand-tint">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- recipe photos come from arbitrary external sites; next/image would need every source domain allow-listed.
        <img
          src={imageUrl!}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden className="text-lg font-extrabold text-brand">
          {(title.trim()[0] ?? "?").toUpperCase()}
        </span>
      )}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="mx-3 mb-2 flex items-center gap-3 rounded-card border border-line bg-paper-raised p-3">
      <div className="h-14 w-14 flex-none animate-pulse rounded-[10px] bg-line" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 w-3/4 animate-pulse rounded bg-line" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-line" />
      </div>
    </div>
  );
}

export function RecipeList() {
  const [status, setStatus] = useState<Status>("loading");
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setStatus("loading");
    setError("");
    fetch("/api/recipes")
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res, "Kunde inte hämta recepten."));
        return (await res.json()) as RecipeSummary[];
      })
      .then((data) => {
        setRecipes(data);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Kunde inte hämta recepten.");
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return (
    <div className="min-h-dvh pb-10">
      <header className="safe-top sticky top-0 z-30 flex items-center gap-2 bg-brand px-4 py-3 text-white">
        <Link href="/" aria-label="Till handlingslistan" className="text-lg font-bold">
          ‹
        </Link>
        <span className="flex-1 text-[16.5px] font-bold tracking-tight">Recept</span>
      </header>

      {status === "loading" && (
        <div className="pt-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {status === "error" && (
        <div className="px-6 py-16 text-center">
          <p className="text-[13px] font-semibold text-danger">{error}</p>
          <button
            type="button"
            onClick={load}
            className="mt-3 rounded-full border border-line px-4 py-2 text-[12.5px] font-bold text-ink"
          >
            Försök igen
          </button>
        </div>
      )}

      {status === "ready" && recipes.length === 0 && (
        <div className="px-6 py-16 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-tint text-3xl">
            📖
          </div>
          <p className="mt-4 text-[15px] font-extrabold text-ink">Inga recept ännu</p>
          <p className="mx-auto mt-2 max-w-xs text-[12.5px] text-ink-soft">
            Klistra in en länk till ett recept, till exempel från ica.se, koket.se, arla.se
            eller coop.se, så hämtar vi ingredienserna åt dig.
          </p>
          <Link
            href="/recept/importera"
            className="mt-4 inline-block rounded-card bg-brand px-5 py-3 text-[13px] font-extrabold text-white"
          >
            Importera recept
          </Link>
        </div>
      )}

      {status === "ready" && recipes.length > 0 && (
        <>
          <div className="px-3 pt-3">
            <Link
              href="/recept/importera"
              className="flex items-center justify-center gap-1.5 rounded-card bg-brand px-4 py-3 text-[13.5px] font-extrabold text-white"
            >
              <span aria-hidden>+</span> Importera recept
            </Link>
          </div>

          <div className="pt-2">
            {recipes.map((r) => {
              const hostname = hostnameOf(r.sourceUrl);
              return (
                <Link
                  key={r.id}
                  href={`/recept/${r.id}`}
                  className="mx-3 mb-2 flex items-center gap-3 rounded-card border border-line bg-paper-raised p-3"
                >
                  <RecipeThumb title={r.title} imageUrl={r.imageUrl} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-extrabold tracking-tight text-ink">
                      {r.title}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-soft">
                      <span>
                        {r.servings} {r.servingsUnit}
                      </span>
                      {hostname && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="truncate">{hostname}</span>
                        </>
                      )}
                      <span aria-hidden>·</span>
                      <span>
                        {r.ingredientCount}{" "}
                        {r.ingredientCount === 1 ? "ingrediens" : "ingredienser"}
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
