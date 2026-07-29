import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// `vitest run` does not load .env the way the db:* scripts do (via `tsx
// --env-file`). A no-op for every pure-engine test — they never read
// process.env — but src/lib/services/apply-op.test.ts needs DATABASE_URL to
// reach the dev database.
try {
  process.loadEnvFile();
} catch {
  // No .env present (e.g. CI with real env vars already set) — fine.
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // The pure engines (units, ingredients, cadence, sync) are the whole point
    // of `pnpm test` — they need no DOM, no database and no network.
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
