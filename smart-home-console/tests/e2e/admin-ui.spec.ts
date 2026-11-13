import { expect, test, type APIRequestContext } from "@playwright/test";

async function resetSimulation(request: APIRequestContext) {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const session = await login.json();
  await request.post("/api/v1/_test/reset", { data: {}, headers: { authorization: `Bearer ${session.data.token}` } });
}

function renameRoom(configuration: { rooms: Array<{ name: string }>; devices: Array<{ room: string }> }, index: number, name: string) {
  const previous = configuration.rooms[index].name;
  configuration.rooms[index].name = name;
  configuration.devices.filter((device) => device.room === previous).forEach((device) => (device.room = name));
}

test.beforeEach(async ({ page, request }) => {
  await resetSimulation(request);
  await page.goto("/admin");
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
});

test("Naive UI room controls edit and save server configuration", async ({ page }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().locator("input").first();
  await firstRoom.fill("客厅演示区");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(firstRoom).toHaveValue("客厅演示区");
});

test("管理配置加载失败不会半登录并主动吊销刚签发的会话", async ({ page }) => {
  let logoutRequests = 0;
  let logoutAuthorization = "";
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/v1/admin/logout")) return;
    logoutRequests += 1;
    logoutAuthorization = request.headers().authorization ?? "";
  });
  await page.route("**/api/v1/admin/config", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 503, json: { error: "EDGE_CONFIGURATION_UNAVAILABLE" } });
    else await route.continue();
  });

  await page.reload();
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await expect(page.getByText(/PIN 已通过，但权威管理配置未能加载/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "运行总览" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "进入工程管理" })).toBeVisible();
  expect(logoutRequests).toBe(1);
  expect(logoutAuthorization).toMatch(/^Bearer\s+\S+$/);

  await page.unroute("**/api/v1/admin/config");
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
});

test("设备安全复位先展示影响清单并保留配置与安全边界", async ({ page, request }) => {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  await request.post("/api/v1/devices/living-main-light/commands", {
    data: { requestId: "e2e-handover-light", property: "power", value: true, source: "admin" },
    headers
  });
  await request.post("/api/v1/_test/faults", { data: { targetId: "bedroom-light", kind: "offline" }, headers });

  let executeRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/admin/bench-reset")) executeRequests += 1;
  });
  await page.getByRole("button", { name: "复位检查" }).click();
  const dialog = page.getByRole("dialog", { name: "设备安全复位" });
  await expect(dialog).toContainText("审计记录");
  await expect(dialog.getByText(/门锁只读/)).toBeVisible();
  await expect(dialog.getByText(/卧室.*设备离线，需现场核对/)).toBeVisible();
  await dialog.getByRole("button", { name: "确认并逐台复位" }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(dialog.getByText(/复位已完成/)).toBeVisible();
  await expect(dialog.getByText(/人工核对/).first()).toBeVisible();
  expect(executeRequests).toBe(1);

  const snapshot = (await (await request.get("/api/v1/snapshot")).json()).data;
  expect(snapshot.devices.find((item: { id: string }) => item.id === "living-main-light").state.power).toBe(false);
  const audits = await request.get("/api/v1/admin/resources/audits?page=1&pageSize=100", { headers });
  expect((await audits.json()).data.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: "设备安全复位" })]));
});

test("设备复位策略保存后改变影响清单并进入配置备份", async ({ page, request }) => {
  const policy = page.getByLabel("设备复位策略");
  const coverPolicy = policy.locator(".n-select").nth(1);
  await coverPolicy.click();
  await coverPolicy.press("ArrowDown");
  await coverPolicy.press("Enter");
  await expect(coverPolicy).toContainText("完全打开");
  await policy.getByRole("textbox", { name: /联动抑制/ }).fill("12");
  await policy.getByRole("button", { name: "保存复位策略" }).click();
  await expect(page.getByText("配置已保存并同步至两屏")).toBeVisible();

  await page.getByRole("button", { name: "复位检查" }).click();
  const dialog = page.getByRole("dialog", { name: "设备安全复位" });
  await expect(dialog).toContainText("position → 100");
  await dialog.getByRole("button", { name: "取消" }).click();

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const backup = await request.get("/api/v1/admin/backup", { headers: { authorization: `Bearer ${token}` } });
  expect((await backup.json()).data.benchResetPolicy).toEqual({ power: "off", cover: "open", automationSuppressionSeconds: 12 });
});

