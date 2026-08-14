"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AiRow } from "@/lib/ai-add";
import type { CatalogItem, Id } from "@/lib/domain";
import { fileToParseInput } from "@/lib/client/image-file";
import { useFocusTrap } from "@/lib/client/use-focus-trap";
import { useSpeech } from "@/lib/client/use-speech";
import { formatAmount } from "@/lib/units";
import { cn } from "@/lib/utils";
import { type AiAddPlan, initialTicked, planAdditions } from "./ai-add-model";
import { ItemIcon } from "./icon";
import { UiIcon } from "./ui-icon";

/**
 * Putting a whole list on the list.
 *
 * The same contract as `RecipeAddSheet`, deliberately down to the row markup:
 * you see what is about to happen, you untick what you did not mean, and one
 * button does the rest. A screenshot of somebody else's app, a clump of typed
 * text and a sentence said out loud all arrive at this one screen, because they
 * are all the same question — "is this what you meant?" — and answering it
 * three different ways would be three things to learn.
 *
 * What it never does is write. The parse is a read; the ops are the caller's,
 * dispatched through the list's ordinary optimistic path.
 */

type Phase =
  | { step: "collecting" }
  | { step: "parsing" }
  | { step: "reviewing"; rows: AiRow[]; usedModel: boolean }
  | { step: "error"; message: string };

export interface AiAddSheetProps {
  listName: string;
  catalog: Record<Id, CatalogItem>;
  /** What is already on the list — those rows arrive unticked. */
  onListItemIds: Set<Id>;
  /** Present when a share opened this: parse that image on mount. */
  shareToken?: string;
  onCancel: () => void;
  onConfirm: (plan: AiAddPlan) => void;
}

type ParseBody =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mediaType: string }
  | { kind: "share"; token: string };

/**
 * The network call, with no React state attached to it.
 *
 * Plain and separate for the same reason `runImport` is in `recipe-import.tsx`:
 * the share effect below has to call it directly, and an effect body must not
 * call something that synchronously sets state. The effect applies the result
 * itself, behind its own cancellation guard.
 */
async function runParse(
  body: ParseBody,
): Promise<
  { ok: true; rows: AiRow[]; usedModel: boolean } | { ok: false; message: string }
> {
  try {
    const res = await fetch("/api/ai/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      return { ok: false, message: problem?.error ?? "Kunde inte läsa det där." };
    }
    const result = (await res.json()) as { rows: AiRow[]; usedModel: boolean };
    return { ok: true, ...result };
  } catch {
    return { ok: false, message: "Ingen kontakt med servern." };
  }
}

