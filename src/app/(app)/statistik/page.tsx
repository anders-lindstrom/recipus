import Link from "next/link";
import { headers } from "next/headers";
import { ItemIcon } from "@/components/icon";
import { ScreenHeader } from "@/components/screen-header";
import { UiIcon } from "@/components/ui-icon";
import { authenticate, AuthError } from "@/lib/auth";
import { loadStatistics, type Statistics } from "@/lib/services/statistics";
import { displayName } from "@/lib/utils";

export const metadata = { title: "Statistik · Recipus" };

/**
 * What the household has actually bought.
 *
 * Server-rendered and never cached, for the ordinary reason: these are counts
 * over a table that changes every time either of you taps a tile, and a cached
 * render would answer a question nobody asked.
 *
 * Deliberately not offline. Every other screen in this app works in a basement
 * because it is the shopping, and this one is not the shopping — it is a thing
 * you look at on the sofa. Building it into the sync state would mean carrying
 * the whole purchase history onto both phones to answer a question neither of
 * them asks in a shop.
 *
 * No charts, and that is the spec's call rather than an omission: a bar chart of
 * four numbers is decoration. Spend is absent for a better reason still — this
 * app has never known a price, and inventing one would be the only lie on the
 * screen.
 */
export const dynamic = "force-dynamic";

/** The window the screen opens on. Long enough to cover a shopping rhythm. */
const WINDOW_DAYS = 90;

export default async function StatisticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  try {
    authenticate(await headers());
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    // Unlike the list, there is nothing local to fall back on — every number
    // here is a database query. So this screen says so rather than rendering
    // zeroes, which would read as "you have never bought anything".
    return (
      <main className="min-h-dvh pb-16">
        <ScreenHeader title="Statistik" backHref="/" backLabel="Till listan" />
        <p className="px-5 pt-8 text-body text-ink-soft">
          Statistiken hämtas från servern och kräver att du är inloggad. Listan
          fungerar under tiden.
        </p>
      </main>
    );
  }

  const { period } = await searchParams;
  const allTime = period === "allt";
  // The clock is read inside `loadStatistics` and handed back on the result, so
  // every relative age below is measured from the same instant the window was
  // cut at — and this component stays a pure function of what it is given.
  const stats = await loadStatistics(allTime ? null : WINDOW_DAYS);

  return (
    <main className="min-h-dvh pb-16">
      <ScreenHeader title="Statistik" backHref="/" backLabel="Till listan" />

      <div className="flex gap-2 px-4 pt-4">
        <PeriodChip href="/statistik" active={!allTime}>
          Senaste {WINDOW_DAYS} dagarna
        </PeriodChip>
        <PeriodChip href="/statistik?period=allt" active={allTime}>
          Allt
        </PeriodChip>
      </div>

      {stats.totalPurchases === 0 ? (
        <p className="px-5 pt-8 text-body text-ink-soft">
          Inga köp {allTime ? "än" : `de senaste ${WINDOW_DAYS} dagarna`}. Ett
          köp skrivs när du bockar av en vara i köpläge — att ta bort något du
          ändrat dig om räknas medvetet inte.
        </p>
      ) : (
        <>
          <Section title="Köp">
            <div className="px-4 py-4">
              <p className="text-display text-ink">{stats.totalPurchases}</p>
              <p className="text-body-sm text-ink-soft">
                {allTime ? "totalt" : `de senaste ${WINDOW_DAYS} dagarna`}
              </p>
            </div>
          </Section>

          {stats.people.length > 0 && (
            <Section title="Vem har handlat">
              {stats.people.map((p) => (
                <div
                  key={p.actor}
                  className="flex items-baseline gap-3 px-4 py-3"
                >
                  <span className="flex-1 text-body text-ink">
                    {displayName(p.actor)}
                  </span>
                  <span className="text-body tabular-nums text-ink">
                    {p.purchases}
                  </span>
                  <span className="w-12 text-right text-caption tabular-nums text-ink-faint">
                    {share(p.purchases, stats.totalPurchases)}
                  </span>
                </div>
              ))}
            </Section>
          )}

          <Section title="Mest köpta">
            {stats.topVaror.map((v) => (
              <div key={v.catalogItemId} className="flex items-center gap-3 px-4 py-2.5">
                <ItemIcon iconRef={v.iconRef} className="flex-none text-2xl" />
                <span className="min-w-0 flex-1 truncate text-body text-ink">
                  {v.name}
                </span>
                <span className="flex-none text-caption text-ink-faint">
                  {sinceText(v.lastPurchasedAt, stats.now)}
                </span>
                <span className="w-6 flex-none text-right text-body tabular-nums text-ink">
                  {v.purchases}
                </span>
              </div>
            ))}
          </Section>
        </>
      )}

      <UnplacedDebt stats={stats} />
    </main>
  );
}

/**
 * The purchases these numbers cannot see.
 *
 * Shown rather than quietly dropped, because the spec is explicit that the
 * review queue "is not cosmetic tidying but the thing that makes the numbers
 * true" — and the screen showing the numbers is the one place where the gap in
 * them is worth an interruption. It links straight to where the debt is paid.
 */
function UnplacedDebt({ stats }: { stats: Statistics }) {
  if (stats.unplacedPurchases === 0) return null;
  return (
    <section className="px-3 pt-5">
      <Link
        href="/varor"
        className="flex items-center gap-3 rounded-card border border-line bg-warn-tint px-4 py-3"
      >
        <UiIcon name="warning" size={18} className="flex-none text-warn" />
        <span className="flex-1 text-body-sm text-ink">
          <strong className="font-semibold">
            {stats.unplacedPurchases} köp
          </strong>{" "}
          väntar på att placeras och räknas inte ovan.
        </span>
        <UiIcon name="chevronDown" size={16} className="flex-none -rotate-90 text-ink-faint" />
      </Link>
    </section>
  );
}

function share(n: number, total: number): string {
  if (total === 0) return "";
  return `${Math.round((n / total) * 100)}%`;
}

/** "i dag" / "3 dgr" / "5 v" — a relative age, in as few characters as possible. */
function sinceText(iso: string, now: Date): string {
  const days = Math.floor(
    (now.getTime() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000),
  );
  if (days <= 0) return "i dag";
  if (days === 1) return "i går";
  if (days < 14) return `${days} dgr`;
  const weeks = Math.floor(days / 7);
  if (weeks < 10) return `${weeks} v`;
  return `${Math.floor(days / 30)} mån`;
}

function PeriodChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-full bg-brand px-3 py-1.5 text-caption font-semibold text-on-brand"
          : "rounded-full border border-line px-3 py-1.5 text-caption font-semibold text-ink-soft"
      }
    >
      {children}
    </Link>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="px-3 pt-5">
      <h2 className="mx-1 mb-2 text-overline text-ink-faint uppercase">
        {title}
      </h2>
      <div className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface-raised">
        {children}
      </div>
    </section>
  );
}