test("运行交接留档后下一位值班员可读取风险和备注且重复触控只写一次", async ({ page, request }) => {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const reset = await request.post("/api/v1/admin/bench-reset", { data: {}, headers });
  expect([200, 207]).toContain(reset.status());
  const beforeAudits = await request.get("/api/v1/admin/resources/audits?page=1&pageSize=100", { headers });
  const beforeHandovers = (await beforeAudits.json()).data.items.filter(
    (item: { action: string }) => item.action === "完成运行交接"
  ).length;

  await page.getByRole("button", { name: "运行检查" }).click();
  const dialog = page.getByRole("dialog", { name: "运行交接检查" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("2–40 字，如：设备管理员").fill("值班员张工");
  await dialog.getByPlaceholder(/卧室灯已现场断电/).fill("卧室灯已断电，下一班勿送电");
  for (const checkbox of await dialog.locator('input[type="checkbox"]').all()) await checkbox.check();

  let completionRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/admin/handover/complete")) completionRequests += 1;
  });
  await dialog.getByRole("button", { name: "确认风险并留档" }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(dialog.getByText("交接已留档")).toBeVisible();
  await expect(dialog).toContainText("值班员张工");
  await expect(dialog).toContainText("卧室灯已断电，下一班勿送电");
  expect(completionRequests).toBe(1);
  await dialog.getByRole("button", { name: "完成" }).click();

  await page.getByRole("button", { name: "运行检查" }).click();
  const nextShift = page.getByRole("dialog", { name: "运行交接检查" });
  await expect(nextShift.getByText("最近一次交接")).toBeVisible();
  await expect(nextShift).toContainText("值班员张工");
  await expect(nextShift).toContainText("卧室灯已断电，下一班勿送电");

  const audits = await request.get("/api/v1/admin/resources/audits?page=1&pageSize=100", { headers });
  const handovers = (await audits.json()).data.items.filter((item: { action: string }) => item.action === "完成运行交接");
  expect(handovers).toHaveLength(beforeHandovers + 1);
});

test("unsaved configuration is visible and navigation requires an explicit decision", async ({ page }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().locator("input").first();
  await firstRoom.fill("未保存的房间名");
  await expect(page.getByText("有未保存修改")).toBeVisible();

  await page.getByRole("button", { name: "场景编排" }).click();
  await expect(page.getByRole("heading", { name: "房间与设备", exact: true })).toBeVisible();
  await expect(page.getByText("存在未保存修改")).toBeVisible();
  await page.getByRole("button", { name: "留在当前页" }).click();
  await expect(firstRoom).toHaveValue("未保存的房间名");

  await page.getByRole("button", { name: "场景编排" }).click();
  await page.getByRole("button", { name: "放弃修改" }).click();
  await expect(page.getByRole("heading", { name: "场景编排" })).toBeVisible();
  await expect(page.getByText("已与服务端同步")).toBeVisible();
});

test("刷新后必须重新验证并明确恢复仅含配置资源的本机草稿", async ({ page, request }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" });
  await firstRoom.fill("刷新后恢复的房间");
  await expect(page.getByText("有未保存修改")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("smart-lab.admin-configuration-draft.v1")), { timeout: 2_000 })
    .toContain("刷新后恢复的房间");

  const persisted = await page.evaluate(() => sessionStorage.getItem("smart-lab.admin-configuration-draft.v1"));
  expect(persisted).toContain("刷新后恢复的房间");
  expect(JSON.parse(persisted!).local).not.toHaveProperty("training");

  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByPlaceholder("输入管理员 PIN")).toBeVisible();
  await expect(page.getByText("刷新后恢复的房间")).not.toBeVisible();
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  const recovery = page.getByRole("dialog", { name: "发现上次中断留下的配置草稿" });
  await expect(recovery).toContainText("尚未写入 EdgeCore");
  await expect(recovery.getByRole("button", { name: "恢复草稿并检查" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(recovery).toBeVisible();
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"], dialog') !== null)).toBe(true);
  }
  await recovery.getByRole("button", { name: "丢弃草稿，使用服务端版本" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(recovery.getByRole("button", { name: "恢复草稿并检查" })).toBeFocused();
  await recovery.getByRole("button", { name: "恢复草稿并检查" }).click();
  await expect(page.getByRole("heading", { name: "房间与设备", exact: true })).toBeVisible();
  await expect(page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" })).toHaveValue("刷新后恢复的房间");
  await page.getByRole("button", { name: "保存配置" }).click();

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const saved = await request.get("/api/v1/admin/config", { headers: { authorization: `Bearer ${token}` } });
  expect((await saved.json()).data.rooms[0].name).toBe("刷新后恢复的房间");
  expect(await page.evaluate(() => sessionStorage.getItem("smart-lab.admin-configuration-draft.v1"))).toBeNull();
});

test("本机草稿存储短暂失败会自动重试且不会重复轰炸告警", async ({ page }) => {
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failuresRemaining = 3;
    Storage.prototype.setItem = function (key, value) {
      if (key === "smart-lab.admin-configuration-draft.v1" && failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new DOMException("temporary storage failure", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "房间与设备" }).click();
  await page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" }).fill("存储自愈后的房间");

  await expect(page.getByText(/本机安全草稿写入失败；系统会自动重试/)).toBeVisible({ timeout: 2_000 });
  await page.waitForTimeout(1_200);
  await expect(page.getByText(/本机安全草稿写入失败；系统会自动重试/)).toBeVisible();
  await expect(page.getByText("本机安全草稿已恢复写入")).toBeVisible({ timeout: 4_000 });
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("smart-lab.admin-configuration-draft.v1")))
    .toContain("存储自愈后的房间");
});

test("中断期间服务端版本变化时恢复草稿必须进入三方冲突流程", async ({ page, request }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  await page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" }).fill("恢复的本机值");
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("smart-lab.admin-configuration-draft.v1")), { timeout: 2_000 })
    .toContain("恢复的本机值");

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const latest = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  latest.scenes[0].name = "中断期间服务端新场景";
  expect((await request.put("/api/v1/admin/config", { headers, data: latest })).status()).toBe(200);

  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  const recovery = page.getByRole("dialog", { name: "发现上次中断留下的配置草稿" });
  await expect(recovery).toContainText(/当前服务端已是版本/);
  await recovery.getByRole("button", { name: "恢复草稿并检查" }).click();
  await expect(page.getByText("配置保存冲突", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看差异并合并" }).click();
  const conflict = page.locator(".configuration-conflict-preview");
  await expect(conflict.getByLabel("配置合并摘要")).toContainText(/仅本机修改 [1-9]\d*/);
  await expect(conflict.getByLabel("配置合并摘要")).toContainText("仅服务端修改 1");
});

test("dangerous deletion explains impact, supports cancel and remains pending until save", async ({ page }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const rows = page.locator(".edit-row");
  const count = await rows.count();
  await rows.first().getByRole("button", { name: "删除" }).click();
  await expect(page.getByText(/个设备将自动迁移|该房间没有归属设备/)).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(rows).toHaveCount(count);

  await rows.first().getByRole("button", { name: "删除" }).click();
  await page.getByRole("button", { name: "删除房间" }).click();
  await expect(rows).toHaveCount(count - 1);
  await expect(page.getByText("有未保存修改")).toBeVisible();
});

test("save failure keeps local edits and exposes a retry action", async ({ page }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().locator("input").first();
  await firstRoom.fill("保存失败仍保留");
  await page.route("**/api/v1/admin/config", async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 500, json: { error: "TEST_SAVE_FAILED" } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText(/保存失败：TEST_SAVE_FAILED/)).toBeVisible();
  await expect(page.locator(".global-operation-message .n-alert__icon")).toHaveCSS("color", "rgb(255, 93, 114)");
  await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
  await expect(firstRoom).toHaveValue("保存失败仍保留");
});

test("expired admin session preserves edits and resumes after PIN verification", async ({ page }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" });
  await firstRoom.fill("会话恢复后保存");
  await page.route("**/api/v1/admin/config", async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 401, json: { error: "ADMIN_AUTH_REQUIRED" } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("管理会话已过期")).toBeVisible();
  await expect(page.locator(".admin-workspace")).toHaveAttribute("inert", "");
  await expect(page.getByText(/未保存的配置仍保留在本机内存中/)).toBeVisible();

  await page.unroute("**/api/v1/admin/config");
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "恢复管理会话" }).click();
  await expect(page.getByText("会话已恢复，未保存修改仍保留")).toBeVisible();
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(firstRoom).toHaveValue("会话恢复后保存");
  await expect(page.getByText("已与服务端同步")).toBeVisible();
});

test("manual lock revokes the bearer session, hides management data and preserves local edits", async ({ page, request }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" });
  await firstRoom.fill("锁定后继续编辑");

  let logoutAuthorization = "";
  await page.route("**/api/v1/admin/logout", async (route) => {
    logoutAuthorization = route.request().headers().authorization ?? "";
    await route.continue();
  });
  await page.getByRole("button", { name: "立即锁定" }).click();

  await expect(page.getByRole("heading", { name: "管理台已锁定", exact: true })).toBeVisible();
  await expect(page.getByText("管理员已主动锁定本台设备，当前服务端会话已吊销。")).toBeVisible();
  await expect(page.getByText(/未保存的配置仍保留在本机内存中/)).toBeVisible();
  await expect(page.locator(".admin-workspace")).toHaveClass(/session-locked/);
  await expect(page.locator(".admin-workspace")).toHaveAttribute("inert", "");
  await expect(page.locator(".admin-workspace")).toHaveCSS("pointer-events", "none");
  expect(logoutAuthorization).toMatch(/^Bearer\s+\S+/);
  await expect
    .poll(async () => {
      const response = await request.get("/api/v1/admin/config", { headers: { authorization: logoutAuthorization } });
      return response.status();
    })
    .toBe(401);

  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "恢复管理会话" }).click();
  await expect(firstRoom).toHaveValue("锁定后继续编辑");
  await expect(page.getByText("有未保存修改")).toBeVisible();
});

