import { expect, test } from "@playwright/test";

for (const surface of ["primary", "secondary"] as const) {
  test(`${surface} 无缓存冷启动失败不会冒充正常空系统且可原地恢复`, async ({ page }) => {
    await page.setViewportSize({ width: surface === "primary" ? 1024 : 1024, height: 600 });
    let unavailable = true;
    await page.route("**/api/v1/snapshot", (route) => (unavailable ? route.abort("connectionrefused") : route.continue()));
    await page.routeWebSocket(/\/api\/v1\/events/, (ws) => {
      if (!unavailable) ws.connectToServer();
    });

    await page.goto(`/${surface}`);
    const gate = page.locator(".startup-gate");
    await expect(gate).toContainText("本地控制服务不可达");
    await expect(gate).toContainText("当前 EdgeCore");
    await expect(gate).toContainText("控制状态未解锁");
    await expect(gate.getByRole("button", { name: "立即重试" })).toBeEnabled();
    await expect(page.getByText("0 个设备在线")).toHaveCount(0);
    await expect(page.getByText("快捷控制待配置")).toHaveCount(0);

    unavailable = false;
    await gate.getByRole("button", { name: "立即重试" }).click();
    await expect(gate).toHaveCount(0);
    await expect(page.locator(".connection.online")).toContainText("已连接");
    if (surface === "secondary") await expect(page.getByText(/18 个设备在线/)).toBeVisible();
    else await expect(page.getByRole("button", { name: /在线设备 18\/18/ })).toBeVisible();
  });
}

test("无缓存终端认证失败给出重新配对指引且后台维修入口不被封锁", async ({ page }) => {
  await page.route("**/api/v1/snapshot", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "TERMINAL_TOKEN_INVALID" }) })
  );
  await page.routeWebSocket(/\/api\/v1\/events/, () => undefined);
  await page.goto("/secondary");

  const gate = page.locator(".startup-gate");
  await expect(gate).toContainText("终端认证失效");
  await expect(gate).toContainText("请在管理端重新配对");
  await expect(gate).toContainText("终端工程设置中重新发现主屏或输入主屏 IP");

  await page.goto("/admin");
  await expect(gate).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "管理员验证" })).toBeVisible();
});

test("WebSocket 只有心跳但没有首帧快照时保持锁控并自动更换连接", async ({ page }) => {
  test.setTimeout(15_000);
  let connections = 0;
  await page.route("**/api/v1/snapshot", (route) => route.abort("connectionrefused"));
  await page.routeWebSocket(/\/api\/v1\/events/, (ws) => {
    connections += 1;
    const heartbeat = JSON.stringify({ type: "heartbeat", sequence: 1, payload: { serverTime: new Date().toISOString() } });
    ws.send(heartbeat);
    const timer = setInterval(() => ws.send(heartbeat), 1_000);
    ws.onClose(() => clearInterval(timer));
  });
  await page.goto("/primary");

  const gate = page.locator(".startup-gate");
  await expect(gate).toContainText("权威状态获取超时", { timeout: 7_000 });
  await expect(gate).toContainText("控制保持锁定并正在自动更换连接");
  await expect(gate).toContainText(/\d+ 秒后自动重试/);
  await expect.poll(() => connections, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await expect(gate).toBeVisible();
});

test("已有旧快照也不能为下一条无全量快照的连接解锁", async ({ page }) => {
  test.setTimeout(25_000);
  let connections = 0;
  await page.routeWebSocket(/\/api\/v1\/events/, (ws) => {
    connections += 1;
    if (connections === 1) {
      const server = ws.connectToServer();
      let forwarded = false;
      server.onMessage((message) => {
        if (forwarded) return;
        forwarded = true;
        ws.send(message);
      });
      return;
    }
    const heartbeat = JSON.stringify({ type: "heartbeat", sequence: 1, payload: { serverTime: new Date().toISOString() } });
    ws.send(heartbeat);
  });
  await page.goto("/primary");
  await expect(page.locator(".connection.online")).toContainText("已连接");

  await page.route("**/api/v1/snapshot", (route) => route.abort("connectionrefused"));
  await expect.poll(() => connections, { timeout: 21_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".connection.offline")).toBeVisible();
  await page.getByRole("button", { name: "场景", exact: true }).click();
  await expect(page.locator(".scene-card").first()).toBeDisabled();
});

for (const target of [
  { name: "secondary", path: "/secondary", width: 1024, height: 600 },
  { name: "contract", path: "/primary", width: 1424, height: 280 }
]) {
  test(`启动门禁适配 ${target.name} 目标视口与深色主题`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("zhijing-theme", "dark"));
    await page.setViewportSize({ width: target.width, height: target.height });
    await page.route("**/api/v1/snapshot", (route) => route.abort("connectionrefused"));
    await page.routeWebSocket(/\/api\/v1\/events/, () => undefined);
    await page.goto(target.path);

    const gate = page.locator(".startup-gate");
    await expect(gate).toBeVisible();
    await expect(gate.getByRole("button", { name: "立即重试" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const overflow = await gate.evaluate((node) => ({
      horizontal: node.scrollWidth - node.clientWidth,
      vertical: node.scrollHeight - node.clientHeight
    }));
    expect(overflow.horizontal).toBeLessThanOrEqual(1);
    expect(overflow.vertical).toBeLessThanOrEqual(1);
  });
}
