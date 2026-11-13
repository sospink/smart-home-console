import { expect, test, type APIRequestContext } from "@playwright/test";

async function resetSimulation(request: APIRequestContext) {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const session = await login.json();
  await request.post("/api/v1/_test/reset", { data: {}, headers: { authorization: `Bearer ${session.data.token}` } });
}

test.beforeEach(async ({ page, request }) => {
  await resetSimulation(request);
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/secondary");
});

test("副屏长时断线显示退避倒计时并允许立即重连", async ({ page }) => {
  await page.goto("/secondary?edge=http://127.0.0.1:65534");

  const gate = page.locator(".startup-gate");
  await expect(gate).toBeVisible();
  await expect(gate).toContainText("本地控制服务不可达");
  await expect(gate).toContainText(/\d+ 秒后自动重试/);
  await expect(page.locator(".secondary-workspace")).toHaveCount(0);

  await gate.getByRole("button", { name: /\d+ 秒后自动重试/ }).click();
  await expect(gate).toBeVisible();
  await expect(gate).toContainText(/正在连接|\d+ 秒后自动重试/);
  await expect(gate).toContainText("127.0.0.1:65534");
});

test("副屏断网时停止无效重试并在网络恢复后立即重连", async ({ page, context }) => {
  await expect(page.locator(".connection.online")).toContainText("已连接");

  await context.setOffline(true);
  const lock = page.locator(".offline-lock");
  await expect(lock).toBeVisible();
  await expect(lock).toContainText("当前网络不可用");
  await expect(lock).toContainText("等待网络恢复");
  await expect(lock.getByRole("button", { name: "网络不可用" })).toBeDisabled();
  await expect(page.locator(".connection.offline")).toBeDisabled();

  await context.setOffline(false);
  await expect(page.locator(".connection.online")).toContainText("已连接");
  await expect(lock).toHaveCount(0);
});

test("副屏冷启动离线时展示跨进程只读缓存并在恢复后让位给权威状态", async ({ page, request }) => {
  await expect(page.locator(".connection.online")).toContainText("已连接");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((key) => key.startsWith("smart-lab:last-snapshot") && Boolean(localStorage.getItem(key)))
      )
    )
    .toBe(true);

  let edgeUnavailable = true;
  await page.route("**/api/v1/snapshot", (route) => (edgeUnavailable ? route.abort("connectionrefused") : route.continue()));
  await page.routeWebSocket(/\/api\/v1\/events/, (ws) => {
    if (edgeUnavailable) ws.close({ code: 1011, reason: "EdgeCore unavailable" });
    else ws.connectToServer();
  });
  await page.reload();

  const lock = page.locator(".offline-lock");
  await expect(lock).toContainText(/离线缓存 · (刚刚保存|\d+ 分钟前)/);
  await expect(lock).toContainText("仅供查看，所有控制已锁定");
  await expect(page.getByText(/上次同步 \d+ 个设备在线/)).toBeVisible();
  await expect(page.locator(".secondary-workspace")).toHaveClass(/readonly/);
  await expect(page.getByRole("button", { name: "全屋关灯" })).toBeDisabled();
  await expect(page.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".connection.offline")).toContainText("离线缓存");

  const authorityUpdate = await request.post("/api/v1/devices/living-main-light/commands", {
    data: { requestId: "offline-cache-authority", property: "brightness", value: 37, source: "primary" }
  });
  expect(authorityUpdate.ok()).toBe(true);
  edgeUnavailable = false;
  await lock.getByRole("button", { name: "立即重连" }).click();
  await expect(page.locator(".connection.online")).toContainText("已连接");
  await expect(lock).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" })).toHaveAttribute("aria-valuenow", "37");
});