test("重新验证时无本地修改会同步锁屏期间的服务端新版本", async ({ page, request }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  await page.getByRole("button", { name: "立即锁定" }).click();

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const latest = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  renameRoom(latest, 0, "轮班管理员已更新");
  expect((await request.put("/api/v1/admin/config", { headers, data: latest })).status()).toBe(200);

  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "恢复管理会话" }).click();
  await expect(page.getByText("管理会话已恢复，并已同步服务端最新配置")).toBeVisible();
  await expect(page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" })).toHaveValue("轮班管理员已更新");
  await expect(page.getByText("已与服务端同步")).toBeVisible();
});

test("重新验证保留本地修改并提前揭示锁屏期间的版本冲突", async ({ page, request }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" });
  await firstRoom.fill("本机尚未保存");
  await page.getByRole("button", { name: "立即锁定" }).click();

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const latest = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  renameRoom(latest, 0, "其他管理员新版本");
  expect((await request.put("/api/v1/admin/config", { headers, data: latest })).status()).toBe(200);

  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "恢复管理会话" }).click();
  await expect(page.getByText(/锁屏期间服务端配置已更新，本地修改仍保留/)).toBeVisible();
  await expect(page.getByText("配置保存冲突")).toBeVisible();
  await expect(page.getByText(/锁屏期间另一个管理会话已保存新版本/)).toBeVisible();
  await expect(firstRoom).toHaveValue("本机尚未保存");
  await expect(page.getByText("有未保存修改")).toBeVisible();
});

test("重新验证配置同步失败会保持锁屏并吊销刚签发的会话", async ({ page }) => {
  await page.getByRole("button", { name: "立即锁定" }).click();
  let logoutRequests = 0;
  let logoutAuthorization = "";
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/v1/admin/logout")) return;
    logoutRequests += 1;
    logoutAuthorization = request.headers().authorization ?? "";
  });
  await page.route("**/api/v1/admin/config", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 503, json: { error: "EDGE_CONFIGURATION_UNAVAILABLE" } });
    else await route.continue();
  });

  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "恢复管理会话" }).click();
  await expect(page.getByText(/PIN 已通过，但权威配置同步失败/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "管理台已锁定", exact: true })).toBeVisible();
  await expect(page.locator(".admin-workspace")).toHaveAttribute("inert", "");
  expect(logoutRequests).toBe(1);
  expect(logoutAuthorization).toMatch(/^Bearer\s+\S+$/);
});

test("ten minutes of inactivity warns first and then locks the management workspace", async ({ page }) => {
  await page.getByRole("button", { name: "退出管理" }).click();
  await page.clock.install({ time: new Date("2026-07-25T08:00:00+08:00") });
  await page.reload();
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();

  await page.clock.fastForward(8 * 60_000 + 1_000);
  const warning = page.getByRole("alert").filter({ hasText: "管理台即将自动锁定" });
  await expect(warning).toContainText(/1 分 \d{2} 秒\s+后隐藏管理数据/);
  await expect(page.getByRole("heading", { name: "管理台已锁定", exact: true })).toHaveCount(0);

  await page.clock.fastForward(2 * 60_000);
  await expect(page.getByRole("heading", { name: "管理台已锁定", exact: true })).toBeVisible();
  await expect(page.getByText("因 10 分钟无操作，管理数据已隐藏，当前服务端会话已吊销。")).toBeVisible();
  await expect(page.locator(".admin-workspace")).toHaveAttribute("aria-hidden", "true");
});

test("admin session warns before expiry instead of failing without notice", async ({ page }) => {
  await page.getByRole("button", { name: "退出管理" }).click();
  await page.route("**/api/v1/admin/login", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await route.fulfill({ response, json: body });
  });
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await expect(page.getByText("管理会话即将过期")).toBeVisible();
  await expect(page.getByText(/会话剩余 10 分/).first()).toBeVisible();
});

test("PIN 暴力尝试锁定会显示明确等待说明而非误报服务故障", async ({ page }) => {
  await page.getByRole("button", { name: "退出管理" }).click();
  await page.route("**/api/v1/admin/login", async (route) => {
    await route.fulfill({ status: 429, json: { error: "TOO_MANY_AUTH_ATTEMPTS" } });
  });
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await expect(page.getByText(/管理入口已锁定 15 分钟/)).toBeVisible();
  await expect(page.getByText(/管理服务暂不可用/)).toHaveCount(0);
  await expect(page.getByPlaceholder("输入管理员 PIN")).toHaveValue("");
  await expect(page.getByRole("button", { name: "进入工程管理" })).toBeDisabled();
});

