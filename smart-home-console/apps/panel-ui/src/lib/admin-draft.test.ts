import assert from "node:assert/strict";
import test from "node:test";
import type { AdminConfiguration } from "@smart-lab/contracts";
import {
  ADMIN_DRAFT_MAX_AGE_MS,
  clearAdminConfigurationDraft,
  createAdminConfigurationDraft,
  createAdminDraftPersistenceController,
  loadAdminConfigurationDraft,
  saveAdminConfigurationDraft,
  parseAdminConfigurationDraft
} from "./admin-draft";

function configuration(version: number): AdminConfiguration {
  return {
    version,
    rooms: [{ id: "room", name: "客厅", order: 0, enabled: true }],
    devices: [],
    scenes: [],
    automations: [],
    gateways: [],
    terminals: []
  };
}

test("管理草稿保留配置资源和版本基线", () => {
  const baseline = configuration(7);
  const local = configuration(7);
  local.rooms[0].name = "本地修改";
  const draft = createAdminConfigurationDraft(baseline, local, "rooms", new Date("2026-07-25T12:00:00Z"));

  assert.equal(draft.baseline.version, 7);
  assert.equal(draft.local.rooms[0].name, "本地修改");
});

test("损坏、未来时间和超过二十四小时的草稿均被拒绝", () => {
  const now = Date.parse("2026-07-26T12:00:00Z");
  const valid = createAdminConfigurationDraft(configuration(1), configuration(1), "rooms", new Date(now - ADMIN_DRAFT_MAX_AGE_MS));
  assert.ok(parseAdminConfigurationDraft(JSON.stringify(valid), now));
  valid.savedAt = new Date(now - ADMIN_DRAFT_MAX_AGE_MS - 1).toISOString();
  assert.equal(parseAdminConfigurationDraft(JSON.stringify(valid), now), undefined);
  valid.savedAt = new Date(now + 60_001).toISOString();
  assert.equal(parseAdminConfigurationDraft(JSON.stringify(valid), now), undefined);
  assert.equal(parseAdminConfigurationDraft("not-json", now), undefined);
});

test("草稿版本与导航字段必须是安全基本类型", () => {
  const draft = createAdminConfigurationDraft(configuration(1), configuration(1), "rooms", new Date("2026-07-26T11:00:00Z"));
  const poisoned = JSON.parse(JSON.stringify(draft));
  poisoned.baseline.version = '<img src=x onerror="globalThis.compromised=true">';
  assert.equal(parseAdminConfigurationDraft(JSON.stringify(poisoned), Date.parse("2026-07-26T12:00:00Z")), undefined);
  poisoned.baseline.version = 1;
  poisoned.activeTab = { toString: "rooms" };
  assert.equal(parseAdminConfigurationDraft(JSON.stringify(poisoned), Date.parse("2026-07-26T12:00:00Z")), undefined);
});

test("草稿写入短暂失败会自动重试、抑制重复告警并在恢复后更新页签", () => {
  const baseline = configuration(1);
  const local = configuration(1);
  local.rooms[0].name = "待恢复修改";
  const state = { authenticated: true, baseline: JSON.stringify(baseline), local, activeTab: "rooms" };
  const attempts: string[] = [];
  const notices: Array<["success" | "warning", string]> = [];
  let failuresRemaining = 2;
  const controller = createAdminDraftPersistenceController(
    () => state,
    (_baseline, _local, activeTab) => {
      attempts.push(activeTab);
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        return false;
      }
      return true;
    },
    () => undefined,
    (type, message) => notices.push([type, message])
  );

  controller.flush();
  controller.flush();
  assert.deepEqual(attempts, ["rooms", "rooms"]);
  assert.equal(notices.filter(([type]) => type === "warning").length, 1);

  controller.flush();
  controller.flush();
  assert.deepEqual(attempts, ["rooms", "rooms", "rooms"]);
  assert.deepEqual(notices.at(-1), ["success", "本机安全草稿已恢复写入"]);

  state.activeTab = "scenes";
  controller.flush();
  assert.deepEqual(attempts, ["rooms", "rooms", "rooms", "scenes"]);
});

test("原生桥缺方法或抛异常时安全失败且绝不降级到 Web 明文存储", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let browserReads = 0;
  let browserWrites = 0;
  let browserClears = 0;
  const fakeWindow = {
    location: { hostname: "localhost" },
    sessionStorage: {
      getItem: () => {
        browserReads += 1;
        return "";
      },
      setItem: () => {
        browserWrites += 1;
      },
      removeItem: () => {
        browserClears += 1;
      }
    },
    SmartLabNative: {}
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  try {
    const draft = createAdminConfigurationDraft(configuration(1), configuration(1), "rooms");
    assert.equal(saveAdminConfigurationDraft(draft), false);
    assert.equal(loadAdminConfigurationDraft(), undefined);
    clearAdminConfigurationDraft();
    assert.deepEqual([browserReads, browserWrites, browserClears], [0, 0, 0]);

    fakeWindow.SmartLabNative = {
      saveAdminConfigurationDraft: () => {
        throw new Error("keystore unavailable");
      },
      getAdminConfigurationDraft: () => {
        throw new Error("keystore unavailable");
      },
      clearAdminConfigurationDraft: () => {
        throw new Error("keystore unavailable");
      }
    };
    assert.equal(saveAdminConfigurationDraft(draft), false);
    assert.equal(loadAdminConfigurationDraft(), undefined);
    assert.doesNotThrow(() => clearAdminConfigurationDraft());
    assert.deepEqual([browserReads, browserWrites, browserClears], [0, 0, 0]);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
