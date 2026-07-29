/*
 * Recipus service worker.
 *
 * The job here is narrow but important: the app must open, fully usable, in a
 * shop basement with no signal. The list itself lives in IndexedDB; this only
 * has to make sure the shell that reads it is available, so "offline" is an
 * ordinary state rather than a failure.
 *
 * The shell is cached but NOT served in preference to the network — see
 * handleNavigation for why that distinction turned out to matter more than it
 * sounds. longhaul's worker is online-first for a different reason (stale
 * health data is worse than none); this one lands in a similar place by a
 * different route.
 *
 * What this worker does NOT do: cache API responses, or retry writes. Reads are
 * served from IndexedDB by the app itself, and pending writes live in the
 * app's outbox. Putting either in the worker would mean two implementations of
 * "what does this household's list look like", which is exactly the kind of
 * divergence this app cannot afford.
 *
 * Bump CACHE_TAG whenever the precache list or these strategies change — the
 * activate handler deletes every cache that does not match, which is what
 * lets a bad cached shell be discarded rather than lingering.
 */

const CACHE_TAG = "recipus-v2";
const OFFLINE_URL = "/offline.html";

// The shell is everything needed to render an empty app that then fills itself
// from IndexedDB. Hashed build assets are added opportunistically at runtime.
const PRECACHE = [OFFLINE_URL, "/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_TAG)
      .then((cache) =>
        // cache: "reload" bypasses the HTTP cache so a new worker version never
        // precaches a stale copy of the shell.
        Promise.allSettled(
          PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" }))),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((k) => k !== CACHE_TAG).map((k) => caches.delete(k)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});

/**
 * Navigations race the network against a short timeout, falling back to cache.
 *
 * This was cache-first, and that was wrong in a way that took a while to see.
 * Cache-first means the shell you cached is the shell you get forever, so one
 * production build on an origin poisons every later dev server on it: the
 * cached HTML references build hashes the new server does not have, the page
 * never hydrates, and the app can never unregister the worker because its own
 * code never runs. A self-inflicted, unrecoverable-from-inside state.
 *
 * Network-first costs far less than it appears to. When you are genuinely
 * offline the fetch fails on connection setup in milliseconds, not seconds —
 * the timeout only bites on a flaky signal, which is exactly when a slightly
 * slower correct answer beats a fast stale one.
 */
const NAV_TIMEOUT_MS = 2500;

async function handleNavigation(request) {
  const cache = await caches.open(CACHE_TAG);

  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("nav timeout")), NAV_TIMEOUT_MS),
      ),
    ]);

    // Only cache real, same-origin HTML. An Authelia redirect to a login page
    // must never become the thing we serve on every future cold start.
    if (
      response.ok &&
      response.type === "basic" &&
      (response.headers.get("content-type") || "").includes("text/html")
    ) {
      cache.put("/", response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match("/", { ignoreSearch: true });
    if (cached) return cached;
    return (
      (await cache.match(OFFLINE_URL)) ||
      new Response("Offline", { status: 503, statusText: "Offline" })
    );
  }
}

/** Build assets are content-hashed, so a hit is always correct. */
async function handleAsset(request) {
  const cache = await caches.open(CACHE_TAG);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The app owns offline behaviour for its own data. Never cache /api.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(handleAsset(request));
  }
});

// Lets the app trigger an immediate update after it detects a new worker,
// rather than waiting for every tab to close.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