test("副屏能识别不关闭但已停止收包的假在线连接并自动更换", async ({ page }) => {
  test.setTimeout(30_000);
  let connections = 0;
  await page.routeWebSocket(/\/api\/v1\/events/, (ws) => {
    connections += 1;
    const server = ws.connectToServer();
    if (connections !== 1) return;
    let forwarded = false;
    server.onMessage((message) => {
      if (forwarded) return;
      forwarded = true;
      ws.send(message);
    });
  });

  await page.goto("/secondary");
  await expect(page.locator(".connection.online")).toContainText("已连接");
  const lock = page.locator(".offline-lock");
  await expect(lock).toContainText("实时状态已停止更新", { timeout: 19_000 });
  await expect(lock).toContainText("心跳已超时");
  await expect(page.locator(".secondary-workspace")).toHaveClass(/readonly/);
  await expect(page.locator(".connection.online")).toContainText("已连接", { timeout: 5_000 });
  expect(connections).toBeGreaterThanOrEqual(2);
});

test("副屏三类聚焦控制均写入权威设备状态", async ({ page }) => {
  const brightness = page.getByRole("slider", { name: "米家客厅吸顶灯亮度，上下滑动调节" });
  await brightness.press("ArrowRight");
  await expect(brightness).toHaveAttribute("aria-valuenow", "69");

  await page.getByRole("button", { name: "窗帘" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByLabel("Aqara C3 窗帘开合位置")).toHaveValue("0");

  await page.getByRole("button", { name: "音乐" }).click();
  await page.getByRole("button", { name: "背景音乐关闭" }).click();
  await expect(page.getByRole("button", { name: "背景音乐开启" })).toBeVisible();
});

test("窗帘空间控制器由真实开合状态驱动并保留完整触控动作", async ({ page }) => {
  await page.getByRole("button", { name: "窗帘" }).click();
  const stage = page.getByTestId("curtain-spatial-control");
  await expect(stage).toBeVisible();
  const initialPosition = Number(await page.getByLabel("Aqara C3 窗帘开合位置").inputValue());
  await expect(stage).toHaveCSS("--curtain-panel-width", `${50 - initialPosition * 0.42}%`);

  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByLabel("Aqara C3 窗帘开合位置")).toHaveValue("0");
  await expect(stage).toHaveCSS("--curtain-panel-width", "50%");

  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.getByLabel("Aqara C3 窗帘开合位置")).toHaveValue("100");
  await expect(stage).toHaveCSS("--curtain-panel-width", "8%");
});

test("副屏全屋关灯关闭当前已开启灯具", async ({ page }) => {
  const allOff = page.getByRole("button", { name: "全屋关灯" });
  await allOff.click();
  const dialog = page.getByRole("dialog", { name: "确认关闭全屋灯光" });
  await expect(dialog).toContainText("将关闭 3 盏灯");
  await expect(dialog).toContainText("中途失败时以操作回执为准");
  await dialog.getByRole("button", { name: "确认关闭 3 盏灯" }).click();
  await expect(allOff).toContainText("当前均已关闭");
});

test("副屏取消全屋关灯不会创建命令并把焦点归还总控", async ({ page, request }) => {
  const allOff = page.getByRole("button", { name: "全屋关灯" });
  const before = (await (await request.get("/api/v1/snapshot")).json()).data.commands.length;
  await allOff.click();
  const dialog = page.getByRole("dialog", { name: "确认关闭全屋灯光" });
  await expect(page.locator("main.secondary-shell")).toHaveAttribute("inert", "");
  await expect(dialog.getByRole("list", { name: "本次将关闭的灯具" }).getByRole("listitem")).toHaveCount(3);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("[role=dialog]") !== null)).toBe(true);
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(allOff).toBeFocused();
  const after = (await (await request.get("/api/v1/snapshot")).json()).data.commands.length;
  expect(after).toBe(before);
});

test("副屏全屋关灯确认清单随实时状态收缩且不向已关闭灯具重复下发", async ({ page, request }) => {
  await page.getByRole("button", { name: "全屋关灯" }).click();
  const dialog = page.getByRole("dialog", { name: "确认关闭全屋灯光" });
  await expect(dialog.getByRole("listitem")).toHaveCount(3);

  const external = await request.post("/api/v1/devices/downlight-a/commands", {
    data: { requestId: "bulk-preview-external-change", property: "power", value: false, source: "primary" }
  });
  expect(external.ok()).toBe(true);
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("status")).toContainText("清单已按当前可控状态更新");
  await dialog.getByRole("button", { name: "确认关闭 2 盏灯" }).click();

  const snapshot = (await (await request.get("/api/v1/snapshot")).json()).data;
  expect(
    snapshot.commands.filter(
      (command: { deviceId: string; source: string; property: string; value: boolean }) =>
        command.deviceId === "downlight-a" && command.source === "secondary" && command.property === "power" && command.value === false
    )
  ).toHaveLength(0);
});

