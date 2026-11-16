/**
 * The pure half of importing a recipe from a photo or PDF: what the browser
 * accepts before uploading, and how a draft becomes a form and back.
 *
 * The limits are the server's (`src/lib/recipes/sources.ts`), imported rather
 * than restated, so a file the browser lets through is one the server takes.
 */

import { MAX_SOURCE_BYTES } from "@/lib/recipes/sources";

export type FileCheck = { ok: true; kind: "image" | "pdf" } | { ok: false; message: string };

/**
 * Whether to upload this file at all.
 *
 * Any image passes, whatever its type or size: it is re-encoded to a JPEG of at
 * most 2400 px before it is sent (`fileToParseInput`), so an iPhone HEIC photo
 * arrives as something the server accepts. A PDF goes as it is, so its size is
 * the size that will be sent.
 */
export function checkFile(file: { type: string; size: number }): FileCheck {
  if (file.type.startsWith("image/")) return { ok: true, kind: "image" };
  if (file.type === "application/pdf") {
    return file.size <= MAX_SOURCE_BYTES
      ? { ok: true, kind: "pdf" }
      : { ok: false, message: "Filen är för stor (max 10 MB)." };
  }
  return { ok: false, message: "Filtypen stöds inte. Välj en bild eller en PDF." };
}

export interface RecipeDraft {
  title: string;
  servings: number;
  servingsUnit: string;
  ingredientLines: string[];
  instructions: string[];
}

/** The review form: text fields, one ingredient and one step per line. */
export interface ReviewForm {
  title: string;
  servings: number;
  servingsUnit: string;
  ingredientText: string;
  stepsText: string;
}

const DEFAULT_UNIT = "portioner";

/** A draft the shim read, or an empty form beside the original when it read nothing. */
export function draftToForm(draft: RecipeDraft | null): ReviewForm {
  if (!draft) {
    return { title: "", servings: 4, servingsUnit: DEFAULT_UNIT, ingredientText: "", stepsText: "" };
  }
  // Kept inside what POST /from-file accepts (title 200, unit 40, 60 steps of
  // 2000): a 20-page PDF can read longer than that, and a draft the save then
  // refuses is a form the household cannot get past.
  return {
    title: draft.title.slice(0, 200),
    servings: draft.servings > 0 && draft.servings <= 999 ? draft.servings : 4,
    servingsUnit: draft.servingsUnit.slice(0, 40),
    ingredientText: draft.ingredientLines.join("\n").slice(0, 20_000),
    stepsText: draft.instructions
      .slice(0, 60)
      .map((step) => step.slice(0, 2000))
      .join("\n"),
  };
}

/**
 * The message in an error body, or `fallback`.
 *
 * Our own errors are `{error: string}`, but a request that fails validation is
 * answered by zod-openapi with `{success: false, error: {…}}` — an object, and
 * rendering an object as a React child throws, taking the reviewed form with it.
 */
export function errorMessage(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : fallback;
}

/** The body for `POST /api/recipes/from-file`. */
export function formToRequest(form: ReviewForm, sourceId: string) {
  return {
    sourceId,
    title: form.title.trim(),
    servings: form.servings,
    servingsUnit: form.servingsUnit.trim() || DEFAULT_UNIT,
    ingredientText: form.ingredientText,
    instructions: form.stepsText
      .split("\n")
      .map((step) => step.trim())
      .filter((step) => step.length > 0),
  };
}
