"use client";

import { useState } from "react";
import type { Category, Id, Product } from "@/lib/domain";
import { cn, emojiToCodepoint } from "@/lib/utils";
import { ItemIcon } from "./icon";
import {
  Sheet,
  SheetActions,
  SheetAdvanced,
  SheetButton,
  SheetButtonRow,
  SheetChipButton,
} from "./sheet";
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
 *
 * The two SWITCHES are deliberately not among them, because neither is something
 * you do to the vara — they are states it is in. "Har alltid hemma" and "Dold"
 * both describe how the rest of the app should treat it, and drawing them as
 * commands would read as instructions ("go and buy some", "delete this").
 *
 * "Dold" in particular has to stay visibly distinct from "Ta bort" one row
 * below it, because they are the pair people confuse: deleting says *we do not
 * buy this* and is refused while the vara is on a list or carries products;
 * hiding says nothing about the thing at all, has no blockers, and is undone by
 * flipping the same switch back. Hiding is what a household's own invented kinds
 * need — "mogna blåbär" was worth a vara in March and is clutter in July — and
 * it must never be reached for by someone who meant the other one.
 */

export interface VarorItemSheetProps {
  vara: VaraView;
  /** The aisle it is filed under. */
  categoryName: string;
  /** Every aisle, in the household's own walking order, for re-filing. */
  categories: Category[];
  /** Names a list this vara sits on. Falls back to the id when the list is unknown here. */
  listName: (listId: Id) => string;
  /**
   * Put it on the list the household was last shopping from.
   *
   * Absent when this screen has no list to add to — offline before the shell
   * has ever been cached, or a household with none yet. The registry is
   * reachable in both states, so the action has to be able to not exist rather
   * than to fail.
   */
  onAddToList?: () => void;
  /**
   * Which list that is. The id rather than the name, so "is it already there"
   * is decided by identity — two shops can be called the same thing, and a
   * household that has two Willys would otherwise see one answer for both.
   */
  targetListId: Id;
  onRename: (name: string) => void;
  /**
   * Re-file into another aisle.
   *
   * The single most load-bearing edit on this screen, because the aisle decides
   * where the item appears on the walk round the shop. Anything the household
   * types into the add bar is created in "Övrigt" — deliberately, since guessing
   * an aisle sends you to the wrong end of the shop — and Övrigt sorts last, so
   * an item that stays there is one you walk back for every single time.
   *
   * This sheet used to show the aisle and refuse to change it, on the grounds
   * that categories were seed-owned. That was wrong: the category is one of the
   * four facts the registry exists to make editable, which is why it has a
   * per-field clock of its own, and why the seed's guard skips any row a human
   * has touched.
   */
  onRecategorize: (categoryId: Id) => void;
  /** Staples: excluded by default when a recipe is added. Nothing else set this. */
  onSetHasAtHome: (hasAtHome: boolean) => void;
  /** A codepoint ref ("1F35E"), already converted from whatever was typed. */
  onSetIcon: (iconRef: string) => void;
  /** Out of search and the catalog well. Reversible from the same switch. */
  onSetHidden: (hidden: boolean) => void;
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

/**
 * A state with two values, drawn as a switch.
 *
 * Two of them now, and the second is why this is a component rather than two
 * copies: they sit next to each other, they are the only controls in this sheet
 * that are not commands, and if they ever stop looking identical one of them
 * starts reading as a button. Both are also one row above "Ta bort" — the
 * control they must never be mistaken for.
 */
function SwitchRow({
  label,
  icon,
  checked,
  hint,
  onToggle,
}: {
  label: string;
  icon: "check" | "clear";
  checked: boolean;
  /** One line under the label, for a state whose consequence is not obvious. */
  hint?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-2 rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <UiIcon name={icon} size={16} />
        <span className="min-w-0 flex-1 text-left">
          {label}
          {hint && (
            <span className="block text-caption font-normal text-ink-faint">
              {hint}
            </span>
          )}
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          "h-6 w-10 flex-none rounded-full p-0.5 transition-colors duration-150",
          checked ? "bg-brand" : "bg-line-strong",
        )}
      >
        <span
          className={cn(
            "block h-5 w-5 rounded-full bg-surface transition-transform duration-150",
            checked && "translate-x-4",
          )}
        />
      </span>
    </button>
  );
}

