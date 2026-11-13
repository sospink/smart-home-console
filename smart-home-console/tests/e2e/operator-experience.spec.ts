import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function adminHeaders(request: APIRequestContext) {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const body = await login.json();
  return { authorization: `Bearer ${body.data.token}` };
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectTouchTargetsAtLeast44(page: Page, containerSelector: string, stateName: string) {
  const undersized = await page
    .locator(containerSelector)
    .locator("button, a, [role=button], input[type=range]")
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible =
          box.width > 0 &&
          box.height > 0 &&
          box.right > 0 &&
          box.bottom > 0 &&
          box.left < innerWidth &&
          box.top < innerHeight &&
          style.visibility !== "hidden" &&
          style.display !== "none";
        if (!visible || (box.width >= 43.5 && box.height >= 43.5)) return [];
        return [
          {
            label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 30) || element.tagName,
            width: Math.round(box.width),
            height: Math.round(box.height)
          }
        ];
      })
    );
  expect(undersized, `${stateName} 存在小于 44×44px 的可见触控面`).toEqual([]);
}

type PanelSurface = {
  name: string;
  path: "/primary" | "/secondary";
  width: number;
  height: number;
  businessTextSelector: string;
};

const panelSurfaces: PanelSurface[] = [
  {
    name: "主屏 1920×1080",
    path: "/primary",
    width: 1920,
    height: 1080,
    businessTextSelector:
      ".side-nav .nav-caption span, .side-nav .nav-caption small, .side-nav .nav-status span, .home-heading > span, .home-heading p, .home-status span, .home-status small, .home-hotspot b, .home-hotspot small, .home-scenes span, .home-scenes small, .home-control-list strong, .home-control-list small"
  },
  {
    name: "主屏 1024×600",
    path: "/primary",
    width: 1024,
    height: 600,
    businessTextSelector:
      ".side-nav .nav-caption span, .side-nav .nav-caption small, .side-nav .nav-status span, .home-heading > span, .home-heading p, .home-status span, .home-status small, .home-hotspot b, .home-hotspot small, .home-scenes span, .home-scenes small, .home-control-list strong, .home-control-list small"
  },
  {
    name: "副屏 1024×600",
    path: "/secondary",
    width: 1024,
    height: 600,
    businessTextSelector:
      ".secondary-workspace .home-title small, .secondary-workspace .ambient-status span, .secondary-workspace .all-off strong, .secondary-workspace .all-off small, .secondary-workspace .rail-label, .secondary-workspace .scene-action strong, .secondary-workspace .scene-action small, .secondary-workspace .switcher-label, .secondary-workspace .device-switcher strong, .secondary-workspace .device-switcher small, .secondary-workspace .focus-copy > span, .secondary-workspace .focus-copy p, .secondary-workspace .focus-value small, .secondary-workspace .preset-row > span, .secondary-workspace .preset-row button, .secondary-workspace .brief-primary strong, .secondary-workspace .brief-primary small, .secondary-workspace .brief-row strong, .secondary-workspace .brief-row small, .secondary-workspace .alert-summary b, .secondary-workspace .alert-summary small"
  },
  {
    name: "合同副屏 1424×280",
    path: "/secondary",
    width: 1424,
    height: 280,
    businessTextSelector:
      ".secondary-workspace .rail-label, .secondary-workspace .scene-action strong, .secondary-workspace .switcher-label, .secondary-workspace .device-switcher strong, .secondary-workspace .device-switcher small, .secondary-workspace .focus-copy > span, .secondary-workspace .focus-value small, .secondary-workspace .preset-row > span, .secondary-workspace .preset-row button"
  }
];

test.beforeEach(async ({ request }) => {
  await request.post("/api/v1/_test/reset", { data: {}, headers: await adminHeaders(request) });
});

