import { OpenAPIHono } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "@/db";
import { AuthError, authenticate } from "@/lib/auth";
import { barcodeRoutes } from "./routes/barcode";
import { listsRoutes } from "./routes/lists";
import { opsRoutes } from "./routes/ops";
import { recipesRoutes } from "./routes/recipes";
import { streamRoutes } from "./routes/stream";
import { suggestionsRoutes } from "./routes/suggestions";

export type ApiEnv = {
  Variables: {
    /** Authelia username of the caller, set by the auth gate below. */
    actor: string;
  };
};

export function api() {
  const app = new OpenAPIHono<ApiEnv>();

  // Every request authenticates itself via src/lib/auth.ts — no exceptions.
  // Recipus sits behind Nginx Proxy Manager + Authelia, but the app never
  // assumes it is unreachable any other way; an accidentally exposed
  // container port must 401, not serve a household's shopping list.
  app.use("*", async (c, next) => {
    try {
      const user = authenticate(c.req.raw.headers);
      c.set("actor", user.autheliaUser);
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ error: err.message }, 401);
      }
      throw err;
    }
    return next();
  });

  app.route("/lists", listsRoutes());
  app.route("/ops", opsRoutes());
  app.route("/stream", streamRoutes());
  app.route("/recipes", recipesRoutes());
  app.route("/barcode", barcodeRoutes());
  app.route("/suggestions", suggestionsRoutes());

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error("[api]", err);
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}

/** Full app with base path + OpenAPI document, mounted by the Next route. */
export function createApp() {
  const app = new OpenAPIHono<ApiEnv>().basePath("/api");

  // Public by design (registered BEFORE the api() mount, so the auth gate
  // never sees it): exposes nothing but the API shape.
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Recipus API",
      version: "0.1.0",
      description:
        "Shared household grocery list. Every request authenticates via the reverse proxy (Nginx Proxy Manager + Authelia) in front of the app.",
    },
  });

  // Also public, and for the same reason: the container's healthcheck runs
  // inside the container, with no proxy in front of it and therefore no
  // credentials to present. It leaks nothing — liveness, and whether Postgres
  // answers.
  //
  // A dead database reports 503 rather than 200. The app itself survives one
  // (the list is served from the client's own copy), but a container that
  // cannot reach Postgres is degraded, and a healthcheck that says otherwise is
  // worse than no healthcheck at all.
  app.get("/health", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: "ok", db: "up" });
    } catch {
      return c.json({ status: "degraded", db: "down" }, 503);
    }
  });

  app.route("/", api());
  return app;
}
