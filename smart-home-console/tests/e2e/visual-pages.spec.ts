import { expect, test, type APIRequestContext } from "@playwright/test";

async function resetSimulation(request: APIRequestContext) {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const session = await login.json();
  await request.post("/api/v1/_test/reset", { data: {}, headers: { authorization: `Bearer ${session.data.token}` } });
}

async function expectViewportFit(page: import("@playwright/test").Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.clientHeight);
}

test("capture redesigned primary sections", async ({ page, request }) => {
  await resetSimulation(request);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/primary");
  await page.locator(".side-nav button").filter({ hasText: "场景" }).click();
  await expect(page.locator(".scene-library")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.screenshot({ path: "output/playwright/primary-scenes-redesign.png" });
  for (const [button, name] of [
    ["首页", "primary-home-redesign"],
    ["设备", "primary-devices-redesign"],
    ["安防", "primary-security-redesign"],
    ["环境", "primary-environment-redesign"],
    ["能耗", "primary-energy-redesign"],
    ["设置", "primary-status-redesign"]
  ] as const) {
    await page.locator(".side-nav button").filter({ hasText: button }).click();
    if (button === "设备") {
      await expect(page.locator(".device-grid")).toHaveCSS("display", "grid");
      await expect(page.locator(".device-card").first()).toHaveCSS("border-radius", "18px");
    }
    await page.screenshot({ path: `output/playwright/${name}.png` });
  }

  await page.setViewportSize({ width: 1920, height: 720 });
  await page.locator(".side-nav button").filter({ hasText: "首页" }).click();
  await page.screenshot({ path: "output/playwright/primary-home-1920x720.png" });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("smart-lab:screen-saver", { detail: { active: true } }));
  });
  await expect(page.locator(".screen-saver")).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "output/playwright/screen-saver-redesign.png" });
});

test("capture redesigned secondary control states", async ({ page, request }) => {
  await resetSimulation(request);
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/secondary");
  await page.waitForTimeout(450);
  await expect(page.locator(".focus-control")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.screenshot({ path: "output/playwright/secondary-light-redesign.png" });
  await page.getByRole("button", { name: "查看告警：型号待核对" }).click();
  const alertDialog = page.getByRole("dialog", { name: "型号待核对" });
  await expect(alertDialog).toBeVisible();
  await page
    .locator(".secondary-alert-backdrop")
    .evaluate(async (element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const alertBox = await alertDialog.boundingBox();
  expect(alertBox).not.toBeNull();
  expect(alertBox!.x).toBeGreaterThanOrEqual(0);
  expect(alertBox!.y).toBeGreaterThanOrEqual(0);
  expect(alertBox!.x + alertBox!.width).toBeLessThanOrEqual(1024);
  expect(alertBox!.y + alertBox!.height).toBeLessThanOrEqual(600);
  await page.screenshot({ path: "output/playwright/secondary-alert-detail-1024x600.png" });
  await page.getByRole("button", { name: "关闭告警详情" }).click();
  await page.getByRole("button", { name: "窗帘" }).click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: "output/playwright/secondary-curtain-redesign.png" });
  await page.getByRole("button", { name: "音乐" }).click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: "output/playwright/secondary-music-redesign.png" });
  await page.setViewportSize({ width: 1424, height: 280 });
  await page.screenshot({ path: "output/playwright/secondary-contract-redesign.png" });
});

