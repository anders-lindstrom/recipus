"use client";

import { useState } from "react";
import type { Amount, Priority } from "@/lib/domain";
import { formatAmount, parseAmount } from "@/lib/units";
import { cn } from "@/lib/utils";

/**
 * Amount and sort, editable where they are shown.
 *
 * These used to be two buttons that swapped the whole sheet for an editor with
 * its own Avbryt/Spara pair — so putting "2 kg" on a vara was long-press, read
 * a menu, tap "Ändra mängd", type, tap Spara. Five deliberate acts and two
 * screens for one number, on a phone, in a shop. Nothing was learned at any of
 * those steps: the sheet already knew you wanted to edit, and a field is the
 * only control that says "type here" without being asked.
 *
 * So they are fields, always visible, always ready. Committing happens on blur
 * and on Enter, which means the common path is type-and-move-on with no Spara
 * to find. An unparseable amount is simply not committed — the text stays put
 * so it can be fixed rather than vanishing on you.
 *
 * Side by side because vertical space is the scarce thing here: with a keyboard
 * up on a small phone the sheet has about three rows before the fold, and the
 * priority control has to be one of them.
 */

export interface DetailFieldsProps {
  amount: Amount | null;
  /** Called on blur and on Enter, never per keystroke. Null clears. */
  onAmountChange: (amount: Amount | null) => void;
  modifier: string | null;
  onModifierChange: (modifier: string | null) => void;
  /**
   * Every keystroke, for a caller that has to REACT to the sort rather than
   * store it.
   *
   * Separate from `onModifierChange` because they answer different questions.
   * That one is "this is the value now", and it deliberately waits for blur or
   * Enter so the entry sheet does not dispatch an op per letter. This one is
   * only ever read to decide what to draw: the add-details sheet reveals its
   * "sort or egen vara?" choice the moment there is a sort at all, and gating
   * that on blur meant typing "fryst" and watching nothing happen until you
   * happened to tap elsewhere.
   */
  onModifierInput?: (modifier: string) => void;
  /** Which field takes the caret when the sheet opens, if any. */
  autoFocus?: "amount" | "modifier";
}

export function DetailFields({
  amount,
  onAmountChange,
  modifier,
  onModifierChange,
  onModifierInput,
  autoFocus,
}: DetailFieldsProps) {
  const [amountDraft, setAmountDraft] = useState(
    amount ? formatAmount(amount) : "",
  );
  const [modifierDraft, setModifierDraft] = useState(modifier ?? "");

  const trimmed = amountDraft.trim();
  const parsed = trimmed === "" ? null : parseAmount(trimmed);
  const unparseable = trimmed !== "" && parsed === null;

  function commitAmount() {
    // A value that cannot be read is not a value. Leaving the text alone lets
    // it be corrected; committing null would silently discard what was typed.
    if (unparseable) return;
    onAmountChange(parsed);
  }

  function commitModifier() {
    const t = modifierDraft.trim();
    // Free text, so there is nothing to fail to parse and no reason to make
    // anyone delete a word twice. Empty clears it.
    onModifierChange(t === "" ? null : t);
  }

  return (
    <div className="px-4 pt-1 pb-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-overline text-ink-faint uppercase">Mängd</span>
          <input
            value={amountDraft}
            autoFocus={autoFocus === "amount"}
            onChange={(e) => setAmountDraft(e.target.value)}
            onBlur={commitAmount}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Claims the keypress. Without it the sheet's own Enter handler —
              // which listens on `window`, so it runs after this — sees focus
              // already on `<body>` and submits the whole sheet on the keystroke
              // that was only meant to leave the field. See `useFocusTrap`.
              e.preventDefault();
              commitAmount();
              e.currentTarget.blur();
            }}
            placeholder="2 dl"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            className={cn(
              "w-full rounded-control border bg-surface px-3 py-2.5 text-body text-ink",
              "outline-none placeholder:text-ink-faint",
              unparseable ? "border-danger" : "border-line",
            )}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-overline text-ink-faint uppercase">Sort</span>
          <input
            value={modifierDraft}
            autoFocus={autoFocus === "modifier"}
            onChange={(e) => {
              setModifierDraft(e.target.value);
              onModifierInput?.(e.target.value);
            }}
            onBlur={commitModifier}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Claims the keypress — see the amount field above.
              e.preventDefault();
              commitModifier();
              e.currentTarget.blur();
            }}
            placeholder="mogna"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            className="w-full rounded-control border border-line bg-surface px-3 py-2.5 text-body text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
      </div>

      {/* One line, always present, so the row cannot change height as you type —
          the sheet twitching under your thumb reads as a bug. */}
      <p
        className={cn(
          "mt-1.5 min-h-[1.125rem] text-caption",
          unparseable ? "text-danger" : "text-ink-faint",
        )}
      >
        {unparseable
          ? `"${trimmed}" går inte att tolka som en mängd.`
          : parsed
            ? `Sparas som ${formatAmount(parsed)}.`
            : ""}
      </p>
    </div>
  );
}

/**
 * Three states, labelled from the shopper's point of view.
 *
 * "Om du hinner" rather than "Låg prioritet": the whole reason this state exists
 * is the instruction "grab it if you pass it", which is a different thing from
 * "this matters less" — and phrasing it as a rank invites the list to become a
 * ranking, which is exactly how urgency stops meaning anything.
 */
const PRIORITY_CHOICES: ReadonlyArray<{ value: Priority; label: string }> = [
  { value: "urgent", label: "Bråttom" },
  { value: "normal", label: "Vanlig" },
  { value: "convenient", label: "Om du hinner" },
];

/**
 * A segmented control rather than a row of buttons, because priority is a STATE
 * with three values and not a thing you do. Three buttons would make "Vanlig"
 * look like a command; this shows which one is in force without being asked.
 */
export function PriorityField({
  value,
  onSelect,
}: {
  value: Priority;
  /** Not `onChange`: Next flags that name on a "use client" boundary. */
  onSelect: (priority: Priority) => void;
}) {
  return (
    <div className="px-4 pt-1 pb-1">
      <p className="mb-1.5 text-overline text-ink-faint uppercase">Hur bråttom</p>
      <div
        role="group"
        aria-label="Prioritet"
        className="flex gap-1 rounded-control border border-line p-1"
      >
        {PRIORITY_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={value === choice.value}
            onClick={() => onSelect(choice.value)}
            className={cn(
              "flex-1 rounded-[0.5rem] px-2 py-2 text-caption font-semibold",
              "transition-colors duration-150",
              value === choice.value ? "bg-ink text-surface" : "text-ink-soft",
            )}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
