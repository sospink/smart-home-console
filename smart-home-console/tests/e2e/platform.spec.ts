import { expect, test, type APIRequestContext } from "@playwright/test";

async function adminHeaders(request: APIRequestContext) {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const body = await login.json();
  return { authorization: `Bearer ${body.data.token}` };
}

test.beforeEach(async ({ request }) => {
  await request.post("/api/v1/_test/reset", { data: {}, headers: await adminHeaders(request) });
});

test("主屏控制同步到副屏且显示确认来源", async ({ browser }) => {
  const context = await browser.newContext();
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await Promise.all([primary.goto("/primary"), secondary.goto("/secondary")]);
  await primary.getByRole("button", { name: "设备", exact: true }).click();
  await primary.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" }).press("ArrowUp");
  await expect(secondary.locator(".sync-pulse.confirmed")).toContainText("主屏同步");
  await context.close();
});

test("副屏控制同步到主屏", async ({ browser }) => {
  const context = await browser.newContext();
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await Promise.all([primary.goto("/primary"), secondary.goto("/secondary")]);
  await secondary.getByRole("button", { name: "米家客厅吸顶灯关闭" }).click();
  await expect(primary.locator(".sync-pulse.confirmed")).toContainText("副屏同步");
  await context.close();
});

test("重复触控由客户端节流且 EdgeCore 只执行一次", async ({ page, request }) => {
  await page.goto("/primary");
  await page.getByRole("button", { name: "设备", exact: true }).click();
  const increase = page.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" });
  await Promise.all([increase.press("ArrowUp"), increase.press("ArrowUp")]);
  await expect(page.locator(".device-detail")).toContainText("69%");

  const snapshot = await request.get("/api/v1/snapshot");
  const body = await snapshot.json();
  expect(
    body.data.commands.filter(
      (item: { deviceId: string; property: string; value: number }) =>
        item.deviceId === "living-main-light" && item.property === "brightness" && item.value === 69
    )
  ).toHaveLength(1);
});

test("连续数值拖动只在松手时提交一次命令", async ({ page, request }) => {
  await page.goto("/primary");
  await page.getByRole("button", { name: "设备", exact: true }).click();
  await page.locator(".device-card").filter({ hasText: "Aqara C3 窗帘" }).click();
  const slider = page.getByRole("slider", { name: "Aqara C3 窗帘开合位置" });
  const requests: number[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/devices/curtain-c3/commands") && request.method() === "POST") requests.push(Date.now());
  });

  const box = await slider.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width * 0.72, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.move(box!.x + box!.width * 0.64, box!.y + box!.height / 2, { steps: 8 });
  expect(requests).toHaveLength(0);
  await page.mouse.up();

  await expect.poll(() => requests.length).toBe(1);
  await expect(slider).toBeDisabled();
  await expect(slider).toBeEnabled();
  const snapshot = (await (await request.get("/api/v1/snapshot")).json()).data;
  expect(
    snapshot.commands.filter(
      (item: { deviceId: string; property: string }) => item.deviceId === "curtain-c3" && item.property === "position"
    )
  ).toHaveLength(1);
});

test("连续数值被设备拒绝或确认超时后恢复权威值并重新可用", async ({ page, request }) => {
  await page.goto("/primary");
  await page.getByRole("button", { name: "设备", exact: true }).click();
  await page.locator(".device-card").filter({ hasText: "Aqara C3 窗帘" }).click();
  const slider = page.getByRole("slider", { name: "Aqara C3 窗帘开合位置" });
  const control = page.getByTestId("continuous-curtain-c3-position");
  const initial = await slider.inputValue();
  const headers = await adminHeaders(request);

  await request.post("/api/v1/_test/faults", {
    data: { targetId: "curtain-c3", kind: "fail-next-command" },
    headers
  });
  await control.getByRole("button", { name: "半开" }).click();
  await expect(slider).toBeDisabled();
  await expect(control).toHaveClass(/failed/, { timeout: 2_000 });
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue(initial);

  await request.post("/api/v1/_test/faults", {
    data: { targetId: "curtain-c3", kind: "timeout-next-command" },
    headers
  });
  await control.getByRole("button", { name: "全开" }).click();
  await expect(slider).toBeDisabled();
  await expect(control).toHaveClass(/timeout/, { timeout: 2_000 });
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue(initial);
});

