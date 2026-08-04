import { describe, expect, it } from "vitest";
import { buildMatchCandidates } from "@/lib/ingredients";
import { interpretUtterance } from "./interpret";
import { dedupeResolutions, resolveSpokenItems } from "./resolve";

/**
 * Spoken words against the household's vocabulary.
 *
 * The case that matters most is the English one. Alexa has no Swedish locale —
 * Amazon supports 17 and sv-SE is not among them — so an Echo in this house
 * speaks English at a catalog that is entirely Swedish. The bridge is
 * `catalog_item_aliases`, the same table that keeps a merged-away word
 * resolving, and these tests are what prove the voice path actually consults
 * it. `resolveQuery` (the add bar's matcher) does NOT, which is why this layer
 * uses `matchIngredient` instead.
 */
describe("resolveSpokenItems", () => {
  const items = [
    { id: "mjolk", nameNorm: "mjolk" },
    { id: "brod", nameNorm: "brod" },
    { id: "gradde", nameNorm: "gradde" },
    { id: "vispgradde", nameNorm: "vispgradde" },
  ];
  const aliases = [
    { itemId: "mjolk", aliasNorm: "milk" },
    { itemId: "brod", aliasNorm: "bread" },
    { itemId: "gradde", aliasNorm: "cream" },
    { itemId: "vispgradde", aliasNorm: "whipping cream" },
  ];
  const candidates = buildMatchCandidates(items, aliases);

  const resolveSpeech = (raw: string) =>
    resolveSpokenItems(interpretUtterance(raw), candidates);

  it("reaches a Swedish vara from a Swedish word", () => {
    const [r] = resolveSpeech("lägg till mjölk");
    expect(r).toMatchObject({ status: "matched", catalogItemId: "mjolk" });
  });

  it("reaches a Swedish vara from an English word, through an alias", () => {
    // The entire English half of this feature, in one assertion.
    const [r] = resolveSpeech("add milk");
    expect(r).toMatchObject({ status: "matched", catalogItemId: "mjolk" });
  });

  it("keeps a compound alias off the generic vara", () => {
    // grädde, vispgrädde and matlagningsgrädde are three varor the catalog
    // deliberately keeps apart, because they are not interchangeable at the
    // stove. "whipping cream" must not land on plain grädde.
    const [whipping] = resolveSpeech("add whipping cream");
    expect(whipping).toMatchObject({ catalogItemId: "vispgradde" });
    const [plain] = resolveSpeech("add cream");
    expect(plain).toMatchObject({ catalogItemId: "gradde" });
  });

  it("carries the quantity through to the match", () => {
    const [r] = resolveSpeech("add 2 l milk");
    expect(r.spoken.amount).toEqual({ value: 2, unit: "l" });
  });

  it("reports a word it cannot reach rather than inventing a vara", () => {
    /*
     * The rule this whole layer is built around. The add bar already refuses to
     * let a fuzzy match decide a word is new — a typo that resolves is
     * recoverable, one that creates a 343rd catalog item is permanent — and
     * speech is far noisier than a thumb with no screen to catch it on.
     */
    const [r] = resolveSpeech("add schnozzberries");
    expect(r.status).toBe("unknown");
    expect(r.spoken.said).toBe("schnozzberries");
  });

  it("resolves each half of a spoken pair independently", () => {
    const out = resolveSpeech("add milk and bread");
    expect(out.map((r) => r.status === "matched" && r.catalogItemId)).toEqual([
      "mjolk",
      "brod",
    ]);
  });

  it("mixes matched and unmatched in one utterance", () => {
    const out = resolveSpeech("add milk and schnozzberries");
    expect(out[0]).toMatchObject({ status: "matched", catalogItemId: "mjolk" });
    expect(out[1]).toMatchObject({ status: "unknown" });
  });
});

describe("dedupeResolutions", () => {
  const spoken = (said: string) => ({ name: said, amount: null, said });

  it("folds two phrases that reach one vara into a single add", () => {
    // A list entry is (listId, catalogItemId) and a vara appears at most once
    // per list, so the second op is a no-op the caller would then report as a
    // second add.
    const out = dedupeResolutions([
      { status: "matched", spoken: spoken("milk"), catalogItemId: "mjolk", score: 1 },
      { status: "matched", spoken: spoken("mjölk"), catalogItemId: "mjolk", score: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.spoken.said).toBe("milk");
  });

  it("keeps the first occurrence, which is the one that gets said back", () => {
    const out = dedupeResolutions([
      {
        status: "matched",
        spoken: { name: "milk", amount: { value: 2, unit: "l" }, said: "2 l milk" },
        catalogItemId: "mjolk",
        score: 1,
      },
      { status: "matched", spoken: spoken("milk"), catalogItemId: "mjolk", score: 1 },
    ]);
    expect(out[0]!.spoken.amount).toEqual({ value: 2, unit: "l" });
  });

  it("never folds unmatched phrases together", () => {
    // Two things it could not find are two things to report, even if they
    // sounded alike — the household needs to hear both.
    const out = dedupeResolutions([
      { status: "unknown", spoken: spoken("quinoa") },
      { status: "unknown", spoken: spoken("quinoa") },
    ]);
    expect(out).toHaveLength(2);
  });
});
