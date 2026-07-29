"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * Recipe import — a URL field, and the PWA's share target.
 *
 * The manifest points Android/iOS "share to app" at this exact route with
 * `?url=&text=&title=`, so a link shared from another app has to be usable
 * with zero typing: a bare `url` param is used as-is, and when a share only
 * populates `text` (common on Android — the link ends up inside a sentence),
 * the first http(s) URL in it is pulled out and imported automatically.
 */

const URL_RE = /https?:\/\/[^\s]+/i;
const TRAILING_PUNCT_RE = /[)\]>.,;:!?'"”’»]+$/;

function extractFirstUrl(text: string): string | null {
  const match = URL_RE.exec(text);
  if (!match) return null;
  return match[0].replace(TRAILING_PUNCT_RE, "");
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveShareUrl(url?: string, text?: string): string | null {
  if (url && looksLikeUrl(url)) return url;
  if (text) {
    const extracted = extractFirstUrl(text);
    if (extracted) return extracted;
  }
  return null;
}

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

type Status = "idle" | "importing" | "error";

export interface RecipeImportProps {
  /** From the share target's `?url=`, when the share was a plain link. */
  initialUrl?: string;
  /** From `?text=` — Android often puts the link inside a sentence here instead. */
  initialText?: string;
}

export function RecipeImport({ initialUrl, initialText }: RecipeImportProps) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl ?? "");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const autoTried = useRef(false);

  const doImport = useCallback(
    async (target: string) => {
      const trimmed = target.trim();
      if (!trimmed) return;
      setStatus("importing");
      setError("");
      try {
        const res = await fetch("/api/recipes/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
        });
        if (!res.ok) {
          throw new Error(await readError(res, "Kunde inte importera receptet."));
        }
        const recipe = (await res.json()) as { id: string; title: string };
        toast(`${recipe.title} importerat`);
        router.push(`/recept/${recipe.id}`);
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Kunde inte importera receptet.");
      }
    },
    [router],
  );

  // Share-target arrivals import themselves — a link shared from another app
  // should not require also tapping "Importera". Guarded to run at most once
  // per mount, from the props the very first render handed us.
  useEffect(() => {
    if (autoTried.current) return;
    const resolved = resolveShareUrl(initialUrl, initialText);
    if (!resolved) return;
    autoTried.current = true;
    void Promise.resolve().then(() => {
      setUrl(resolved);
      void doImport(resolved);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-dvh pb-10">
      <header className="safe-top sticky top-0 z-30 flex items-center gap-2 bg-brand px-4 py-3 text-white">
        <Link href="/recept" aria-label="Till recepten" className="text-lg font-bold">
          ‹
        </Link>
        <span className="flex-1 text-[15.5px] font-bold tracking-tight">Importera recept</span>
      </header>

      <div className="px-4 pt-5">
        <p className="text-[12.5px] text-ink-soft">
          Klistra in en länk till ett recept, till exempel från ica.se, koket.se, arla.se
          eller coop.se.
        </p>

        <form
          className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-paper-raised px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void doImport(url);
          }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            aria-label="Receptlänk"
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-faint"
          />
          <button
            type="submit"
            disabled={status === "importing" || url.trim() === ""}
            className="rounded-full bg-brand px-4 py-2 text-[12.5px] font-extrabold text-white disabled:opacity-40"
          >
            {status === "importing" ? "Importerar…" : "Importera"}
          </button>
        </form>

        {status === "importing" && (
          <div className="mt-4 flex items-center gap-2 text-[12.5px] text-ink-soft">
            <span
              aria-hidden
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-line border-t-brand"
            />
            <span>Hämtar receptet…</span>
          </div>
        )}

        {status === "error" && (
          <div className="mt-4 rounded-card border border-line bg-paper-raised p-3">
            <p className="text-[12.5px] font-semibold text-danger">{error}</p>
            <button
              type="button"
              onClick={() => void doImport(url)}
              className="mt-2 rounded-full border border-line px-4 py-2 text-[12px] font-bold text-ink"
            >
              Försök igen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