for (const surface of panelSurfaces) {
  test(`${surface.name} 保持可读业务文字、44px 触控面和键盘焦点`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await page.goto(surface.path);
    await expect(page.locator(surface.path === "/primary" ? ".primary-shell" : ".secondary-shell")).toBeVisible();
    await expect(page.getByRole("button", { name: "切换至深色主题" })).toBeVisible();

    const measurement = await page.evaluate((businessTextSelector) => {
      const visible = (element: Element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const undersized = [...document.querySelectorAll("button, a, [role=button], input[type=range]")]
        .filter((element) => {
          if (!visible(element)) return false;
          const box = element.getBoundingClientRect();
          return box.width < 44 || box.height < 44;
        })
        .map((element) => {
          const box = element.getBoundingClientRect();
          return {
            label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 30) || element.tagName,
            width: Math.round(box.width),
            height: Math.round(box.height)
          };
        });
      const unreadable = [...document.querySelectorAll(businessTextSelector)]
        .filter((element) => visible(element) && Number.parseFloat(getComputedStyle(element).fontSize) < 11)
        .map((element) => ({ label: element.textContent?.trim().slice(0, 30), fontSize: getComputedStyle(element).fontSize }));
      return {
        undersized,
        unreadable,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight
      };
    }, surface.businessTextSelector);

    expect(measurement.undersized, `${surface.name} 存在小于 44×44px 的可见触控面`).toEqual([]);
    expect(measurement.unreadable, `${surface.name} 存在小于 11px 的业务文字`).toEqual([]);
    expect(measurement.scrollWidth).toBeLessThanOrEqual(measurement.clientWidth);
    expect(measurement.scrollHeight).toBeLessThanOrEqual(measurement.clientHeight);

    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      const style = getComputedStyle(active);
      return {
        tag: active.tagName,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        outlineStyle: style.outlineStyle,
        boxShadow: style.boxShadow
      };
    });
    expect(focus, `${surface.name} Tab 后没有可见焦点目标`).not.toBeNull();
    expect(focus!.tag, `${surface.name} Tab 后焦点仍停留在页面容器`).not.toBe("BODY");
    const hasVisibleFocus = (focus!.outlineStyle !== "none" && focus!.outlineWidth >= 2) || focus!.boxShadow !== "none";
    expect(hasVisibleFocus, `${surface.name} 键盘焦点没有可见反馈`).toBe(true);
  });
}

