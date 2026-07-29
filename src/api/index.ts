import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { AuthError, authenticate } from "@/lib/auth";
import { barcodeRoutes } from "./routes/barcode";
import { listsRoutes } from "./routes/lists";
import { opsRoutes } from "./routes/ops";
import { recipesRoutes } from "./routes/recipes";
import { streamRoutes } from "./routes/stream";

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

  app.route("/", api());
  return app;
}
