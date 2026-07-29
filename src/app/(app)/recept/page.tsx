import { RecipeList } from "@/components/recipe-list";

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