test("展开各类设备详情后仍保持 44px 触控面且不溢出", async ({ page }) => {
  for (const viewport of [
    { width: 1920, height: 1080, name: "主屏 1920×1080" },
    { width: 1024, height: 600, name: "主屏 1024×600" }
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/primary");
    await page.getByRole("button", { name: "设备", exact: true }).click();

    for (const deviceName of ["米家客厅吸顶灯", "Aqara C3 窗帘", "背景音乐主机", "智能开关 Pro 三开", "人体传感器"]) {
      const card = page.locator(".device-card").filter({ hasText: deviceName });
      await card.click();
      await expect(page.locator(".device-detail-head")).toContainText(deviceName);
      await expectTouchTargetsAtLeast44(page, ".device-detail", `${viewport.name} · ${deviceName}`);
      await expectNoHorizontalOverflow(page);
    }
  }

  for (const viewport of [
    { width: 1024, height: 600, name: "副屏 1024×600" },
    { width: 1424, height: 280, name: "副屏 1424×280" }
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/secondary");
    for (const [control, selector] of [
      ["灯光", ".light-focus"],
      ["窗帘", ".curtain-focus"],
      ["音乐", ".music-focus"]
    ] as const) {
      await page.getByRole("button", { name: control }).click();
      await expect(page.locator(selector)).toBeVisible();
      await expectTouchTargetsAtLeast44(page, selector, `${viewport.name} · ${control}`);
      await expectNoHorizontalOverflow(page);
    }
  }
});

test("动效档位可跨三端同步、持久化并明确关闭所有动画", async ({ page, context }) => {
  await page.goto("/primary");
  await page.evaluate(() => localStorage.removeItem("zhijing-motion"));
  await page.reload();
  const secondary = await context.newPage();
  const admin = await context.newPage();
  await secondary.goto("/secondary");
  await admin.goto("/admin");

  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
  await page.getByRole("button", { name: "动效设置（完整）" }).click();
  await page.getByRole("button", { name: "动效精简" }).click();

  for (const target of [page, secondary, admin]) await expect(target.locator("html")).toHaveAttribute("data-motion", "reduced");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zhijing-motion"))).toBe("reduced");

  await page.getByRole("button", { name: "动效关闭" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  const animation = await page
    .locator(".header-signal span")
    .first()
    .evaluate((element) => getComputedStyle(element).animationName);
  const transition = await page.getByRole("button", { name: "首页" }).evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(animation).toBe("none");
  expect(transition).toBe("0s");
  await page.getByRole("button", { name: "设备", exact: true }).click();
  await page.getByRole("button", { name: "米家客厅吸顶灯 电源", exact: true }).click();
  await expect(page.locator(".touch-ripple")).toHaveCount(0);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await expect(page.getByRole("button", { name: "动效设置（关闭）" })).toBeVisible();
  await secondary.close();
  await admin.close();
});

test("操作回执保留设备命令、场景结果、来源和失败原因", async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/primary");
  await page.getByRole("button", { name: "设备", exact: true }).click();
  await page.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" }).press("ArrowUp");
  await expect
    .poll(async () => {
      const snapshot = await request.get("/api/v1/snapshot");
      const body = await snapshot.json();
      return body.data.commands.find(
        (item: { deviceId: string; property: string }) => item.deviceId === "living-main-light" && item.property === "brightness"
      )?.status;
    })
    .toBe("confirmed");

  await request.post("/api/v1/_test/faults", {
    data: { targetId: "music-r11", kind: "fail-next-command" },
    headers: await adminHeaders(request)
  });
  await page.getByRole("button", { name: "场景", exact: true }).click();
  await page.getByRole("button", { name: "执行回家场景（6 项动作）" }).click();
  await expect(page.locator(".spatial-core")).toHaveClass(/partial/, { timeout: 6_000 });

  await page.getByRole("button", { name: "查看操作回执" }).click();
  const center = page.getByRole("region", { name: "最近操作回执" });
  await expect(center).toContainText("米家客厅吸顶灯");
  await expect(center).toContainText("亮度已由设备确认");
  await expect(center).toContainText("主屏");
  await expect(center).toContainText("回家场景");
  await expect(center).toContainText("请检查失败动作");
  await expect(center).toContainText("型号待核对");
  await center.evaluate(async (element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await page.screenshot({ path: "output/playwright/operator-receipts.png" });
});

test("控制请求遭遇网络黑洞时不会永久锁死或误报成功", async ({ page, request }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let hangNextCommand = true;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (hangNextCommand && /\/api\/v1\/devices\/[^/]+\/commands/.test(url)) {
        hangNextCommand = false;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
  });
  await page.goto("/primary");
  await page.getByRole("button", { name: "设备", exact: true }).click();
  const initial = Number(
    (await (await request.get("/api/v1/snapshot")).json()).data.devices.find((item: { id: string }) => item.id === "living-main-light")
      .state.brightness
  );

  const brightnessUp = page.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" });
  await brightnessUp.press("ArrowUp");
  await expect(brightnessUp).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("status").filter({ hasText: "正在同步" })).toBeVisible();

  await page.clock.fastForward(12_100);
  const notice = page.getByRole("alert").filter({ hasText: "控制请求等待超时" });
  await expect(notice).toContainText("请求结果暂时未知");
  await expect(notice).toContainText("确认未执行后再操作");
  await expect(brightnessUp).toHaveAttribute("aria-disabled", "false");
  await expect(page.getByText("亮度已确认")).toHaveCount(0);

  await brightnessUp.press("ArrowUp");
  await expect
    .poll(async () => {
      const snapshot = await (await request.get("/api/v1/snapshot")).json();
      return snapshot.data.devices.find((item: { id: string }) => item.id === "living-main-light").state.brightness;
    })
    .toBe(initial + 1);
  await expect(brightnessUp).toHaveAttribute("aria-disabled", "false");
});

test("HTTP 回包丢失但权威事件已确认时立即解锁且不追加假失败", async ({ page, request }) => {
  let releaseResponse: (() => void) | undefined;
  await page.route("**/api/v1/devices/*/commands", async (route) => {
    await route.fetch();
    await new Promise<void>((resolve) => (releaseResponse = resolve));
    await route.abort("failed");
  });
  await page.goto("/primary");
  await page.getByRole("button", { name: "设备", exact: true }).click();
  const brightnessUp = page.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" });
  const initial = Number(
    (await (await request.get("/api/v1/snapshot")).json()).data.devices.find((item: { id: string }) => item.id === "living-main-light")
      .state.brightness
  );

  await brightnessUp.press("ArrowUp");
  await expect(brightnessUp).toHaveAttribute("aria-disabled", "true");
  await expect
    .poll(async () => {
      const snapshot = await (await request.get("/api/v1/snapshot")).json();
      return snapshot.data.devices.find((item: { id: string }) => item.id === "living-main-light").state.brightness;
    })
    .toBe(initial + 1);
  await expect(brightnessUp).toHaveAttribute("aria-disabled", "false");
  await expect(page.getByRole("status").filter({ hasText: "请求发送中" })).toHaveCount(0);

  releaseResponse?.();
  await expect(page.getByRole("alert").filter({ hasText: "控制请求等待超时" })).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "设备控制失败" })).toHaveCount(0);
});

