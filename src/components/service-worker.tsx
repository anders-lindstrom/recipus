"use client";

import { useEffect } from "react";

/**
 * Register the service worker.
 *
 * Without this, `public/sw.js` is a file nobody ever asks for: the shell is
 * never cached, and opening the app with no signal fails at the connection
 * rather than showing your list. The worker is the difference between an app
 * you trust in a shop and one you don't, and it is invisible until the one
 * moment it matters — so its absence is easy to miss.
 *
 * Dev is deliberately excluded. Next serves modules straight from disk with
 * HMR, and a worker caching that shell serves stale chunks after every edit.
 * Test offline behaviour against `pnpm build && pnpm start`, which is what
 * production actually runs.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    // Registering after load keeps the worker's install off the critical path
    // for the first paint, which is the one launch that has no cache to fall
    // back on anyway.
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // A failed registration must never break the app — it only costs
        // offline capability, and the list still works while online.
      });
    };

    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
