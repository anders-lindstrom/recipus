"use client";

import { useState } from "react";
import type { Amount, CatalogItem, Priority } from "@/lib/domain";
import { cn } from "@/lib/utils";
import { DetailFields, PriorityField } from "./detail-fields";
import { ItemIcon } from "./icon";
import { Sheet, SheetActions, SheetButton } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * Long-press a vara anywhere it is offered: add it, with details, in one go.
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
 *
 * Two things arrived here later, both from the same report:
 *
 * **"Egen vara".** A sort typed against a vara already on the list used to have
 * exactly one possible meaning — change the one that is there — because an entry
 * is keyed by `(listId, catalogItemId)` and appears at most once per list. So
 * "I already have broccoli, I want the frozen ones too" was unsayable from any
 * surface that offers varor. The segmented control makes it a choice, and it
 * defaults to the second kind when the vara is already on the list, because that
 * is what typing a sort against something you already asked for almost always
 * means.
 *
 * **"Dölj".** The first change makes the catalog easy to grow, so this is the
 * other half of it: a sort that turns out to have been a one-off has to be
 * nudgeable back out of search without destroying its history. See
 * `CatalogItem.hidden`.
 */

export interface AddDetailsSheetProps {
  item: CatalogItem;
  /** Already on the list, so the sheet can say so rather than silently merging. */
  alreadyOnList: boolean;
  /** Where a vara split off from this one would land — it inherits the aisle. */
  aisleName: string;
  onClose: () => void;
  onAdd: (details: {
    amount: Amount | null;
    modifier: string | null;
    priority: Priority;
  }) => void;
  /**
   * Put this kind on the list as a vara of its own, filed beside `item`.
   *
   * The sort does not travel as a modifier: the name carries it now, and
   * printing "fryst" under a tile that already says "broccoli fryst" is the same
   * word twice.
   */
  onAddAsOwnVara: (details: {
    name: string;
    amount: Amount | null;
    priority: Priority;
  }) => void;
  /** Out of search and the catalog well, keeping every purchase behind it. */
  onHide: () => void;
}

