import { execSync } from "node:child_process";

/**
 * Build/version info for the "Om" section.
 *
 * Baked into the image at build time by CI: the Dockerfile's runner stage sets
 * `RECIPUS_GIT_SHA` / `RECIPUS_BUILD_TIME` from docker build-args, because the
 * image does not ship `.git` (see .dockerignore) — so the running container
 * reads them from the environment rather than from a repo it does not have.
 *
 * In local dev the env is unset, so this falls back to the working tree's HEAD
 * and flags `isDev`. That distinction is the point of the whole file: "which
 * commit is the shop actually running" is a question you ask when something
 * looks wrong on a phone in a supermarket, and an answer that silently means
 * "whatever is checked out on my laptop" would be worse than no answer.
 *
 * Same shape as longhaul's `src/lib/version.ts`, deliberately: the two projects
 * share a stack and a deploy pipeline, and having them answer this question
 * differently would mean learning it twice.
 *
 * Server-only. `execSync` is reached solely on the dev-fallback path, and the
 * only importer is the settings page, which is a server component.
 */
export type BuildInfo = {
  /** Full commit SHA, or "dev" when neither env nor git is available. */
  sha: string;
  /** First 12 chars of the SHA for display (or "dev"). */
  shortSha: string;
  /** ISO-8601 UTC build timestamp, or "okänd" when unknown. */
  buildTime: string;
  /** True when the SHA came from the local working tree, not a CI build. */
  isDev: boolean;
};

const SHORT_SHA_LEN = 12;
const GITHUB_REPO = "anders-lindstrom/recipus";

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;

  const envSha = process.env.RECIPUS_GIT_SHA?.trim();
  const buildTime = process.env.RECIPUS_BUILD_TIME?.trim() || "okänd";

  if (envSha) {
    cached = {
      sha: envSha,
      shortSha: envSha.slice(0, SHORT_SHA_LEN),
      buildTime,
      isDev: false,
    };
    return cached;
  }

  // Dev fallback: read the working tree's HEAD. Never throw if git is missing —
  // the container has no git at all, and a settings screen that 500s because it
  // could not name itself is a poor trade.
  let sha = "dev";
  try {
    sha =
      execSync("git rev-parse HEAD", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "dev";
  } catch {
    // git unavailable — keep the "dev" placeholder.
  }

  cached = {
    sha,
    shortSha: sha === "dev" ? "dev" : sha.slice(0, SHORT_SHA_LEN),
    buildTime,
    isDev: true,
  };
  return cached;
}

/** GitHub commit URL for a full SHA (null when we only have the dev placeholder). */
export function commitUrl(sha: string): string | null {
  if (!sha || sha === "dev") return null;
  return `https://github.com/${GITHUB_REPO}/commit/${sha}`;
}

/** ISO-8601 build stamp -> "2026-07-31 18:30 UTC"; passes non-dates through. */
export function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  return `${formatted} UTC`;
}