test("副屏窗帘拖动即时预览且只在松手后提交一次", async ({ page, request }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/secondary");
  await page.getByRole("button", { name: "窗帘" }).click();
  const slider = page.getByRole("slider", { name: "Aqara C3 窗帘开合位置" });
  const stage = page.getByTestId("curtain-spatial-control");
  const beforeWidth = await stage.evaluate((element) => getComputedStyle(element).getPropertyValue("--curtain-panel-width"));
  const requests: number[] = [];
  page.on("request", (commandRequest) => {
    if (commandRequest.url().includes("/api/v1/devices/curtain-c3/commands") && commandRequest.method() === "POST") {
      requests.push(Date.now());
    }
  });

  const box = await slider.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width * 0.72, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.46, box!.y + box!.height / 2, { steps: 8 });
  const previewWidth = await stage.evaluate((element) => getComputedStyle(element).getPropertyValue("--curtain-panel-width"));
  expect(previewWidth).not.toBe(beforeWidth);
  expect(requests).toHaveLength(0);
  await page.mouse.move(box!.x + box!.width * 0.61, box!.y + box!.height / 2, { steps: 8 });
  expect(requests).toHaveLength(0);
  await page.mouse.up();

  await expect.poll(() => requests.length).toBe(1);
  await expect(slider).toBeDisabled();
  await expect(slider).toBeEnabled();
  const commands = (await (await request.get("/api/v1/snapshot")).json()).data.commands.filter(
    (item: { deviceId: string; property: string }) => item.deviceId === "curtain-c3" && item.property === "position"
  );
  expect(commands).toHaveLength(1);
});

test("副屏音乐音量拖动只提交一次且失败或超时后恢复权威值", async ({ page, request }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/secondary");
  await page.getByRole("button", { name: "音乐" }).click();

  const slider = page.getByRole("slider", { name: "背景音乐音量" });
  const player = page.locator(".music-focus");
  const initial = await slider.inputValue();
  const requests: number[] = [];
  page.on("request", (commandRequest) => {
    if (commandRequest.url().includes("/api/v1/devices/music-r11/commands") && commandRequest.method() === "POST") {
      requests.push(Date.now());
    }
  });

  const dragTo = async (ratio: number) => {
    const box = await slider.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + box!.width * 0.36, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * ratio, box!.y + box!.height / 2, { steps: 10 });
    expect(requests).toHaveLength(0);
    await page.mouse.up();
  };

  const headers = await adminHeaders(request);
  await request.post("/api/v1/_test/faults", {
    data: { targetId: "music-r11", kind: "fail-next-command" },
    headers
  });
  await dragTo(0.72);
  await expect.poll(() => requests.length).toBe(1);
  await expect(slider).toBeDisabled();
  await expect(player).toHaveClass(/failed/, { timeout: 2_000 });
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue(initial);

  requests.length = 0;
  await request.post("/api/v1/_test/faults", {
    data: { targetId: "music-r11", kind: "timeout-next-command" },
    headers
  });
  await dragTo(0.58);
  await expect.poll(() => requests.length).toBe(1);
  await expect(slider).toBeDisabled();
  await expect(player).toHaveClass(/timeout/, { timeout: 2_000 });
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue(initial);

  const commands = (await (await request.get("/api/v1/snapshot")).json()).data.commands.filter(
    (item: { deviceId: string; property: string }) => item.deviceId === "music-r11" && item.property === "volume"
  );
  expect(commands).toHaveLength(2);
  expect(commands.map((item: { status: string }) => item.status)).toEqual(["timeout", "failed"]);
});

