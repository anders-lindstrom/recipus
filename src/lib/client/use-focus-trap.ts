"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The keyboard half of a modal: focus goes in, Tab stays in, Escape gets out,
 * and focus goes back where it came from.
 *
 * `aria-modal="true"` is a promise that everything behind the dialog is
 * unreachable, and the sheets were breaking it within three keystrokes. Opening
 * one left focus on the tile that opened it — outside the dialog it had just
 * announced — so Tab walked straight into the header underneath and read out
 * "Hemköp", "Byt till handla-läge", "Inställningar": a page assistive tech had
 * been told was not there. Nothing on screen hinted at any of it, because
 * sighted users see the backdrop and never press Tab.
 *
 * Escape belongs here rather than in each caller because trapping Tab is what
 * makes it load-bearing. Before, Escape was a courtesy — you could always Tab
 * away and press something else. A dialog you cannot Tab out of and cannot
 * dismiss from the keyboard is not a modal, it is a dead end, so the trap and
 * the way out ship as one thing and cannot drift apart.
 *
 * Hand-rolled, though `radix-ui` is already a dependency and owns a perfectly
 * good Dialog. Radix would bring its own overlay and its own dismissal rules,
 * and the overlay is exactly where `Sheet` keeps a hard-won production fix: the
 * latch that ignores the stray click a long-press synthesizes, and dismissing
 * only on a click on the backdrop ITSELF. Adopting Radix means re-deriving that
 * bug fix inside someone else's event model. This touches nothing but focus.
 */

/**
 * What a Tab can land on.
 *
 * Document order, which is tab order as long as nothing carries a positive
 * `tabindex` — nothing in this app does. Elements with no boxes are dropped:
 * a sheet's collapsed branches would otherwise become invisible stops that
 * swallow a keypress and look like the trap has frozen.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Exported for the add bar, which is not a modal and must not become one — it
 * only needs the same answer to "what can take focus in here", so that Arrow
 * keys walk its results in exactly the order Tab would.
 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * Controls that own Enter themselves.
 *
 * A button's Enter activates it, a select's opens it, and a field's belongs to
 * whatever that field decided — `DetailFields` commits and blurs, the rename
 * sheet saves. Firing the sheet's primary action on top of any of those would
 * mean one keypress doing two things.
 *
 * A textarea is here for the opposite reason to the rest: Enter inserts a
 * newline, which is the entire point of a textarea, so it must never submit.
 */
const OWNS_ENTER = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]);

/**
 * Should this Enter fire the sheet's primary action?
 *
 * The interesting case is the one that reads as a bug otherwise: type "1 kg",
 * press Enter, the field commits and blurs — and focus lands on `<body>`,
 * OUTSIDE the dialog. The second Enter, the one meant to say "yes, add it", then
 * arrives from nowhere in particular. Treating body as "inside" is what makes
 * type-Enter-Enter work, and it is safe because a modal is on screen: nothing
 * else on the page can be the intended target of a keypress while `aria-modal`
 * is claiming the document.
 */
function enterHitsPrimary(container: HTMLElement, active: Element | null): boolean {
  if (!active || active === document.body) return true;
  if (!container.contains(active)) return false;
  return !OWNS_ENTER.has(active.tagName);
}

/**
 * Attach the returned ref to the element carrying `role="dialog"`. It needs
 * `tabIndex={-1}` so it can hold focus itself when the sheet has no field of
 * its own to offer.
 */
