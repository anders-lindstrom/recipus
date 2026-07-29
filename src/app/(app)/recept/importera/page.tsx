import { RecipeImport } from "@/components/recipe-import";

/**
 * Recipe import page — also the PWA share target.
 *
 * The manifest posts here as `/recept/importera?url=&text=&title=` (GET, per
 * public/manifest.webmanifest's share_target). Reading the params server-side
 * and handing them to RecipeImport as plain props avoids needing
 * `useSearchParams` (and the Suspense boundary that implies) in the client
 * component for what is otherwise a one-time, first-render concern.
 */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ImportRecipePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  return (
    <main>
      <RecipeImport initialUrl={first(sp.url)} initialText={first(sp.text)} />
    </main>
  );
}