test("管理员 PIN 轮换会先校验并在成功后回到登录页", async ({ page }) => {
  let posted = 0;
  await page.route("**/api/v1/admin/change-pin", async (route) => {
    posted += 1;
    expect(route.request().postDataJSON()).toEqual({ currentPin: "2468", newPin: "135790", confirmPin: "135790" });
    await route.fulfill({ status: 200, json: { data: true, sequence: 1 } });
  });
  await page.getByRole("button", { name: "轮换管理员 PIN", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const current = page.getByRole("textbox", { name: /current PIN|当前 PIN/i });
  const next = page.getByRole("textbox", { name: /^新 PIN/ });
  const confirmation = page.getByRole("textbox", { name: /再次输入新 PIN/ });
  await current.fill("2468");
  await next.fill("1234");
  await confirmation.fill("1234");
  await dialog.getByRole("button", { name: "确认轮换并吊销旧会话" }).click();
  await expect(dialog.getByText("新 PIN 必须为 6–12 位数字")).toBeVisible();
  expect(posted).toBe(0);

  await next.fill("135790");
  await confirmation.fill("135790");
  await dialog.getByRole("button", { name: "确认轮换并吊销旧会话" }).click();
  await expect(page.getByRole("heading", { name: "管理员验证" })).toBeVisible();
  await expect(page.getByText("管理员 PIN 已轮换；所有旧会话已吊销，请使用新 PIN 重新登录")).toBeVisible();
  expect(posted).toBe(1);
});

test("管理员 PIN 轮换失败会保留当前会话和输入", async ({ page }) => {
  await page.route("**/api/v1/admin/change-pin", (route) => route.fulfill({ status: 401, json: { error: "INVALID_CURRENT_ADMIN_PIN" } }));
  await page.getByRole("button", { name: "轮换管理员 PIN", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const current = page.getByRole("textbox", { name: /当前 PIN/ });
  await current.fill("000000");
  await page.getByRole("textbox", { name: /^新 PIN/ }).fill("135790");
  await page.getByRole("textbox", { name: /再次输入新 PIN/ }).fill("135790");
  await dialog.getByRole("button", { name: "确认轮换并吊销旧会话" }).click();
  await expect(dialog.getByText("当前 PIN 不正确")).toBeVisible();
  await expect(current).toHaveValue("000000");
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
});

test("管理员 PIN 轮换锁定会说明等待时间且不踢出当前会话", async ({ page }) => {
  await page.route("**/api/v1/admin/change-pin", (route) => route.fulfill({ status: 429, json: { error: "TOO_MANY_AUTH_ATTEMPTS" } }));
  await page.getByRole("button", { name: "轮换管理员 PIN", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await page.getByRole("textbox", { name: /当前 PIN/ }).fill("000000");
  await page.getByRole("textbox", { name: /^新 PIN/ }).fill("135790");
  await page.getByRole("textbox", { name: /再次输入新 PIN/ }).fill("135790");
  await dialog.getByRole("button", { name: "确认轮换并吊销旧会话" }).click();
  await expect(dialog.getByText(/PIN 轮换已锁定 15 分钟/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
});

test("stale admin session cannot overwrite newer server configuration and can reload safely", async ({ page, request }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().locator("input").first();
  await firstRoom.fill("旧会话本地修改");

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const latestResponse = await request.get("/api/v1/admin/config", { headers });
  const latest = (await latestResponse.json()).data;
  renameRoom(latest, 0, "其他会话已保存");
  expect((await request.put("/api/v1/admin/config", { headers, data: latest })).status()).toBe(200);

  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("配置保存冲突")).toBeVisible();
  await expect(page.getByText(/本页修改仍在，服务端内容未被覆盖/)).toBeVisible();
  await expect(firstRoom).toHaveValue("旧会话本地修改");

  await page.getByRole("button", { name: "放弃本地修改并重新载入" }).click();
  await page.getByRole("button", { name: "重新载入", exact: true }).click();
  await expect(firstRoom).toHaveValue("其他会话已保存");
  await expect(page.getByText("已与服务端同步")).toBeVisible();
});

test("配置冲突会自动合并不同记录上的修改并保持最新服务端版本", async ({ page, request }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" });
  await firstRoom.fill("本机房间修改");

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const latest = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  latest.scenes[0].name = "服务端场景修改";
  expect((await request.put("/api/v1/admin/config", { headers, data: latest })).status()).toBe(200);

  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("button", { name: "查看差异并合并" }).click();
  const dialog = page.locator(".configuration-conflict-preview");
  await expect(dialog).toContainText("核对多人配置冲突");
  await expect(dialog.getByLabel("配置合并摘要")).toContainText(/仅本机修改 [1-9]\d*/);
  await expect(dialog.getByLabel("配置合并摘要")).toContainText("仅服务端修改 1");
  await expect(dialog.getByLabel("配置合并摘要")).toContainText("同项冲突 0");
  await dialog.getByRole("button", { name: "生成合并草稿" }).click();
  await expect(firstRoom).toHaveValue("本机房间修改");
  await expect(page.getByText(/冲突已合并为本地草稿/)).toBeVisible();
  await page.getByRole("button", { name: "保存配置" }).click();

  const saved = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  expect(saved.rooms[0].name).toBe("本机房间修改");
  expect(saved.scenes[0].name).toBe("服务端场景修改");
});

test("同一配置记录被双方修改时必须逐项选择且只合并配置资源", async ({ page, request }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" });
  await firstRoom.fill("选择保留的本机值");

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const latest = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  renameRoom(latest, 0, "服务端竞争值");
  expect((await request.put("/api/v1/admin/config", { headers, data: latest })).status()).toBe(200);

  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("button", { name: "查看差异并合并" }).click();
  const dialog = page.locator(".configuration-conflict-preview");
  await expect(dialog).toContainText("核对多人配置冲突");
  await expect(dialog.getByText(/同一记录被双方改动时必须逐项决定/)).toBeVisible();
  await expect(dialog.getByText(/配置冲突只比较房间、设备、场景、联动、网关、终端与复位策略/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "生成合并草稿" })).toBeDisabled();
  const localChoices = dialog.getByRole("button", { name: "保留我的" });
  const choiceCount = await localChoices.count();
  expect(choiceCount).toBeGreaterThan(1);
  for (let index = 0; index < choiceCount; index += 1) await localChoices.nth(index).click();
  await expect(dialog.getByRole("button", { name: "生成合并草稿" })).toBeEnabled();
  await dialog.getByRole("button", { name: "生成合并草稿" }).click();
  await expect(firstRoom).toHaveValue("选择保留的本机值");
  await page.getByRole("button", { name: "保存配置" }).click();

  const saved = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  expect(saved.rooms[0].name).toBe("选择保留的本机值");
});

test("同项冲突可以采用服务端值且不会制造待保存草稿", async ({ page, request }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" });
  await firstRoom.fill("准备放弃的本机值");

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const latest = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  renameRoom(latest, 0, "明确采用的服务端值");
  expect((await request.put("/api/v1/admin/config", { headers, data: latest })).status()).toBe(200);

  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("button", { name: "查看差异并合并" }).click();
  const dialog = page.locator(".configuration-conflict-preview");
  await expect(dialog).toContainText("核对多人配置冲突");
  const serverChoices = dialog.getByRole("button", { name: "采用服务端" });
  const choiceCount = await serverChoices.count();
  expect(choiceCount).toBeGreaterThan(1);
  for (let index = 0; index < choiceCount; index += 1) await serverChoices.nth(index).click();
  await dialog.getByRole("button", { name: "生成合并草稿" }).click();
  await expect(firstRoom).toHaveValue("明确采用的服务端值");
  await expect(page.getByText("已与服务端同步")).toBeVisible();
  await expect(page.getByText("已采用服务端最新配置，无需再次保存")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存配置" })).toBeDisabled();
});

test("冲突差异读取失败会保留本地草稿并允许原位重试", async ({ page, request }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const firstRoom = page.locator(".edit-row").first().getByRole("textbox", { name: "房间名称" });
  await firstRoom.fill("读取失败也不能丢");

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const latest = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  latest.scenes[0].name = "制造服务端新版本";
  expect((await request.put("/api/v1/admin/config", { headers, data: latest })).status()).toBe(200);
  await page.getByRole("button", { name: "保存配置" }).click();

  await page.route("**/api/v1/admin/config", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 503, json: { error: "EDGE_CONFIGURATION_UNAVAILABLE" } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "查看差异并合并" }).click();
  await expect(page.getByText(/无法读取服务端最新配置/)).toBeVisible();
  await expect(page.locator(".configuration-conflict-preview")).toHaveCount(0);
  await expect(firstRoom).toHaveValue("读取失败也不能丢");
  await expect(page.getByText("有未保存修改")).toBeVisible();

  await page.unroute("**/api/v1/admin/config");
  await page.getByRole("button", { name: "查看差异并合并" }).click();
  await expect(page.locator(".configuration-conflict-preview")).toContainText("核对多人配置冲突");
});

test("admin controls use contained surfaces and pagination keeps focus clearance", async ({ page }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const row = page.locator(".edit-row").first();
  const input = row.locator(".n-input").first();
  const inputBorder = input.locator(".n-input__border");
  await expect(input).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(inputBorder).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");

  const sizePicker = page.locator('[data-resource="rooms"] .n-base-selection');
  const sizeLabel = sizePicker.locator(".n-base-selection-label");
  await expect(sizePicker).toHaveCSS("height", "44px");
  await expect(sizeLabel).toHaveCSS("height", "44px");
  const clearance = await page.locator('[data-resource="rooms"] .n-pagination').evaluate((pagination) => {
    const panel = document.querySelector(".list-panel");
    if (!panel) return -1;
    return Math.round(panel.getBoundingClientRect().right - pagination.getBoundingClientRect().right);
  });
  expect(clearance).toBeGreaterThanOrEqual(24);
  const documentWidth = await page
    .locator("html")
    .evaluate((html) => ({ scrollWidth: html.scrollWidth, viewportWidth: window.innerWidth }));
  expect(documentWidth.scrollWidth).toBe(documentWidth.viewportWidth);
});

for (const viewport of [
  { width: 800, height: 600 },
  { width: 1024, height: 600 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 }
]) {
  test(`${viewport.width}×${viewport.height} 九个后台工作页保持可读触控尺寸和常驻安全操作`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const workspaces = ["运行总览", "房间与设备", "场景编排", "自动联动", "告警中心", "网关配置", "终端管理", "配置备份", "审计日志"];

    for (const workspace of workspaces) {
      await page.getByRole("button", { name: workspace, exact: true }).click();
      await expect(page.getByRole("heading", { name: workspace, exact: true })).toBeVisible();

      const measurement = await page.locator(".admin-workspace").evaluate((root) => {
        const isVisible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        const actionable = [...root.querySelectorAll("button, .n-input, .n-base-selection")].filter((element) => {
          if (!isVisible(element)) return false;
          if (element.matches(".n-input *, .n-base-selection *")) return false;
          return !element.closest('[aria-hidden="true"]');
        });
        const undersized = actionable
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              label: (element.getAttribute("aria-label") || element.textContent || "未命名控件").trim().replace(/\s+/g, " ").slice(0, 50),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            };
          })
          .filter((item) => item.width < 44 || item.height < 44);
        const tinyText = [...root.querySelectorAll("small, label, button, p, .eyebrow")]
          .filter(
            (element) =>
              isVisible(element) && (element.textContent ?? "").trim() && Number.parseFloat(getComputedStyle(element).fontSize) < 11
          )
          .map((element) => ({
            text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50),
            size: getComputedStyle(element).fontSize
          }));
        const bounds = root.getBoundingClientRect();
        const lock = [...root.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("立即锁定"))
          ?.getBoundingClientRect();
        const logout = [...root.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("退出管理"))
          ?.getBoundingClientRect();
        return {
          undersized,
          tinyText,
          rootBottom: Math.round(bounds.bottom),
          viewportHeight: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          lockBottom: lock ? Math.round(lock.bottom) : null,
          logoutBottom: logout ? Math.round(logout.bottom) : null
        };
      });

      expect(measurement.undersized, `${workspace} 存在小于 44×44px 的核心触控面`).toEqual([]);
      expect(measurement.tinyText, `${workspace} 存在小于 11px 的业务文字`).toEqual([]);
      expect(measurement.rootBottom).toBe(measurement.viewportHeight);
      expect(measurement.documentWidth).toBe(measurement.viewportWidth);
      expect(measurement.lockBottom).toBeLessThanOrEqual(measurement.viewportHeight);
      expect(measurement.logoutBottom).toBeLessThanOrEqual(measurement.viewportHeight);
    }

    const sharedHeaderTargets = await page.locator(".system-header").evaluate((header) =>
      [...header.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          label: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "未命名顶栏按钮",
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      })
    );
    expect(
      sharedHeaderTargets.filter((target) => target.width < 44 || target.height < 44),
      "共享顶栏存在过小触控按钮"
    ).toEqual([]);

    const firstNavigationItem = page.getByRole("button", { name: "运行总览", exact: true });
    await firstNavigationItem.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(firstNavigationItem).toBeFocused();
    expect(
      await firstNavigationItem.evaluate((button) => {
        const style = getComputedStyle(button);
        return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
      })
    ).toBe(true);
  });
}

