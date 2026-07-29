import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
