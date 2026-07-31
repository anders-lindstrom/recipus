"use client";

import { useOnce } from "@/lib/client/use-once";

/**
 * Put the long-press tip back.
 *
 * The tip is said once ever, which is right — a hint that returns is an advert.
 * But "once ever" with no way back means a phone that dismissed it by accident,
 * or a second person picking up the same phone, has permanently lost the only
 * thing that advertises half of what the list can do. This is the way back, and
 * it belongs here rather than on the list: it is a preference, and preferences
 * are what this screen is for.
 */
export function SettingsHintReset() {
  const { pending, dismiss, restore } = useOnce("recipus:hint:longpress");

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink">Tips om långtryck</p>
        <p className="text-caption text-ink-faint">
          {pending
            ? "Visas nästa gång listan har tre varor."
            : "Har visats och dolts."}
        </p>
      </div>
      <button
        type="button"
        onClick={pending ? dismiss : restore}
        className="flex-none rounded-full border border-line-strong px-3 py-1.5 text-caption font-semibold text-ink-soft"
      >
        {pending ? "Dölj" : "Visa igen"}
      </button>
    </div>
  );
}
