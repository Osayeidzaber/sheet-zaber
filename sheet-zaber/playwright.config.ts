import { defineConfig, devices } from "@playwright/test"

/*
 * Browser tests against a production build. Run `pnpm build` first, then `pnpm test:e2e`.
 * Port 3101 keeps e2e clear of the dev server (3001) and the portfolio app (3000/3100).
 */
const port = Number(process.env.E2E_PORT || 3101)

export const E2E_DATABASE_URL = "postgresql://postgres:postgres@localhost:5433/sheet_zaber_e2e"
export const E2E_SESSION_SECRET = "e2e-only-session-secret-00000000000000000"
export const E2E_TOKEN_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${port}`,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `pnpm start -p ${port}`,
    port,
    reuseExistingServer: false,
    // Never the developer's database or real providers: blank secrets keep every send and grant off.
    env: {
      NODE_ENV: "production",
      DATABASE_URL: E2E_DATABASE_URL,
      SESSION_SECRET: E2E_SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: E2E_TOKEN_KEY,
      OWNER_EMAIL: "e2e-owner@example.com",
      NEXT_PUBLIC_SITE_URL: `http://localhost:${port}`,
    },
    timeout: 120_000,
  },
})
