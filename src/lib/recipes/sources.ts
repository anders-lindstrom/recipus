/**
 * What a recipe may be read from, and how big it may be. Shared by the upload
 * route, the share target and the browser's own check, so the three cannot
 * disagree about what is accepted.
 */

export type SourceKind = "image" | "pdf" | "text";

/** A `Map`, not an object literal: `"__proto__"` must not look like a type. */
export const SOURCE_MEDIA_TYPES: ReadonlyMap<string, { kind: "image" | "pdf"; ext: string }> =
  new Map([
    ["image/jpeg", { kind: "image", ext: "jpg" }],
    ["image/png", { kind: "image", ext: "png" }],
    ["image/webp", { kind: "image", ext: "webp" }],
    ["application/pdf", { kind: "pdf", ext: "pdf" }],
  ]);

/** 10 MB of file, before base64. The shim's body limit is sized to fit it. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