test("scene editor expands, reorders actions and stays operable", async ({ page }) => {
  await page.getByRole("button", { name: "场景编排" }).click();
  const scene = page.locator(".n-collapse-item").first();
  await scene.locator(".n-collapse-item__header-main").click();
  await expect(scene.getByPlaceholder("场景名称")).toBeVisible();
  await expect(scene.locator(".action-editor > div")).toHaveCount(6);
  await scene
    .getByRole("button", { name: /下移动作/ })
    .first()
    .click();
  await expect(scene.getByRole("button", { name: "保存并试运行" })).toBeEnabled();
});

test("scene and automation editors use capability-aware value controls", async ({ page, request }) => {
  await page.getByRole("button", { name: "场景编排" }).click();
  const scene = page.locator(".n-collapse-item").first();
  await scene.locator(".n-collapse-item__header-main").click();
  const actions = scene.locator(".action-editor > div");

  const powerValue = actions.nth(0).getByLabel(/电源 动作值/);
  await expect(powerValue).toContainText("开启 / 是");
  const brightnessValue = actions.nth(1).getByRole("textbox", { name: /亮度 动作值/ });
  await brightnessValue.fill("73");
  await expect(brightnessValue).toHaveValue("73");

  const curtainAction = actions.nth(2);
  const capability = curtainAction.locator(".n-select").nth(1);
  await capability.click();
  await page.getByText("电机", { exact: true }).last().click();
  const motorValue = curtainAction.getByLabel(/电机 动作值/);
  await motorValue.click();
  await expect(page.getByText("打开", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("停止", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("关闭", { exact: true }).last()).toBeVisible();
  await page.getByText("关闭", { exact: true }).last().click();
  await scene.getByRole("button", { name: "保存并试运行" }).click();
  await expect(page.getByText(/场景试运行：completed/)).toBeVisible();

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const saved = (await (await request.get("/api/v1/admin/config", { headers: { authorization: `Bearer ${token}` } })).json()).data;
  const savedScene = saved.scenes.find((item: { id: string }) => item.id === "scene-home");
  expect(savedScene.actions.find((item: { id: string }) => item.id === "home-2").value).toBe(73);
  expect(savedScene.actions.find((item: { id: string }) => item.id === "home-3").value).toBe("close");

  await page.getByRole("button", { name: "自动联动" }).click();
  await page.getByRole("button", { name: "创建第一条联动" }).click();
  const automation = page.locator(".automation-editor").first();
  const operator = automation.locator("label").filter({ hasText: "比较方式" }).locator(".n-select");
  await operator.click();
  await expect(page.getByText("等于", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("不等于", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("大于", { exact: true })).toHaveCount(0);
});

test("invalid configuration is explained before any save request is sent", async ({ page }) => {
  await page.getByRole("button", { name: "场景编排" }).click();
  const scene = page.locator(".n-collapse-item").first();
  await scene.locator(".n-collapse-item__header-main").click();
  await scene.getByPlaceholder("场景名称").fill("");
  await expect(page.getByText("保存前需要修正")).toBeVisible();
  await expect(page.getByText("场景名称不能为空")).toBeVisible();

  let saves = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/api/v1/admin/config")) saves += 1;
  });
  await page.getByRole("button", { name: "保存配置" }).click();
  expect(saves).toBe(0);
  await expect(page.getByText(/配置未保存：场景名称不能为空/)).toBeVisible();
});

test("场景与联动的失效设备能力引用会在提交前给出可执行说明", async ({ page }) => {
  await page.route("**/api/v1/admin/config", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.data.scenes[0].actions[0] = { deviceId: "missing-scene-device", property: "power", value: true };
    body.data.scenes[0].actions.push({
      id: "legacy-range-action",
      deviceId: "living-main-light",
      property: "brightness",
      value: 999,
      label: "旧版越界亮度"
    });
    body.data.scenes.push({
      id: "legacy-empty-scene",
      name: "旧版空场景",
      description: "迁移前遗留",
      tone: "cyan",
      enabled: true,
      strategy: "serial",
      actions: []
    });
    const safetyDevice = body.data.devices.find((device: { kind: string }) => device.kind === "sensor");
    safetyDevice.display.hidden = true;
    safetyDevice.display.secondarySlot = "legacy-panel-slot";
    body.data.automations.push({
      id: "legacy-readonly-action",
      name: "旧版水浸复位联动",
      enabled: true,
      condition: { deviceId: "living-main-light", property: "power", operator: "gt", value: true },
      actions: [{ id: "legacy-action", deviceId: "water-sensor", property: "waterLeak", value: false, label: "复位水浸" }],
      cooldownSeconds: 5
    });
    await route.fulfill({ response, json: body });
  });

  await page.reload();
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
  await expect(page.getByText("服务端配置需修复")).toBeVisible();
  await expect(page.getByText("服务端配置存在兼容性问题")).toBeVisible();
  await expect(page.getByText(/场景“.*”引用了不存在的设备/).first()).toBeVisible();
  await expect(page.getByText(/联动“.*”不能写入/).first()).toBeVisible();
  await expect(page.getByText(/值不符合能力范围或类型/).first()).toBeVisible();
  await expect(page.getByText(/只能使用等于或不等于/).first()).toBeVisible();
  await expect(page.getByText(/安防设备不能从主屏隐藏/).first()).toBeVisible();
  await expect(page.getByText(/副屏快捷槽位版本不兼容/).first()).toBeVisible();
  await expect(page.getByText(/启用场景至少需要 1 个动作/).first()).toBeVisible();
  await page.getByRole("button", { name: /生成安全修复草稿/ }).click();
  await expect(page.getByText(/已生成安全修复草稿：修复 3 项/)).toBeVisible();
  await expect(page.getByText(/安防设备不能从主屏隐藏/)).toHaveCount(0);
  await expect(page.getByText(/副屏快捷槽位版本不兼容/)).toHaveCount(0);
  await expect(page.getByText(/启用场景至少需要 1 个动作/)).toHaveCount(0);
  await expect(page.getByText(/场景“.*”引用了不存在的设备/).first()).toBeVisible();
  await expect(page.getByText(/值不符合能力范围或类型/).first()).toBeVisible();
  await expect(page.getByText(/只能使用等于或不等于/).first()).toBeVisible();
  await page.getByRole("button", { name: "场景编排" }).click();
  await page.getByRole("button", { name: "保留草稿并前往" }).click();
  await expect(page.getByRole("heading", { name: "场景编排" })).toBeVisible();
  await expect(page.getByText("保存前需要修正")).toBeVisible();

  let saveRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/api/v1/admin/config")) saveRequests += 1;
  });
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText(/场景“.*”不能写入|场景“.*”引用了不存在的设备/).first()).toBeVisible();
  expect(saveRequests).toBe(0);
});