for (const viewport of [
  { width: 1024, height: 600, path: "/secondary", name: "secondary" },
  { width: 1424, height: 280, path: "/secondary", name: "contract" },
  { width: 1920, height: 720, path: "/primary", name: "primary" }
]) {
  test(`回执与动效入口适配 ${viewport.name} 目标视口`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(viewport.path);
    await expect(page.getByRole("button", { name: "查看操作回执" })).toBeVisible();
    await expect(page.getByRole("button", { name: /动效设置/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "查看操作回执" }).click();
    const panel = page.getByRole("region", { name: "最近操作回执" });
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  });
}

test("后台首页收藏与隐藏设置保存后同步改变主屏常用设备", async ({ page, context }) => {
  const primary = await context.newPage();
  await primary.goto("/primary");
  await page.goto("/admin");
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await page.getByRole("button", { name: "房间与设备" }).click();
  await page.getByPlaceholder("搜索设备 / 房间 / 型号").fill("米家客厅吸顶灯");

  const firstDevice = page.locator(".device-edit").first();
  await expect(firstDevice).toBeVisible();
  await expect(firstDevice.locator("input").first()).toHaveValue("米家客厅吸顶灯");
  await firstDevice.getByRole("switch", { name: "米家客厅吸顶灯 首页收藏" }).click();
  await firstDevice.getByRole("switch", { name: "米家客厅吸顶灯 主屏隐藏" }).click();
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("配置已保存并同步至两屏")).toBeVisible();

  const homeControls = primary.locator(".home-control-list");
  await expect(homeControls.getByRole("button", { name: "查看米家客厅吸顶灯详情", exact: true })).toHaveCount(0);
  await expect(homeControls.getByRole("button", { name: "查看Aqara C3 窗帘详情", exact: true })).toBeVisible();

  await page.reload();
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await page.getByRole("button", { name: "房间与设备" }).click();
  await page.getByPlaceholder("搜索设备 / 房间 / 型号").fill("米家客厅吸顶灯");
  const persisted = page.locator(".device-edit").first();
  await expect(persisted.locator("input").first()).toHaveValue("米家客厅吸顶灯");
  await expect(persisted.getByRole("switch", { name: "米家客厅吸顶灯 主屏隐藏" })).toBeChecked();

  await page.getByPlaceholder("搜索设备 / 房间 / 型号").fill("水浸卫士 A");
  await expect(page.getByRole("switch", { name: "水浸卫士 A 主屏隐藏" })).toBeDisabled();
  await expect(page.getByText("安防设备保持可见")).toBeVisible();
  await primary.close();
});

