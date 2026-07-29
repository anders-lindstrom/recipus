import { headers } from "next/headers";
import { RecipeDetail } from "@/components/recipe-detail";
import { authenticate, AuthError } from "@/lib/auth";

/**
 * The recipe detail page.
 *
 * Auth failure must not render a different page — same reasoning as
 * src/app/(app)/page.tsx. Browsing a recipe needs no actor at all; adding it
 * to a list does (for op provenance), so a lapsed session still lets you read
 * the recipe, it just can't complete the add.
 */
export const dynamic = "force-dynamic";

export default async function RecipeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let actor: string | null = null;
  try {
    actor = authenticate(await headers()).autheliaUser;
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
  }

  return (
    <main>
      <RecipeDetail recipeId={id} actor={actor} />
    </main>
  );
}