test("empty automation workspace provides a primary action", async ({ page }) => {
  await page.getByRole("button", { name: "自动联动" }).click();
  await expect(page.getByRole("button", { name: "创建第一条联动" })).toBeVisible();
});

test("device page uses server pagination and preserves edits across pages", async ({ page }) => {
  await page.getByRole("button", { name: "房间与设备" }).click();
  const pager = page.locator('[data-resource="devices"]');
  await expect(pager.getByText("共 18 条")).toBeVisible();
  await expect(page.locator(".device-edit")).toHaveCount(8);

  const secondPageRequest = page.waitForResponse(
    (response) => response.url().includes("/api/v1/admin/resources/devices") && response.url().includes("page=2")
  );
  await pager.getByText("2", { exact: true }).click();
  const response = await secondPageRequest;
  const body = await response.json();
  expect(body.data.page).toBe(2);
  expect(body.data.total).toBe(18);

  const deviceName = page.locator(".device-edit input").first();
  await deviceName.fill("分页保留设备");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(deviceName).toHaveValue("分页保留设备");
  await pager.getByText("1", { exact: true }).click();
  await pager.getByText("2", { exact: true }).click();
  await expect(page.locator(".device-edit input").first()).toHaveValue("分页保留设备");
});

test("alerts search is executed by paginated server query", async ({ page }) => {
  await page.getByRole("button", { name: "告警中心" }).click();
  const requestPromise = page.waitForResponse(
    (response) => response.url().includes("/api/v1/admin/resources/alerts") && response.url().includes("q=%E5%9E%8B%E5%8F%B7")
  );
  await page.getByPlaceholder("搜索标题 / 消息").fill("型号");
  const response = await requestPromise;
  const body = await response.json();
  expect(body.data.total).toBeGreaterThanOrEqual(1);
  await expect(page.locator('[data-resource="alerts"]')).toContainText(`共 ${body.data.total} 条`);
});