test("新增温度角度和模式能力无需型号特例即可生成友好控件", async ({ page, request }) => {
  const headers = await adminHeaders(request);
  const config = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  const panel = config.devices.find((device: { id: string }) => device.id === "home-panel");
  panel.state.targetTemperature = 23;
  panel.state.tiltAngle = 90;
  panel.state.airflowMode = "auto";
  panel.capabilities.push(
    {
      property: "targetTemperature",
      label: "目标温度",
      type: "number",
      min: 16,
      max: 30,
      step: 0.5,
      unit: "℃",
      writable: true
    },
    { property: "tiltAngle", label: "倾角", type: "number", min: 0, max: 180, step: 5, unit: "°", writable: true },
    {
      property: "airflowMode",
      label: "风向模式",
      type: "enum",
      writable: true,
      options: [
        { label: "自动", value: "auto" },
        { label: "上送风", value: "up" },
        { label: "下送风", value: "down" }
      ]
    }
  );
  expect((await request.put("/api/v1/admin/config", { headers, data: config })).ok()).toBe(true);

  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/primary");
  await page.getByRole("button", { name: "设备", exact: true }).click();
  await page.locator(".device-card").filter({ hasText: "小米智能家庭面板" }).click();

  const temperature = page.getByTestId("continuous-home-panel-targetTemperature");
  const angle = page.getByTestId("continuous-home-panel-tiltAngle");
  await expect(temperature.getByRole("slider", { name: "小米智能家庭面板目标温度" })).toHaveValue("23");
  await expect(temperature.getByRole("button", { name: "低" })).toBeVisible();
  await expect(temperature.getByRole("button", { name: "舒适" })).toBeVisible();
  await expect(temperature.getByRole("button", { name: "高" })).toBeVisible();
  await expect(angle.getByRole("slider", { name: "小米智能家庭面板倾角" })).toHaveValue("90");
  await expect(angle.getByRole("button", { name: "最小" })).toBeVisible();
  await expect(angle.getByRole("button", { name: "居中" })).toBeVisible();
  await expect(angle.getByRole("button", { name: "最大" })).toBeVisible();
  await expect(page.locator(".device-detail").getByText("风向模式", { exact: true })).toBeVisible();
  await expect(page.locator(".device-detail").getByRole("button", { name: "+", exact: true })).toHaveCount(0);
  await expect(page.locator(".device-detail").getByRole("button", { name: "−", exact: true })).toHaveCount(0);

  const temperatureSlider = temperature.getByRole("slider", { name: "小米智能家庭面板目标温度" });
  await temperatureSlider.press("ArrowUp");
  await expect(temperatureSlider).toBeDisabled();
  await expect(temperatureSlider).toBeEnabled();
  await expect(temperatureSlider).toHaveValue("23.5");
  await page.locator(".device-detail").getByRole("button", { name: "上送风" }).click();
  await expect
    .poll(async () => {
      const snapshot = (await (await request.get("/api/v1/snapshot")).json()).data;
      const device = snapshot.devices.find((item: { id: string }) => item.id === "home-panel");
      return [device.state.targetTemperature, device.state.airflowMode];
    })
    .toEqual([23.5, "up"]);
  await page.screenshot({ path: "output/playwright/detail-capability-driven-temperature-angle-1024x600.png" });
});

test("同一设备不同属性可并行等待确认且任一完成不会清除另一条", async ({ page, request }) => {
  await page.goto("/primary");
  await page.getByRole("button", { name: "设备", exact: true }).click();

  const brightness = page.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" });
  const power = page.getByRole("button", { name: "米家客厅吸顶灯 电源", exact: true }).first();
  const requestedProperties: string[] = [];
  page.on("request", (commandRequest) => {
    if (!commandRequest.url().includes("/api/v1/devices/living-main-light/commands") || commandRequest.method() !== "POST") return;
    const property = commandRequest.postDataJSON()?.property;
    if (typeof property === "string") requestedProperties.push(property);
  });
  await brightness.press("ArrowUp");
  await page.waitForTimeout(300);
  await power.click();

  await expect(brightness).toHaveAttribute("aria-disabled", "true");
  await expect(power).toBeDisabled();
  expect(new Set(requestedProperties)).toEqual(new Set(["power", "brightness"]));

  await expect
    .poll(async () => {
      const snapshot = (await (await request.get("/api/v1/snapshot")).json()).data;
      return Object.fromEntries(
        snapshot.commands
          .filter(
            (item: { deviceId: string; property: string }) =>
              item.deviceId === "living-main-light" && ["power", "brightness"].includes(item.property)
          )
          .map((item: { property: string; status: string }) => [item.property, item.status])
      );
    })
    .toEqual({ power: "pending", brightness: "confirmed" });
  await expect(brightness).toHaveAttribute("aria-disabled", "false");
  await expect(power).toBeDisabled();
  await expect(page.locator(".device-card").filter({ hasText: "米家客厅吸顶灯" })).toHaveClass(/pending/);

  await expect(brightness).toHaveAttribute("aria-disabled", "false");
  await expect(power).toBeEnabled();
  const settled = (await (await request.get("/api/v1/snapshot")).json()).data.commands.filter(
    (item: { deviceId: string; property: string }) =>
      item.deviceId === "living-main-light" && ["power", "brightness"].includes(item.property)
  );
  expect(settled.slice(0, 2).every((item: { status: string }) => item.status === "confirmed")).toBe(true);
});

