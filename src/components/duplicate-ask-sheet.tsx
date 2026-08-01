"use client";

import { Sheet, SheetActions, SheetButton } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * "You already asked for ripe blueberries — is this one of those?"
 *
 * This exists because of a specific silent wrong answer that modifiers create.
 * The modifier lives on the manual contribution, and so does the amount, so
 * typing "blåbär 1 st" against an existing "2 kg mogna" quietly produces
 * "1 st mogna": one plain punnet asked for, ripe ones delivered, and nothing on
 * screen ever said so.
 *
 * It shipped with two answers and the second one was a trap. "Nej, vanlig
 * blåbär" cleared the qualifier — which is the only thing it COULD do, because
 * an entry is identified by `(listId, catalogItemId)` and one vara appears at
 * most once per list. So the household's honest answer, "I want both", came out
 * as "mogna" being deleted, and nothing warned them. Reported from real use, and
 * fairly described as bad rather than as a bug: the app had no way to represent
 * what was being asked for.
 *
 * Now it does, and it is the middle button. Splitting the qualified ask off as
 * its own vara is what the design has always said the answer is — "wanting ripe
 * mango tracked as its own thing with its own cadence is the registry's split" —
 * and this is that split, reached from where the question actually comes up
 * rather than from a screen nobody is on at the time. The new vara inherits the
 * original's aisle and icon, keeps the amount and priority that were already on
 * the ask, and is a first-class vara afterwards: searchable, re-addable, and
 * hideable if it turns out to have been a one-off.
 *
 * Scoped as tightly as it ever was: only from the add bar, only when the
 * existing ask already carries a modifier. **A tile tap never opens a dialog.**
 * The core loop is tapping tiles in a shop, and anything that can interrupt it
 * will eventually interrupt it at the worst moment.
 */

export interface DuplicateAsk {
  itemId: string;
  itemName: string;
  /** The modifier already on the list, e.g. "mogna". */
  existingModifier: string;
  /** What was typed after the name, e.g. "1 st". Empty when only a name. */
  amountText: string;
}

export interface DuplicateAskSheetProps {
  ask: DuplicateAsk;
  onClose: () => void;
  /** Apply the new amount, leave the qualifier alone. */
  onKeepModifier: () => void;
  /**
   * Both kinds. Opens `SplitSortSheet` to name the second one — naming is its
   * own step rather than a field on this screen, because two of the three
   * answers need no typing at all and are the common ones. Putting a keyboard in
   * front of all three would tax the fast paths to serve the careful one.
   */
  onSplit: () => void;
  /** Apply the new amount and drop the qualifier — this ask replaces that one. */
  onClearModifier: () => void;
}

export function DuplicateAskSheet({
  ask,
  onClose,
  onKeepModifier,
  onSplit,
  onClearModifier,
}: DuplicateAskSheetProps) {
  return (
    <Sheet title={ask.itemName} onClose={onClose}>
      <p className="px-4 pt-1 pb-3 text-body-sm text-ink-soft">
        Står redan på listan som{" "}
        <span className="font-semibold text-ink">{ask.existingModifier}</span>.
        {ask.amountText ? ` Gäller ${ask.amountText} samma sort?` : " Samma sort?"}
      </p>

      <SheetActions>
        <SheetButton
          onClick={onKeepModifier}
          icon={<UiIcon name="check" size={16} />}
        >
          Ja, {ask.existingModifier}
        </SheetButton>

        {/* The answer the sheet was missing, and the one people actually mean
            when they say no — between the two it used to offer, because it is
            the middle position in meaning as well as in the list. */}
        <SheetButton
          onClick={onSplit}
          icon={<UiIcon name="plus" size={16} />}
        >
          Nej — jag vill ha båda sorterna
        </SheetButton>

        {/* Tinted, and worded so it cannot be mistaken for the one above. It was
            labelled "Nej, vanlig blåbär", which sounds like adding a plain one
            and in fact deletes the word "mogna" off the ask that was already
            there. */}
        <SheetButton
          tone="danger"
          onClick={onClearModifier}
          icon={<UiIcon name="edit" size={16} />}
        >
          Nej — ta bort &ldquo;{ask.existingModifier}&rdquo;
        </SheetButton>
      </SheetActions>
    </Sheet>
  );
}
