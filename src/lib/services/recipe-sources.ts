import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recipeSources } from "@/db/schema";
import { MAX_SOURCE_BYTES, SOURCE_MEDIA_TYPES, type SourceKind } from "@/lib/recipes/sources";
import { storage } from "@/lib/storage";

/**
 * The file a recipe was read from: written to disk, recorded in
 * `recipe_sources`, attached to its recipe once the household saves it.
 *
 * File first, row second, always. A crash between the two leaves a file with no
 * row — harmless, and swept by the prune job — never a row pointing at nothing.
 * See docs/superpowers/specs/2026-11-16-recipe-file-import-design.md §5.2.
 */

/** A file the household tried to give us that we will not keep. */
export class SourceRejectedError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
  }
}

/** The disk would not take the file. A 500 to the caller, never a missing row. */
export class SourceStorageError extends Error {}

/** The source is attached already, or is not this person's to attach. */
export class SourceTakenError extends Error {}

/** The draft's source is gone — pruned after a day — so there is nothing to attach. */
export class SourceGoneError extends Error {}

export const TEXT_MEDIA_TYPE = "text/plain; charset=utf-8";

/** The base64 alphabet, with optional padding, and nothing else. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode, refusing what `Buffer.from` would silently mangle: it skips
 * characters outside the alphabet rather than failing, which would store a
 * truncated file and say nothing.
 */
export function decodeBase64(data: string): Buffer {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
    throw new SourceRejectedError(400, "Filen kunde inte läsas.");
  }
  return Buffer.from(data, "base64");
}

/** Throws `SourceRejectedError` for a type or size we do not keep. */
export function checkSourceFile(mediaType: string, byteSize: number): { kind: "image" | "pdf"; ext: string } {
  const type = SOURCE_MEDIA_TYPES.get(mediaType);
  if (!type) throw new SourceRejectedError(400, "Filtypen stöds inte. Välj en bild eller en PDF.");
  if (byteSize > MAX_SOURCE_BYTES) throw new SourceRejectedError(413, "Filen är för stor (max 10 MB).");
  return type;
}

interface StoredFile {
  storageKey: string;
  sha256: string;
  byteSize: number;
}

/** Puts the bytes on disk under a key of our own making. */
async function storeFile(bytes: Buffer, ext: string): Promise<StoredFile> {
  // The extension comes from the allow-list, never from the uploaded name.
  const storageKey = `sources/${randomUUID()}.${ext}`;
  try {
    await storage().put(storageKey, bytes);
  } catch (err) {
    console.error(`[recipe-sources] could not write ${storageKey}:`, err);
    throw new SourceStorageError("Kunde inte spara filen.");
  }
  return {
    storageKey,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
  };
}

/**
 * A file on its way to becoming a recipe: stored, recorded, attached to nothing
 * yet. Returns the id the review screen hands back when it saves.
 */
export async function saveFileSource(input: {
  bytes: Buffer;
  mediaType: string;
  fileName: string | null;
  actor: string;
}): Promise<{ id: string; kind: "image" | "pdf" }> {
  const { kind, ext } = checkSourceFile(input.mediaType, input.bytes.length);
  const file = await storeFile(input.bytes, ext);
  const id = randomUUID();
  try {
    await db.insert(recipeSources).values({
      id,
      recipeId: null,
      kind,
      mediaType: input.mediaType,
      ...file,
      fileName: input.fileName,
      createdBy: input.actor,
    });
  } catch (err) {
    // Best effort: the file would otherwise wait a day for the prune job.
    await storage().delete(file.storageKey).catch(() => {});
    throw err;
  }
  return { id, kind };
}

/** What a transaction handle looks like here, without naming drizzle's internals. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Attaches a draft's source to the recipe made from it, inside the caller's
 * transaction. Only a source still unattached and created by this actor moves,
 * so a double-tapped "Spara" attaches once; anything but `"attached"` tells
 * the caller to roll back the recipe it was about to create.
 */
export async function attachSource(
  tx: Tx,
  sourceId: string,
  recipeId: string,
  actor: string,
): Promise<"attached" | "taken" | "gone"> {
  const rows = await tx
    .update(recipeSources)
    .set({ recipeId })
    .where(
      and(eq(recipeSources.id, sourceId), isNull(recipeSources.recipeId), eq(recipeSources.createdBy, actor)),
    )
    .returning({ id: recipeSources.id });
  if (rows.length === 1) return "attached";
  // Told apart because the two need different answers: "saved already" sends
  // the household to the recipe; "gone" must keep the form they typed.
  const [exists] = await tx
    .select({ id: recipeSources.id })
    .from(recipeSources)
    .where(eq(recipeSources.id, sourceId))
    .limit(1);
  return exists ? "taken" : "gone";
}

/**
 * Pasted text kept as the recipe's original. The file is written before the
 * transaction (disk cannot roll back); the returned row goes in with the recipe.
 */
export async function storeTextSource(text: string, actor: string) {
  const file = await storeFile(Buffer.from(text, "utf8"), "txt");
  return {
    id: randomUUID(),
    kind: "text" as SourceKind,
    mediaType: TEXT_MEDIA_TYPE,
    ...file,
    fileName: null,
    createdBy: actor,
  };
}

export interface SourceSummary {
  kind: SourceKind;
  mediaType: string;
}

/** The kind of original a recipe has, if any — what the recipe screen needs. */
export async function sourceSummaryFor(recipeId: string): Promise<SourceSummary | null> {
  const [row] = await db
    .select({ kind: recipeSources.kind, mediaType: recipeSources.mediaType })
    .from(recipeSources)
    .where(eq(recipeSources.recipeId, recipeId))
    .orderBy(recipeSources.createdAt)
    .limit(1);
  return row ?? null;
}

/**
 * The original's bytes, or `"missing"` when the row exists and the file does
 * not — a restore that brought back the database but not the folder. Logged,
 * because nobody else will notice.
 */
export async function loadSourceFor(
  recipeId: string,
): Promise<{ mediaType: string; bytes: Buffer } | "missing" | null> {
  const [row] = await db
    .select()
    .from(recipeSources)
    .where(eq(recipeSources.recipeId, recipeId))
    .orderBy(recipeSources.createdAt)
    .limit(1);
  if (!row) return null;
  try {
    return { mediaType: row.mediaType, bytes: await storage().get(row.storageKey) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    console.error(`[recipe-sources] ${row.storageKey} is recorded for recipe ${recipeId} but missing on disk`);
    return "missing";
  }
}