export function AiAddSheet({
  listName,
  catalog,
  onListItemIds,
  shareToken,
  onCancel,
  onConfirm,
}: AiAddSheetProps) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>(() =>
    shareToken ? { step: "parsing" } : { step: "collecting" },
  );
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const sharedTried = useRef(false);
  /**
   * The field only ever gains FINISHED sentences.
   *
   * `useSpeech` shows the sentence in progress itself, below the button, and
   * calls this once when it stops moving — so nothing that can still change
   * reaches the textarea, and there is no base to capture and no earlier text
   * to rebuild around. Adding to what is there is safe precisely because a
   * finished sentence never comes back.
   *
   * The updater form rather than `text`, because two sentences can settle
   * before a render lands, and the second must add to the first rather than to
   * whatever the closure remembers.
   */
  const speech = useSpeech(
    useCallback((utterance: string) => {
      setText((current) => (current ? `${current}, ${utterance}` : utterance));
    }, []),
  );

  const show = useCallback(
    (result: Awaited<ReturnType<typeof runParse>>) => {
      if (!result.ok) {
        setPhase({ step: "error", message: result.message });
        return;
      }
      setTicked(initialTicked(result.rows, onListItemIds));
      setPhase({
        step: "reviewing",
        rows: result.rows,
        usedModel: result.usedModel,
      });
    },
    [onListItemIds],
  );

  const parse = useCallback(
    async (body: ParseBody) => {
      setPhase({ step: "parsing" });
      show(await runParse(body));
    },
    [show],
  );

  /**
   * A share opens straight into the parse — the person already chose the image
   * in another app, and asking them to press a second button here would be
   * asking them to confirm the thing they just did.
   *
   * The run-once ref and a cancellation flag cannot both be here, and the ref is
   * the one that has to stay. `recipe-import.tsx` pairs them safely because its
   * guard is re-derivable — a cancelled share can simply be imported again. This
   * token cannot: it is one-shot and consumed on first read, so a second fetch
   * gets a 404.
   *
   * Together they deadlock under StrictMode, which the App Router turns on:
   * setup marks the ref and starts the fetch, the simulated cleanup sets
   * `cancelled`, the second setup finds the ref already marked and starts
   * nothing — and the first fetch then resolves into a closure that has been
   * told to discard its result. `phase` starts at `parsing`, so the sheet sat on
   * the spinner for ever, every time, in dev.
   *
   * So there is no cleanup. Resolving after unmount sets state on a component
   * that is gone, which React 18+ treats as the no-op it is; the warning that
   * made this pattern feel obligatory was removed precisely because guarding
   * against it costs more than it saves.
   */
  useEffect(() => {
    if (!shareToken || sharedTried.current) return;
    sharedTried.current = true;
    void runParse({ kind: "share", token: shareToken }).then(show);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickImage(file: File) {
    setPhase({ step: "parsing" });
    try {
      const image = await fileToParseInput(file);
      show(await runParse({ kind: "image", ...image }));
    } catch {
      setPhase({ step: "error", message: "Kunde inte läsa bilden." });
    }
  }

  function confirm() {
    if (phase.step !== "reviewing") return;
    const plan = planAdditions(phase.rows, ticked, catalog);
    if (plan.adds.length === 0) return;
    onConfirm(plan);
  }

  const dialogRef = useFocusTrap<HTMLDivElement>(onCancel, confirm);

  const rows = phase.step === "reviewing" ? phase.rows : [];
  const listRows = rows.filter((r) => r.group === "list");
  const otherRows = rows.filter((r) => r.group === "other");
  const chosen = rows.filter((r) => ticked.has(r.id)).length;

  /**
   * A parse that found nothing is a question, not an answer.
   *
   * Reviewing zero rows used to end the dialog: the sentence stood alone with
   * the textarea gone and the primary button offering to add nothing, so the
   * text somebody had just typed was thrown away and a photo the model could
   * not read had no second attempt. On the share path there was not even that,
   * since the token is spent by the time the answer arrives.
   *
   * So the collect block comes back and the sentence sits above it. "Found
   * nothing" and "try it another way" are the same screen.
   */
  const emptyParse = phase.step === "reviewing" && rows.length === 0;
  const collecting =
    phase.step === "collecting" || phase.step === "error" || emptyParse;

  function toggle(id: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderRow(row: AiRow) {
    const off = !ticked.has(row.id);
    const item = row.catalogItemId ? catalog[row.catalogItemId] : undefined;
    const already = row.catalogItemId
      ? onListItemIds.has(row.catalogItemId)
      : false;
    return (
      <li key={row.id}>
        <button
          type="button"
          onClick={() => toggle(row.id)}
          aria-pressed={!off}
          className="flex w-full items-center gap-3 py-3 text-left"
        >
          <span
            aria-hidden
            className={cn(
              "flex h-[22px] w-[22px] flex-none items-center justify-center rounded-md transition-colors duration-150",
              off ? "border-[1.5px] border-line-strong" : "bg-brand text-on-brand",
            )}
          >
            {!off && <UiIcon name="check" size={14} />}
          </span>
          <ItemIcon iconRef={item?.iconRef ?? "1F4E6"} className="text-xl" />
          <span
            className={cn(
              "flex flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-body",
              off ? "text-ink-faint line-through" : "text-ink",
            )}
          >
            {item?.name ?? row.name}
            {!row.catalogItemId && (
              <span className="rounded-full bg-warn-tint px-2 py-0.5 text-badge text-warn uppercase no-underline">
                Ny vara
              </span>
            )}
            {already && (
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-badge text-ink-soft uppercase no-underline">
                På listan
              </span>
            )}
            {item?.hasAtHome && (
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-badge text-ink-soft uppercase no-underline">
                Har hemma
              </span>
            )}
          </span>
          {row.amount && (
            <span
              className={cn(
                "flex-none text-body font-bold",
                off ? "text-ink-faint" : "text-brand-ink",
              )}
            >
              {formatAmount(row.amount)}
            </span>
          )}
        </button>
      </li>
    );
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex flex-col bg-surface outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={`Lägg till flera i ${listName}`}
      tabIndex={-1}
    >
      <div className="safe-top flex-none border-b border-line bg-surface">
        <div className="flex h-12 items-center gap-2 px-2">
          <span className="flex-1 truncate pl-2 text-title text-ink">
            Lägg till i {listName}
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Stäng"
            className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-ink-soft"
          >
            <UiIcon name="close" size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-4">
        {emptyParse && (
          <p className="mb-4 rounded-card border border-line bg-surface-sunken px-3.5 py-2.5 text-caption text-ink-soft">
            Hittade inga varor att lägga till.
          </p>
        )}

        {collecting && (
          <>
            <p className="max-w-[42ch] text-body text-ink-soft">
              Säg vad ni behöver, klistra in en hel lista, eller ta en bild av
              en — till exempel en skärmdump från en annan app.
            </p>

            {speech.supported && (
              <button
                type="button"
                onClick={speech.toggle}
                aria-pressed={speech.listening}
                className={cn(
                  "mt-5 flex w-full items-center justify-center gap-3 rounded-card py-5 text-body font-semibold transition-transform duration-100 active:scale-[0.99]",
                  speech.listening
                    ? "bg-brand text-on-brand"
                    : "border border-line-strong text-ink",
                )}
              >
                <UiIcon
                  name="mic"
                  size={22}
                  className={speech.listening ? "animate-pulse" : undefined}
                />
                {speech.listening
                  ? "Lyssnar — tryck för att sluta"
                  : "Säg vad ni behöver"}
              </button>
            )}

            {/*
             * The sentence being spoken, before it is anybody's to keep.
             *
             * It exists because the alternative is a textarea that rewrites
             * itself under the speaker on every guess — which is what made the
             * old dictation feel broken even when the words were right. Here
             * the moving text and the kept text are different objects on
             * screen: this one is replaced whole each time the engine changes
             * its mind, and the field below it only ever gains whole sentences.
             *
             * `aria-live="polite"` because a blind user gets no other signal
             * that the microphone heard anything; `min-h` so the layout does
             * not jump the moment the first word arrives.
             */}
            {speech.listening && (
              <p
                aria-live="polite"
                className="mt-3 min-h-[1.5rem] px-1 text-body text-ink-soft italic"
              >
                {speech.live || "…"}
              </p>
            )}

            <label className="mt-4 flex flex-col gap-1.5">
              <span className="text-overline text-ink-faint uppercase">
                Eller skriv och klistra in
              </span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder={"ägg\n2 l mjölk\nketchup"}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="w-full resize-y rounded-card border border-line bg-surface-raised px-3.5 py-3 text-body text-ink outline-none placeholder:text-ink-faint"
              />
            </label>

            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Cleared so picking the same file twice fires again.
                e.target.value = "";
                if (file) void pickImage(file);
              }}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="mt-4 inline-flex items-center gap-2 text-body-sm font-semibold text-brand"
            >
              <UiIcon name="sparkle" size={15} />
              Läs av en bild i stället
            </button>
          </>
        )}

        {phase.step === "parsing" && (
          <div className="flex flex-col items-center gap-3 py-16 text-ink-soft">
            <UiIcon name="spinner" size={24} className="animate-spin" />
            <span className="text-body">Läser…</span>
          </div>
        )}

        {phase.step === "reviewing" && rows.length > 0 && (
          <>
            {!phase.usedModel && (
              /* Said out loud rather than hidden: without a key the loose
                 phrasing a model would have tidied is simply not read, and a
                 person who does not know that will blame the app. */
              <p className="mb-4 rounded-card border border-line bg-surface-sunken px-3.5 py-2.5 text-caption text-ink-soft">
                Lästes utan AI — bara rader som redan liknar varor kom med.
              </p>
            )}

            {listRows.length > 0 && (
              <>
                <div className="mb-1 flex items-baseline justify-between text-overline text-ink-faint uppercase">
                  <span>Hittade</span>
                  <span>{chosen} läggs till</span>
                </div>
                <ul className="divide-y divide-line">{listRows.map(renderRow)}</ul>
              </>
            )}

            {otherRows.length > 0 && (
              <>
                {/* Not dropped, not ticked. A suggestion grid in a screenshot is
                    twenty varor nobody asked for — but a boundary the model
                    judged wrongly must be visible rather than silently applied. */}
                <div className="mt-7 mb-1 text-overline text-ink-faint uppercase">
                  Också på bilden
                </div>
                <ul className="divide-y divide-line">{otherRows.map(renderRow)}</ul>
              </>
            )}
          </>
        )}

        {/* A live region that is always mounted, holding a card that is not —
            the same shape `recipe-import.tsx` had to take. The region has to
            exist BEFORE its text does: one inserted together with its own
            content is a coin flip across screen readers, and a share opens
            straight into a parse, so this failure is sometimes the first thing
            the sheet ever says. `role="alert"` rather than a polite region
            because the person is standing there waiting for this exact
            answer. */}
        <div role="alert">
          {phase.step === "error" && (
            <div className="mt-5 rounded-card border border-line bg-danger-tint p-4">
              <div className="flex items-start gap-2.5">
                <UiIcon
                  name="warning"
                  size={18}
                  className="mt-0.5 flex-none text-danger"
                />
                <p className="flex-1 text-body font-semibold text-danger">
                  {phase.message}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="safe-bottom flex-none border-t border-line bg-surface p-3">
        {phase.step === "reviewing" && rows.length > 0 ? (
          <button
            type="button"
            disabled={chosen === 0}
            onClick={confirm}
            className="flex w-full items-center justify-center gap-2 rounded-card bg-brand py-3.5 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.99] disabled:opacity-40"
          >
            <UiIcon name="toList" size={17} />
            Lägg till {chosen} {chosen === 1 ? "vara" : "varor"}
          </button>
        ) : (
          <button
            type="button"
            disabled={phase.step === "parsing" || text.trim() === ""}
            onClick={() => void parse({ kind: "text", text })}
            className="flex w-full items-center justify-center gap-2 rounded-card bg-brand py-3.5 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.99] disabled:opacity-40"
          >
            <UiIcon name="sparkle" size={17} />
            Läs listan
          </button>
        )}
      </div>
    </div>
  );
}
