import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  CloudOff,
  ExternalLink,
  LayoutGrid,
  ListPlus,
  LoaderCircle,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  ShoppingBag,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

/**
 * Chrome icons.
 *
 * Distinct from `icon.tsx`, which draws the *items* — those stay OpenMoji,
 * because a grid of little pictures is what makes the list scannable and it is
 * half the app's character. This module is the other half: the furniture.
 *
 * It used to be emoji (🔍 📖 ▣ ➕ ✕ ✓ ‹ ▼), and emoji-as-chrome has one fatal
 * property — the phone chooses the artwork. Weights, colours and optical sizes
 * came out different on every device, none of them matched the text next to
 * them, and none of them could take the ink colour. These are line icons that
 * inherit `currentColor` and one stroke weight, so the furniture recedes and
 * the items stay the only pictures on screen.
 *
 * The set is closed on purpose: reaching for a new glyph means adding it here,
 * which is the moment to ask whether the app really needs another one.
 */

const GLYPHS = {
  allAisles: LayoutGrid,
  back: ChevronLeft,
  backArrow: ArrowLeft,
  check: Check,
  chevronDown: ChevronDown,
  clear: X,
  close: X,
  decrease: Minus,
  edit: Pencil,
  external: ExternalLink,
  increase: Plus,
  offline: CloudOff,
  plus: Plus,
  recipes: BookOpen,
  /**
   * The household's goods — the registry, `/varor`.
   *
   * The one glyph here that exists because another was doing too much.
   * `allAisles` is a grid, and a grid says *layout*: it already means "every
   * aisle at once" in the rail and "which aisle is this filed under" in the
   * sheets. Pointed at the registry as well, one drawing carried three
   * meanings, and the meaning it carried worst was the screen nobody could
   * find. A bag reads as goods rather than as a layout, so `allAisles` is back
   * to meaning only aisles.
   */
  registry: ShoppingBag,
  remove: Trash2,
  retry: RefreshCw,
  scan: ScanLine,
  search: Search,
  spinner: LoaderCircle,
  toList: ListPlus,
  toTop: ArrowUp,
  undo: Undo2,
  warning: CircleAlert,
} as const;

export type UiIconName = keyof typeof GLYPHS;

export interface UiIconProps {
  name: UiIconName;
  /** Pixel size. Stick to the ladder: 14 inline, 16 dense, 18 default, 22 touch. */
  size?: number;
  className?: string;
  /**
   * Only set this when the icon is the sole content of a control that has no
   * accessible name of its own. Everywhere else the icon is decoration next to
   * a real label, and naming it just makes a screen reader say it twice.
   */
  title?: string;
}

export function UiIcon({ name, size = 18, className, title }: UiIconProps) {
  const Glyph = GLYPHS[name];
  return (
    <Glyph
      size={size}
      // 1.75 sits right against Familjen Grotesk's stems at these sizes; the
      // lucide default of 2 looked heavier than the text it labels.
      strokeWidth={1.75}
      className={className}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      role={title ? "img" : undefined}
    />
  );
}