test("all data workspaces expose pagination controls", async ({ page }) => {
  for (const [tab, resources] of [
    ["房间与设备", ["rooms", "devices"]],
    ["场景编排", ["scenes"]],
    ["自动联动", ["automations"]],
    ["告警中心", ["alerts"]],
    ["网关配置", ["gateways"]],
    ["终端管理", ["terminals"]],
    ["审计日志", ["audits"]]
  ] as const) {
    await page.getByRole("button", { name: tab }).click();
    for (const resource of resources) await expect(page.locator(`[data-resource="${resource}"]`)).toBeVisible();
  }
});

test("audit and terminal timestamps use readable local formatting while preserving the source value", async ({ page }) => {
  await page.getByRole("button", { name: "审计日志" }).click();
  const auditTime = page.locator(".audit-row time").first();
  await expect(auditTime).toBeVisible();
  await expect(auditTime).not.toContainText("T");
  expect(await auditTime.getAttribute("title")).toMatch(/T.*Z$/);

  await page.getByRole("button", { name: "终端管理" }).click();
  const terminalTime = page.locator(".terminal-row time").first();
  await expect(terminalTime).not.toContainText("T");
  expect(await terminalTime.getAttribute("title")).toMatch(/T.*Z$/);
});

test("scene trial persists, executes and appears in audit pagination", async ({ page }) => {
  await page.getByRole("button", { name: "场景编排" }).click();
  const scene = page.locator(".n-collapse-item").first();
  await scene.locator(".n-collapse-item__header-main").click();
  const sceneName = await scene.getByPlaceholder("场景名称").inputValue();
  await scene.getByRole("button", { name: "保存并试运行" }).click();
  await expect(page.getByText(/场景试运行：completed/)).toBeVisible();
  await page.getByRole("button", { name: "审计日志" }).click();
  await page.getByPlaceholder("搜索动作 / 来源 / 详情").fill(sceneName);
  await expect(page.locator(".audit-row").filter({ hasText: sceneName })).toBeVisible();
});

test("automation creation persists and can run through real command path", async ({ page }) => {
  await page.getByRole("button", { name: "自动联动" }).click();
  await page.getByRole("button", { name: "创建第一条联动" }).click();
  const editor = page.locator(".automation-editor").first();
  await expect(editor).toBeVisible();
  const enabled = editor.getByRole("switch", { name: /启用状态/ });
  await expect(enabled).not.toBeChecked();
  await enabled.click();
  await expect(page.getByText(/启用联动至少需要 1 个动作/).first()).toBeVisible();
  await editor.getByRole("button", { name: "添加动作" }).click();
  await expect(page.getByText(/启用联动至少需要 1 个动作/)).toHaveCount(0);
  await editor.getByRole("button", { name: "保存并试运行" }).click();
  await expect(page.getByText(/联动试运行：1\/1 个动作已确认/)).toBeVisible();
});

test("alert confirmation and recovery refresh paginated status", async ({ page }) => {
  await page.getByRole("button", { name: "告警中心" }).click();
  const row = page.locator(".alert-row").first();
  await row.getByRole("button", { name: "确认" }).click();
  await expect(row).toContainText("处理中");
  await row.getByRole("button", { name: "恢复" }).click();
  await expect(row).toContainText("已恢复");
});