test("双屏并发场景与设备控制被明确拒绝且完成后自动恢复", async ({ browser, request }) => {
  const context = await browser.newContext();
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await Promise.all([primary.goto("/primary"), secondary.goto("/secondary")]);
  await primary.getByRole("button", { name: "场景", exact: true }).click();

  await primary.getByRole("button", { name: "执行回家场景（6 项动作）" }).click();
  await expect(primary.locator(".spatial-core")).toHaveClass(/running/);

  const away = secondary.locator(".scene-action.scene-away");
  await expect(away).toBeDisabled();
  await expect(away).toContainText("主屏正在执行回家");

  const rejectedScene = await request.post("/api/v1/scenes/scene-away/execute", { data: { source: "secondary" } });
  expect(rejectedScene.status()).toBe(409);
  expect((await rejectedScene.json()).error).toBe("SCENE_EXECUTION_CONFLICT:回家:primary");

  await secondary.getByRole("button", { name: /米家客厅吸顶灯(?:开启|关闭)/ }).click();
  await expect(secondary.locator(".operation-notice")).toContainText("设备正在响应其他操作");
  await expect(secondary.locator(".operation-notice")).toContainText("场景或另一终端占用");

  const during = (await (await request.get("/api/v1/snapshot")).json()).data;
  expect(during.executions.filter((item: { status: string }) => item.status === "running")).toHaveLength(1);
  expect(
    during.commands.some((item: { source: string; requestId: string }) => item.source === "secondary" && !item.requestId.includes(":"))
  ).toBe(false);

  await expect(primary.locator(".spatial-core")).toHaveClass(/completed/, { timeout: 6_000 });
  await expect(away).toBeEnabled();
  await away.click();
  await expect(away).toHaveClass(/running/);
  await expect(away).toHaveClass(/completed/, { timeout: 6_000 });
  await context.close();
});

test("副屏执行四场景时主屏同步聚焦来源、进度与当前生效状态", async ({ browser }) => {
  const context = await browser.newContext();
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await Promise.all([primary.goto("/primary"), secondary.goto("/secondary")]);

  for (const [scene, sceneId, kind] of [
    ["回家", "scene-home", "home"],
    ["离家", "scene-away", "away"],
    ["观影", "scene-movie", "movie"],
    ["夜间", "scene-sleep", "sleep"]
  ] as const) {
    const button = secondary.locator(`.scene-action.scene-${kind}`);
    await button.click();
    await expect(button).toHaveClass(/running/);
    await expect(primary.locator(".spatial-core")).toHaveAttribute("data-scene", kind);
    await expect(primary.locator(".spatial-core")).toHaveAttribute("data-source", "secondary");
    await expect(primary.locator(".spatial-core")).toContainText("副屏发起");
    await expect(button).toHaveClass(/completed/, { timeout: 6_000 });
    await expect(button).toContainText("本屏已完成");
    await expect(primary.locator(".scene-card.current")).toContainText(`${scene}模式`);
    await expect(primary.locator(".scene-card.current")).toContainText("当前生效");
    await expect(primary.locator(".spatial-core")).toHaveClass(new RegExp(`scene-${kind}`));
    await expect(primary.locator(".spatial-core")).toHaveClass(/completed/);
    await expect(primary.locator(".spatial-core .device-node")).toHaveCount(
      sceneId === "scene-home" ? 5 : sceneId === "scene-sleep" ? 3 : 4
    );
  }

  await expect(primary.locator(".scene-card").filter({ hasText: "回家模式" })).toContainText("上次已执行");
  await context.close();
});

