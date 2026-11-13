import { defineConfig } from "@playwright/test";

const uiPort = Number(process.env.UI_PORT ?? 8083);
const edgePort = Number(process.env.EDGE_PORT ?? 8787);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: `http://127.0.0.1:${uiPort}`,
    // 仅 Mock EdgeCore 识别的 E2E 直连请求兜底；不覆盖页面登录后的真实 admin Authorization。
    extraHTTPHeaders: { "x-smart-lab-test-terminal-token": "mock-primary-terminal-token" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: `UI_PORT=${uiPort} EDGE_PORT=${edgePort} pnpm dev:test`,
    url: `http://127.0.0.1:${uiPort}/primary`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
