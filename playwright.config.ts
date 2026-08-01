import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests.
 *
 * These run against the dev server with `DEV_AUTH_USER` standing in for
 * Authelia — the production auth path needs a proxy in front and is not what
 * these tests are about.
 *
 * Port 3101, deliberately not 3100: a dev server is often already running
 * there by hand, and a test run that silently attached to it would be testing
 * whatever code that server happened to have loaded.
 */
const PORT = Number(process.env.E2E_PORT ?? 3101);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Serial: these share one database, and a test that removes an item while
  // another is asserting on the list would fail for the wrong reason.
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Pixel 7"],
  },
  webServer: {
    command: `PORT=${PORT} pnpm dev`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DEV_AUTH_USER: "e2e" },
  },
});
