import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type TerminalRole = "primary" | "secondary";

async function resetSimulation(request: APIRequestContext) {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const session = await login.json();
  await request.post("/api/v1/_test/reset", {
    data: {},
    headers: { authorization: `Bearer ${session.data.token}` }
  });
}

async function installNativeRuntime(page: Page, role: TerminalRole) {
  await page.addInitScript(
    ({ terminalRole, token }) => {
      const runtime = window as Window & { __rememberedSurfaces?: string[]; SmartLabNative?: Record<string, unknown> };
      runtime.__rememberedSurfaces = [];
      runtime.SmartLabNative = {
        getRole: () => terminalRole,
        // 隔离 E2E 的 Edge 端口由运行命令决定；始终经当前 Vite 同源代理，
        // 避免命令落到旧服务、审计却从本轮服务读取的跨实例假失败。
        getEdgeBaseUrl: () => window.location.origin,
        getTerminalToken: () => token,
        getAppVersion: () => "0.1.0-test",
        configureHomeAssistant: () => true,
        rememberSurface: (surface: string) => {
          runtime.__rememberedSurfaces?.push(surface);
          return true;
        },
        requestTerminalReconfiguration: () => true
      };
    },
    {
      terminalRole: role,
      token: role === "primary" ? "mock-primary-terminal-token" : "mock-secondary-terminal-token"
    }
  );
}

async function switchSurface(page: Page, label: "主屏工作台" | "副屏工作台" | "工程管理") {
  await page.getByRole("button", { name: "切换工作界面" }).click();
  await expect(page.getByRole("region", { name: "终端工作界面" })).toBeVisible();
  await page.locator("#terminal-surface-popover nav button").filter({ hasText: label }).click();
}

async function loginAdmin(page: Page) {
  await expect(page.getByPlaceholder("输入管理员 PIN")).toBeVisible();
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await expect(page.getByText("运行总览", { exact: true }).last()).toBeVisible();
}

async function auditTabletSurface(page: Page, name: string) {
  const result = await page.evaluate(() => {
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 2 &&
        box.height > 2 &&
        box.right > 0 &&
        box.bottom > 0 &&
        box.left < innerWidth &&
        box.top < innerHeight &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };
    const interactiveSurface = (element: Element) => {
      if (!element.matches("input, select")) return element;
      return element.closest(".n-input, .n-base-selection, .n-input-number, .n-select") ?? element;
    };
    const touchTargets = [
      ...new Set(
        [...document.querySelectorAll("button, a, [role=button], [role=tab], [role=slider], input, select")]
          .filter(visible)
          .map(interactiveSurface)
          .filter(visible)
      )
    ].flatMap((element) => {
      const box = element.getBoundingClientRect();
      if (box.width >= 43.5 && box.height >= 43.5) return [];
      return [
        {
          label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 28) || element.tagName,
          width: Math.round(box.width),
          height: Math.round(box.height)
        }
      ];
    });
    const textSelectors = [
      ".side-nav button > span",
      ".scene-tabs button",
      ".device-copy strong",
      ".device-copy small",
      ".temperature-tabs button",
      ".effect-options button",
      ".device-switcher strong",
      ".device-switcher small",
      ".scene-action strong",
      ".scene-action small",
      ".admin-workspace nav button",
      ".workspace-head h2",
      ".terminal-surface-menu strong",
      ".terminal-surface-menu small"
    ];
    const verticalText = [...document.querySelectorAll(textSelectors.join(","))]
      .filter((element) => visible(element) && (element.textContent?.trim().length ?? 0) >= 2)
      .flatMap((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4;
        const looksVertical =
          style.writingMode !== "horizontal-tb" ||
          style.wordBreak === "break-all" ||
          (box.height > lineHeight * 2.6 && box.width < Number.parseFloat(style.fontSize) * 4);
        return looksVertical
          ? [
              {
                text: element.textContent?.trim().slice(0, 28),
                width: Math.round(box.width),
                height: Math.round(box.height),
                wordBreak: style.wordBreak,
                writingMode: style.writingMode
              }
            ]
          : [];
      });
    const probeButton = [...document.querySelectorAll("button")].find(visible);
    const probeInput = [...document.querySelectorAll("input")].find(visible);
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      touchTargets,
      verticalText,
      tapHighlight: probeButton ? getComputedStyle(probeButton).webkitTapHighlightColor : "",
      bodyUserSelect: getComputedStyle(document.body).userSelect,
      buttonUserSelect: probeButton ? getComputedStyle(probeButton).userSelect : "",
      inputUserSelect: probeInput ? getComputedStyle(probeInput).userSelect : undefined
    };
  });
  expect(result.scrollWidth, `${name} 文档横向溢出`).toBeLessThanOrEqual(result.clientWidth);
  expect(result.touchTargets, `${name} 存在小于 44×44px 的可见触控面`).toEqual([]);
  expect(result.verticalText, `${name} 存在逐字竖排或 break-all 文本`).toEqual([]);
  expect(result.tapHighlight).toBe("rgba(0, 0, 0, 0)");
  expect(result.bodyUserSelect).toBe("none");
  expect(result.buttonUserSelect).toBe("none");
  if (result.inputUserSelect !== undefined) expect(result.inputUserSelect).toBe("text");
}

