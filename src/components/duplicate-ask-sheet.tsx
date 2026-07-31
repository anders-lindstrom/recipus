"use client";

import { Sheet, SheetActions, SheetButton } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * "You already asked for ripe mangos — is this one of those?"
 *
 * This exists because of a specific silent wrong answer that modifiers create.
 * The modifier lives on the manual contribution, and so does the amount, so
 * typing "mango 1 st" against an existing "2 kg mogna" quietly produces
 * "1 st mogna": one plain mango asked for, one ripe mango delivered, and nothing
 * on screen ever said so. The amount is overwritten by design — that part is
 * right — but the qualifier silently outliving it is not.
 *
 * So it is a correction, not a courtesy, and it is scoped as tightly as that
 * implies: only from the add bar, only when the existing ask already carries a
 * modifier. **A tile tap never opens a dialog.** The core loop is tapping tiles
 * in a shop, and anything that can interrupt it will eventually interrupt it at
 * the worst moment.
 *
 * Wanting both kinds tracked separately — two tiles, two cadences — is a
 * different and larger decision about the household's own taxonomy, and it
 * belongs to the registry's split rather than to a word typed into the add bar.
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
  /** Apply the new amount and drop the qualifier — this ask is for the plain thing. */
  onClearModifier: () => void;
}

export function DuplicateAskSheet({
  ask,
  onClose,
  onKeepModifier,
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
        <SheetButton
          onClick={onClearModifier}
          icon={<UiIcon name="edit" size={16} />}
        >
          Nej, vanlig {ask.itemName.toLocaleLowerCase("sv")}
        </SheetButton>
      </SheetActions>
    </Sheet>
  );
}
