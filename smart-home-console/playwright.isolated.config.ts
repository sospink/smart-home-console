import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5273",
    extraHTTPHeaders: { "x-smart-lab-test-terminal-token": "mock-primary-terminal-token" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command: "EDGE_PORT=8887 pnpm --filter @smart-lab/mock-edge dev",
      url: "http://127.0.0.1:8887/api/v1/health",
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "UI_PORT=5273 EDGE_PORT=8887 pnpm --filter @smart-lab/panel-ui dev",
      url: "http://127.0.0.1:5273/primary",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});
