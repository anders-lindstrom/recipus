"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fileToParseInput, RECIPE_MAX_EDGE } from "@/lib/client/image-file";
import {
  checkFile,
  draftToForm,
  errorMessage,
  formToRequest,
  type RecipeDraft,
  type ReviewForm,
} from "./recipe-file-model";
import { UiIcon } from "./ui-icon";

/**
 * A recipe from one photo, screenshot or PDF: pick it, wait while it is read,
 * check what was read beside the original, save.
 *
 * The file is stored by the server the moment it arrives, before anything is
 * read, so a read that fails still opens the review — empty, next to the
 * original — and nothing the household chose to keep is lost to a model that
 * could not read handwriting. See
 * docs/superpowers/specs/2026-11-16-recipe-file-import-design.md §5.3–5.4.
 */

type Phase =
  | { at: "pick" }
  | { at: "reading" }
  | { at: "review"; sourceId: string; read: boolean };

interface Original {
  kind: "image" | "pdf";
  url: string;
}

interface ReadOutcome {
  sourceId: string;
  kind: "image" | "pdf";
  draft: RecipeDraft | null;
}

/** Plain async, no React state — so the share effect can call it safely. */
async function postRead(body: unknown): Promise<ReadOutcome | { error: string }> {
  try {
    const res = await fetch("/api/recipes/read-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as ReadOutcome | null;
    if (!res.ok || !json) return { error: errorMessage(json, "Kunde inte ladda upp filen.") };
    return json;
  } catch {
    return { error: "Kunde inte ladda upp filen. Är du ansluten?" };
  }
}

/** A PDF as raw base64, no data-URL prefix — what the API takes. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const FIELD =
  "w-full rounded-card border border-line bg-surface-raised px-3.5 py-3 text-body text-ink outline-none placeholder:text-ink-faint";
const PRIMARY =
  "flex w-full items-center justify-center gap-2 rounded-card bg-brand py-3.5 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.99] disabled:opacity-40";

export interface RecipeFileImportProps {
  /** A PDF or photo shared into the app, parked by `/dela` under this token. */
  initialShareToken?: string;
}

