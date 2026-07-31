"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ScreenHeader } from "./screen-header";
import { UiIcon, type UiIconName } from "./ui-icon";

/**
 * Recipe import — a URL field, a paste field, and the PWA's share target.
 *
 * The manifest points Android/iOS "share to app" at this exact route with
 * `?url=&text=&title=`, so a link shared from another app has to be usable
 * with zero typing: a bare `url` param is used as-is, and when a share only
 * populates `text` (common on Android — the link ends up inside a sentence),
 * the first http(s) URL in it is pulled out and imported automatically.
 *
 * The paste field is the answer to a dead end. A page that publishes no JSON-LD
 * and that the LLM fallback cannot read either — or any page at all, when
 * `ANTHROPIC_API_KEY` is unset — produced "Kunde inte läsa receptet från sidan."
 * over a "Försök igen" that would fail identically, with nothing else on the
 * screen to do. The recipe was never actually out of reach: it is on the page
 * the person just came from, and once it is pasted the same parser that reads
 * an imported line reads this one. The failure now offers that way through
 * rather than only a way to repeat itself.
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

/** The paste path's half of the same call. Kept plain for the same reason. */
async function runPaste(input: {
  title: string;
  servings: number;
  text: string;
}): Promise<ImportOutcome> {
  try {
    const res = await fetch("/api/recipes/paste", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      return { ok: false, message: await readError(res, "Kunde inte spara receptet.") };
    }
    const recipe = (await res.json()) as { id: string; title: string };
    return { ok: true, recipe };
  } catch {
    return { ok: false, message: "Kunde inte spara receptet." };
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

  /**
   * The paste path keeps its own status and its own error, rather than sharing
   * the URL path's.
   *
   * They are two different operations that fail for different reasons, and one
   * shared error meant the "Försök igen" under a message had to know which of
   * them to repeat. Two small pieces of state that are each obviously right beat
   * one that needs a note explaining which half it currently refers to.
   */
  const [pasting, setPasting] = useState(false);
  const [title, setTitle] = useState("");
  const [servings, setServings] = useState(4);
  const [pastedText, setPastedText] = useState("");
  const [pasteStatus, setPasteStatus] = useState<Status>("idle");
  const [pasteError, setPasteError] = useState("");

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

  const doPaste = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || pastedText.trim() === "") return;
    setPasteStatus("importing");
    setPasteError("");
    const outcome = await runPaste({
      title: trimmedTitle,
      servings,
      text: pastedText,
    });
    if (outcome.ok) {
      toast(`${outcome.recipe.title} sparat`);
      router.push(`/recept/${outcome.recipe.id}`);
    } else {
      setPasteStatus("error");
      setPasteError(outcome.message);
    }
  }, [router, title, servings, pastedText]);

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
            <ErrorCard message={error}>
              <ErrorAction icon="retry" onClick={() => void doImport(url)}>
                Försök igen
              </ErrorAction>
              {/* The way through, offered where the wall is. "Försök igen" on
                  its own repeats a request that has already failed for a
                  reason that will not have changed — the page has no recipe
                  markup, or there is no API key to fall back on — so the only
                  honest second option is the one that does not need the page
                  to cooperate. */}
              {!pasting && (
                <ErrorAction icon="edit" onClick={() => setPasting(true)}>
                  Klistra in i stället
                </ErrorAction>
              )}
            </ErrorCard>
          )}
        </div>

        {/* Available before anything has failed, too. The design spec counts
            paste among the four ways in, not as a consolation, and a path that
            only exists after an error is a path nobody knows about. Stood down
            while the error card is up, which is already offering it — two
            buttons for one thing, a line apart, reads as two different things. */}
        {!pasting && status !== "error" && (
          <button
            type="button"
            onClick={() => setPasting(true)}
            className="mt-6 inline-flex items-center gap-2 text-body-sm font-semibold text-brand"
          >
            <UiIcon name="edit" size={15} />
            Klistra in ingredienserna i stället
          </button>
        )}

        {pasting && (
          <form
            className="mt-7 border-t border-line pt-5"
            onSubmit={(e) => {
              e.preventDefault();
              void doPaste();
            }}
          >
            <h2 className="text-title text-ink">Klistra in receptet</h2>
            <p className="mt-1 max-w-[42ch] text-body-sm text-ink-soft">
              Kopiera ingredienserna från sidan och klistra in dem här, en per
              rad. Rubriker och «4 portioner» kan följa med — de sorteras bort.
            </p>

            <label className="mt-4 flex flex-col gap-1.5">
              <span className="text-overline text-ink-faint uppercase">
                Vad heter receptet?
              </span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Pannkakor"
                type="text"
                autoCapitalize="sentences"
                className="w-full rounded-card border border-line bg-surface-raised px-3.5 py-3 text-body text-ink outline-none placeholder:text-ink-faint"
              />
            </label>

            {/* A stepper rather than a number field, matching the one in the
                add-to-list sheet — and because a number field can be emptied,
                and "" scaled against is every amount in the recipe becoming
                NaN. There is no way to type a bad value into this. */}
            <div className="mt-4 flex items-center gap-3">
              <span className="flex-1 text-overline text-ink-faint uppercase">
                Hur många portioner?
              </span>
              <button
                type="button"
                aria-label="Färre portioner"
                onClick={() => setServings((s) => Math.max(1, s - 1))}
                className="flex h-10 w-10 flex-none items-center justify-center rounded-full border border-line-strong text-ink transition-transform duration-100 active:scale-95"
              >
                <UiIcon name="decrease" size={18} />
              </button>
              <output className="w-8 text-center text-body font-bold text-ink">
                {servings}
              </output>
              <button
                type="button"
                aria-label="Fler portioner"
                onClick={() => setServings((s) => Math.min(999, s + 1))}
                className="flex h-10 w-10 flex-none items-center justify-center rounded-full border border-line-strong text-ink transition-transform duration-100 active:scale-95"
              >
                <UiIcon name="increase" size={18} />
              </button>
            </div>

            <label className="mt-4 flex flex-col gap-1.5">
              <span className="text-overline text-ink-faint uppercase">
                Ingredienser
              </span>
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                rows={8}
                placeholder={"3 dl mjöl\n6 dl mjölk\n3 ägg"}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="w-full resize-y rounded-card border border-line bg-surface-raised px-3.5 py-3 text-body text-ink outline-none placeholder:text-ink-faint"
              />
            </label>

            <button
              type="submit"
              disabled={
                pasteStatus === "importing" ||
                title.trim() === "" ||
                pastedText.trim() === ""
              }
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-card bg-brand py-3.5 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.99] disabled:opacity-40"
            >
              {pasteStatus === "importing" ? (
                <>
                  <UiIcon name="spinner" size={17} className="animate-spin" />
                  Sparar receptet…
                </>
              ) : (
                <>
                  <UiIcon name="check" size={17} />
                  Spara receptet
                </>
              )}
            </button>

            {/* Its own region, mounted with the form rather than with the
                message, for the same reason as the one above: a live region
                that arrives together with its text is announced unreliably. */}
            <div role="alert">
              {pasteStatus === "error" && (
                <ErrorCard message={pasteError}>
                  <ErrorAction icon="retry" onClick={() => void doPaste()}>
                    Försök igen
                  </ErrorAction>
                </ErrorCard>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ErrorCard({
  message,
  children,
}: {
  message: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 rounded-card border border-line bg-danger-tint p-4">
      <div className="flex items-start gap-2.5">
        <UiIcon
          name="warning"
          size={18}
          className="mt-0.5 flex-none text-danger"
        />
        <p className="flex-1 text-body font-semibold text-danger">{message}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function ErrorAction({
  icon,
  onClick,
  children,
}: {
  icon: UiIconName;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-full border border-danger/30 px-4 py-2 text-body-sm font-semibold text-danger"
    >
      <UiIcon name={icon} size={15} />
      {children}
    </button>
  );
}
