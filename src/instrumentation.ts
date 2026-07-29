/**
 * Server startup hook.
 *
 * One job: make sure the catalog exists before anyone opens the app.
 *
 * Recipus is unusable without its seed data — an empty catalog is a screen with
 * nothing to tap, which looks exactly like a broken deploy. The seed is
 * idempotent and deliberately preserves everything the household owns
 * (`has_at_home`, `use_count`, `last_used_at`), so running it on every boot is
 * safe, and it means "deploy" and "the catalog is correct" are the same event
 * rather than two things someone has to remember to do in order.
 *
 * This is the reason `src/db/seed.ts` exports a function instead of running on
 * import: the production image has no `tsx` and no `src/`, so `pnpm db:seed`
 * cannot run inside the container. Compiling the seed into the server bundle
 * sidesteps that without shipping a second copy of the seed logic as SQL —
 * there is one implementation of "what the catalog should contain", and both
 * the CLI and the server call it.
 */

/** Long enough for a cold Postgres, short enough that boot can't hang on one. */
const SEED_TIMEOUT_MS = 30_000;

function seedEnabled(): boolean {
  // Next executes this hook during `next build` too, where there is no database
  // and DATABASE_URL is deliberately a placeholder. Seeding there would fail the
  // image build for no reason.
  if (process.env.NEXT_PHASE === "phase-production-build") return false;

  // Explicit wins. Otherwise: on in production, off in dev — local development
  // has `pnpm db:seed` and does not need a few hundred upserts on every restart.
  if (process.env.SEED_ON_BOOT === "1") return true;
  if (process.env.SEED_ON_BOOT === "0") return false;
  return process.env.NODE_ENV === "production";
}

export async function register() {
  // Also runs on the edge runtime, which has no database driver at all.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!seedEnabled()) return;

  try {
    const { seed } = await import("@/db/seed");
    await Promise.race([
      seed(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`seed did not finish in ${SEED_TIMEOUT_MS}ms`)),
          SEED_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    // Never fatal. A failed seed costs you catalog items; refusing to boot costs
    // you the app, including the offline list that would otherwise still work.
    console.error("[instrumentation] catalog seed failed:", err);
  }
}