test.beforeEach(async ({ request }) => resetSimulation(request));

test("物理副屏可切换三端、管理仍需 PIN，离开后台后控制来源仍是副屏且同步到主屏", async ({ page, context, request }) => {
  await installNativeRuntime(page, "secondary");
  const observer = await context.newPage();
  await installNativeRuntime(observer, "primary");

  await page.setViewportSize({ width: 1024, height: 600 });
  await observer.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/primary");
  await observer.goto("/primary");
  await expect(page.locator(".primary-shell")).toBeVisible();
  await expect(observer.locator(".primary-shell")).toBeVisible();

  await switchSurface(page, "副屏工作台");
  await expect(page).toHaveURL(/\/secondary$/);
  await expect(page.locator(".secondary-shell")).toBeVisible();
  await switchSurface(page, "工程管理");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByPlaceholder("输入管理员 PIN")).toBeVisible();
  await loginAdmin(page);

  await switchSurface(page, "主屏工作台");
  await expect(page).toHaveURL(/\/primary$/);
  await expect(page.locator(".primary-shell")).toBeVisible();
  await page.getByRole("button", { name: "设备", exact: true }).click();
  await observer.getByRole("button", { name: "设备", exact: true }).click();
  const operatorCard = page.locator(".device-card").filter({ hasText: "米家客厅吸顶灯" });
  const observerCard = observer.locator(".device-card").filter({ hasText: "米家客厅吸顶灯" });
  const initialState = (await operatorCard.locator(".state").innerText()).trim();
  await expect(observerCard.locator(".state")).toHaveText(initialState);
  const expectedState = initialState === "已关闭" ? "68%" : "已关闭";
  await operatorCard.getByRole("button", { name: "米家客厅吸顶灯 电源" }).click();
  await expect(operatorCard.locator(".state")).toHaveText(expectedState);
  await expect(observerCard.locator(".state")).toHaveText(expectedState);

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const session = await login.json();
  await expect
    .poll(async () => {
      const audits = await request.get("/api/v1/admin/resources/audits?page=1&pageSize=100", {
        headers: { authorization: `Bearer ${session.data.token}` }
      });
      const body = await audits.json();
      return body.data.items.find(
        (item: { action: string; source: string; result: string }) =>
          item.action === "米家客厅吸顶灯.power" && item.source === "secondary" && item.result === "success"
      );
    })
    .toBeTruthy();

  const remembered = await page.evaluate(() => {
    const values = (window as Window & { __rememberedSurfaces?: string[] }).__rememberedSurfaces ?? [];
    return values.filter((value, index) => value !== values[index - 1]);
  });
  expect(remembered).toEqual(["primary", "secondary", "admin", "primary"]);
  await observer.close();
});