export function useFocusTrap<T extends HTMLElement>(
  onClose: () => void,
  /**
   * The sheet's one affirmative action, fired by Enter when no field is holding
   * it.
   *
   * Optional, and absent means Enter does nothing — right for a sheet that is a
   * menu of equals (the entry breakdown, the vara sheet) rather than one
   * question with one answer. Guessing which of five buttons is "the" one is how
   * Enter ends up removing something.
   */
  onPrimary?: () => void,
): RefObject<T | null> {
  const ref = useRef<T>(null);

  /**
   * What opened this sheet, captured during the FIRST RENDER rather than in the
   * mount effect below.
   *
   * It has to be, and the effect is measurably too late. React honours a field's
   * `autoFocus` during the commit, and every effect — passive or layout — runs
   * after that commit. So a sheet that opens onto a field had already moved focus
   * INTO ITSELF by the time this ran, and the effect dutifully recorded the
   * sheet's own amount input as the thing to go back to. That element is
   * unmounting at the moment the cleanup wants it, `isConnected` is false, and
   * focus fell to `<body>` — the exact failure the return was written to prevent,
   * silently present in every sheet that autofocuses anything.
   *
   * Measured on the details sheet: focus the ananas tile, open it, Escape.
   * Before, focus came back to `<body>`; after, to the tile. The entry sheet,
   * which autofocuses nothing, was correct all along — which is why this went
   * unnoticed.
   *
   * A state initialiser rather than a ref assignment because it runs exactly
   * once, before the commit, and never again on a re-render.
   */
  const [returnTo] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    /**
     * Only when nothing inside has already claimed it.
     *
     * Several sheets open straight onto a field — renaming a vara, typing an
     * amount — and React has honoured their `autoFocus` during the commit, well
     * before this passive effect runs. Pulling focus back to the dialog would
     * shut the phone's keyboard in the same frame it opened.
     *
     * A sheet that focused nothing gets the dialog element itself rather than
     * its first control. That is what makes a screen reader announce the
     * sheet's name and purpose instead of a button in isolation — and the
     * button it would otherwise announce is sometimes "Ta bort".
     */
    if (!container.contains(document.activeElement)) container.focus();

    return () => {
      /**
       * Back to the trigger, if it is still there — and only if the sheet still
       * had focus to give back.
       *
       * Closing used to leave focus on `<body>`, so the next Tab restarted from
       * the top of the document — several screens away from the tile you had
       * just been looking at. And half these sheets exist to remove the thing
       * that opened them, so a detached trigger is the normal case, not an
       * edge one: focusing it would be indistinguishable from focusing nothing.
       *
       * The `contains` check is what makes this safe under StrictMode, which is
       * on: the App Router defaults `reactStrictMode` to true, so dev runs
       * setup → cleanup → setup on every mount. Now that `returnTo` is the
       * TRIGGER rather than whatever had focus after the commit, an unguarded
       * cleanup would fire between the two setups and pull focus out of a sheet
       * that is still on screen — the second setup would then find nothing
       * focused inside and fall back to the dialog wrapper, so the amount field
       * this sheet exists for would never hold the caret and a phone keyboard
       * would open and shut in one frame. Exactly what the comment above says
       * must not happen, in dev only, which is the worst place to have it:
       * every manual test of every autofocusing sheet would diverge from
       * production.
       *
       * The discriminator is the container itself. StrictMode's simulated
       * unmount does not touch the DOM, so the dialog is still in the document
       * when that cleanup runs; a real close has already removed it by the time
       * a passive cleanup gets there. Checking where focus currently sits does
       * NOT work here and was the first thing tried: at the simulated cleanup
       * focus is still on the sheet's own autofocused field, which is inside the
       * container, so the guard passes and the steal happens anyway.
       */
      if (container.isConnected) return;
      if (returnTo instanceof HTMLElement && returnTo.isConnected) {
        returnTo.focus();
      }
    };
    // Mount and unmount only, which is why nothing reactive may be read above:
    // re-running this would yank focus out of a field mid-word, and `onClose`
    // is an inline arrow at most call sites, so it changes identity on every
    // render. `returnTo` is state with no setter, so it is stable by
    // construction and safe to close over.
  }, [returnTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (e.key === "Enter") {
        const container = ref.current;
        if (!container || !onPrimary) return;
        /*
         * A field that handled this Enter has already said so.
         *
         * This listener is on `window`, so it runs AFTER React has finished
         * bubbling the event through the sheet — by which time a field's own
         * handler has typically committed its value and blurred. Focus is then
         * on `<body>`, which the check below reads as "no field is holding
         * Enter", and the sheet submits on the very keypress that was meant only
         * to leave the field. Measured: typing "3 st" and pressing Enter once
         * both committed the amount AND added the item, so the second Enter the
         * user was about to press would have done something else entirely.
         *
         * `preventDefault` is the fields' way of claiming the keypress, and this
         * is the other half of that contract.
         */
        if (e.defaultPrevented) return;
        // `isComposing` is not a nicety on a Swedish phone with a prediction
        // bar: Enter is how an IME accepts the candidate it is offering, and
        // submitting the sheet on that keystroke would commit a half-typed word
        // and close over it.
        if (e.isComposing) return;
        // A modified Enter is somebody else's shortcut, not this one.
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if (!enterHitsPrimary(container, document.activeElement)) return;
        e.preventDefault();
        onPrimary();
        return;
      }

      if (e.key !== "Tab") return;

      const container = ref.current;
      if (!container) return;

      const stops = focusableWithin(container);
      const active = document.activeElement;
      const inside = container.contains(active);

      // A sheet with nothing to focus is still a sheet. Keeping the keypress
      // rather than letting it walk out is the whole point.
      if (stops.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }

      const first = stops[0];
      const last = stops[stops.length - 1];

      if (e.shiftKey) {
        // The dialog element counts as the near edge: it sits before all of its
        // own content, so backwards from it leads out of the sheet.
        if (!inside || active === first || active === container) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // `window`, not `document`, and deliberately: this is where the sheets'
    // Escape handler already lived, and moving it a level in would reorder it
    // against the field-level Escape handlers that clear a search box before
    // the sheet closes over them.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrimary]);

  return ref;
}
