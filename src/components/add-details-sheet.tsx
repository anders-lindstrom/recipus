"use client";

import { useState } from "react";
import type { Amount, CatalogItem, Priority } from "@/lib/domain";
import { DetailFields, PriorityField } from "./detail-fields";
import { ItemIcon } from "./icon";
import { Sheet } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * Long-press in the catalog: add this, with details, in one go.
 *
 * The catalog tile had exactly one gesture and it added a bare item. So wanting
 * two ripe mangos meant tapping mango in the well, losing it — the tile leaves
 * the catalog the instant it is added — then scrolling back up to the buy zone,
 * finding it among everything else there, and long-pressing THAT. Three
 * navigations and a search to say a thing you knew before you started.
 *
 * The gesture is the same 500ms hold the buy zone uses, and it opens the same
 * fields, so there is one thing to learn rather than two. What differs is that
 * nothing has happened yet: this sheet holds a draft and commits on "Lägg
 * till", where the entry sheet edits something already on the list and commits
 * as you type. Dismissing this one leaves the list untouched, which is what
 * makes it safe to open out of curiosity.
 */

export interface AddDetailsSheetProps {
  item: CatalogItem;
  /** Already on the list, so the sheet can say so rather than silently merging. */
  alreadyOnList: boolean;
  onClose: () => void;
  onAdd: (details: {
    amount: Amount | null;
    modifier: string | null;
    priority: Priority;
  }) => void;
}

export function AddDetailsSheet({
  item,
  alreadyOnList,
  onClose,
  onAdd,
}: AddDetailsSheetProps) {
  const [amount, setAmount] = useState<Amount | null>(null);
  const [modifier, setModifier] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>("normal");

  return (
    <Sheet title={item.name} showTitle={false} onClose={onClose}>
      <div className="flex items-center gap-3 px-4 pt-2 pb-1">
        <ItemIcon iconRef={item.iconRef} className="text-[28px] leading-none" />
        <div className="min-w-0 flex-1">
          <h2 className="text-display text-ink">{item.name}</h2>
          {alreadyOnList && (
            // Said before you commit rather than discovered after: this vara
            // appears at most once per list, so what looks like a second ask is
            // an edit of the one already there.
            <p className="text-caption text-ink-faint">
              Står redan på listan — det här ändrar den.
            </p>
          )}
        </div>
      </div>

      {/* Autofocus the amount, because a quantity is what this gesture is
          overwhelmingly for. The keyboard is already up by the time the sheet
          has finished arriving. */}
      <DetailFields
        amount={amount}
        onAmountChange={setAmount}
        modifier={modifier}
        onModifierChange={setModifier}
        autoFocus="amount"
      />

      <PriorityField value={priority} onSelect={setPriority} />

      {/* One primary action, full width, at the bottom where a thumb is. The
          entry sheet has no equivalent because there is nothing to confirm
          there — its fields commit themselves. */}
      <div className="safe-bottom p-3 pt-4">
        <button
          type="button"
          onClick={() => onAdd({ amount, modifier, priority })}
          className="flex w-full items-center justify-center gap-2 rounded-control bg-brand px-3 py-3.5 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.98]"
        >
          <UiIcon name="plus" size={16} />
          {alreadyOnList ? "Uppdatera" : "Lägg till"}
        </button>
      </div>
    </Sheet>
  );
}
