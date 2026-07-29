import Link from "next/link";
import { UiIcon } from "./ui-icon";

/**
 * The header on every screen that is not the list.
 *
 * Same 3rem content height as the list screen's header, because the aisle
 * rail's sticky offset is measured against it and because a header that
 * changes height between routes reads as the page jumping.
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
      <div className="flex h-12 items-center gap-1 px-2">
        <Link
          href={backHref}
          aria-label={backLabel}
          className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-ink-soft"
        >
          <UiIcon name="back" size={22} />
        </Link>
        <span className="min-w-0 flex-1 truncate text-title text-ink">
          {title}
        </span>
        {action}
      </div>
    </header>
  );
}
