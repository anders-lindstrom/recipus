import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { recipeSources, recipes } from "@/db/schema";
import { putSharedFile } from "@/lib/services/share-inbox";
import { LocalFSStorage, setStorageForTests, storage, type StorageAdapter } from "@/lib/storage";
import type { ApiEnv } from "..";
import { recipesRoutes } from "./recipes";

/**
 * Importing a recipe from a file, against the dev database and a throwaway
 * storage directory. Every row is written by an actor named `test-file-…` and
 * removed in `afterAll`; the shim is a stubbed `fetch`.
 */
const ACTOR = `test-file-${randomUUID().slice(0, 8)}`;
const OTHER = `${ACTOR}-other`;

function appFor(actor: string) {
  const app = new OpenAPIHono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/recipes", recipesRoutes());
  return app;
}
const app = appFor(ACTOR);

const JPEG = Buffer.from("not really a jpeg, but bytes all the same");
const JPEG_B64 = JPEG.toString("base64");

function readFile(body: unknown, on = app) {
  return on.request("/recipes/read-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function saveDraft(body: Record<string, unknown>, on = app) {
  return on.request("/recipes/from-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Mormors kladdkaka",
      servings: 8,
      servingsUnit: "bitar",
      ingredientText: "2 ägg\n2 dl socker",
      instructions: ["Rör ihop.", "Grädda."],
      ...body,
    }),
  });
}

function shimAnswers(recipe: Record<string, unknown> | null) {
  process.env.SHIM_URL = "http://shim.test";
  process.env.SHIM_TOKEN = "t";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    recipe === null
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify({ recipe }), { status: 200 }),
  );
}

async function sourceRows(actor = ACTOR) {
  return db.select().from(recipeSources).where(eq(recipeSources.createdBy, actor));
}

let dir = "";
let previous: StorageAdapter;
const ENV = { url: process.env.SHIM_URL, token: process.env.SHIM_TOKEN };

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "recipus-sources-"));
  previous = setStorageForTests(new LocalFSStorage(dir));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.SHIM_URL = ENV.url;
  process.env.SHIM_TOKEN = ENV.token;
  if (ENV.url === undefined) delete process.env.SHIM_URL;
  if (ENV.token === undefined) delete process.env.SHIM_TOKEN;
});