test("管理端水浸事件同步到两屏", async ({ browser, request }) => {
  const context = await browser.newContext();
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await Promise.all([primary.goto("/primary"), secondary.goto("/secondary")]);
  await request.post("/api/v1/_test/faults", {
    data: { targetId: "water-sensor", kind: "water-leak" },
    headers: await adminHeaders(request)
  });
  await expect(primary.locator(".critical-strip")).toBeVisible();
  await expect(secondary.locator(".home-brief")).toContainText("检测到水浸");
  await context.close();
});

test("网关离线级联禁用所属设备但不误伤独立 WiFi 设备", async ({ browser, request }) => {
  const context = await browser.newContext();
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await Promise.all([primary.goto("/primary"), secondary.goto("/secondary")]);
  await primary.getByRole("button", { name: "设备", exact: true }).click();

  await request.post("/api/v1/_test/faults", {
    data: { targetId: "gateway-main", kind: "offline" },
    headers: await adminHeaders(request)
  });

  await expect(primary.locator(".device-card").filter({ hasText: "米家客厅吸顶灯" })).toHaveClass(/offline/);
  await expect(primary.locator(".device-detail")).toContainText("设备离线，数值为最后已知状态");
  await expect(primary.locator(".device-card").filter({ hasText: "米家客厅吸顶灯" })).toContainText("上次 68%");
  await expect(secondary.locator(".light-focus")).toContainText("设备离线，以下为最后已知状态");
  await expect(secondary.locator(".light-focus .light-reading")).toContainText("68%");
  await expect(secondary.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" })).toHaveAttribute("aria-disabled", "true");
  await expect(secondary.getByRole("button", { name: /米家客厅吸顶灯(?:开启|关闭)/ })).toBeDisabled();
  const devices = (await (await request.get("/api/v1/devices")).json()).data;
  expect(devices.find((item: { id: string }) => item.id === "living-main-light").health).toBe("offline");
  expect(devices.find((item: { id: string }) => item.id === "curtain-c3").health).toBe("offline");
  expect(devices.find((item: { id: string }) => item.id === "bedroom-light").health).toBe("online");
  await context.close();
});

test("安防节点离线形成可自动恢复的运维事件且不触发业务联动", async ({ browser, request }) => {
  const context = await browser.newContext();
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await Promise.all([primary.goto("/primary"), secondary.goto("/secondary")]);
  const headers = await adminHeaders(request);

  await request.post("/api/v1/_test/faults", {
    data: { targetId: "motion-sensor", kind: "offline" },
    headers
  });

  await expect(secondary.getByRole("button", { name: "查看告警：监控链路不可用" })).toBeVisible();
  await secondary.getByRole("button", { name: "查看告警：监控链路不可用" }).click();
  await expect(secondary.getByRole("dialog")).toContainText("运维事件");
  await expect(secondary.getByRole("dialog")).toContainText("当前无法确认安防状态");

  const openSnapshot = (await (await request.get("/api/v1/snapshot")).json()).data;
  const alert = openSnapshot.alerts.find(
    (item: { deviceId: string; title: string; recoveredAt?: string }) =>
      item.deviceId === "motion-sensor" && item.title === "监控链路不可用" && !item.recoveredAt
  );
  expect(alert.level).toBe("warning");
  expect(openSnapshot.commands.filter((item: { source: string }) => item.source === "automation")).toHaveLength(0);
  const blockedRecovery = await request.post(`/api/v1/admin/alerts/${alert.id}/recover`, { headers });
  expect(blockedRecovery.status()).toBe(409);

  await request.post("/api/v1/_test/faults", {
    data: { targetId: "motion-sensor", kind: "online" },
    headers
  });
  await expect(secondary.getByRole("button", { name: "查看告警：监控链路不可用" })).toHaveCount(0);
  const recoveredSnapshot = (await (await request.get("/api/v1/snapshot")).json()).data;
  expect(recoveredSnapshot.alerts.find((item: { id: string }) => item.id === alert.id).recoveredAt).toBeTruthy();
  expect(recoveredSnapshot.commands.filter((item: { source: string }) => item.source === "automation")).toHaveLength(0);
  await context.close();
});

test("主屏空间模型真实映射场景成功与设备确认", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/primary");
  await page.getByRole("button", { name: "场景", exact: true }).click();

  const spatial = page.locator(".spatial-core");
  await expect(spatial).toBeVisible();
  await expect(spatial).toHaveClass(/idle/);
  await expect(spatial.locator(".device-node")).toHaveCount(5);
  await expect(spatial).toContainText("场景待命");

  await page.getByRole("button", { name: "执行回家场景（6 项动作）" }).click();
  await expect(spatial).toHaveClass(/running/);
  await expect(spatial).toContainText("回家场景执行中");
  await expect(spatial).toHaveClass(/completed/, { timeout: 6_000 });
  await expect(spatial.locator(".device-node.confirmed")).toHaveCount(5);
  await expect(spatial).toContainText("回家环境已就绪");
  await expect(spatial).toContainText("6/6");
});

