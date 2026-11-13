import { expect, test, type APIRequestContext } from "@playwright/test";

async function adminSession(request: APIRequestContext) {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  return (await login.json()).data.token as string;
}

test.beforeEach(async ({ page, request }) => {
  const token = await adminSession(request);
  await request.post("/api/v1/_test/reset", { data: {}, headers: { authorization: `Bearer ${token}` } });
  await page.goto("/primary");
});

test("security acknowledgement follows the real alert and audit path", async ({ page, request }) => {
  const token = await adminSession(request);
  await request.post("/api/v1/_test/faults", {
    data: { targetId: "water-sensor", kind: "water-leak" },
    headers: { authorization: `Bearer ${token}` }
  });
  await page.getByRole("complementary", { name: "主屏导航" }).getByRole("button", { name: /^安防/ }).click();
  await expect(page.locator(".alert-history article").filter({ hasText: "检测到水浸" })).toBeVisible();
  const alert = page.locator(".alert-history article").filter({ hasText: "检测到水浸" });
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/v1/alerts/") && response.url().endsWith("/acknowledge")
  );
  await alert.getByRole("button", { name: "确认" }).click();
  expect((await responsePromise).ok()).toBeTruthy();
  await expect(alert).toContainText("处理中");
  await expect(page.locator(".critical-strip")).toContainText("紧急告警已确认，等待设备恢复");

  const alerts = (await (await request.get("/api/v1/alerts")).json()).data as Array<{ id: string; title: string }>;
  const waterAlert = alerts.find((item) => item.title === "检测到水浸");
  expect(waterAlert).toBeTruthy();
  const blockedRecovery = await request.post(`/api/v1/admin/alerts/${waterAlert!.id}/recover`, {
    headers: { authorization: `Bearer ${token}` }
  });
  expect(blockedRecovery.status()).toBe(409);
  await expect(page.locator(".critical-strip")).toBeVisible();
  await request.post("/api/v1/_test/faults", {
    data: { targetId: "water-sensor", kind: "clear-water-leak" },
    headers: { authorization: `Bearer ${token}` }
  });
  await expect(page.locator(".critical-strip")).toHaveCount(0);

  const audits = await request.get("/api/v1/admin/resources/audits?q=%E7%A1%AE%E8%AE%A4%E5%91%8A%E8%AD%A6", {
    headers: { authorization: `Bearer ${token}` }
  });
  const auditBody = await audits.json();
  expect(auditBody.data.total).toBeGreaterThan(0);
  expect(auditBody.data.items[0].source).toBe("primary");
});

test("environment exposes only real instant states and can locate a device", async ({ page }) => {
  await page.getByRole("button", { name: "环境" }).click();
  await expect(page.getByText("采购能力范围内的人体、门磁与水浸瞬时状态")).toBeVisible();
  await expect(page.getByText("温湿度与历史趋势尚无可信数据源")).toBeVisible();
  await page.getByRole("button", { name: /需关注/ }).click();
  await expect(page.getByText("当前没有需要关注的环境节点")).toBeVisible();
  await page.getByRole("button", { name: /全部 5/ }).click();
  await page.locator(".live-readings article").filter({ hasText: "水浸卫士 A" }).click();
  await expect(page.locator(".device-detail-head strong")).toHaveText("水浸卫士 A");
});

test("energy capability gate does not fabricate power or kWh", async ({ page }) => {
  await page.getByRole("button", { name: "能耗" }).click();
  await expect(page.getByText("当前采购设备未声明功率或电量遥测能力")).toBeVisible();
  await expect(page.getByText("能耗遥测设备").locator("..").getByText("0", { exact: true })).toBeVisible();
  await expect(page.locator(".energy-module")).not.toContainText(/\d+(\.\d+)?\s*(W|kWh)/);
  await page.locator(".energy-live-list button").first().click();
  await expect(page.locator(".device-detail")).toBeVisible();
});

test("settings manually reloads the authoritative snapshot and locates abnormal nodes", async ({ page }) => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/snapshot"));
  await page.getByRole("button", { name: "同步快照" }).click();
  expect((await responsePromise).ok()).toBeTruthy();
  await expect(page.getByText(/已同步权威快照 · sequence \d+/)).toBeVisible();
  await page.locator(".offline-list article").filter({ hasText: "背景音乐主机" }).click();
  await expect(page.locator(".device-detail-head strong")).toHaveText("背景音乐主机");
});

test("主屏冷启动离线使用独立只读缓存且恢复后重新取得权威状态", async ({ page, request }) => {
  await expect(page.locator(".connection.online")).toContainText("已连接");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some(
          (key) => key.startsWith("smart-lab:last-snapshot") && key.endsWith(":primary") && Boolean(localStorage.getItem(key))
        )
      )
    )
    .toBe(true);

  let edgeUnavailable = true;
  await page.route("**/api/v1/snapshot", (route) => (edgeUnavailable ? route.abort("connectionrefused") : route.continue()));
  await page.routeWebSocket(/\/api\/v1\/events/, (ws) => {
    // 握手成功但不发送任何权威帧：仅端口可达不得解锁缓存上的控制。
    if (!edgeUnavailable) ws.connectToServer();
  });
  await page.reload();

  await expect(page.locator(".connection.offline")).toContainText("离线缓存");
  await page.getByRole("button", { name: "设备", exact: true }).click();
  await expect(page.locator(".device-card").first()).toContainText("上次");
  await expect(page.locator(".power-dot").first()).toBeDisabled();
  await expect(page.getByText("离线缓存，数值为上次同步状态，控制已锁定")).toBeVisible();

  const authorityUpdate = await request.post("/api/v1/devices/living-main-light/commands", {
    data: { requestId: "primary-cache-authority", property: "brightness", value: 41, source: "secondary" }
  });
  expect(authorityUpdate.ok()).toBe(true);
  edgeUnavailable = false;
  await page.locator(".connection.offline").click();
  await expect(page.locator(".connection.online")).toContainText("已连接");
  await expect(page.getByText("离线缓存，数值为上次同步状态，控制已锁定")).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" })).toHaveAttribute("aria-valuenow", "41");
});

test("设备搜索无结果时可一键清除筛选", async ({ page }) => {
  await page.getByRole("button", { name: "设备", exact: true }).click();
  await page.getByPlaceholder("搜索设备 / 型号").fill("不存在的型号-XYZ");
  await expect(page.getByText("没有找到匹配设备")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.getByPlaceholder("搜索设备 / 型号")).toHaveValue("");
  await expect(page.locator(".device-card").first()).toBeVisible();
});