test("后台按能力重映射副屏快捷设备并跨屏、刷新和备份持久化", async ({ page, context, request }) => {
  test.setTimeout(60_000);
  const secondary = await context.newPage();
  await secondary.goto("/secondary");
  await expect(secondary.getByRole("heading", { name: "米家客厅吸顶灯" })).toBeVisible();

  await page.goto("/admin");
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await page.getByRole("button", { name: "房间与设备" }).click();
  const lightSlot = page.getByTestId("secondary-slot-light");
  await lightSlot.click();
  await page.getByText("米家吸顶灯 350 · 卧室", { exact: true }).click();
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("配置已保存并同步至两屏")).toBeVisible();

  await expect(secondary.getByRole("heading", { name: "米家吸顶灯 350" })).toBeVisible();
  await expect(secondary.getByText("卧室 · 智能灯光")).toBeVisible();
  await expect(secondary.getByText("卧室控制", { exact: true })).toBeVisible();
  await secondary.getByRole("button", { name: "米家吸顶灯 350开启" }).click();
  await expect
    .poll(async () => {
      const response = await request.get("/api/v1/devices");
      const body = await response.json();
      return body.data.find((device: { id: string }) => device.id === "bedroom-light")?.state.power;
    })
    .toBe(true);

  await page.reload();
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await page.getByRole("button", { name: "房间与设备" }).click();
  await expect(page.getByTestId("secondary-slot-light")).toContainText("米家吸顶灯 350");

  const headers = await adminHeaders(request);
  const backupResponse = await request.get("/api/v1/admin/backup", { headers });
  const backup = (await backupResponse.json()).data;
  expect(backup.devices.find((device: { id: string }) => device.id === "bedroom-light")?.display.secondarySlot).toBe("light");

  const configResponse = await request.get("/api/v1/admin/config", { headers });
  const config = (await configResponse.json()).data;
  const music = config.devices.find((device: { display?: { secondarySlot?: string } }) => device.display?.secondarySlot === "music");
  music.display.secondarySlot = undefined;
  await request.put("/api/v1/admin/config", { headers, data: config });
  const emptyMusicSlot = secondary.getByRole("button", { name: "音乐 待配置" });
  await expect(emptyMusicSlot).toBeVisible();
  await emptyMusicSlot.click();
  await expect(secondary.getByText("音乐槽位没有可用设备")).toBeVisible();
  await secondary.close();
});

test("单台 EdgeCore 只管理本台网关且改名后双屏持续显示部署身份", async ({ page, context }) => {
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await primary.goto("/primary");
  await secondary.goto("/secondary");

  await expect(primary.getByTitle("当前控制域：1 号实训台网关")).toBeVisible();
  await expect(secondary.getByTitle("当前控制域：1 号实训台网关")).toBeVisible();
  await expect(secondary.getByText("1/1 网关在线", { exact: true }).first()).toBeVisible();

  await page.goto("/admin");
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await page.getByRole("button", { name: "网关配置" }).click();
  const gatewayName = page.getByRole("textbox", { name: "网关名称" }).first();
  await gatewayName.fill("2 号实训台网关");
  await page.getByRole("button", { name: "保存配置" }).click();

  await expect(primary.getByTitle("当前控制域：2 号实训台网关")).toBeVisible();
  await expect(secondary.getByTitle("当前控制域：2 号实训台网关")).toBeVisible();
  await expect(secondary.getByText("1/1 网关在线", { exact: true }).first()).toBeVisible();

  await primary.close();
  await secondary.close();
});