export function AddDetailsSheet({
  item,
  alreadyOnList,
  aisleName,
  onClose,
  onAdd,
  onAddAsOwnVara,
  onHide,
}: AddDetailsSheetProps) {
  const [amount, setAmount] = useState<Amount | null>(null);
  const [modifier, setModifier] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>("normal");
  /**
   * Whether the sort names a kind of its own.
   *
   * Seeded from `alreadyOnList` rather than always false: adding a sort to
   * something not on the list yet is an ordinary "get the ripe ones this time",
   * while adding one to something already on it is the case that had no answer.
   * Held separately from the typed name so switching back and forth does not
   * lose either.
   */
  const [ownVara, setOwnVara] = useState(alreadyOnList);
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  const sort = modifier?.trim() ?? "";
  // Only a choice once there is a sort to make a kind out of.
  const canSplit = sort.length > 0;
  const splitting = canSplit && ownVara;

  const derivedName = `${item.name.toLocaleLowerCase("sv")} ${sort}`;
  const name = (nameDraft ?? derivedName).trim();
  const nameOk = name.length >= 2;

  function commit() {
    if (splitting) {
      if (!nameOk) return;
      onAddAsOwnVara({ name, amount, priority });
      return;
    }
    onAdd({ amount, modifier, priority });
  }

  const actionLabel = splitting
    ? "Lägg till som egen vara"
    : alreadyOnList
      ? "Uppdatera"
      : "Lägg till";

  return (
    <Sheet
      title={item.name}
      showTitle={false}
      onClose={onClose}
      // Type an amount, Enter to commit the field, Enter again to add. See
      // `useFocusTrap` — the second Enter arrives with focus on nothing, which is
      // exactly the case it was taught to handle.
      onPrimary={commit}
    >
      <div className="flex items-center gap-3 px-4 pt-2 pb-1">
        <ItemIcon iconRef={item.iconRef} className="text-[28px] leading-none" />
        <div className="min-w-0 flex-1">
          <h2 className="text-display text-ink">{item.name}</h2>
          {alreadyOnList && (
            // Said before you commit rather than discovered after. It used to
            // read "det här ändrar den", full stop, which was true and was also
            // the whole problem — there was nothing else it could do.
            <p className="text-caption text-ink-faint">
              {splitting
                ? "Står redan på listan — den här blir en andra sort."
                : "Står redan på listan — det här ändrar den."}
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
        // Live, so the choice below appears while you are still typing the sort
        // rather than after you happen to leave the field. Nothing is dispatched
        // from this sheet until "Lägg till", so a per-keystroke value costs
        // nothing here — unlike in the entry sheet, where it would be an op each.
        onModifierInput={setModifier}
        autoFocus="amount"
      />

      {canSplit && (
        <div className="px-4 pt-1 pb-1">
          <p className="mb-1.5 text-overline text-ink-faint uppercase">
            {sort} — vad menar du?
          </p>
          {/* A segmented control rather than a checkbox, for the same reason
              priority is one: these are two states of one question, and a
              checkbox labelled "egen vara" would make the ordinary answer look
              like the absence of a decision. */}
          <div
            role="group"
            aria-label="Sort eller egen vara"
            className="flex gap-1 rounded-control border border-line p-1"
          >
            {[
              { value: false, label: `Sort på ${item.name.toLocaleLowerCase("sv")}` },
              { value: true, label: "Egen vara" },
            ].map((choice) => (
              <button
                key={String(choice.value)}
                type="button"
                aria-pressed={ownVara === choice.value}
                onClick={() => setOwnVara(choice.value)}
                className={cn(
                  "flex-1 rounded-[0.5rem] px-2 py-2 text-caption font-semibold",
                  "transition-colors duration-150",
                  ownVara === choice.value
                    ? "bg-ink text-surface"
                    : "text-ink-soft",
                )}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {splitting && (
        <div className="px-4 pt-2 pb-1">
          <label
            htmlFor="own-vara-name"
            className="mb-1.5 block text-overline text-ink-faint uppercase"
          >
            Namn
          </label>
          <input
            id="own-vara-name"
            value={nameDraft ?? derivedName}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              // Blur rather than submit: the priority control is below this and
              // the amount above, so Enter here means "done with the name", not
              // "done with the sheet". The next Enter does that — which requires
              // claiming this one, or the sheet's own handler sees focus on
              // `<body>` and submits on this very keystroke.
              if (e.key !== "Enter") return;
              e.preventDefault();
              e.currentTarget.blur();
            }}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            className="w-full rounded-control border border-line bg-surface px-3.5 py-2.5 text-body text-ink outline-none"
          />
          <p className="mt-1.5 text-caption text-ink-faint">
            Hamnar i {aisleName.toLowerCase()}, med samma ikon. Går att söka fram
            och lägga till igen sen.
          </p>
        </div>
      )}

      <PriorityField value={priority} onSelect={setPriority} />

      {/* One primary action, full width, at the bottom where a thumb is. The
          entry sheet has no equivalent because there is nothing to confirm
          there — its fields commit themselves. */}
      <div className="p-3 pt-4">
        <button
          type="button"
          disabled={splitting && !nameOk}
          onClick={commit}
          className="flex w-full items-center justify-center gap-2 rounded-control bg-brand px-3 py-3.5 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.98] disabled:opacity-40"
        >
          <UiIcon name="plus" size={16} />
          {actionLabel}
        </button>
      </div>

      {/* Below the primary action and quiet, because it is the rare half of this
          sheet — but it is HERE, on the surface where the household's own kinds
          get invented, rather than only in the registry two screens away. The
          person who has just realised a sort was a one-off is looking at this
          tile, not at /varor. */}
      <SheetActions>
        <SheetButton
          onClick={onHide}
          icon={<UiIcon name="clear" size={16} />}
        >
          Dölj {item.name.toLocaleLowerCase("sv")} i sök och katalog
        </SheetButton>
      </SheetActions>
    </Sheet>
  );
}
