import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "packages/core/ui/test/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
      : {}),
  },
});
