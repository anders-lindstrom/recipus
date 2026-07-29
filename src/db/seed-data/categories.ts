/**
 * Seed categories — the walking order of a Swedish supermarket (Hemköp/ICA/Coop
 * style), first to last aisle. `position` becomes the default aisle order for
 * a list's catalog view.
 *
 * Icons are emoji codepoints (uppercase hex, no "U+" prefix; multi-codepoint
 * sequences join with "-"), matching CatalogItem.iconRef in src/lib/domain.ts.
 */

export interface SeedCategory {
  slug: string;
  name: string;
  icon: string;
  position: number;
}

export const CATEGORIES: SeedCategory[] = [
  { slug: "frukt-gront", name: "Frukt & grönt", icon: "1F34E", position: 0 }, // 🍎
  { slug: "brod", name: "Bröd", icon: "1F35E", position: 1 }, // 🍞
  { slug: "mejeri-agg", name: "Mejeri & ägg", icon: "1F95B", position: 2 }, // 🥛
  { slug: "chark-palagg", name: "Chark & pålägg", icon: "1F953", position: 3 }, // 🥓
  { slug: "kott-fagel", name: "Kött & fågel", icon: "1F357", position: 4 }, // 🍗
  { slug: "fisk-skaldjur", name: "Fisk & skaldjur", icon: "1F41F", position: 5 }, // 🐟
  { slug: "fardigmat", name: "Färdigmat", icon: "1F371", position: 6 }, // 🍱
  { slug: "fryst", name: "Fryst", icon: "1F9CA", position: 7 }, // 🧊
  { slug: "skafferi", name: "Skafferi", icon: "1F96B", position: 8 }, // 🥫
  { slug: "pasta-ris-gryn", name: "Pasta, ris & gryn", icon: "1F35D", position: 9 }, // 🍝
  { slug: "bak-mjol", name: "Bak & mjöl", icon: "1F33E", position: 10 }, // 🌾
  { slug: "kaffe-te", name: "Kaffe & te", icon: "2615", position: 11 }, // ☕
  { slug: "snacks-godis", name: "Snacks & godis", icon: "1F36C", position: 12 }, // 🍬
  { slug: "dryck", name: "Dryck", icon: "1F964", position: 13 }, // 🥤
  { slug: "hushall", name: "Hushåll", icon: "1F9FD", position: 14 }, // 🧽
  { slug: "hygien", name: "Hygien", icon: "1F9F4", position: 15 }, // 🧴
  { slug: "barn", name: "Barn", icon: "1F37C", position: 16 }, // 🍼
  { slug: "djur", name: "Djur", icon: "1F43E", position: 17 }, // 🐾
  { slug: "ovrigt", name: "Övrigt", icon: "1F4E6", position: 18 }, // 📦
];
