/*
 * Recipus service worker.
 *
 * The job here is narrow but important: the app must open, instantly and fully
 * usable, in a shop basement with no signal. That inverts the usual caching
 * posture — longhaul's worker is deliberately online-first and caches nothing
 * but an error page, because stale health data is worse than no data. A
 * shopping list is the opposite. The list lives in IndexedDB and the shell is
 * cached, so "offline" is an ordinary state rather than a failure.
 *
 * What this worker does NOT do: cache API responses, or retry writes. Reads are
 * served from IndexedDB by the app itself, and pending writes live in the
 * app's outbox. Putting either in the worker would mean two implementations of
 * "what does this household's list look like", which is exactly the kind of
 * divergence this app cannot afford.
 *
 * Bump CACHE_TAG whenever the precache list or these strategies change.
 */

const CACHE_TAG = "recipus-v1";
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
 * Navigations are served from cache first, then revalidated in the background.
 *
 * This is the single most important decision in the file. Network-first would
 * make every cold launch wait on a TLS handshake to a home server over 4G,
 * which is the difference between an app you open at the shop entrance and one
 * you give up on.
 */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE_TAG);
  const cached = await cache.match("/", { ignoreSearch: true });

  const network = fetch(request)
    .then((response) => {
      // Only cache real HTML. An Authelia redirect to a login page must never
      // become the thing we serve on every future cold start.
      if (
        response.ok &&
        response.type === "basic" &&
        (response.headers.get("content-type") || "").includes("text/html")
      ) {
        cache.put("/", response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;

  const fresh = await network;
  if (fresh) return fresh;

  return (
    (await cache.match(OFFLINE_URL)) ||
    new Response("Offline", { status: 503, statusText: "Offline" })
  );
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
