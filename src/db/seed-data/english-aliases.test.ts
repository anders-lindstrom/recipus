import { describe, expect, it } from "vitest";
import { normalizeName, slugify } from "@/lib/utils";
import { CATALOG_ITEMS } from "./catalog";
import { ENGLISH_ALIASES } from "./english-aliases";

/**
 * The invariants an alias table has to hold, checked by execution rather than
 * by trusting the pass that generated it.
 *
 * An alias is a word that silently redirects a shopping instruction. Getting
 * one wrong does not throw, does not warn, and is discovered in a shop holding
 * the wrong thing — so every rule that can be mechanically checked is checked
 * here.
 */
describe("ENGLISH_ALIASES", () => {
  const byName = new Map(CATALOG_ITEMS.map((i) => [i.name, i]));
  const entries = Object.entries(ENGLISH_ALIASES);

  it("names only varor that exist", () => {
    // A rename in catalog.ts that orphans a key must fail the build rather than
    // silently dropping the English word for that vara.
    const orphans = entries.map(([name]) => name).filter((name) => !byName.has(name));
    expect(orphans).toEqual([]);
  });

  it("never aliases a word that names a DIFFERENT vara", () => {
    /*
     * The failure the first generated pass made forty-one times, because for a
     * great many groceries the Swedish word IS the English word: lime, mango,
     * salt, pasta, chips, yoghurt, bacon. Such a row shadows the catalog row it
     * collides with — the matcher scores a flat candidate list and has no way
     * to prefer the real vara over an alias pointing somewhere else.
     *
     * "Different" is the whole test. An alias that folds onto the name of the
     * vara it ALREADY points at is redundant, not dangerous: `normalizeName`
     * strips diacritics, so "apple" and "äpple" are the same string, and the
     * candidate list then holds two identical entries with the same target.
     * `matchIngredient` documents that case explicitly — "equal ids can occur…
     * either answer is the same answer" — so it costs one row and changes
     * nothing. Rejecting it would mean deleting the English spelling of äpple,
     * which is the one an English speaker actually says.
     */
    const varaByNorm = new Map(CATALOG_ITEMS.map((i) => [normalizeName(i.name), i.name]));
    const collisions: string[] = [];
    for (const [vara, aliases] of entries) {
      for (const alias of aliases) {
        const owner = varaByNorm.get(normalizeName(alias));
        if (owner !== undefined && owner !== vara) {
          collisions.push(`"${alias}" on ${vara} is the name of ${owner}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it("never points one word at two different varor", () => {
    // `catalog_item_aliases.alias_norm` is the PRIMARY KEY, so two rows wanting
    // the same word is not a merge problem to resolve later — it is a seed that
    // cannot be inserted.
    const owner = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [vara, aliases] of entries) {
      for (const alias of aliases) {
        const norm = normalizeName(alias);
        const existing = owner.get(norm);
        if (existing && existing !== vara) duplicates.push(`${alias}: ${existing} vs ${vara}`);
        else owner.set(norm, vara);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("emits nothing that cannot be a lookup key", () => {
    const malformed: string[] = [];
    for (const [vara, aliases] of entries) {
      if (aliases.length === 0) malformed.push(`${vara}: empty array`);
      for (const alias of aliases) {
        // Single letters match far too much; digits and punctuation never come
        // out of a speech transcriber as part of a grocery word.
        if (alias.trim().length < 2) malformed.push(`${vara}: "${alias}" too short`);
        if (alias !== alias.toLowerCase()) malformed.push(`${vara}: "${alias}" not lowercase`);
        if (/[0-9]/.test(alias)) malformed.push(`${vara}: "${alias}" has digits`);
      }
    }
    expect(malformed).toEqual([]);
  });

  it("normalizes to something a stored alias_norm can equal", () => {
    // The column stores the folded form and the matcher compares against it, so
    // an alias that normalizes to empty would insert a row nothing can reach.
    for (const aliases of Object.values(ENGLISH_ALIASES)) {
      for (const alias of aliases) expect(normalizeName(alias).length).toBeGreaterThan(0);
    }
  });

  it("covers the words an English speaker actually reaches for", () => {
    // A spot check with teeth: these are the ones that would be noticed missing
    // on the first day, and the compound families that must NOT capture them.
    const idFor = (alias: string) => {
      const found = entries.find(([, list]) => list.includes(alias));
      return found ? slugify(found[0]) : null;
    };
    expect(idFor("milk")).toBe("mjolk");
    // formbröd, not "bröd" — there is no plain bröd vara at all. The catalog
    // carries only compounds (formbröd, surdegsbröd, rågbröd, …), and formbröd
    // is the everyday sliced loaf, so it is where a bare "bread" belongs.
    expect(idFor("bread")).toBe("formbrod");
    expect(idFor("eggs")).toBe("agg");
    expect(idFor("butter")).toBe("smor");
    expect(idFor("cream")).toBe("gradde");
    expect(idFor("onion")).toBe("lok");
    expect(idFor("flour")).toBe("mjol");
    expect(idFor("cheese")).toBe("ost");
  });

  it("keeps a generic word off a compound vara", () => {
    /*
     * The catalog keeps grädde, vispgrädde and matlagningsgrädde apart on
     * purpose — they are not interchangeable at the stove — and the same holds
     * for lök and mjöl. "cream" belongs to the generic vara alone; a compound
     * claiming it would put something more specific on the list than was asked
     * for, which is the exact reasoning catalog.ts already writes down.
     */
    for (const generic of ["cream", "onion", "flour", "milk", "cheese"]) {
      const owners = entries.filter(([, list]) => list.includes(generic));
      expect(owners).toHaveLength(1);
    }
  });
});