test("主屏场景卡只选择预览，独立执行按钮才创建权威场景", async ({ page, request }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/primary");
  await page.getByRole("button", { name: "场景", exact: true }).click();

  await page.getByRole("button", { name: /查看离家模式详情/ }).click();
  await expect(page.locator(".detail-title")).toContainText("场景详情：离家模式");
  const before = (await (await request.get("/api/v1/snapshot")).json()).data.executions.length;
  await page.waitForTimeout(250);
  const afterPreview = (await (await request.get("/api/v1/snapshot")).json()).data.executions.length;
  expect(afterPreview).toBe(before);

  await page.getByRole("button", { name: "执行离家场景（4 项动作）" }).click();
  await expect(page.locator(".spatial-core")).toHaveClass(/running/);
  await expect.poll(async () => (await (await request.get("/api/v1/snapshot")).json()).data.executions.length).toBe(before + 1);
});

test("主屏空间模型显示部分失败而非固定成功", async ({ page, request }) => {
  const headers = await adminHeaders(request);
  await request.post("/api/v1/_test/faults", {
    data: { targetId: "music-r11", kind: "fail-next-command" },
    headers
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/primary");
  await page.getByRole("button", { name: "场景", exact: true }).click();

  const spatial = page.locator(".spatial-core");
  await page.getByRole("button", { name: "执行回家场景（6 项动作）" }).click();
  await expect(spatial).toHaveClass(/partial/, { timeout: 6_000 });
  await expect(spatial.locator(".device-node.failed")).toHaveCount(1);
  await expect(spatial.locator(".device-node.confirmed")).toHaveCount(4);
  await expect(spatial).toContainText("部分设备未完成");
  await expect(spatial).toContainText("5/6");
});

for (const viewport of [
  { name: "primary-1920x1080", path: "/primary", width: 1920, height: 1080 },
  { name: "primary-1920x720", path: "/primary", width: 1920, height: 720 },
  { name: "primary-1024x600", path: "/primary", width: 1024, height: 600 },
  { name: "secondary-1024x600", path: "/secondary", width: 1024, height: 600 },
  { name: "admin-1024x600", path: "/admin", width: 1024, height: 600 },
  { name: "contract-1424x280", path: "/secondary", width: 1424, height: 280 }
]) {
  test(`目标视口无横向溢出 ${viewport.name}`, async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    await page.goto(viewport.path);
    if (viewport.path === "/admin") {
      await page.getByPlaceholder("输入管理员 PIN").fill("2468");
      await page.getByRole("button", { name: "进入工程管理" }).click();
      await page.getByRole("button", { name: "终端管理" }).click();
      await expect(page.getByText("物理终端", { exact: true })).toBeVisible();
    }
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await page.screenshot({ path: `output/playwright/${viewport.name}.png` });
    await page.close();
  });
}
