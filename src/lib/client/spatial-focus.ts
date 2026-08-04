/**
 * Arrow keys that move focus by where things ARE, not by document order.
 *
 * Document order is the right answer for a single-column list and the wrong one
 * for a grid: consecutive tiles in the DOM are side by side on screen, so
 * ArrowDown walks SIDEWAYS along the first row and ArrowUp can never leave it.
 * That defect was found in the add bar's "Vanligast" grid and filed against the
 * list screen's own grid at the same time — the same bug twice, because the
 * stepping lived inside one component.
 *
 * Reading the boxes handles both shapes with one rule and needs no column
 * count: down is the nearest stop starting below this one, tie-broken by
 * horizontal centre so a grid keeps its column; left and right only consider
 * stops on the same row, so they are inert in a single-column list.
 *
 * The geometry is pure and takes plain boxes, which is the only reason it can be
 * tested at all — jsdom gives every element a zero rect, so anything that reads
 * `getBoundingClientRect` itself is only ever testable in a real browser.
 */

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** The part of a `DOMRect` any of this actually depends on. */
export interface Box {
  top: number;
  left: number;
  width: number;
}

export function isArrowKey(key: string): key is ArrowKey {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight"
  );
}

/**
 * Two stops share a row when their tops agree. Grid tiles agree exactly; list
 * rows are a whole row apart, so a few pixels of slack is enough and cannot
 * accidentally merge two of them.
 */
const SAME_ROW_PX = 8;

const centre = (b: Box) => b.left + b.width / 2;

/**
 * The stop an arrow key should land on, or null when there is nothing that way.
 *
 * Generic over what a stop IS so the geometry never touches the DOM.
 */
export function nextInDirection<T>(
  from: Box,
  others: { stop: T; box: Box }[],
  key: ArrowKey,
): T | null {
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const right = key === "ArrowRight";
    // No wrapping at the ends of a row. Wrapping from the last tile of one row
    // to the first of the next reads as the grid having moved under you, and
    // ArrowDown is already the way to the next row.
    const sameRow = others.filter(
      ({ box }) =>
        Math.abs(box.top - from.top) < SAME_ROW_PX &&
        (right ? box.left > from.left : box.left < from.left),
    );
    if (sameRow.length === 0) return null;
    return sameRow.sort((a, b) =>
      right ? a.box.left - b.box.left : b.box.left - a.box.left,
    )[0].stop;
  }

  const down = key === "ArrowDown";
  const candidates = others.filter(({ box }) =>
    down ? box.top > from.top + SAME_ROW_PX : box.top < from.top - SAME_ROW_PX,
  );
  if (candidates.length === 0) return null;

  return candidates.sort(
    (a, b) =>
      (down ? a.box.top - b.box.top : b.box.top - a.box.top) ||
      Math.abs(centre(a.box) - centre(from)) -
        Math.abs(centre(b.box) - centre(from)),
  )[0].stop;
}

/**
 * The same step, against real elements, ending in a real `focus()`.
 *
 * Returns whether focus moved, which is what the caller needs to decide about
 * `preventDefault` — though every caller so far prevents the default whichever
 * way this went, because an arrow key that scrolls the page at the edge of a
 * grid is the behaviour being replaced.
 */
export function stepFocusWithin(
  stops: HTMLElement[],
  current: Element | null,
  key: ArrowKey,
): boolean {
  if (!(current instanceof HTMLElement) || !stops.includes(current)) {
    return false;
  }
  const next = nextInDirection(
    current.getBoundingClientRect(),
    stops
      .filter((el) => el !== current)
      .map((el) => ({ stop: el, box: el.getBoundingClientRect() })),
    key,
  );
  if (!next) return false;
  next.focus();
  return true;
}
