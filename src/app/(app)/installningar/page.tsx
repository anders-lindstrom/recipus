import { headers } from "next/headers";
import { ScreenHeader } from "@/components/screen-header";
import { SettingsHintReset } from "@/components/settings-hint-reset";
import { authenticate, AuthError } from "@/lib/auth";
import { commitUrl, formatBuildTime, getBuildInfo } from "@/lib/version";

// The layout sets a single constant "Recipus" for every route, so navigating
// between screens announced nothing at all. A per-route title is the cheapest
// thing that fixes it, and it is also what the tab and the PWA task switcher
// show.
export const metadata = { title: "Inställningar · Recipus" };

/**
 * Settings, and the answer to "what is actually running".
 *
 * The version block is the reason this screen exists. Everything else in this
 * app is used in a shop on a phone, which is exactly where you cannot check
 * whether the thing misbehaving is the deploy you pushed an hour ago — and
 * Watchtower means the answer changes without anyone doing anything. The commit
 * links to GitHub so the next question after "which build" takes one tap.
 *
 * Server-rendered: `getBuildInfo` reads the environment the container was built
 * with, and its dev fallback shells out to git. Neither belongs in a bundle.
 *
 * Not cached. The whole point is what is running RIGHT NOW; a version banner
 * served from the service worker's cache would be a version banner that lies
 * precisely when it matters.
 */
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let actor: string | null = null;
  try {
    actor = authenticate(await headers()).autheliaUser;
  } catch (err) {
    // Being signed out is a state, not a failure — same reasoning as the list
    // and registry pages. The screen renders and says so.
    if (!(err instanceof AuthError)) throw err;
  }

  const build = getBuildInfo();
  const url = commitUrl(build.sha);

  return (
    <main className="min-h-dvh pb-16">
      <ScreenHeader title="Inställningar" backHref="/" backLabel="Till listan" />

      <Section title="Konto">
        <Row
          label="Inloggad som"
          value={actor ?? "Inte inloggad"}
          muted={!actor}
        />
      </Section>

      <Section title="Listan">
        <SettingsHintReset />
      </Section>

      <Section title="Om Recipus">
        <Row
          label="Version"
          value={
            url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="font-mono underline underline-offset-2"
              >
                {build.shortSha}
              </a>
            ) : (
              <span className="font-mono">{build.shortSha}</span>
            )
          }
          hint={build.isDev ? "utvecklingsläge" : undefined}
        />
        <Row label="Byggd" value={formatBuildTime(build.buildTime)} />
      </Section>
    </main>
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
      {/* Hairlines between rows and nowhere else — the divider separates two
          things rather than drawing a box around each one. */}
      <div className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface-raised">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  hint,
  muted = false,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-3">
      <span className="flex-none text-body text-ink-soft">{label}</span>
      <span className="min-w-0 flex-1 text-right">
        <span className={muted ? "text-body text-ink-faint" : "text-body text-ink"}>
          {value}
        </span>
        {hint && (
          <span className="ml-1.5 text-caption text-ink-faint">({hint})</span>
        )}
      </span>
    </div>
  );
}
