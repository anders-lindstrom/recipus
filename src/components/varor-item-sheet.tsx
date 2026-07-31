"use client";

import { useState } from "react";
import type { Id, Product } from "@/lib/domain";
import { ItemIcon } from "./icon";
import { Sheet, SheetActions, SheetButton } from "./sheet";
import { UiIcon } from "./ui-icon";
import { deletionBlockers, productSubtitle, type VaraView } from "./varor-model";

/**
 * One of the household's words, and the four things you can do to it.
 *
 * The four verbs are kept semantically distinct so they cannot become rivals —
 * that is the whole reason there are four rather than one flexible "edit":
 *
 *   Byt namn   — the same thing, called something else.
 *   Dela upp   — this word was covering two things.
 *   Slå samman — these two words were covering one thing.
 *   Ta bort    — we do not buy this.
 *
 * Only the last one is destructive, so only the last one is tinted, and it is
 * absent entirely while it would do something surprising. A taxonomy screen that
 * can silently take an item off today's shopping list, or leave products pointing
 * at a word that no longer exists, is a screen people stop opening.
 */

export interface VarorItemSheetProps {
  vara: VaraView;
  /** The aisle it is filed under. Shown, not editable — categories stay seed-owned. */
  categoryName: string;
  /** Names a list this vara sits on. Falls back to the id when the list is unknown here. */
  listName: (listId: Id) => string;
  onRename: (name: string) => void;
  onSplit: () => void;
  onMerge: () => void;
  onDelete: () => void;
  /** The inline fix for the on-a-list blocker: take it off, without recording a purchase. */
  onTakeOffList: (listId: Id) => void;
  /** The inline fix for the has-products blocker: send them back to the review queue. */
  onUnplaceProducts: () => void;
  /** Re-open a product's placement — an auto-map is a guess, and guesses need correcting. */
  onOpenProduct: (product: Product) => void;
  onClose: () => void;
}

