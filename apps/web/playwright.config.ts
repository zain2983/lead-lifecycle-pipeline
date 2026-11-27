import { defineConfig, devices } from "@playwright/test";

// Don't run Playwright while self-hosted Sim is up: together they exceed the Mac's memory (PLAN.md section 4).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: "http://localhost:3100", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm start",
    url: "http://localhost:3100/api/health",
    reuseExistingServer: !process.env.CI,
  },
});
