import { describe, expect, it, vi } from "vitest";

/**
 * What the share target does with a photo that is too big to park.
 *
 * The picker path shrinks an image before it uploads; a share does not pass
 * through that, so whatever another app hands over arrives whole and sits in
 * `shareInbox`, which counts slots and not bytes. This pins the ceiling and,
 * just as importantly, where an oversized file goes: to a plain list, not to
 * the recipe importer, which is where the fall-through would send it once a
 * shared image arrives with a title attached — as they usually do.
 *
 * Authentication is mocked away because it is not what is under test here.
 */

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({
  AuthError: class AuthError extends Error {},
  authenticate: () => ({ autheliaUser: "anders" }),
}));

const { POST } = await import("./route");

function share(bytes: number, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set(
    "image",
    new File([new Uint8Array(bytes)], "lista.jpg", { type: "image/jpeg" }),
  );
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return POST(new Request("http://localhost/dela", { method: "POST", body: form }));
}

describe("POST /dela", () => {
  it("parks an ordinary screenshot and sends the dialog its token", async () => {
    const res = await share(64 * 1024);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toMatch(/^\/\?ai=share&t=.+/);
  });

  it("drops a photo over the cap on the list rather than into the dialog", async () => {
    const res = await share(7 * 1024 * 1024, { title: "Skärmbild" });

    expect(res.status).toBe(303);
    // Plain "/" — not the recipe importer the title would otherwise reach.
    expect(res.headers.get("Location")).toBe("/");
  });
});