export function VarorItemSheet({
  vara,
  categoryName,
  listName,
  onRename,
  onSplit,
  onMerge,
  onDelete,
  onTakeOffList,
  onUnplaceProducts,
  onOpenProduct,
  onClose,
}: VarorItemSheetProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  const blockers = deletionBlockers(vara);
  const onLists = [...new Set(vara.onList.map((e) => e.listId))];

  const trimmed = draft.trim();
  const nameOk = trimmed.length >= 1 && trimmed !== vara.item.name;

  function startRename() {
    setDraft(vara.item.name);
    setRenaming(true);
  }

  if (renaming) {
    return (
      <Sheet title={`Byt namn på ${vara.item.name}`} onClose={onClose}>
        <div className="px-4 pb-4">
          <label
            htmlFor="vara-name"
            className="mb-1.5 block text-overline text-ink-faint uppercase"
          >
            Namn
          </label>
          <input
            id="vara-name"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameOk) onRename(trimmed);
            }}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-body text-ink outline-none"
          />
          {/* A rename is not a merge, and the difference is worth one line: the
              id stays, so everything already pointing here keeps pointing here. */}
          <p className="mt-2 min-h-[1.25rem] text-caption text-ink-soft">
            Byter bara ordet. Köp, produkter och recept följer med.
          </p>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setRenaming(false)}
              className="flex-1 rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
            >
              Avbryt
            </button>
            <button
              type="button"
              disabled={!nameOk}
              onClick={() => onRename(trimmed)}
              className="flex-1 rounded-control bg-brand px-3 py-3 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.98] disabled:opacity-40"
            >
              Spara
            </button>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title={vara.item.name}
      onClose={onClose}
      trailing={
        <span className="text-caption text-ink-faint">{categoryName}</span>
      }
    >
      {/* The visible proof that a past merge did not destroy anything. Without
          this line the surviving word is the only evidence anywhere that the old
          one still resolves in recipes and search. */}
      {vara.aliases.length > 0 && (
        <p className="px-4 pb-2 text-body-sm text-ink-soft">
          Hittas även som{" "}
          <span className="font-semibold text-ink">
            {vara.aliases.map((a) => a.aliasNorm).join(", ")}
          </span>
          .
        </p>
      )}

      {vara.onList.length > 0 && (
        <p className="px-4 pb-2 text-body-sm text-brand-ink">
          Står på {onLists.map(listName).join(" och ")} just nu.
        </p>
      )}

      {vara.products.length > 0 && (
        <>
          <p className="px-4 pt-1 text-overline text-ink-faint uppercase">
            Produkter
          </p>
          <ul className="mx-4 mt-1 divide-y divide-line">
            {vara.products.map((product) => {
              const subtitle = productSubtitle(product);
              return (
                <li key={product.id}>
                  <button
                    type="button"
                    onClick={() => onOpenProduct(product)}
                    className="flex w-full items-center gap-3 py-2.5 text-left"
                  >
                    <ItemIcon iconRef="1F4E6" className="text-lg opacity-60" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-ink">
                        {product.name}
                      </span>
                      {subtitle && (
                        <span className="block truncate text-caption text-ink-faint">
                          {subtitle}
                        </span>
                      )}
                    </span>
                    <UiIcon
                      name="chevronDown"
                      size={15}
                      className="-rotate-90 flex-none text-ink-faint"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* Why "Ta bort" is not down there, and what to tap to change that.
          Refusing without saying how to proceed is the version of this that makes
          people give up on the screen. */}
      {blockers.length > 0 && (
        <div className="mx-4 mt-4 rounded-card border border-line bg-surface p-3">
          <p className="flex items-center gap-1.5 text-caption font-bold text-ink">
            <UiIcon name="warning" size={14} className="flex-none text-warn" />
            Går inte att ta bort än
          </p>

          {blockers.map((blocker) =>
            blocker.kind === "on_list" ? (
              <div key="on_list" className="mt-2.5">
                <p className="text-body-sm text-ink-soft">
                  Den står på {onLists.map(listName).join(" och ")}.
                </p>
                {onLists.map((listId) => (
                  <button
                    key={listId}
                    type="button"
                    onClick={() => onTakeOffList(listId)}
                    className="mt-1.5 w-full rounded-control border border-line-strong px-3 py-2.5 text-body-sm font-semibold text-ink"
                  >
                    Ta bort från {listName(listId)}
                  </button>
                ))}
              </div>
            ) : (
              <div key="has_products" className="mt-2.5">
                <p className="text-body-sm text-ink-soft">
                  {blocker.products.length}{" "}
                  {blocker.products.length === 1 ? "produkt" : "produkter"} pekar
                  hit. Vill du behålla deras köp — slå samman med en annan vara i
                  stället.
                </p>
                <button
                  type="button"
                  onClick={onUnplaceProducts}
                  className="mt-1.5 w-full rounded-control border border-line-strong px-3 py-2.5 text-body-sm font-semibold text-ink"
                >
                  Flytta {blocker.products.length === 1 ? "den" : "dem"} till Att
                  placera
                </button>
              </div>
            ),
          )}
        </div>
      )}

      <SheetActions>
        <SheetButton onClick={startRename} icon={<UiIcon name="edit" size={16} />}>
          Byt namn
        </SheetButton>

        <SheetButton onClick={onSplit} icon={<UiIcon name="plus" size={16} />}>
          Dela upp
        </SheetButton>

        <SheetButton onClick={onMerge} icon={<UiIcon name="toList" size={16} />}>
          Slå samman med annan vara
        </SheetButton>

        {/* Rendered only when it would work. A disabled button that explains
            itself elsewhere is a dead control you tap twice before reading. */}
        {blockers.length === 0 && (
          <SheetButton
            tone="danger"
            icon={<UiIcon name="remove" size={16} />}
            onClick={onDelete}
          >
            Ta bort {vara.item.name}
          </SheetButton>
        )}
      </SheetActions>
    </Sheet>
  );
}
