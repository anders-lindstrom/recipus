import { RecipeList } from "@/components/recipe-list";

// The layout sets a single constant "Recipus" for every route, so navigating
// between screens announced nothing at all. A per-route title is the cheapest
// thing that fixes it, and it is also what the tab and the PWA task switcher
// show.
export const metadata = { title: "Recept · Recipus" };

/**
 * The recipe list page.
 *
 * All data loading happens client-side in RecipeList — see that file for why
 * a server-rendered snapshot (the pattern the shopping list uses) doesn't buy
 * anything here.
 */
export const dynamic = "force-dynamic";

export default function RecipesPage() {
  return (
    <main>
      <RecipeList />
    </main>
  );
}
