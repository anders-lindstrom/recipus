import { headers } from "next/headers";
import { AuthError, authenticate } from "@/lib/auth";
import { putSharedImage } from "@/lib/services/share-inbox";

/**
 * The one share target, triaging what was shared.
 *
 * A manifest may declare exactly one `share_target`, and images require
 * `method: "POST"` with `multipart/form-data`. That would have cost the recipe
 * importer its own GET target, so both now arrive here and are sent onward: a
 * file to the list's AI dialog, a link to the recipe importer, which keeps
 * working exactly as it did.
 *
 * A route handler rather than the service worker, deliberately. The first
 * design put this in `sw.js`'s fetch handler with the file stashed in
 * IndexedDB, and `sw.js`'s own comments explain why that is the wrong place for
 * a rarely-run code path: a bad worker is "a self-inflicted,
 * unrecoverable-from-inside state" because the app's code never runs to fix it.
 * This can be tested, deployed and rolled back like any other route, and it
 * works the first time the app is installed, before any worker is active.
 *
 * 303 rather than 302: the share arrives as POST, and only 303 tells the
 * browser to follow it with GET. A 302 re-POSTs to a page that cannot take it.
 */

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);

function seeOther(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path } });
}

export async function POST(request: Request): Promise<Response> {
  // Who shared it, so `takeSharedImage` can refuse to hand the image to anybody
  // else. A share from a lapsed session goes to the app, which shows its own
  // signed-out banner over a working offline list — far better than an error
  // page at the end of a share.
  let actor: string | null = null;
  try {
    actor = authenticate(await headers()).autheliaUser;
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return seeOther("/");
  }

  const file = form.get("image");
  if (actor && file instanceof File && file.size > 0 && ACCEPTED.has(file.type)) {
    const data = Buffer.from(await file.arrayBuffer()).toString("base64");
    const token = putSharedImage({ data, mediaType: file.type, actor });
    return seeOther(`/?ai=share&t=${encodeURIComponent(token)}`);
  }

  // Not a file — the recipe importer's existing GET contract, rebuilt from the
  // form fields. It already pulls a URL out of a sentence in `text`, so both
  // are passed through untouched.
  const url = typeof form.get("url") === "string" ? String(form.get("url")) : "";
  const text = typeof form.get("text") === "string" ? String(form.get("text")) : "";
  const title = typeof form.get("title") === "string" ? String(form.get("title")) : "";
  if (url || text || title) {
    const params = new URLSearchParams();
    if (url) params.set("url", url);
    if (text) params.set("text", text);
    if (title) params.set("title", title);
    return seeOther(`/recept/importera?${params.toString()}`);
  }

  return seeOther("/");
}
