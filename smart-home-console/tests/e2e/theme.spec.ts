import { expect, test, type APIRequestContext } from "@playwright/test";

async function resetSimulation(request: APIRequestContext) {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const session = await login.json();
  await request.post("/api/v1/_test/reset", { data: {}, headers: { authorization: `Bearer ${session.data.token}` } });
}

test.beforeEach(async ({ request }) => resetSimulation(request));

async function expectNoBrightSurface(page: import("@playwright/test").Page) {
  const brightSurfaces = await page.locator("body *").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 20 || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth)
        return [];
      const match = getComputedStyle(element).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!match) return [];
      const [, red, green, blue, alpha = "1"] = match;
      if (Number(alpha) < 0.5 || Number(red) < 236 || Number(green) < 236 || Number(blue) < 236) return [];
      return [`${element.tagName.toLowerCase()}.${element.className}=${match[0]}`];
    })
  );
  expect(brightSurfaces).toEqual([]);
}

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

test("主题可跨屏同步、持久化并完整切回浅色", async ({ page, context }) => {
  await page.goto("/primary");
  await page.evaluate(() => localStorage.removeItem("zhijing-theme"));
  await page.reload();

  const secondary = await context.newPage();
  const admin = await context.newPage();
  await secondary.goto("/secondary");
  await admin.goto("/admin");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f5f6f7");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(245, 246, 247)");
  await expect(secondary.locator(".focus-control")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(admin.locator(".login-panel")).toHaveCSS("background-color", "rgb(255, 255, 255)");

  await page.getByRole("button", { name: "切换至深色主题" }).click();

  for (const target of [page, secondary, admin]) {
    await expect(target.locator("html")).toHaveAttribute("data-theme", "dark");
  }
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(16, 17, 19)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#101113");
  await expect(page.getByTestId("overview-panel")).toBeVisible();
  await expect(secondary.locator(".focus-control")).toHaveCSS("background-color", "rgb(28, 29, 32)");
  await expect(admin.locator(".login-panel")).toHaveCSS("background-color", "rgb(28, 29, 32)");
  await expect(page.getByRole("button", { name: "切换至浅色主题" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zhijing-theme"))).toBe("dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#101113");
  await expect(page.getByRole("button", { name: "切换至浅色主题" })).toBeVisible();

  await secondary.getByRole("button", { name: "切换至浅色主题" }).click();

  for (const target of [page, secondary, admin]) {
    await expect(target.locator("html")).toHaveAttribute("data-theme", "light");
  }
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(245, 246, 247)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f5f6f7");
  await expect(page.getByTestId("overview-panel")).toBeVisible();
  await expect(secondary.locator(".focus-control")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(admin.locator(".login-panel")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect.poll(() => secondary.evaluate(() => localStorage.getItem("zhijing-theme"))).toBe("light");
});

test("双主题在主屏、辅屏与后台目标视口视觉适配", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("zhijing-theme", "dark"));

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/primary");
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "首页" }).click();
  await page.screenshot({ path: "output/playwright/theme-dark-primary-home.png" });
  await page.getByRole("complementary", { name: "主屏导航" }).getByRole("button", { name: "设备", exact: true }).click();
  await page.locator(".device-card").first().click();
  await expect(page.locator(".light-capability-panel")).toBeVisible();
  const lightPanelColors = await page.locator(".light-capability-panel").evaluate((panel) => {
    const rgba = (selector: string) => {
      const value = getComputedStyle(panel.querySelector(selector)!).backgroundColor;
      return value.match(/[\d.]+/g)?.map(Number) ?? [];
    };
    return {
      stage: rgba(".light-stage"),
      column: rgba(".light-column"),
      indicator: rgba(".temperature-tab-indicator"),
      stageGlow: (() => {
        const stage = panel.querySelector(".light-stage")!;
        const style = getComputedStyle(stage, "::after");
        const rect = stage.getBoundingClientRect();
        return {
          topRatio: Number.parseFloat(style.top) / rect.height,
          leftRatio: Number.parseFloat(style.left) / rect.width,
          filter: style.filter
        };
      })(),
      activeTemperatureShadow: getComputedStyle(panel.querySelector(".temperature-tabs button.active")!).textShadow,
      effectBackground: getComputedStyle(panel).getPropertyValue("--light-effect-background").trim(),
      effectText: getComputedStyle(panel).getPropertyValue("--light-effect-text").trim()
    };
  });
  expect(lightPanelColors.stage.slice(0, 3).every((channel) => channel < 90)).toBeTruthy();
  expect(lightPanelColors.column.slice(0, 3).every((channel) => channel < 90)).toBeTruthy();
  // 暗色主题的色温磁条只能使用低明度半透明选中层，防止退回浅色主题的白色胶囊。
  expect(lightPanelColors.indicator.slice(0, 3).every((channel) => channel === 255)).toBeTruthy();
  expect(lightPanelColors.indicator[3]).toBeLessThan(0.14);
  // 这两项来自组件 scoped 暗色覆盖，防止构建器再次把后代选择器错误压缩成裸 :root。
  expect(lightPanelColors.stageGlow.topRatio).toBeCloseTo(0.28, 2);
  expect(lightPanelColors.stageGlow.leftRatio).toBeCloseTo(0.12, 2);
  expect(lightPanelColors.stageGlow.filter).toBe("blur(30px)");
  expect(lightPanelColors.activeTemperatureShadow).not.toBe("none");
  await expect(page.locator(".temperature-tabs button.active")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // 默认 Mock 灯未必声明 effect capability；直接锁定主题令牌，真实设备渲染按钮时会继承同一组值。
  expect(lightPanelColors.effectBackground).toBe("#292a2f");
  expect(lightPanelColors.effectText).toBe("#d4d6da");
  await expectNoBrightSurface(page);
  await page.screenshot({ path: "output/playwright/theme-dark-primary-devices.png" });

  await page.setViewportSize({ width: 1920, height: 720 });
  await expect(page.locator(".primary-shell")).toHaveCSS("overflow", "hidden");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "output/playwright/theme-dark-primary-1920x720.png" });

  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/secondary");
  await expect(page.locator(".secondary-shell")).toHaveCSS("background-color", "rgb(16, 17, 19)");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "output/playwright/theme-dark-secondary-1024x600.png" });

  await page.setViewportSize({ width: 1424, height: 280 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "output/playwright/theme-dark-secondary-1424x280.png" });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/admin");
  await expect(page.getByPlaceholder("输入管理员 PIN")).toBeVisible();
  await page.screenshot({ path: "output/playwright/theme-dark-admin-login.png" });
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await expect(page.getByText("运行总览", { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: "output/playwright/theme-dark-admin-overview.png" });
});

test("深色覆盖主屏全部模块与后台全部工作页", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("zhijing-theme", "dark"));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/primary");

  for (const button of ["首页", "场景", "设备", "安防", "环境", "能耗", "设置"]) {
    await page.locator(".side-nav button").filter({ hasText: button }).click();
    await expect(page.locator(".primary-shell")).toHaveCSS("background-color", "rgb(16, 17, 19)");
    await expectNoBrightSurface(page);
    await expectNoHorizontalOverflow(page);
  }

  await page.goto("/admin");
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  for (const button of ["运行总览", "房间与设备", "场景编排", "自动联动", "告警中心", "网关配置", "终端管理", "配置备份", "审计日志"]) {
    await page.getByRole("button", { name: button }).click();
    await expect(page.locator(".admin-content")).toHaveCSS("background-color", "rgb(16, 17, 19)");
    await expectNoBrightSurface(page);
    await expectNoHorizontalOverflow(page);
  }
});
