"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ScreenHeader } from "./screen-header";
import { UiIcon } from "./ui-icon";

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

type ImportOutcome =
  | { ok: true; recipe: { id: string; title: string } }
  | { ok: false; message: string };

/**
 * The network call, with no React state attached to it at all.
 *
 * Kept separate from `doImport` below so the auto-import effect can call it
 * directly: an effect body must not itself call a function that synchronously
 * sets state (that's the cascading-render footgun the lint rule catches), but
 * calling a plain async function that only returns a result is fine, and the
 * effect applies that result itself, behind its own cancellation guard.
 */
async function runImport(url: string): Promise<ImportOutcome> {
  try {
    const res = await fetch("/api/recipes/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      return { ok: false, message: await readError(res, "Kunde inte importera receptet.") };
    }
    const recipe = (await res.json()) as { id: string; title: string };
    return { ok: true, recipe };
  } catch {
    return { ok: false, message: "Kunde inte importera receptet." };
  }
}

export interface RecipeImportProps {
  /** From the share target's `?url=`, when the share was a plain link. */
  initialUrl?: string;
  /** From `?text=` — Android often puts the link inside a sentence here instead. */
  initialText?: string;
}

export function RecipeImport({ initialUrl, initialText }: RecipeImportProps) {
  const router = useRouter();
  // The field starts prefilled with whatever the share target resolved to —
  // computed once, during the initial render, rather than written from an
  // effect: it's fully derivable from props, so there is no state to
  // synchronize with an external system here at all.
  const [url, setUrl] = useState(
    () => resolveShareUrl(initialUrl, initialText) ?? initialUrl ?? "",
  );
  // Likewise derived at the first render: a share that arrived with a usable
  // link starts "importing" immediately, rather than the effect below
  // flipping it there a tick later.
  const [status, setStatus] = useState<Status>(() =>
    resolveShareUrl(initialUrl, initialText) ? "importing" : "idle",
  );
  const [error, setError] = useState("");
  const autoTried = useRef(false);

  const doImport = useCallback(async (target: string) => {
    const trimmed = target.trim();
    if (!trimmed) return;
    setStatus("importing");
    setError("");
    const outcome = await runImport(trimmed);
    if (outcome.ok) {
      toast(`${outcome.recipe.title} importerat`);
      router.push(`/recept/${outcome.recipe.id}`);
    } else {
      setStatus("error");
      setError(outcome.message);
    }
  }, [router]);

  // Share-target arrivals import themselves — a link shared from another app
  // should not require also tapping "Importera". Guarded to run at most once
  // per mount, from the props the very first render handed us. Calls
  // `runImport` directly rather than `doImport`, and only ever sets state
  // from inside its `.then()` — guarded by `cancelled` — so a share that
  // resolves after the user has already navigated away never touches state
  // on an unmounted component.
  useEffect(() => {
    if (autoTried.current) return;
    const resolved = resolveShareUrl(initialUrl, initialText);
    if (!resolved) return;
    autoTried.current = true;

    let cancelled = false;
    void runImport(resolved).then((outcome) => {
      if (cancelled) return;
      if (outcome.ok) {
        toast(`${outcome.recipe.title} importerat`);
        router.push(`/recept/${outcome.recipe.id}`);
      } else {
        setStatus("error");
        setError(outcome.message);
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = status === "importing";

  return (
    <div className="min-h-dvh pb-10">
      <ScreenHeader
        title="Importera recept"
        backHref="/recept"
        backLabel="Till recepten"
      />

      <div className="px-4 pt-6">
        <p className="max-w-[42ch] text-body text-ink-soft">
          Klistra in en länk till ett recept, till exempel från ica.se,
          koket.se, arla.se eller coop.se.
        </p>

        {/* Field above, button below. Side by side, the button squeezed the URL
            field down to a few visible characters on a phone — which is the one
            input in the app where seeing what you pasted actually matters. */}
        <form
          className="mt-4"
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
            className="w-full rounded-card border border-line bg-surface-raised px-3.5 py-3 text-body text-ink outline-none placeholder:text-ink-faint"
          />
          <button
            type="submit"
            disabled={busy || url.trim() === ""}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-card bg-brand py-3.5 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.99] disabled:opacity-40"
          >
            {busy ? (
              <>
                <UiIcon name="spinner" size={17} className="animate-spin" />
                Hämtar receptet…
              </>
            ) : (
              <>
                <UiIcon name="plus" size={17} />
                Importera
              </>
            )}
          </button>
        </form>

        {/* A live region that is always mounted, holding a card that is not.
            The failure is otherwise completely silent to a screen reader: focus
            stays on the submit button, whose label simply flips back from
            "Hämtar receptet…" to "Importera", which says nothing about whether
            the import worked — and this screen is reached by sharing a link
            from another app, so it is often the first thing the app ever says.

            Empty and unstyled until there is something to say, so it takes no
            space. The region has to exist BEFORE the text does: a live region
            inserted together with its own content is a coin flip across screen
            readers, and this one is a failure, which is the worst thing to
            drop. `role="alert"` rather than a polite region because the person
            is standing there waiting for this exact answer. */}
        <div role="alert">
          {status === "error" && (
            <div className="mt-5 rounded-card border border-line bg-danger-tint p-4">
              <div className="flex items-start gap-2.5">
                <UiIcon
                  name="warning"
                  size={18}
                  className="mt-0.5 flex-none text-danger"
                />
                <p className="flex-1 text-body font-semibold text-danger">
                  {error}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void doImport(url)}
                className="mt-3 inline-flex items-center gap-2 rounded-full border border-danger/30 px-4 py-2 text-body-sm font-semibold text-danger"
              >
                <UiIcon name="retry" size={15} />
                Försök igen
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
