"use client";

/** The long edge a photo is shrunk to. See `fitWithin`'s own comment. */
const MAX_EDGE = 1600;
const QUALITY = 0.8;

/**
 * The size a photo is shrunk to before it is uploaded.
 *
 * A modern phone screenshot is 12 megapixels of a list containing perhaps forty
 * words. Sending it whole costs the shopper's uplink and the prompt's budget
 * for nothing — the text is legible far below that. Pure and separately tested;
 * the canvas that applies it is below.
 */
export function fitWithin(
  w: number,
  h: number,
  max: number,
): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h };
  const scale = max / longest;
  // Never zero: a canvas of width 0 throws, and a sliver of an image is still
  // an image.
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * A picked or shared photo, small enough to send from a phone.
 *
 * Always re-encoded to JPEG, whatever came in: a PNG screenshot of a shopping
 * list is several megabytes of losslessly-encoded flat colour, and the model
 * reads the JPEG exactly as well. The arithmetic is `fitWithin`, which is pure
 * and tested; this is the canvas around it.
 */
export async function fileToParseInput(
  file: File,
): Promise<{ data: string; mediaType: "image/jpeg" }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Kunde inte läsa bilden.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
  // Strip "data:image/jpeg;base64," — the API takes raw base64.
  return {
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    mediaType: "image/jpeg",
  };
}