export function RecipeFileImport({ initialShareToken }: RecipeFileImportProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(() =>
    initialShareToken ? { at: "reading" } : { at: "pick" },
  );
  const [original, setOriginal] = useState<Original | null>(null);
  const [form, setForm] = useState<ReviewForm>(() => draftToForm(null));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shareTried = useRef(false);

  // A blob URL holds the file in memory until revoked.
  useEffect(() => {
    return () => {
      if (original?.url.startsWith("blob:")) URL.revokeObjectURL(original.url);
    };
  }, [original]);

  function arrive(outcome: ReadOutcome) {
    setForm(draftToForm(outcome.draft));
    setPhase({ at: "review", sourceId: outcome.sourceId, read: outcome.draft !== null });
  }

  async function pick(file: File) {
    const check = checkFile(file);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setError("");
    setPhase({ at: "reading" });
    let body: { data: string; mediaType: string; fileName: string };
    try {
      body =
        check.kind === "image"
          ? { ...(await fileToParseInput(file, RECIPE_MAX_EDGE)), fileName: file.name }
          : { data: await readAsBase64(file), mediaType: "application/pdf", fileName: file.name };
    } catch {
      setPhase({ at: "pick" });
      setError("Kunde inte läsa filen.");
      return;
    }
    setOriginal({ kind: check.kind, url: URL.createObjectURL(file) });
    const outcome = await postRead(body);
    if ("error" in outcome) {
      setPhase({ at: "pick" });
      setError(outcome.error);
      return;
    }
    arrive(outcome);
  }

  // A shared file reads itself, once, the way a shared link imports itself.
  // State is only touched from inside the `.then`, behind `cancelled`.
  useEffect(() => {
    if (!initialShareToken || shareTried.current) return;
    shareTried.current = true;
    let cancelled = false;
    void postRead({ shareToken: initialShareToken }).then((outcome) => {
      if (cancelled) return;
      if ("error" in outcome) {
        setPhase({ at: "pick" });
        setError(outcome.error);
        return;
      }
      // No local copy of a shared file: show the stored one.
      setOriginal({ kind: outcome.kind, url: `/api/recipes/sources/${outcome.sourceId}` });
      arrive(outcome);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(sourceId: string) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/recipes/from-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formToRequest(form, sourceId)),
      });
      const json = (await res.json().catch(() => null)) as { id?: string; title?: string } | null;
      if (res.status === 409) {
        // Saved already — by a double tap, or a second tab. The recipe exists.
        toast(errorMessage(json, "Receptet är redan sparat."));
        router.push("/recept");
        return;
      }
      if (!res.ok || !json?.id) {
        // Including a draft pruned while the form stood open (404): the form
        // stays, so what was typed can be copied before choosing the file again.
        setError(errorMessage(json, "Kunde inte spara receptet."));
        return;
      }
      toast(`${json.title} sparat`);
      router.push(`/recept/${json.id}`);
    } catch {
      setError("Kunde inte spara receptet. Är du ansluten?");
    } finally {
      setSaving(false);
    }
  }

  const set = <K extends keyof ReviewForm>(key: K, value: ReviewForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <section className="mt-7 border-t border-line pt-5" aria-labelledby="file-import-heading">
      <h2 id="file-import-heading" className="text-title text-ink">
        Från bild eller PDF
      </h2>

      {phase.at === "pick" && (
        <>
          <p className="mt-1 max-w-[42ch] text-body-sm text-ink-soft">
            Fotografera en kokbokssida eller ett receptkort, eller välj en skärmdump eller PDF.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            aria-label="Välj bild eller PDF"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void pick(file);
            }}
          />
          <button type="button" onClick={() => inputRef.current?.click()} className={`mt-4 ${PRIMARY}`}>
            <UiIcon name="upload" size={17} />
            Välj bild eller PDF
          </button>
        </>
      )}

      {phase.at === "reading" && (
        <p className="mt-4 flex items-center gap-2 text-body text-ink-soft" role="status">
          <UiIcon name="spinner" size={17} className="animate-spin" />
          Läser receptet … det kan ta upp till en minut.
        </p>
      )}

      {phase.at === "review" && (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save(phase.sourceId);
          }}
        >
          {!phase.read && (
            <p className="mb-4 rounded-card border border-line bg-surface-raised p-3 text-body-sm text-ink-soft">
              Kunde inte läsa receptet — skriv in det bredvid originalet.
            </p>
          )}

          {original && <OriginalPreview original={original} />}

          <label className="mt-4 flex flex-col gap-1.5">
            <span className="text-overline text-ink-faint uppercase">Titel</span>
            <input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Mormors kladdkaka"
              type="text"
              autoCapitalize="sentences"
              className={FIELD}
            />
          </label>

          <div className="mt-4 flex gap-3">
            <label className="flex w-24 flex-col gap-1.5">
              <span className="text-overline text-ink-faint uppercase">Antal</span>
              <input
                value={form.servings}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n > 0 && n <= 999) set("servings", n);
                }}
                type="number"
                inputMode="decimal"
                min={1}
                max={999}
                className={FIELD}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-overline text-ink-faint uppercase">Enhet</span>
              <input
                value={form.servingsUnit}
                onChange={(e) => set("servingsUnit", e.target.value)}
                placeholder="portioner"
                type="text"
                className={FIELD}
              />
            </label>
          </div>

          <label className="mt-4 flex flex-col gap-1.5">
            <span className="text-overline text-ink-faint uppercase">Ingredienser, en per rad</span>
            <textarea
              value={form.ingredientText}
              onChange={(e) => set("ingredientText", e.target.value)}
              rows={8}
              placeholder={"3 dl mjöl\n6 dl mjölk\n3 ägg"}
              autoCapitalize="off"
              spellCheck={false}
              className={`resize-y ${FIELD}`}
            />
          </label>

          <label className="mt-4 flex flex-col gap-1.5">
            <span className="text-overline text-ink-faint uppercase">Gör så här, ett steg per rad</span>
            <textarea
              value={form.stepsText}
              onChange={(e) => set("stepsText", e.target.value)}
              rows={6}
              className={`resize-y ${FIELD}`}
            />
          </label>

          <button
            type="submit"
            disabled={saving || form.title.trim() === "" || form.ingredientText.trim() === ""}
            className={`mt-4 ${PRIMARY}`}
          >
            {saving ? (
              <>
                <UiIcon name="spinner" size={17} className="animate-spin" />
                Sparar receptet…
              </>
            ) : (
              <>
                <UiIcon name="check" size={17} />
                Spara receptet
              </>
            )}
          </button>
        </form>
      )}

      {/* Always mounted, so the message is announced when it arrives. */}
      <div role="alert">
        {error && (
          <p className="mt-4 rounded-card border border-line bg-danger-tint p-3 text-body-sm font-semibold text-danger">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function OriginalPreview({ original }: { original: Original }) {
  if (original.kind === "pdf") {
    return (
      <a
        href={original.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 text-body-sm font-semibold text-brand"
      >
        <UiIcon name="external" size={15} />
        Öppna PDF:en
      </a>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a local blob or a private API route; next/image would only get in the way
    <img
      src={original.url}
      alt="Originalet"
      className="max-h-80 w-full rounded-card border border-line bg-surface-raised object-contain"
    />
  );
}
