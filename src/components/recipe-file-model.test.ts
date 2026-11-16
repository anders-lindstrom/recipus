import { describe, expect, it } from "vitest";
import { checkFile, draftToForm, errorMessage, formToRequest } from "./recipe-file-model";

const MB = 1024 * 1024;

describe("checkFile", () => {
  it("takes a PDF of exactly 10 MB", () => {
    expect(checkFile({ type: "application/pdf", size: 10 * MB })).toEqual({ ok: true, kind: "pdf" });
  });

  it("refuses a PDF one byte over 10 MB, saying the limit", () => {
    expect(checkFile({ type: "application/pdf", size: 10 * MB + 1 })).toEqual({
      ok: false,
      message: "Filen är för stor (max 10 MB).",
    });
  });

  it("takes any image, because it is re-encoded to JPEG before it leaves", () => {
    // An iPhone photo is HEIC; the canvas turns it into a JPEG, so its own
    // type and size are not what gets sent.
    expect(checkFile({ type: "image/heic", size: 30 * MB })).toEqual({ ok: true, kind: "image" });
  });

  it("refuses what is neither an image nor a PDF", () => {
    expect(checkFile({ type: "text/plain", size: 10 })).toEqual({
      ok: false,
      message: "Filtypen stöds inte. Välj en bild eller en PDF.",
    });
  });
});

describe("draftToForm", () => {
  it("starts empty, in portioner, when nothing could be read", () => {
    expect(draftToForm(null)).toEqual({
      title: "",
      servings: 4,
      servingsUnit: "portioner",
      ingredientText: "",
      stepsText: "",
    });
  });

  it("puts one ingredient and one step per line", () => {
    expect(
      draftToForm({
        title: "Kladdkaka",
        servings: 8,
        servingsUnit: "bitar",
        ingredientLines: ["2 ägg", "2 dl socker"],
        instructions: ["Rör.", "Grädda."],
      }),
    ).toEqual({
      title: "Kladdkaka",
      servings: 8,
      servingsUnit: "bitar",
      ingredientText: "2 ägg\n2 dl socker",
      stepsText: "Rör.\nGrädda.",
    });
  });
});

describe("formToRequest", () => {
  it("splits the steps on lines and drops the blank ones", () => {
    expect(
      formToRequest(
        { title: " Kladdkaka ", servings: 8, servingsUnit: "", ingredientText: "2 ägg", stepsText: "Rör.\n\n  Grädda. \n" },
        "src-1",
      ),
    ).toEqual({
      sourceId: "src-1",
      title: "Kladdkaka",
      servings: 8,
      servingsUnit: "portioner",
      ingredientText: "2 ägg",
      instructions: ["Rör.", "Grädda."],
    });
  });
});

describe("draftToForm keeps a long read inside what the save accepts", () => {
  it("caps the title, the step count and each step, and fixes a servings of nothing", () => {
    const form = draftToForm({
      title: "x".repeat(300),
      servings: 0,
      servingsUnit: "y".repeat(80),
      ingredientLines: ["2 ägg"],
      instructions: Array.from({ length: 80 }, (_, i) => (i === 0 ? "z".repeat(2500) : `Steg ${i}`)),
    });
    expect(form.title).toHaveLength(200);
    expect(form.servings).toBe(4);
    expect(form.servingsUnit).toHaveLength(40);
    const steps = form.stepsText.split("\n");
    expect(steps).toHaveLength(60);
    expect(steps[0]).toHaveLength(2000);
  });
});

describe("errorMessage", () => {
  it("passes a string error through", () => {
    expect(errorMessage({ error: "Filen är för stor (max 10 MB)." }, "fallback")).toBe("Filen är för stor (max 10 MB).");
  });

  it("falls back on a validation error, which is an object and cannot be shown", () => {
    // zod-openapi answers 400 with {success:false, error:{name:"ZodError",…}}.
    expect(errorMessage({ success: false, error: { name: "ZodError" } }, "Kunde inte spara receptet.")).toBe(
      "Kunde inte spara receptet.",
    );
    expect(errorMessage(null, "x")).toBe("x");
  });
});