test("副屏只总控声明可写电源能力的在线灯具", async ({ page, request }) => {
  const headers = {
    authorization: `Bearer ${(await (await request.post("/api/v1/admin/login", { data: { pin: "2468" } })).json()).data.token}`
  };
  const config = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  const unsupported = config.devices.find((device: { id: string }) => device.id === "downlight-b");
  unsupported.state.power = true;
  unsupported.capabilities = unsupported.capabilities.filter((capability: { property: string }) => capability.property !== "power");
  await request.put("/api/v1/admin/config", { headers, data: config });

  const allOff = page.getByRole("button", { name: "全屋关灯" });
  await expect(allOff).toContainText("1 盏不可总控");
  await allOff.click();
  const dialog = page.getByRole("dialog", { name: "确认关闭全屋灯光" });
  await expect(dialog).toContainText("另有 1 盏离线或不支持总控，本次不会操作");
  await dialog.getByRole("button", { name: "确认关闭 3 盏灯" }).click();
  await expect(allOff).toContainText("1 盏不可总控");
  const devices = (await (await request.get("/api/v1/devices")).json()).data;
  expect(devices.find((device: { id: string }) => device.id === "downlight-b").state.power).toBe(true);
});

test("副屏在安防数据不完整时不宣称空间安全或门窗关闭", async ({ page, request }) => {
  const headers = {
    authorization: `Bearer ${(await (await request.post("/api/v1/admin/login", { data: { pin: "2468" } })).json()).data.token}`
  };
  await request.post("/api/v1/admin/alerts/alert-model-review/recover", { headers });
  await request.post("/api/v1/_test/faults", { headers, data: { targetId: "door-sensor", kind: "offline" } });

  await expect(page.getByText("状态不完整", { exact: true })).toHaveCount(1);
  await expect(page.getByText("1/2 传感器在线")).toBeVisible();
  await expect(page.getByText("有事件待确认", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看告警：监控链路不可用" })).toBeVisible();
  await expect(page.getByText("空间安全", { exact: true })).toHaveCount(0);

  const config = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  for (const device of config.devices.filter((item: { capabilities: Array<{ property: string }> }) =>
    item.capabilities.some((capability) => capability.property === "contact")
  )) {
    device.capabilities = device.capabilities.filter((capability: { property: string }) => capability.property !== "contact");
    delete device.state.contact;
  }
  await request.put("/api/v1/admin/config", { headers, data: config });
  await expect(page.getByText("门窗待配置", { exact: true })).toBeVisible();
  await expect(page.getByText("未发现门窗传感器")).toBeVisible();
  await expect(page.getByText("门窗已关", { exact: true })).toHaveCount(0);
});

test("副屏告警详情可失败重试并以本屏来源完成权威确认", async ({ page, request }) => {
  const headers = {
    authorization: `Bearer ${(await (await request.post("/api/v1/admin/login", { data: { pin: "2468" } })).json()).data.token}`
  };
  await request.post("/api/v1/_test/faults", { headers, data: { targetId: "water-sensor", kind: "water-leak" } });

  await page.getByRole("button", { name: "查看告警：检测到水浸" }).click();
  const dialog = page.getByRole("dialog", { name: "检测到水浸" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".secondary-alert-backdrop")).toBeFocused();
  await expect(dialog).toContainText("水浸卫士 A");
  await expect(dialog).toContainText("确认仅表示操作员已知悉");
  await expect(dialog).toContainText("待确认");

  await page.route(
    "**/api/v1/alerts/*/acknowledge",
    async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "EDGECORE_WRITE_FAILED" }) });
    },
    { times: 1 }
  );
  await dialog.getByRole("button", { name: "确认已知悉" }).click();
  await expect(dialog.getByRole("alert")).toContainText("EDGECORE_WRITE_FAILED");
  await expect(dialog.getByRole("button", { name: "重试确认" })).toBeVisible();

  await dialog.getByRole("button", { name: "重试确认" }).click();
  await expect(dialog).toContainText("已确认，等待设备恢复");
  await expect(dialog.getByRole("button", { name: "已确认" })).toBeDisabled();
  await expect(page.getByText("异常处理中", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看告警：检测到水浸" })).toBeVisible();

  const alertId = (await (await request.get("/api/v1/alerts")).json()).data.find(
    (item: { title: string }) => item.title === "检测到水浸"
  ).id;
  const blockedRecovery = await request.post(`/api/v1/admin/alerts/${alertId}/recover`, { headers });
  expect(blockedRecovery.status()).toBe(409);
  await expect(page.getByText("异常处理中", { exact: true })).toBeVisible();
  await request.post("/api/v1/_test/faults", { headers, data: { targetId: "water-sensor", kind: "clear-water-leak" } });
  await expect(page.getByRole("button", { name: "查看告警：检测到水浸" })).toHaveCount(0);

  const audits = await request.get("/api/v1/admin/resources/audits?q=%E7%A1%AE%E8%AE%A4%E5%91%8A%E8%AD%A6", { headers });
  const auditBody = await audits.json();
  expect(auditBody.data.items[0].source).toBe("secondary");
});