for (const theme of ["light", "dark"] as const) {
  test(`设备右侧详情 ${theme} 主题多设备与多视口视觉证据`, async ({ page, request }) => {
    await resetSimulation(request);
    await page.addInitScript((value) => localStorage.setItem("zhijing-theme", value), theme);

    for (const viewport of [
      { width: 1920, height: 1080, suffix: "1920x1080" },
      { width: 1920, height: 720, suffix: "1920x720" },
      { width: 1024, height: 600, suffix: "1024x600" }
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/primary");
      await expect(page.locator(".primary-shell")).toBeVisible();
      await page.getByRole("button", { name: "设备", exact: true }).click();
      for (const [device, id] of [
        ["米家客厅吸顶灯", "light"],
        ["Aqara C3 窗帘", "curtain"],
        ["背景音乐主机", "media"],
        ["智能开关 Pro 三开", "switch"],
        ["人体传感器", "sensor"]
      ] as const) {
        await page.locator(".device-card").filter({ hasText: device }).click();
        await expect(page.locator(".device-detail-head")).toContainText(device);
        await expectViewportFit(page);
        await page.screenshot({ path: `output/playwright/detail-${theme}-${id}-${viewport.suffix}.png` });
      }
    }

    for (const viewport of [
      { width: 1024, height: 600, suffix: "1024x600" },
      { width: 1424, height: 280, suffix: "1424x280" }
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/secondary");
      await expect(page.locator(".secondary-shell")).toBeVisible();
      for (const [control, selector, id] of [
        ["灯光", ".light-focus", "light"],
        ["窗帘", ".curtain-focus", "curtain"],
        ["音乐", ".music-focus", "music"]
      ] as const) {
        await page.getByRole("button", { name: control }).click();
        await expect(page.locator(selector)).toBeVisible();
        await expectViewportFit(page);
        await page.screenshot({ path: `output/playwright/secondary-${theme}-${id}-${viewport.suffix}.png` });
      }
    }
  });
}

test("capture redesigned admin login and workspaces", async ({ page, request }) => {
  await resetSimulation(request);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/admin");
  await expect(page.getByPlaceholder("输入管理员 PIN")).toBeVisible();
  await page.screenshot({ path: "output/playwright/admin-login-redesign.png" });
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await expect(page.getByText("运行总览", { exact: true }).last()).toBeVisible();
  await expect(page.locator(".admin-content")).toHaveCSS("background-color", "rgb(245, 246, 247)");
  await page.screenshot({ path: "output/playwright/admin-overview-redesign.png" });
  await page.getByRole("button", { name: "房间与设备" }).click();
  await page.screenshot({ path: "output/playwright/admin-rooms-redesign.png" });
  await page.setViewportSize({ width: 1200, height: 900 });
  const roomDimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(roomDimensions.scrollWidth).toBeLessThanOrEqual(roomDimensions.clientWidth);
  await expect(page.getByRole("region", { name: "副屏快捷控制映射" })).toBeVisible();
  await page.screenshot({ path: "output/playwright/admin-secondary-slots-1200x900.png" });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole("button", { name: "场景编排" }).click();
  await page.screenshot({ path: "output/playwright/admin-scenes-redesign.png" });
  const firstScene = page.locator(".n-collapse-item").first();
  await firstScene.locator(".n-collapse-item__header-main").click();
  await expect(firstScene.getByPlaceholder("场景名称")).toBeVisible();
  await expect(firstScene.locator(".n-collapse-item__content-wrapper")).toHaveCSS("height", /[1-9]\d+px/);
  await page.waitForTimeout(250);
  await page.screenshot({ path: "output/playwright/admin-scene-editor-redesign.png" });
  for (const [button, name] of [
    ["自动联动", "admin-automations-redesign"],
    ["告警中心", "admin-alerts-redesign"],
    ["网关配置", "admin-gateways-redesign"],
    ["终端管理", "admin-terminals-redesign"],
    ["配置备份", "admin-backup-redesign"],
    ["审计日志", "admin-audit-redesign"]
  ] as const) {
    await page.getByRole("button", { name: button }).click();
    await page.screenshot({ path: `output/playwright/${name}.png` });
  }
});

test("关键结构以表面层级替代贯穿式边框", async ({ page, request }) => {
  await resetSimulation(request);
  await page.setViewportSize({ width: 1920, height: 1080 });

  await page.goto("/primary");
  await expect(page.locator(".system-header")).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".side-nav")).toHaveCSS("border-right-width", "0px");
  await page.getByRole("complementary", { name: "主屏导航" }).getByRole("button", { name: /^安防/ }).click();
  await expect(page.locator(".security-devices article").first()).toHaveCSS("border-bottom-width", "0px");

  await page.goto("/secondary");
  await expect(page.locator(".home-brief > header")).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".brief-row").first()).toHaveCSS("border-bottom-width", "0px");

  await page.goto("/admin");
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await page.getByRole("button", { name: "房间与设备" }).click();
  await expect(page.locator(".admin-workspace > aside")).toHaveCSS("border-right-width", "0px");
  await expect(page.locator(".edit-row").first()).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".device-edit").first()).toHaveCSS("border-bottom-width", "0px");
});