afterAll(async () => {
  await db.delete(recipeSources).where(inArray(recipeSources.createdBy, [ACTOR, OTHER]));
  await db.delete(recipes).where(inArray(recipes.createdBy, [ACTOR, OTHER]));
  setStorageForTests(previous);
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /recipes/read-file", () => {
  it("stores the file even when the shim cannot read it", async () => {
    shimAnswers(null);
    const before = (await sourceRows()).length;
    const res = await readFile({ data: JPEG_B64, mediaType: "image/jpeg", fileName: "kort.jpg" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sourceId: string; kind: string; draft: unknown };
    expect(body.draft).toBeNull();
    expect(body.kind).toBe("image");

    const rows = await sourceRows();
    expect(rows.length).toBe(before + 1);
    const row = rows.find((r) => r.id === body.sourceId)!;
    expect(row.recipeId).toBeNull();
    expect(row.kind).toBe("image");
    expect(row.fileName).toBe("kort.jpg");
    expect(row.sha256).toBe(createHash("sha256").update(JPEG).digest("hex"));
    expect((await storage().get(row.storageKey)).equals(JPEG)).toBe(true);
  });

  it("returns the shim's draft, with headings tidied out of the ingredients", async () => {
    shimAnswers({
      title: "Kladdkaka",
      servings: 8,
      servingsUnit: "bitar",
      imageUrl: null,
      ingredientLines: ["Smet:", "2 ägg"],
      instructions: ["Rör."],
    });
    const res = await readFile({ data: JPEG_B64, mediaType: "image/jpeg" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: { title: string; ingredientLines: string[] } };
    expect(body.draft.title).toBe("Kladdkaka");
    expect(body.draft.ingredientLines).toEqual(["2 ägg"]);
  });

  it("refuses a type outside the allow-list, and stores nothing", async () => {
    const before = (await sourceRows()).length;
    const res = await readFile({ data: JPEG_B64, mediaType: "image/gif" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Filtypen stöds inte. Välj en bild eller en PDF.",
    );
    expect((await sourceRows()).length).toBe(before);
  });

  it("refuses data that is not base64", async () => {
    const res = await readFile({ data: "inte base64!!", mediaType: "image/jpeg" });
    expect(res.status).toBe(400);
  });

  it("refuses a file over 10 MB with 413, and stores nothing", async () => {
    const before = (await sourceRows()).length;
    const big = Buffer.alloc(10 * 1024 * 1024 + 3).toString("base64");
    const res = await readFile({ data: big, mediaType: "application/pdf" });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("Filen är för stor (max 10 MB).");
    expect((await sourceRows()).length).toBe(before);
  });

  it("writes no row when the file cannot be written", async () => {
    const before = (await sourceRows()).length;
    const restore = setStorageForTests({
      put: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      get: async () => Buffer.alloc(0),
      delete: async () => {},
      list: async () => [],
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await readFile({ data: JPEG_B64, mediaType: "image/jpeg" });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe("Kunde inte spara filen.");
    } finally {
      setStorageForTests(restore);
    }
    expect((await sourceRows()).length).toBe(before);
  });
});

async function freshSource(on = app): Promise<string> {
  shimAnswers(null);
  const res = await readFile({ data: JPEG_B64, mediaType: "image/jpeg" }, on);
  vi.restoreAllMocks();
  return ((await res.json()) as { sourceId: string }).sourceId;
}

describe("POST /recipes/from-file", () => {
  it("saves the draft and attaches the original", async () => {
    const sourceId = await freshSource();
    const res = await saveDraft({ sourceId });
    expect(res.status).toBe(200);
    const recipe = (await res.json()) as {
      id: string;
      title: string;
      sourceUrl: string | null;
      instructions: string[];
      ingredients: unknown[];
      source: { kind: string; mediaType: string } | null;
    };
    expect(recipe.title).toBe("Mormors kladdkaka");
    expect(recipe.sourceUrl).toBeNull();
    expect(recipe.instructions).toEqual(["Rör ihop.", "Grädda."]);
    expect(recipe.ingredients).toHaveLength(2);
    expect(recipe.source).toEqual({ kind: "image", mediaType: "image/jpeg" });

    const [row] = await db.select().from(recipeSources).where(eq(recipeSources.id, sourceId));
    expect(row!.recipeId).toBe(recipe.id);
  });

  it("a second save of the same source is a 409 and creates no second recipe", async () => {
    const sourceId = await freshSource();
    expect((await saveDraft({ sourceId, title: "En gång" })).status).toBe(200);
    const again = await saveDraft({ sourceId, title: "Två gånger" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("Receptet är redan sparat.");
    const twice = await db.select().from(recipes).where(eq(recipes.title, "Två gånger"));
    expect(twice.filter((r) => r.createdBy === ACTOR)).toHaveLength(0);
  });

  it("someone else's source cannot be attached", async () => {
    const sourceId = await freshSource(appFor(OTHER));
    expect((await saveDraft({ sourceId })).status).toBe(409);
  });

  it("says the draft is gone, not saved, when it was pruned before the save", async () => {
    const sourceId = await freshSource();
    await db.delete(recipeSources).where(eq(recipeSources.id, sourceId));
    const res = await saveDraft({ sourceId });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Utkastet finns inte längre. Välj filen igen.",
    );
  });

  it("refuses a draft with no ingredients, as the paste path does", async () => {
    const sourceId = await freshSource();
    const res = await saveDraft({ sourceId, ingredientText: "Deg:\n\n" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Hittade inga ingredienser i texten.");
  });
});

describe("GET /recipes/{id}/source", () => {
  async function savedRecipe() {
    const sourceId = await freshSource();
    const recipe = (await (await saveDraft({ sourceId })).json()) as { id: string };
    return { recipeId: recipe.id, sourceId };
  }

  it("serves the original with its media type", async () => {
    const { recipeId } = await savedRecipe();
    const res = await app.request(`/recipes/${recipeId}/source`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(Buffer.from(await res.arrayBuffer()).equals(JPEG)).toBe(true);
  });

  it("404s with a message when the file is gone from disk", async () => {
    const { recipeId, sourceId } = await savedRecipe();
    const [row] = await db.select().from(recipeSources).where(eq(recipeSources.id, sourceId));
    await storage().delete(row!.storageKey);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await app.request(`/recipes/${recipeId}/source`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("Originalet finns inte.");
    // The recipe itself still loads.
    expect((await app.request(`/recipes/${recipeId}`)).status).toBe(200);
  });

  it("404s for a recipe with no original", async () => {
    const res = await app.request(`/recipes/${randomUUID()}/source`);
    expect(res.status).toBe(404);
  });
});

describe("POST /recipes/paste keeps what was pasted", () => {
  it("stores the pasted text as the recipe's original", async () => {
    const text = "3 dl mjöl\n2 ägg";
    const res = await app.request("/recipes/paste", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Pannkakor", servings: 4, text }),
    });
    expect(res.status).toBe(200);
    const recipe = (await res.json()) as { id: string; source: { kind: string } | null };
    expect(recipe.source).toEqual({ kind: "text", mediaType: "text/plain; charset=utf-8" });

    const source = await app.request(`/recipes/${recipe.id}/source`);
    expect(await source.text()).toBe(text);
  });
});

describe("a shared file", () => {
  it("is read from its share token, and the token is spent", async () => {
    shimAnswers(null);
    const shareToken = putSharedFile({ data: JPEG_B64, mediaType: "application/pdf", actor: ACTOR });
    const res = await readFile({ shareToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sourceId: string; kind: string };
    expect(body.kind).toBe("pdf");
    expect((await readFile({ shareToken })).status).toBe(404);
  });

  it("is a 404 with a message when the share is gone", async () => {
    const res = await readFile({ shareToken: "made-up" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("Den delade filen är borta. Dela den igen.");
  });

  it("can be looked at by its owner while it is still a draft, and by nobody else", async () => {
    const sourceId = await freshSource();
    const mine = await app.request(`/recipes/sources/${sourceId}`);
    expect(mine.status).toBe(200);
    expect(Buffer.from(await mine.arrayBuffer()).equals(JPEG)).toBe(true);
    expect((await appFor(OTHER).request(`/recipes/sources/${sourceId}`)).status).toBe(404);
  });
});

describe("paste when the disk will not take the original", () => {
  it("still saves the recipe, without an original", async () => {
    const restore = setStorageForTests({
      put: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      get: async () => Buffer.alloc(0),
      delete: async () => {},
      list: async () => [],
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.request("/recipes/paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Pannkakor utan original", servings: 4, text: "3 dl mjöl" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { source: unknown }).source).toBeNull();
    } finally {
      setStorageForTests(restore);
    }
  });
});