test("water leak alert cannot be recovered before the device reports clear", async ({ page, request }) => {
  const token = (await (await request.post("/api/v1/admin/login", { data: { pin: "2468" } })).json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  await request.post("/api/v1/_test/faults", {
    headers,
    data: { targetId: "water-sensor", kind: "water-leak" }
  });
  await page.getByRole("button", { name: "告警中心" }).click();
  const row = page.locator(".alert-row").filter({ hasText: "检测到水浸" });
  await expect(row.getByRole("button", { name: "恢复" })).toBeDisabled();
  await expect(row).toContainText("异常条件仍存在，请先排除现场故障");

  await request.post("/api/v1/_test/faults", {
    headers,
    data: { targetId: "water-sensor", kind: "clear-water-leak" }
  });
  await expect(row).toContainText("已恢复");
});

test("gateway test and terminal pairing remain visible across workspaces", async ({ page }) => {
  await page.getByRole("button", { name: "网关配置" }).click();
  const gateway = page.locator(".gateway-editor").first();
  await gateway.getByRole("button", { name: "网关与灯联检" }).click();
  await expect(gateway).toContainText("隔离测试网关可用");
  await expect(gateway.locator(".gateway-test-result")).toHaveClass(/success/);

  await page.getByRole("button", { name: "终端管理" }).click();
  const secondary = page.locator(".terminal-row").filter({ hasText: "实训台副屏" });
  await expect(secondary.getByText("已配对")).toBeVisible();
  await page.getByRole("button", { name: "运行总览" }).click();
  await page.getByRole("button", { name: "终端管理" }).click();
  await expect(secondary.getByText("已配对")).toBeVisible();
});

test("终端撤销明确说明令牌失效与重新配对边界", async ({ page }) => {
  let revoked = false;
  await page.route("**/api/v1/admin/terminals/terminal-secondary/revoke", async (route) => {
    revoked = true;
    await route.fulfill({
      status: 200,
      json: {
        data: {
          id: "terminal-secondary",
          name: "实训台副屏",
          role: "secondary",
          paired: false,
          online: false,
          address: "192.168.31.21",
          version: "0.1.0",
          lastSeenAt: new Date().toISOString()
        },
        sequence: 1
      }
    });
  });
  await page.route("**/api/v1/admin/config", async (route) => {
    if (route.request().method() !== "GET" || !revoked) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const secondary = body.data.terminals.find((terminal: { id: string }) => terminal.id === "terminal-secondary");
    secondary.paired = false;
    secondary.online = false;
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: "终端管理" }).click();
  const secondary = page.locator(".terminal-row").filter({ hasText: "实训台副屏" });
  await secondary.getByRole("button", { name: "撤销配对" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/清除旧令牌与事件票据/)).toBeVisible();
  await expect(dialog.getByText(/保存配置不能复活旧令牌/)).toBeVisible();
  await expect(dialog.getByText(/重新使用须在副屏输入新配对码/)).toBeVisible();
  await dialog.getByRole("button", { name: "撤销并断开终端" }).click();
  await expect(secondary.getByText("已撤销", { exact: true })).toBeVisible();
  await expect(secondary.getByRole("button", { name: "撤销配对" })).toHaveCount(0);
  await expect(page.getByText(/旧令牌和在线连接已失效/)).toBeVisible();
});

test("terminal management follows a live secondary connection without assuming an idle shared server", async ({ page, browser }) => {
  await page.getByRole("button", { name: "终端管理" }).click();
  const secondary = page.locator(".terminal-row").filter({ hasText: "实训台副屏" });
  const initialPresence = await secondary.getByRole("status").innerText();

  const context = await browser.newContext();
  const secondaryPage = await context.newPage();
  await secondaryPage.goto("/secondary");
  await expect(secondary.getByRole("status")).toHaveText("在线");

  await context.close();
  // 共享开发服务可能已有用户打开的副屏；只有基线本来离线时，
  // 本测试才能把关闭后离线归因于自己的最后一条连接。
  if (initialPresence === "离线") await expect(secondary.getByRole("status")).toHaveText("离线");
  else await expect(secondary.getByRole("status")).toHaveText("在线");
  // 跨过客户端 1.6 秒异常重连延迟，主动关闭不得制造额外状态反转。
  await page.waitForTimeout(1900);
  await expect(secondary.getByRole("status")).toHaveText(initialPresence);
});

test("legacy two-gateway configuration can be reviewed and explicitly consolidated to this bench", async ({ page, request }) => {
  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const current = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  current.gateways.push({
    id: "gateway-legacy-lighting",
    name: "旧版灯光子网关",
    host: "192.168.31.31",
    port: 23,
    credentialRef: "keystore://gateway-legacy-lighting",
    mode: "test-fixture"
  });
  current.devices.find((device: { id: string }) => device.id === "living-main-light").integration.gatewayId = "gateway-legacy-lighting";
  expect((await request.put("/api/v1/admin/config", { headers, data: current })).status()).toBe(200);

  await page.reload();
  await page.getByPlaceholder("输入管理员 PIN").fill("2468");
  await page.getByRole("button", { name: "进入工程管理" }).click();
  await page.getByRole("button", { name: "网关配置" }).click();
  await expect(page.getByText("检测到旧版多网关控制域")).toBeVisible();

  await page.locator(".gateway-editor").first().getByRole("button", { name: "设为本台唯一网关" }).click();
  await expect(page.getByText(/将移除 1 个其他网关，并把 1 个设备的归属迁移/)).toBeVisible();
  await page.getByRole("button", { name: "归并为单网关" }).click();
  await expect(page.getByText("拓扑归并已预览，请检查设备归属后保存配置")).toBeVisible();
  await expect(page.getByText("有未保存修改")).toBeVisible();

  const beforeSave = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  expect(beforeSave.gateways).toHaveLength(2);

  await page.getByRole("button", { name: "保存配置" }).click();
  const saved = (await (await request.get("/api/v1/admin/config", { headers })).json()).data;
  expect(saved.gateways).toHaveLength(1);
  expect(
    saved.devices.every(
      (device: { integration: { gatewayId?: string } }) =>
        !device.integration.gatewayId || device.integration.gatewayId === saved.gateways[0].id
    )
  ).toBe(true);
});

test("alert CSV and redacted diagnostics produce downloadable artifacts", async ({ page }) => {
  await page.getByRole("button", { name: "告警中心" }).click();
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "导出 CSV" }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^alerts-\d{4}-\d{2}-\d{2}\.csv$/);

  await page.getByRole("button", { name: "网关配置" }).click();
  const [diagnostics] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "导出脱敏诊断包" }).click()]);
  expect(diagnostics.suggestedFilename()).toMatch(/^diagnostics-\d{4}-\d{2}-\d{2}\.json$/);
});

test("审计页按当前筛选导出完整运行记录", async ({ page, request }) => {
  const command = await request.post("/api/v1/devices/living-main-light/commands", {
    data: { requestId: `audit-export-${Date.now()}`, property: "brightness", value: 55, source: "primary" }
  });
  expect(command.ok()).toBe(true);

  await page.getByRole("button", { name: "审计日志" }).click();
  await page.getByPlaceholder("搜索动作 / 来源 / 详情").fill("brightness");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "导出当前筛选" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^audits-\d{4}-\d{2}-\d{2}\.csv$/);
  const content = await (await import("node:fs/promises")).readFile(await download.path(), "utf8");
  expect(content).toContain("brightness");
  expect(content).toContain("primary");
  expect(content).not.toMatch(/,"[=+\-@]/);
  await expect(page.getByText(/已按当前筛选导出 \d+ 条完整审计记录/)).toBeVisible();
});

test("配置备份只包含正式配置资源并完成预览恢复", async ({ page }) => {
  await page.getByRole("button", { name: "配置备份" }).click();
  await page.getByRole("button", { name: "生成备份" }).click();
  const backup = page.locator("textarea");
  await expect(backup).toHaveValue(/"credentialRef": "keystore:\/\//);
  const backupText = await backup.inputValue();
  expect(JSON.parse(backupText)).not.toHaveProperty("training");
  expect(backupText).not.toContain("教学");

  let restoreRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/admin/backup")) restoreRequests += 1;
  });
  await page.getByRole("button", { name: "校验并预览" }).click();
  const dialog = page.getByRole("dialog", { name: "确认恢复备份" });
  await expect(dialog).toContainText(/房间\s*4 项/);
  await expect(dialog.getByText("内容变化 0").first()).toBeVisible();
  await expect(dialog).not.toContainText(/教师|课堂|学生|成绩|教学/);
  expect(restoreRequests).toBe(0);
  await dialog.getByRole("button", { name: "确认恢复配置" }).click();
  await expect(page.getByText(/已恢复配置版本/)).toBeVisible();
  expect(restoreRequests).toBe(1);
});

test("正式后台不暴露教师实训、成绩或模拟器能力", async ({ page, request }) => {
  await expect(page.getByRole("button", { name: "教师实训" })).toHaveCount(0);
  await expect(page.getByText(/学生成绩|故障注入|模拟器/)).toHaveCount(0);

  const login = await request.post("/api/v1/admin/login", { data: { pin: "2468" } });
  const token = (await login.json()).data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const responses = await Promise.all([
    request.get("/api/v1/admin/training", { headers }),
    request.get("/api/v1/admin/resources/training", { headers }),
    request.post("/api/v1/admin/training", { headers, data: {} }),
    request.post("/api/v1/simulator/reset", { headers, data: {} }),
    request.post("/api/v1/simulator/faults", { headers, data: {} })
  ]);
  expect(responses.map((response) => response.status())).toEqual([404, 404, 404, 404, 404]);
});