export function VarorItemSheet({
  vara,
  categoryName,
  categories,
  listName,
  onAddToList,
  targetListId,
  onRename,
  onRecategorize,
  onSetHasAtHome,
  onSetIcon,
  onSetHidden,
  onSplit,
  onMerge,
  onDelete,
  onTakeOffList,
  onUnplaceProducts,
  onOpenProduct,
  onClose,
}: VarorItemSheetProps) {
  const [renaming, setRenaming] = useState(false);
  const [refiling, setRefiling] = useState(false);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [iconDraft, setIconDraft] = useState("");
  const [draft, setDraft] = useState("");

  const blockers = deletionBlockers(vara);
  const onLists = [...new Set(vara.onList.map((e) => e.listId))];
  /**
   * The lists this vara is on OTHER than the one the add button targets.
   *
   * Kept separate because the two facts have different jobs: the button answers
   * "can I add it to the list I came from", and this answers "is it already on
   * some other shop's list" — which is the one nothing else on this screen can
   * tell you, and the reason a household with two lists needs the line at all.
   *
   * Falls back to every list when there is no add button, since then nothing
   * else says any of it.
   */
  const otherLists = onAddToList
    ? onLists.filter((id) => id !== targetListId)
    : onLists;
  const alreadyOnTargetList = onLists.includes(targetListId);
  const targetListName = listName(targetListId);

  const trimmed = draft.trim();
  const nameOk = trimmed.length >= 1 && trimmed !== vara.item.name;

  function startRename() {
    setDraft(vara.item.name);
    setRenaming(true);
  }

  /*
   * Each sub-editor closes ITSELF on save, back to the vara it belongs to.
   *
   * It used to be the parent that closed — the whole sheet, screen and all — so
   * saving a name was indistinguishable from giving up on the vara entirely. The
   * category picker was already doing it this way (`setRefiling(false)` before
   * `onRecategorize`); these two were the odd ones out, and only because
   * unmounting happened to hide them.
   */
  function commitRename() {
    if (!nameOk) return;
    setRenaming(false);
    onRename(trimmed);
  }

  function commitIcon(iconRef: string) {
    setPickingIcon(false);
    setIconDraft("");
    onSetIcon(iconRef);
  }

  if (renaming) {
    return (
      <Sheet
        title={`Byt namn på ${vara.item.name}`}
        onClose={onClose}
        // The field commits on Enter itself; this catches the Enter that arrives
        // after a blur, so the keyboard never has to hand back to the mouse.
        onPrimary={commitRename}
      >
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
              if (e.key !== "Enter") return;
              // Claims the keypress, so the sheet's own Enter handler does not
              // also fire on it. See `useFocusTrap`.
              e.preventDefault();
              commitRename();
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
              onClick={commitRename}
              className="flex-1 rounded-control bg-brand px-3 py-3 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.98] disabled:opacity-40"
            >
              Spara
            </button>
          </div>
        </div>
      </Sheet>
    );
  }

  if (pickingIcon) {
    const picked = emojiToCodepoint(iconDraft);
    const category = categories.find((c) => c.id === vara.item.categoryId);
    return (
      <Sheet
        title={`Ikon för ${vara.item.name}`}
        onClose={onClose}
        onPrimary={() => picked && commitIcon(picked)}
      >
        <div className="px-4 pb-4">
          <label
            htmlFor="vara-icon"
            className="mb-1.5 block text-overline text-ink-faint uppercase"
          >
            Emoji
          </label>
          <div className="flex items-center gap-3">
            {/* The preview is the whole validation surface: a codepoint tells
                nobody anything, and this is what will actually sit on the tile. */}
            <span className="flex h-12 w-12 flex-none items-center justify-center rounded-control border border-line">
              <ItemIcon
                iconRef={picked ?? vara.item.iconRef}
                className="text-2xl"
              />
            </span>
            <input
              id="vara-icon"
              autoFocus
              value={iconDraft}
              onChange={(e) => setIconDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (picked) commitIcon(picked);
              }}
              placeholder="🍞"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-control border border-line bg-surface px-3.5 py-3 text-body text-ink outline-none"
            />
          </div>
          <p className="mt-2 min-h-[1.25rem] text-caption text-ink-soft">
            {iconDraft.trim() === ""
              ? "Öppna emoji-tangentbordet och välj en."
              : picked
                ? "Ser bra ut."
                : "Det där är ingen emoji."}
          </p>

          {category && (
            <button
              type="button"
              onClick={() => commitIcon(category.icon)}
              className="mt-1 flex w-full items-center gap-2 rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
            >
              <ItemIcon iconRef={category.icon} className="text-xl" />
              Använd {category.name.toLowerCase()}s ikon
            </button>
          )}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setPickingIcon(false)}
              className="flex-1 rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
            >
              Avbryt
            </button>
            <button
              type="button"
              disabled={!picked}
              onClick={() => picked && commitIcon(picked)}
              className="flex-1 rounded-control bg-brand px-3 py-3 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.98] disabled:opacity-40"
            >
              Spara
            </button>
          </div>
        </div>
      </Sheet>
    );
  }

  if (refiling) {
    return (
      <Sheet title={`Var står ${vara.item.name}?`} onClose={onClose}>
        {/* Read "Aisle-ordningen" until now — an English word sitting in the
            middle of a Swedish sentence, which is how you can tell the schema's
            vocabulary had leaked into the copy rather than been translated. */}
        <div className="px-4 pb-1">
          <p className="text-body text-ink-soft">
            Kategoriordningen är per lista, så varan hamnar där ni går förbi
            den i varje butik.
          </p>
        </div>
        <ul className="mx-2 mt-2">
          {categories.map((category) => {
            const current = category.id === vara.item.categoryId;
            return (
              <li key={category.id}>
                <button
                  type="button"
                  aria-current={current}
                  onClick={() => {
                    setRefiling(false);
                    if (!current) onRecategorize(category.id);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-control px-2 py-3 text-left",
                    current && "bg-brand-tint",
                  )}
                >
                  <ItemIcon iconRef={category.icon} className="text-xl" />
                  <span className="flex-1 text-body text-ink">{category.name}</span>
                  {current && (
                    <UiIcon name="check" size={18} className="text-brand-ink" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 border-t border-line p-3">
          <button
            type="button"
            onClick={() => setRefiling(false)}
            className="w-full rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
          >
            Avbryt
          </button>
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

      {/* Only when it says something the action below does not.
          The add button reads "Står på Hemköp" once the vara is there, so on a
          single-list household this line was the same sentence twice, one
          screenful apart. It earns its place the moment another list is
          involved — that is a fact about a shop you are not standing in, and
          nothing else on this screen carries it. */}
      {otherLists.length > 0 && (
        <p className="px-4 pb-2 text-body-sm text-brand-ink">
          Står på {otherLists.map(listName).join(" och ")} just nu.
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
        {/* The reason to open this sheet, at the top of it and in the one colour
            that means "on the list".

            This screen used to say, in writing, "Inget läggs på listan
            härifrån" — and that was a real design position: the registry is
            where you edit the WORD, the list is where you shop. It reads
            differently from inside the errand. You are standing in the registry
            looking straight at mjölk, you want mjölk, and the app's answer was
            to go back to the list and type its name again. Nothing about
            renaming a vara makes adding it a category error; the screens simply
            each owned half of the same object. */}
        {onAddToList && (
          <SheetButton
            tone="primary"
            disabled={alreadyOnTargetList}
            icon={<UiIcon name={alreadyOnTargetList ? "check" : "plus"} size={16} />}
            onClick={onAddToList}
          >
            {alreadyOnTargetList
              ? `Står på ${targetListName}`
              : `Lägg till i ${targetListName}`}
          </SheetButton>
        )}

        {/* Three edits that are one tap and one word, on one line.
            They were three full-width rows out of seven, which put the things
            people actually come here for below the fold on a phone. */}
        <SheetButtonRow>
          <SheetChipButton
            onClick={startRename}
            icon={<UiIcon name="edit" size={16} />}
          >
            Byt namn
          </SheetChipButton>

          <SheetChipButton
            onClick={() => {
              setIconDraft("");
              setPickingIcon(true);
            }}
            icon={<ItemIcon iconRef={vara.item.iconRef} className="text-base" />}
          >
            Byt ikon
          </SheetChipButton>

          {/* "Kategori", one word for one thing across the app — see the note in
              aisle-rail.tsx, where the same word is read aloud and never drawn.
              It was "avdelning" on the argument that the thing is a walking order
              rather than a taxonomy; the household reads it as stilted Swedish,
              which settles it. The sheet it opens still asks "Var står mjölk?",
              because where a vara stands is what you are answering.

              The current category is not repeated here — the sheet's own header
              already carries it, one line up, which is what freed this control
              to be a third of a row. */}
          <SheetChipButton
            onClick={() => setRefiling(true)}
            icon={<UiIcon name="allAisles" size={16} />}
          >
            Byt kategori
          </SheetChipButton>
        </SheetButtonRow>

        {/* A state with two values, so a switch rather than a button: "Har
            alltid hemma" as a command would read as an instruction to go and
            buy some. Nothing else in the app could set this, which meant the
            recipe sheet's staple exclusion had no way to ever be true.

            Stays in the open, unlike the other switch: it is a fact about the
            household's kitchen that anyone might set on any vara, not a repair
            to the catalog. */}
        <SwitchRow
          label="Har alltid hemma"
          icon="check"
          checked={vara.item.hasAtHome}
          // What it actually DOES, which nothing said. The name reads as a note
          // to self — and its only effect is somewhere else entirely, on a
          // screen this one does not mention: a recipe leaves it off the list by
          // default. Same complaint as "Behövs till → Tillagd", one screen over.
          hint="Recept hoppar över den när de läggs till."
          onToggle={() => onSetHasAtHome(!vara.item.hasAtHome)}
        />

        {/* Everything that repairs the CATALOG rather than uses it.
            Hiding, splitting, merging and deleting are all a household tidying
            its own vocabulary — a few times a year each, against an add that
            happens weekly. They were four of the seven rows in front of it.

            "Dold" stays first and stays a switch, which is what keeps it
            visibly distinct from "Ta bort" further down: they are the pair
            people confuse, and hiding is the harmless one. */}
        <SheetAdvanced label="Avancerat">
          <SwitchRow
            label="Dold i sök och katalog"
            icon="clear"
            checked={vara.item.hidden}
            hint={
              vara.item.hidden
                ? "Syns bara här. Sök på namnet för att lägga till den ändå."
                : undefined
            }
            onToggle={() => onSetHidden(!vara.item.hidden)}
          />

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
        </SheetAdvanced>
      </SheetActions>
    </Sheet>
  );
}