test("副屏多告警摘要优先持续展示未恢复的紧急告警", async ({ page, request }) => {
  const headers = {
    authorization: `Bearer ${(await (await request.post("/api/v1/admin/login", { data: { pin: "2468" } })).json()).data.token}`
  };
  await request.post("/api/v1/_test/faults", { headers, data: { targetId: "water-sensor", kind: "water-leak" } });

  const trigger = page.getByRole("button", { name: "查看告警：检测到水浸" });
  await expect(trigger).toContainText("2 条待确认");
  await trigger.click();
  await page.getByRole("dialog", { name: "检测到水浸" }).getByRole("button", { name: "确认已知悉" }).click();
  await page.getByRole("dialog", { name: "检测到水浸" }).getByRole("button", { name: "稍后处理" }).click();

  await expect(page.getByText("异常处理中", { exact: true })).toBeVisible();
  await expect(trigger).toContainText("1 条待确认 · 1 条处理中");
  await expect(trigger).toBeVisible();
});

test("副屏告警详情支持 Esc 关闭并把焦点归还摘要", async ({ page, request }) => {
  const headers = {
    authorization: `Bearer ${(await (await request.post("/api/v1/admin/login", { data: { pin: "2468" } })).json()).data.token}`
  };
  await request.post("/api/v1/_test/faults", { headers, data: { targetId: "water-sensor", kind: "water-leak" } });
  const trigger = page.getByRole("button", { name: "查看告警：检测到水浸" });
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "检测到水浸" })).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("副屏本地音源由真实浏览器音频元素播放", async ({ page }) => {
  await page.getByRole("button", { name: "音乐" }).click();
  await page.getByRole("button", { name: "播放音乐" }).click();

  const audio = page.locator("audio");
  await expect(page.getByRole("button", { name: "暂停音乐" })).toBeVisible();
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime)).toBeGreaterThan(0.2);
  await expect(audio).toHaveJSProperty("paused", false);

  await page.getByRole("button", { name: "下一首" }).click();
  await expect(page.getByRole("heading", { name: "安静夜色" })).toBeVisible();
  await expect(page.getByRole("button", { name: "暂停音乐" })).toBeVisible();
});

test("副屏场景按钮显示真实执行来源和当前场景", async ({ page }) => {
  const away = page.locator(".scene-action.scene-away");
  await away.click();
  await expect(away).toHaveClass(/running/);
  await expect(away).toContainText("本屏执行");
  await expect(away).toHaveClass(/completed/, { timeout: 6_000 });
  await expect(away).toContainText("本屏已完成");

  const home = page.locator(".scene-action.scene-home");
  await home.click();
  await expect(home).toHaveClass(/completed/, { timeout: 6_000 });
  await expect(away).toContainText("上次已执行");
  await expect(home).toContainText("本屏已完成");
});
