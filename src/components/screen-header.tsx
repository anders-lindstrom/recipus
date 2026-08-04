import Link from "next/link";
import { UiIcon } from "./ui-icon";

/**
 * The header on every screen that is not the list.
 *
 * Same 3.25rem content height as the list screen's header, because the aisle
 * rail's sticky offset is measured against it and because a header that
 * changes height between routes reads as the page jumping.
 *
 * The height is what it is for the list screen's sake — see the note there. A
 * 44px control needs 4px around it for its focus ring, and this row is pinned
 * to the top of the viewport, where anything short of that is off screen rather
 * than merely tight.
 *
 * Paper and ink rather than the old solid green bar: green is reserved for
 * items you still have to buy and for the one primary action per screen, and
 * spending it on furniture is what made the signal hard to find.
 */

export interface ScreenHeaderProps {
  title: string;
  /** Where the back chevron goes. */
  backHref: string;
  backLabel: string;
  /** Right-aligned action, e.g. the import button. */
  action?: React.ReactNode;
}

export function ScreenHeader({
  title,
  backHref,
  backLabel,
  action,
}: ScreenHeaderProps) {
  return (
    <header className="safe-top sticky top-0 z-30 border-b border-line bg-surface">
      <div className="flex h-13 items-center gap-1 px-2">
        <Link
          href={backHref}
          aria-label={backLabel}
          /* 44px, the same floor the outbound links in the app were raised to.
             That audit grew everything that navigates INTO a screen and never
             reached the control that navigates back out of one — which is on
             seven screens, sits under the thumb, and is next to the notch. The
             icon is unchanged; only the target grew. */
          className="-ml-1 flex h-11 w-11 flex-none items-center justify-center rounded-full text-ink-soft"
        >
          <UiIcon name="back" size={22} />
        </Link>
        {/* An <h1>, not a styled span. No screen in the app had a top-level
            heading, so a screen-reader user landing on one of these had nothing
            to orient by and no way to jump to the content — and `document.title`
            was the constant "Recipus" on every route, so navigating announced
            nothing either. The type scale is unchanged; only the element is. */}
        <h1 className="min-w-0 flex-1 truncate text-title text-ink">
          {title}
        </h1>
        {action}
      </div>
    </header>
  );
}