test("普通浏览器不显示原生终端切换入口", async ({ page }) => {
  await page.goto("/primary");
  await expect(page.getByRole("button", { name: "切换工作界面" })).toHaveCount(0);
});

for (const viewport of [
  { width: 800, height: 600 },
  { width: 900, height: 600 },
  { width: 1024, height: 600 }
]) {
  test(`${viewport.width}×${viewport.height} 主屏网关配置保持两列可读布局，不再挤压标题和实体字段`, async ({ page }) => {
    await installNativeRuntime(page, "primary");
    await page.setViewportSize(viewport);
    await page.goto("/admin");
    await loginAdmin(page);
    await expect(page.getByTestId("admin-app-version")).toHaveText("APK 0.1.0-test");
    await page.getByRole("button", { name: "网关配置", exact: true }).click();

    const editor = page.locator(".ha-setup-editor");
    await expect(editor).toBeVisible();
    await expect(editor.getByText("Home Assistant · Xiaomi Home 云链路", { exact: true })).toBeVisible();
    await expect(editor.getByText(/令牌仅存于 Android Keystore/)).toBeVisible();

    const layout = await editor.evaluate((root) => {
      const heading = root.querySelector<HTMLElement>(".ha-setup-heading")!;
      const labels = [...root.querySelectorAll<HTMLElement>(":scope > label")];
      const title = heading.querySelector<HTMLElement>("strong")!;
      const titleStyle = getComputedStyle(title);
      const rootBox = root.getBoundingClientRect();
      const headingBox = heading.getBoundingClientRect();
      const labelBoxes = labels.map((label) => label.getBoundingClientRect());
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        headingWidth: Math.round(headingBox.width),
        editorWidth: Math.round(rootBox.width),
        titleHeight: Math.round(title.getBoundingClientRect().height),
        titleLineHeight: Math.round(Number.parseFloat(titleStyle.lineHeight)),
        labelWidths: labelBoxes.map((box) => Math.round(box.width)),
        rowTops: [...new Set(labelBoxes.map((box) => Math.round(box.top)))]
      };
    });

    expect(layout.documentWidth).toBe(layout.viewportWidth);
    expect(layout.headingWidth).toBeGreaterThanOrEqual(layout.editorWidth - 40);
    expect(layout.titleHeight).toBeLessThanOrEqual(layout.titleLineHeight * 2);
    expect(layout.labelWidths.every((width) => width >= 190)).toBe(true);
    expect(layout.rowTops).toHaveLength(2);
  });
}

for (const viewport of [
  { width: 800, height: 600 },
  { width: 900, height: 600 },
  { width: 962, height: 601 },
  { width: 1024, height: 768 },
  { width: 1366, height: 768 }
]) {
  test(`${viewport.width}×${viewport.height} 横屏三端无横向溢出、文字竖排和触控高亮`, async ({ page }) => {
    await installNativeRuntime(page, "secondary");
    await page.setViewportSize(viewport);

    await page.goto("/primary");
    await expect(page.locator(".primary-shell")).toBeVisible();
    await auditTabletSurface(page, `${viewport.width}×${viewport.height} 主屏`);

    await switchSurface(page, "副屏工作台");
    await expect(page.locator(".secondary-shell")).toBeVisible();
    await auditTabletSurface(page, `${viewport.width}×${viewport.height} 副屏`);

    await switchSurface(page, "工程管理");
    await expect(page.getByPlaceholder("输入管理员 PIN")).toBeVisible();
    await auditTabletSurface(page, `${viewport.width}×${viewport.height} 管理登录`);
    await loginAdmin(page);
    await auditTabletSurface(page, `${viewport.width}×${viewport.height} 管理工作区`);
  });
}
