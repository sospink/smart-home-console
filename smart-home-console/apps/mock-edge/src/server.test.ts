import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SimulationEngine } from "./engine.js";
import { createEdgeServer } from "./server.js";
import { WebSocket } from "ws";
import type { AdminConfiguration, AuditRecord, HandoverChecklist, HandoverCompletion, Scene } from "@smart-lab/contracts";

interface SharedContractCase {
  name: string;
  method: string;
  path: string;
  auth: "none" | "admin" | "terminal";
  expectedStatus: number;
  bodyKind: "envelope" | "error" | "event";
  dataKind: "object" | "array" | "none";
  requestBody?: unknown;
  requiredDataKeys: string[];
}

const sharedContractCases = JSON.parse(
  await readFile(new URL("../../../packages/contracts/fixtures/api-contract-cases.json", import.meta.url), "utf8")
) as SharedContractCase[];

async function terminalEventTicket(base: string, token: string) {
  const response = await fetch(`${base}/api/v1/terminals/event-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: { ticket: string } }).data.ticket;
}

function renameRoom(configuration: AdminConfiguration, index: number, name: string) {
  const previous = configuration.rooms[index].name;
  configuration.rooms[index].name = name;
  configuration.devices.filter((device) => device.room === previous).forEach((device) => (device.room = name));
}

test("command stays pending until test device confirmation and then updates state", async () => {
  const engine = new SimulationEngine();
  const command = await engine.command("living-main-light", {
    requestId: "test-command-1",
    property: "brightness",
    value: 77,
    source: "primary"
  });
  assert.equal(command.status, "confirmed");
  assert.equal(engine.snapshot().devices.find((item) => item.id === "living-main-light")?.state.brightness, 77);
});

test("offline gateway causes child device command failure", async () => {
  const engine = new SimulationEngine();
  engine.injectFault({ targetId: "gateway-main", kind: "offline" });
  const command = await engine.command("living-main-light", {
    requestId: "test-command-2",
    property: "power",
    value: false,
    source: "secondary"
  });
  assert.equal(command.status, "failed");
  assert.equal(command.error, "所属网关离线");
  assert.equal(engine.snapshot().devices.find((item) => item.id === "living-main-light")?.health, "offline");
  assert.equal(engine.snapshot().devices.find((item) => item.id === "bedroom-light")?.health, "online");
});

test("health transitions never retrigger automation from a stale matching property", async () => {
  const engine = new SimulationEngine();
  const configuration = engine.getConfiguration();
  configuration.automations.push({
    id: "auto-stale-motion",
    name: "无人时开卧室灯（仅用于验证）",
    enabled: true,
    condition: { deviceId: "motion-sensor", property: "motion", operator: "eq", value: false },
    actions: [{ id: "action-stale", deviceId: "bedroom-light", property: "power", value: true, label: "开卧室灯" }],
    cooldownSeconds: 1
  });
  engine.updateConfiguration(configuration);

  engine.injectFault({ targetId: "motion-sensor", kind: "offline" });
  engine.injectFault({ targetId: "motion-sensor", kind: "online" });
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(engine.snapshot().devices.find((item) => item.id === "bedroom-light")?.state.power, false);
  assert.equal(engine.snapshot().commands.filter((item) => item.source === "automation").length, 0);
});

test("automation evaluates only the property changed by the trusted command", async () => {
  const engine = new SimulationEngine();
  const configuration = engine.getConfiguration();
  configuration.automations.push({
    id: "auto-power-only",
    name: "主灯开启时同步卧室灯",
    enabled: true,
    condition: { deviceId: "living-main-light", property: "power", operator: "eq", value: true },
    actions: [{ id: "action-power", deviceId: "bedroom-light", property: "power", value: true, label: "开卧室灯" }],
    cooldownSeconds: 1
  });
  engine.updateConfiguration(configuration);

  await engine.command("living-main-light", {
    requestId: "brightness-not-power-event",
    property: "brightness",
    value: 69,
    source: "primary"
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(engine.snapshot().devices.find((item) => item.id === "bedroom-light")?.state.power, false);
  assert.equal(engine.snapshot().commands.filter((item) => item.source === "automation").length, 0);
});

test("offline safety node opens a warning operation event and trusted recovery closes it", () => {
  const engine = new SimulationEngine();
  engine.injectFault({ targetId: "motion-sensor", kind: "offline" });

  const alert = engine
    .snapshot()
    .alerts.find((item) => item.deviceId === "motion-sensor" && item.title === "监控链路不可用" && !item.recoveredAt);
  assert.equal(alert?.level, "warning");
  assert.throws(() => engine.recoverAlert(alert!.id), /ALERT_CONDITION_STILL_ACTIVE/);

  engine.injectFault({ targetId: "motion-sensor", kind: "online" });
  const recovered = engine.snapshot().alerts.find((item) => item.id === alert?.id);
  assert.ok(recovered?.recoveredAt);
  assert.equal(recovered?.acknowledgedAt, undefined);
});

test("scene reports partial execution rather than fixed success", async () => {
  const engine = new SimulationEngine();
  engine.injectFault({ targetId: "music-r11", kind: "fail-next-command" });
  const execution = await engine.executeScene("scene-away", "primary");
  assert.equal(execution.status, "partial");
  assert.equal(execution.completedActions, 3);
  assert.equal(execution.totalActions, 4);
});

test("concurrent scene is rejected before creating a second execution", async () => {
  const engine = new SimulationEngine();
  const first = engine.executeScene("scene-home", "primary");
  await new Promise((resolve) => setTimeout(resolve, 40));

  await assert.rejects(engine.executeScene("scene-away", "secondary"), /SCENE_EXECUTION_CONFLICT:回家:primary/);
  const completed = await first;

  assert.equal(completed.status, "completed");
  assert.equal(engine.snapshot().executions.length, 1);
  assert.ok(engine.getAudits().some((item) => item.category === "scene" && item.source === "secondary" && item.result === "failed"));
});

test("manual command cannot overwrite a property leased by a running scene", async () => {
  const engine = new SimulationEngine();
  const first = engine.executeScene("scene-home", "primary");
  await new Promise((resolve) => setTimeout(resolve, 40));

  await assert.rejects(
    engine.command("living-main-light", {
      requestId: "manual-during-scene",
      property: "power",
      value: false,
      source: "secondary"
    }),
    /DEVICE_OPERATION_CONFLICT/
  );
  await first;

  assert.equal(engine.snapshot().commands.filter((item) => item.requestId === "manual-during-scene").length, 0);
  assert.ok(engine.getAudits().some((item) => item.category === "command" && item.source === "secondary" && item.result === "failed"));
});

test("automation conflict is settled and cannot terminate the EdgeCore execution path", async () => {
  const engine = new SimulationEngine();
  const configuration = engine.getConfiguration();
  configuration.automations.push({
    id: "auto-conflicts-with-scene",
    name: "场景内冲突联动",
    enabled: true,
    condition: { deviceId: "living-main-light", property: "power", operator: "eq", value: true },
    actions: [{ id: "action-conflict", deviceId: "living-main-light", property: "power", value: false, label: "关闭主灯" }],
    cooldownSeconds: 1
  });
  engine.updateConfiguration(configuration);

  const execution = await engine.executeScene("scene-home", "primary");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(execution.status, "completed");
  assert.equal(engine.snapshot().devices.find((item) => item.id === "living-main-light")?.state.power, true);
  assert.ok(
    engine
      .getAudits()
      .some((item) => item.action === "自动联动" && item.source === "automation" && item.result === "failed" && item.detail.includes("0/1"))
  );
});

test("test fixture reset clears in-flight operation leases for the next test cycle", async () => {
  const engine = new SimulationEngine();
  const running = engine.executeScene("scene-home", "primary");
  await new Promise((resolve) => setTimeout(resolve, 40));

  engine.reset();
  const command = await engine.command("living-main-light", {
    requestId: "after-reset",
    property: "power",
    value: false,
    source: "secondary"
  });

  assert.equal(command.status, "confirmed");
  await running;
});

test("bench reset preserves configuration, alerts and audits while returning per-device outcomes", async () => {
  const engine = new SimulationEngine();
  await engine.command("living-main-light", {
    requestId: "before-handover-light",
    property: "power",
    value: true,
    source: "admin"
  });
  await engine.command("music-r11", {
    requestId: "before-handover-music",
    property: "power",
    value: true,
    source: "admin"
  });
  engine.injectFault({ targetId: "bedroom-light", kind: "offline" });
  const configVersion = engine.getConfiguration().version;
  const alertsBefore = engine.getAlerts().length;

  const result = await engine.benchReset();

  assert.equal(result.status, "manual-check");
  assert.equal(engine.snapshot().devices.find((item) => item.id === "living-main-light")?.state.power, false);
  assert.equal(engine.snapshot().devices.find((item) => item.id === "music-r11")?.state.power, true);
  assert.ok(result.items.some((item) => item.deviceId === "music-r11" && item.outcome === "manual-check"));
  assert.ok(result.items.some((item) => item.deviceId === "bedroom-light" && item.outcome === "manual-check"));
  assert.ok(result.items.some((item) => item.deviceId === "smart-lock" && item.outcome === "excluded"));
  assert.equal(engine.getConfiguration().version, configVersion);
  assert.equal(engine.getAlerts().length, alertsBefore);
  assert.ok(engine.getAudits().some((item) => item.action === "设备安全复位" && item.detail.includes("告警与审计记录保留")));
});

test("bench reset is blocked by a critical alert without creating reset commands", async () => {
  const engine = new SimulationEngine();
  engine.injectFault({ targetId: "water-sensor", kind: "water-leak" });
  await assert.rejects(engine.benchReset(), /ACTIVE_CRITICAL_ALERT/);
  assert.equal(
    engine.snapshot().commands.some((item) => item.requestId.startsWith("bench-reset:")),
    false
  );
});

test("bench reset follows saved policy and suppresses reverse automation", async () => {
  const engine = new SimulationEngine();
  const configuration = engine.getConfiguration();
  configuration.benchResetPolicy = { power: "off", cover: "open", automationSuppressionSeconds: 8 };
  configuration.automations.push({
    id: "reverse-reset",
    name: "关灯后重新开灯",
    enabled: true,
    condition: { deviceId: "living-main-light", property: "power", operator: "eq", value: false },
    actions: [{ id: "reverse-reset-action", deviceId: "living-main-light", property: "power", value: true, label: "重新开灯" }],
    cooldownSeconds: 1
  });
  engine.updateConfiguration(configuration);
  await engine.command("living-main-light", {
    requestId: "policy-before-reset",
    property: "power",
    value: true,
    source: "admin"
  });
  await engine.command("curtain-c3", {
    requestId: "policy-before-cover",
    property: "position",
    value: 0,
    source: "admin"
  });

  const result = await engine.benchReset();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(result.items.find((item) => item.deviceId === "curtain-c3")?.targetValue, 100);
  assert.equal(engine.snapshot().devices.find((item) => item.id === "living-main-light")?.state.power, false);
  assert.equal(engine.snapshot().devices.find((item) => item.id === "curtain-c3")?.state.position, 100);
  assert.equal(
    engine.snapshot().commands.some((item) => item.source === "automation" && item.requestId.includes("reverse-reset")),
    false
  );
  assert.deepEqual(engine.exportBackup().benchResetPolicy, configuration.benchResetPolicy);
});

test("water leak test fixture creates a critical alert", () => {
  const engine = new SimulationEngine();
  engine.injectFault({ targetId: "water-sensor", kind: "water-leak" });
  const newest = engine.snapshot().alerts[0];
  assert.equal(newest.level, "critical");
  assert.equal(newest.deviceId, "water-sensor");
});

test("an active water leak alert is deduplicated until recovery", () => {
  const engine = new SimulationEngine();
  engine.injectFault({ targetId: "water-sensor", kind: "water-leak" });
  engine.injectFault({ targetId: "water-sensor", kind: "water-leak" });
  assert.equal(engine.snapshot().alerts.filter((item) => item.title === "检测到水浸" && !item.recoveredAt).length, 1);
  assert.ok(engine.getAudits().some((item) => item.action === "重复告警已抑制" && item.result === "ignored"));

  engine.injectFault({ targetId: "water-sensor", kind: "clear-water-leak" });
  engine.injectFault({ targetId: "water-sensor", kind: "water-leak" });
  assert.equal(engine.snapshot().alerts.filter((item) => item.title === "检测到水浸").length, 2);
});

test("duplicate requestId returns the same command without executing twice", async () => {
  const engine = new SimulationEngine();
  const request = { requestId: "dedupe-1", property: "power", value: false, source: "primary" } as const;
  const first = await engine.command("living-main-light", request);
  const second = await engine.command("living-main-light", request);
  assert.equal(second.id, first.id);
  assert.equal(engine.snapshot().commands.filter((item) => item.requestId === request.requestId).length, 1);
});

test("timeout fault produces an explicit timeout command state", async () => {
  const engine = new SimulationEngine();
  engine.injectFault({ targetId: "living-main-light", kind: "timeout-next-command" });
  const command = await engine.command("living-main-light", { requestId: "timeout-1", property: "power", value: false, source: "primary" });
  assert.equal(command.status, "timeout");
  assert.equal(command.error, "设备确认超时");
});

test("configuration backup restores rooms and advances version", () => {
  const engine = new SimulationEngine();
  const backup = engine.exportBackup();
  renameRoom(backup, 0, "恢复测试房间");
  const restored = engine.restoreBackup(backup);
  assert.equal(restored.rooms[0].name, "恢复测试房间");
  assert.ok(restored.version > backup.version);
  assert.ok(restored.gateways.every((item) => item.credentialRef.startsWith("keystore://")));
});

test("device display order, visibility and homepage favorite survive configuration and backup", () => {
  const engine = new SimulationEngine();
  const config = engine.getConfiguration();
  const light = config.devices.find((item) => item.id === "living-main-light");
  assert.ok(light);
  light.display = { icon: "ceiling", order: 42, hidden: true, favorite: false };

  const updated = engine.updateConfiguration(config);
  const persisted = updated.devices.find((item) => item.id === light.id)?.display;
  assert.deepEqual(persisted, light.display);
  const backup = engine.exportBackup();
  assert.deepEqual(backup.devices.find((item) => item.id === light.id)?.display, light.display);
});

test("secondary quick controls are uniquely seeded and survive remapping and backup", () => {
  const engine = new SimulationEngine();
  const initial = engine.getConfiguration();
  const seeded = initial.devices.flatMap((device) => (device.display?.secondarySlot ? [[device.display.secondarySlot, device.id]] : []));
  assert.deepEqual(seeded.map(([slot]) => slot).sort(), ["curtain", "light", "music"]);
  assert.equal(new Set(seeded.map(([slot]) => slot)).size, 3);

  const original = initial.devices.find((device) => device.display?.secondarySlot === "light");
  const replacement = initial.devices.find((device) => device.id === "bedroom-light");
  assert.ok(original && replacement);
  original.display = { ...original.display, secondarySlot: undefined };
  replacement.display = { ...replacement.display, secondarySlot: "light" };
  const saved = engine.updateConfiguration(initial);
  assert.equal(saved.devices.find((device) => device.id === replacement.id)?.display?.secondarySlot, "light");
  assert.equal(engine.exportBackup().devices.find((device) => device.id === replacement.id)?.display?.secondarySlot, "light");
});

test("secondary quick control validation rejects duplicate, incompatible and unknown slots", () => {
  const duplicateEngine = new SimulationEngine();
  const duplicate = duplicateEngine.getConfiguration();
  const secondLight = duplicate.devices.find((device) => device.id === "bedroom-light");
  assert.ok(secondLight);
  secondLight.display = { ...secondLight.display, secondarySlot: "light" };
  assert.throws(() => duplicateEngine.updateConfiguration(duplicate), /DUPLICATE_SECONDARY_SLOT/);

  const incompatibleEngine = new SimulationEngine();
  const incompatible = incompatibleEngine.getConfiguration();
  const mappedLight = incompatible.devices.find((device) => device.display?.secondarySlot === "light");
  const sensor = incompatible.devices.find((device) => device.id === "water-sensor");
  assert.ok(mappedLight && sensor);
  mappedLight.display = { ...mappedLight.display, secondarySlot: undefined };
  sensor.display = { ...sensor.display, secondarySlot: "light" };
  assert.throws(() => incompatibleEngine.updateConfiguration(incompatible), /SECONDARY_SLOT_CAPABILITY_MISMATCH:light:water-sensor/);

  const invalidEngine = new SimulationEngine();
  const invalid = invalidEngine.getConfiguration();
  const device = invalid.devices.find((item) => item.display?.secondarySlot === "light");
  assert.ok(device);
  device.display = { ...device.display, secondarySlot: "unsupported" as "light" };
  assert.throws(() => invalidEngine.updateConfiguration(invalid), /INVALID_SECONDARY_SLOT/);
});

test("stale configuration is rejected without overwriting the latest version", () => {
  const engine = new SimulationEngine();
  const stale = engine.getConfiguration();
  const latest = engine.getConfiguration();
  renameRoom(latest, 0, "已保存的最新房间");
  const saved = engine.updateConfiguration(latest);

  renameRoom(stale, 0, "过期会话的房间");
  assert.throws(() => engine.updateConfiguration(stale), /CONFIG_VERSION_CONFLICT/);
  const current = engine.getConfiguration();
  assert.equal(current.version, saved.version);
  assert.equal(current.rooms[0].name, "已保存的最新房间");
  assert.ok(engine.getAudits().some((item) => item.action === "更新配置" && item.result === "failed"));
});

test("backup restore remains an explicit full replacement across configuration versions", () => {
  const engine = new SimulationEngine();
  const backup = engine.exportBackup();
  const next = engine.getConfiguration();
  renameRoom(next, 0, "临时新版本");
  const saved = engine.updateConfiguration(next);
  renameRoom(backup, 0, "备份恢复房间");

  const restored = engine.restoreBackup(backup);
  assert.equal(restored.version, saved.version + 1);
  assert.equal(restored.rooms[0].name, "备份恢复房间");
  assert.ok(engine.getAudits().some((item) => item.action === "恢复配置备份" && item.detail.includes(`源版本 ${backup.version}`)));
});

test("configuration rejects hiding safety devices", () => {
  const engine = new SimulationEngine();
  const config = engine.getConfiguration();
  const sensor = config.devices.find((item) => item.id === "water-sensor");
  assert.ok(sensor);
  sensor.display = { ...sensor.display, hidden: true };
  assert.throws(() => engine.updateConfiguration(config), /SAFETY_DEVICE_CANNOT_BE_HIDDEN/);
});

test("configuration rejects blank names, invalid cooldown and gateway address", () => {
  const engine = new SimulationEngine();
  const blankScene = engine.getConfiguration();
  blankScene.scenes[0].name = " ";
  assert.throws(() => engine.updateConfiguration(blankScene), /INVALID_SCENE_NAME/);

  const invalidAutomation = engine.getConfiguration();
  invalidAutomation.automations.push({
    id: "invalid-auto",
    name: "无效联动",
    enabled: true,
    condition: { deviceId: "living-main-light", property: "power", operator: "eq", value: true },
    actions: [],
    cooldownSeconds: 0
  });
  assert.throws(() => engine.updateConfiguration(invalidAutomation), /INVALID_AUTOMATION_COOLDOWN/);

  const invalidGateway = engine.getConfiguration();
  invalidGateway.gateways[0].host = "";
  assert.throws(() => engine.updateConfiguration(invalidGateway), /INVALID_GATEWAY_ADDRESS/);
});

test("enabled scenes and automations require at least one real action", async () => {
  const engine = new SimulationEngine();
  const emptyScene = engine.getConfiguration();
  emptyScene.scenes.push({
    id: "empty-scene",
    name: "空场景",
    description: "不应启用",
    tone: "cyan",
    enabled: true,
    strategy: "serial",
    actions: []
  });
  assert.throws(() => engine.updateConfiguration(emptyScene), /SCENE_ACTION_REQUIRED:empty-scene/);

  const emptyAutomation = engine.getConfiguration();
  emptyAutomation.automations.push({
    id: "empty-automation",
    name: "空联动",
    enabled: true,
    condition: { deviceId: "living-main-light", property: "power", operator: "eq", value: true },
    actions: [],
    cooldownSeconds: 5
  });
  assert.throws(() => engine.updateConfiguration(emptyAutomation), /AUTOMATION_ACTION_REQUIRED:empty-automation/);

  const legacyEngine = new SimulationEngine();
  const legacyScenes = (legacyEngine as unknown as { scenes: Scene[] }).scenes;
  legacyScenes.push({
    id: "legacy-empty-scene",
    name: "旧版空场景",
    description: "迁移前遗留",
    tone: "cyan",
    enabled: true,
    strategy: "serial",
    actions: []
  });
  await assert.rejects(legacyEngine.executeScene("legacy-empty-scene", "primary"), /SCENE_ACTION_REQUIRED/);
  assert.equal(
    legacyEngine.snapshot().executions.some((item) => item.sceneId === "legacy-empty-scene"),
    false
  );
});

test("capability values and automation operators are validated before persistence or execution", async () => {
  const engine = new SimulationEngine();
  await assert.rejects(
    engine.command("living-main-light", { requestId: "invalid-type", property: "brightness", value: "80", source: "primary" }),
    /INVALID_CAPABILITY_VALUE:living-main-light.brightness:TYPE/
  );
  await assert.rejects(
    engine.command("living-main-light", { requestId: "invalid-range", property: "brightness", value: 101, source: "primary" }),
    /INVALID_CAPABILITY_VALUE:living-main-light.brightness:MAX/
  );
  await assert.rejects(
    engine.command("curtain-c3", { requestId: "invalid-option", property: "motor", value: "reverse", source: "primary" }),
    /INVALID_CAPABILITY_VALUE:curtain-c3.motor:OPTION/
  );
  assert.equal(
    engine.snapshot().commands.some((item) => item.requestId.startsWith("invalid-")),
    false
  );

  const invalidSceneValue = engine.getConfiguration();
  invalidSceneValue.scenes[0].actions[0] = { ...invalidSceneValue.scenes[0].actions[0], value: "true" };
  assert.throws(() => engine.updateConfiguration(invalidSceneValue), /SCENE_VALUE_INVALID:living-main-light.power:TYPE/);

  const invalidOperator = engine.getConfiguration();
  invalidOperator.automations.push({
    id: "invalid-operator",
    name: "布尔值大于比较",
    enabled: true,
    condition: { deviceId: "living-main-light", property: "power", operator: "gt", value: true },
    actions: [{ id: "valid-action", deviceId: "living-main-light", property: "power", value: false, label: "关灯" }],
    cooldownSeconds: 5
  });
  assert.throws(() => engine.updateConfiguration(invalidOperator), /AUTOMATION_OPERATOR_INVALID:living-main-light.power/);

  const invalidConditionValue = engine.getConfiguration();
  invalidConditionValue.automations.push({
    id: "invalid-condition-value",
    name: "错误条件值",
    enabled: true,
    condition: { deviceId: "living-main-light", property: "brightness", operator: "gte", value: 101 },
    actions: [{ id: "valid-action", deviceId: "living-main-light", property: "power", value: false, label: "关灯" }],
    cooldownSeconds: 5
  });
  assert.throws(
    () => engine.updateConfiguration(invalidConditionValue),
    /AUTOMATION_CONDITION_VALUE_INVALID:living-main-light.brightness:MAX/
  );
});

test("configuration rejects duplicate rooms and orphaned device room references", () => {
  const engine = new SimulationEngine();
  const duplicateRoom = engine.getConfiguration();
  duplicateRoom.rooms[1].name = duplicateRoom.rooms[0].name;
  assert.throws(() => engine.updateConfiguration(duplicateRoom), /DUPLICATE_ROOM_NAME/);

  const orphanedDevice = engine.getConfiguration();
  orphanedDevice.devices.find((device) => device.kind !== "gateway")!.room = "不存在的房间";
  assert.throws(() => engine.updateConfiguration(orphanedDevice), /DEVICE_ROOM_NOT_FOUND/);
});

test("configuration rejects invalid scene and automation device capability references", () => {
  const unknownSceneDevice = new SimulationEngine().getConfiguration();
  unknownSceneDevice.scenes[0].actions[0].deviceId = "missing-scene-device";
  assert.throws(() => new SimulationEngine().updateConfiguration(unknownSceneDevice), /SCENE_DEVICE_NOT_FOUND:missing-scene-device/);

  const readonlySceneCapability = new SimulationEngine().getConfiguration();
  readonlySceneCapability.scenes[0].actions[0] = {
    ...readonlySceneCapability.scenes[0].actions[0],
    deviceId: "water-sensor",
    property: "waterLeak"
  };
  assert.throws(
    () => new SimulationEngine().updateConfiguration(readonlySceneCapability),
    /SCENE_CAPABILITY_NOT_WRITABLE:water-sensor.waterLeak/
  );

  const unknownConditionDevice = new SimulationEngine().getConfiguration();
  unknownConditionDevice.automations.push({
    id: "unknown-condition-device",
    name: "无效条件设备",
    enabled: true,
    condition: { deviceId: "missing-condition-device", property: "power", operator: "eq", value: true },
    actions: [],
    cooldownSeconds: 5
  });
  assert.throws(
    () => new SimulationEngine().updateConfiguration(unknownConditionDevice),
    /AUTOMATION_DEVICE_NOT_FOUND:missing-condition-device/
  );

  const unknownConditionProperty = new SimulationEngine().getConfiguration();
  unknownConditionProperty.automations.push({
    id: "unknown-condition-property",
    name: "无效条件属性",
    enabled: true,
    condition: { deviceId: "living-main-light", property: "missing", operator: "eq", value: true },
    actions: [],
    cooldownSeconds: 5
  });
  assert.throws(() => new SimulationEngine().updateConfiguration(unknownConditionProperty), /AUTOMATION_CONDITION_NOT_FOUND:missing/);

  const unknownActionDevice = new SimulationEngine().getConfiguration();
  unknownActionDevice.automations.push({
    id: "unknown-action-device",
    name: "无效动作设备",
    enabled: true,
    condition: { deviceId: "living-main-light", property: "power", operator: "eq", value: true },
    actions: [{ id: "invalid", deviceId: "missing-action-device", property: "power", value: true, label: "无效动作" }],
    cooldownSeconds: 5
  });
  assert.throws(
    () => new SimulationEngine().updateConfiguration(unknownActionDevice),
    /AUTOMATION_ACTION_DEVICE_NOT_FOUND:missing-action-device/
  );

  const readonlyActionCapability = new SimulationEngine().getConfiguration();
  readonlyActionCapability.automations.push({
    id: "readonly-action",
    name: "只读动作",
    enabled: true,
    condition: { deviceId: "living-main-light", property: "power", operator: "eq", value: true },
    actions: [{ id: "invalid", deviceId: "water-sensor", property: "waterLeak", value: false, label: "无效动作" }],
    cooldownSeconds: 5
  });
  assert.throws(
    () => new SimulationEngine().updateConfiguration(readonlyActionCapability),
    /AUTOMATION_CAPABILITY_NOT_WRITABLE:water-sensor.waterLeak/
  );
});

test("one bench owns its gateway identity and rejects broken gateway topology", () => {
  const engine = new SimulationEngine();
  const initial = engine.getConfiguration();
  assert.equal(initial.gateways.length, 1);
  assert.ok(initial.devices.every((device) => !device.integration.gatewayId || device.integration.gatewayId === "gateway-main"));

  initial.gateways[0].name = "2 号实训台网关";
  const saved = engine.updateConfiguration(initial);
  assert.equal(saved.devices.find((device) => device.id === "gateway-main")?.name, "2 号实训台网关");
  assert.equal(engine.snapshot().health.gateways[0]?.name, "2 号实训台网关");

  const noGateway = engine.getConfiguration();
  noGateway.gateways = [];
  assert.throws(() => engine.updateConfiguration(noGateway), /GATEWAY_REQUIRED/);

  const missingReference = engine.getConfiguration();
  const light = missingReference.devices.find((device) => device.id === "living-main-light");
  assert.ok(light);
  light.integration.gatewayId = "unknown-gateway";
  assert.throws(() => engine.updateConfiguration(missingReference), /DEVICE_GATEWAY_NOT_FOUND/);
});

test("parallel scene strategy executes every action and reports aggregate status", async () => {
  const engine = new SimulationEngine();
  const config = engine.getConfiguration();
  const scene = config.scenes.find((item) => item.id === "scene-home");
  assert.ok(scene);
  scene.strategy = "parallel";
  engine.updateConfiguration(config);
  const result = await engine.executeScene(scene.id, "admin");
  assert.equal(result.source, "admin");
  assert.equal(result.status, "completed");
  assert.equal(result.completedActions, result.totalActions);
});

test("alert recovery is blocked until the authoritative device condition clears", () => {
  const engine = new SimulationEngine();
  engine.injectFault({ targetId: "water-sensor", kind: "water-leak" });
  const alert = engine.snapshot().alerts[0];
  assert.throws(() => engine.recoverAlert(alert.id), /ALERT_CONDITION_STILL_ACTIVE/);
  assert.equal(engine.snapshot().alerts[0].recoveredAt, undefined);

  engine.injectFault({ targetId: "water-sensor", kind: "clear-water-leak" });
  const recovered = engine.snapshot().alerts.find((item) => item.id === alert.id)!;
  assert.ok(recovered.acknowledgedAt);
  assert.ok(recovered.recoveredAt);
});

test("alert acknowledgement preserves the actual terminal source in audit", () => {
  const engine = new SimulationEngine();
  const alert = engine.snapshot().alerts[0];
  engine.acknowledgeAlert(alert.id, "primary");
  const audit = engine.getAudits().find((item) => item.action === "确认告警");
  assert.equal(audit?.source, "primary");
});

test("control APIs reject unauthenticated clients before accepting a claimed source", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/alerts/alert-model-review/acknowledge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "forged-client" })
  });
  assert.equal(response.status, 401);
  assert.equal(((await response.json()) as { error: string }).error, "TERMINAL_AUTH_REQUIRED");
});

test("native WebView preflight permits runtime and test terminal headers", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/snapshot`, {
    method: "OPTIONS",
    headers: {
      origin: "http://appassets.androidplatform.net",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,x-smart-lab-version,x-smart-lab-test-terminal-token"
    }
  });
  assert.equal(response.status, 204);
  const allowed = response.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
  assert.match(allowed, /authorization/);
  assert.match(allowed, /x-smart-lab-version/);
  assert.match(allowed, /x-smart-lab-test-terminal-token/);
});

test("control source is derived from bearer identity and cannot be forged by request body", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" })
  });
  const adminToken = ((await login.json()) as { data: { token: string } }).data.token;

  for (const [bearer, claimed, expected] of [
    ["mock-secondary-terminal-token", "primary", "secondary"],
    ["mock-primary-terminal-token", "admin", "primary"],
    [adminToken, "primary", "admin"]
  ] as const) {
    const response = await fetch(`${base}/api/v1/alerts/alert-model-review/acknowledge`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ source: claimed })
    });
    assert.equal(response.status, 200);
    const audits = await fetch(`${base}/api/v1/admin/audits`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const records = ((await audits.json()) as { data: Array<{ action: string; source: string }> }).data;
    assert.equal(records.find((item) => item.action === "确认告警")?.source, expected);
  }
});

test("command and scene APIs reject forged audit sources", async () => {
  const engine = new SimulationEngine();
  await assert.rejects(
    engine.command("living-main-light", {
      requestId: "forged-command-source",
      property: "power",
      value: false,
      source: "forged-client" as "primary"
    }),
    /INVALID_COMMAND_SOURCE/
  );
  await assert.rejects(engine.executeScene("scene-home", "forged-client" as "primary"), /INVALID_SCENE_SOURCE/);
});

test("terminal presence follows the last live event stream connection", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" })
  });
  const token = ((await login.json()) as { data: { token: string } }).data.token;
  const firstTicket = await terminalEventTicket(base, "mock-secondary-terminal-token");
  const secondTicket = await terminalEventTicket(base, "mock-secondary-terminal-token");
  const first = new WebSocket(`${base.replace("http", "ws")}/api/v1/events?surface=secondary&ticket=${firstTicket}`);
  const second = new WebSocket(`${base.replace("http", "ws")}/api/v1/events?surface=secondary&ticket=${secondTicket}`);
  await Promise.all([
    new Promise<void>((resolve) => first.once("open", resolve)),
    new Promise<void>((resolve) => second.once("open", resolve))
  ]);

  const secondaryOnline = async () => {
    const response = await fetch(`${base}/api/v1/admin/resources/terminals?pageSize=100`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as { data: { items: Array<{ role: string; online: boolean }> } };
    return body.data.items.find((item) => item.role === "secondary")?.online;
  };
  const expectPresence = async (expected: boolean) => {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if ((await secondaryOnline()) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await secondaryOnline(), expected);
  };
  await expectPresence(true);

  const firstClosed = new Promise<void>((resolve) => first.once("close", resolve));
  first.close();
  await firstClosed;
  await expectPresence(true);
  const secondClosed = new Promise<void>((resolve) => second.once("close", resolve));
  second.close();
  await secondClosed;
  await expectPresence(false);
});

test("terminal revocation closes live streams and cannot be undone by stale configuration", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" })
  });
  const token = ((await login.json()) as { data: { token: string } }).data.token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const initialCode = (
    (await (await fetch(`${base}/api/v1/admin/terminals/pairing-code`, { headers })).json()) as { data: { code: string } }
  ).data.code;
  const initialPair = await fetch(`${base}/api/v1/terminals/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingCode: initialCode,
      deviceId: "android-original-secondary",
      name: "实训台副屏",
      role: "secondary",
      version: "0.1.0"
    })
  });
  const initialPairData = (
    (await initialPair.json()) as { data: { token: string; controlDomainId: string; controlDomainProofKey: string } }
  ).data;
  const oldToken = initialPairData.token;
  const oldProofKey = Buffer.from(initialPairData.controlDomainProofKey, "base64url");
  const initialTicket = await fetch(`${base}/api/v1/terminals/event-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${oldToken}` }
  });
  const oldTicket = ((await initialTicket.json()) as { data: { ticket: string } }).data.ticket;
  const stale = ((await (await fetch(`${base}/api/v1/admin/config`, { headers })).json()) as { data: AdminConfiguration }).data;
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/events?surface=secondary&ticket=${oldTicket}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  const revoked = await fetch(`${base}/api/v1/admin/terminals/terminal-secondary/revoke`, {
    method: "POST",
    headers,
    body: "{}"
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await closed, { code: 1008, reason: "TERMINAL_REVOKED" });
  const config = ((await (await fetch(`${base}/api/v1/admin/config`, { headers })).json()) as { data: AdminConfiguration }).data;
  assert.equal(config.terminals.find((item) => item.role === "secondary")?.paired, false);
  assert.equal(config.terminals.find((item) => item.role === "secondary")?.online, false);
  const revokedNonce = Buffer.alloc(32, 9).toString("base64url");
  const revokedClientProof = createHmac("sha256", oldProofKey)
    .update(`client:${initialPairData.controlDomainId}:android-original-secondary:${revokedNonce}`)
    .digest("base64url");
  const revokedChallenge = await fetch(`${base}/api/v1/control-domain/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "android-original-secondary", nonce: revokedNonce, clientProof: revokedClientProof })
  });
  assert.equal(revokedChallenge.status, 401);
  const replay = await fetch(`${base}/api/v1/admin/config`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...stale, version: config.version })
  });
  assert.equal(replay.status, 409);
  assert.equal(((await replay.json()) as { error: string }).error, "TERMINAL_REPAIR_REQUIRES_NEW_PAIRING");

  const pairingCode = await fetch(`${base}/api/v1/admin/terminals/pairing-code`, { headers });
  assert.equal(pairingCode.status, 200);
  const code = ((await pairingCode.json()) as { data: { code: string } }).data.code;
  const pair = await fetch(`${base}/api/v1/terminals/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingCode: code,
      deviceId: "android-original-secondary",
      name: "实训台副屏",
      role: "secondary",
      version: "0.2.0"
    })
  });
  assert.equal(pair.status, 200);
  const newPairData = ((await pair.json()) as { data: { token: string; controlDomainProofKey: string } }).data;
  const newToken = newPairData.token;
  assert.notEqual(newPairData.controlDomainProofKey, initialPairData.controlDomainProofKey);
  const oldTokenTicket = await fetch(`${base}/api/v1/terminals/event-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${oldToken}` }
  });
  assert.equal(oldTokenTicket.status, 401);
  const newTokenTicket = await fetch(`${base}/api/v1/terminals/event-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${newToken}` }
  });
  assert.equal(newTokenTicket.status, 200);
  const repaired = ((await (await fetch(`${base}/api/v1/admin/config`, { headers })).json()) as { data: AdminConfiguration }).data;
  assert.equal(repaired.terminals.find((item) => item.role === "secondary")?.paired, true);
  assert.equal(repaired.terminals.find((item) => item.role === "secondary")?.version, "0.2.0");
});

test("handover checklist blocks unsafe state and archives only a fresh fully acknowledged handover", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" })
  });
  const token = ((await login.json()) as { data: { token: string } }).data.token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const first = ((await (await fetch(`${base}/api/v1/admin/handover`, { headers })).json()) as { data: HandoverChecklist }).data;
  assert.equal(first.canComplete, false);
  assert.ok(first.blockers.includes("BENCH_NOT_RESET"));

  const reset = await fetch(`${base}/api/v1/admin/bench-reset`, { method: "POST", headers, body: "{}" });
  assert.ok([200, 207].includes(reset.status));
  const ready = ((await (await fetch(`${base}/api/v1/admin/handover`, { headers })).json()) as { data: HandoverChecklist }).data;
  assert.equal(ready.blockers.includes("BENCH_NOT_RESET"), false);
  const missingAcknowledgement = await fetch(`${base}/api/v1/admin/handover/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      completionId: "handover-test-missing",
      completedBy: "值班员张工",
      stateToken: ready.stateToken,
      acknowledgedWarnings: [],
      note: "已现场核对"
    })
  });
  assert.equal(missingAcknowledgement.status, ready.warnings.length ? 409 : 200);
  const completed = await fetch(`${base}/api/v1/admin/handover/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      completionId: "handover-test-001",
      completedBy: "值班员张工",
      stateToken: ready.stateToken,
      acknowledgedWarnings: ready.warnings,
      note: "已现场核对"
    })
  });
  assert.equal(completed.status, 200);
  const archived = ((await completed.json()) as { data: HandoverCompletion }).data;
  assert.equal(archived.completedBy, "值班员张工");
  const retry = await fetch(`${base}/api/v1/admin/handover/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ completionId: archived.id, completedBy: "忽略", stateToken: "stale", acknowledgedWarnings: [], note: "" })
  });
  assert.deepEqual(((await retry.json()) as { data: HandoverCompletion }).data, archived);
  const after = ((await (await fetch(`${base}/api/v1/admin/handover`, { headers })).json()) as { data: HandoverChecklist }).data;
  assert.deepEqual(after.lastCompletion, archived);
  const audits = ((await (await fetch(`${base}/api/v1/admin/audits`, { headers })).json()) as { data: AuditRecord[] }).data;
  assert.equal(
    audits.some((item) => item.action === "完成运行交接" && item.detail.includes("已现场核对")),
    true
  );
  assert.equal(audits.filter((item) => item.action === "完成运行交接").length, 1);
  const stale = await fetch(`${base}/api/v1/admin/handover/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      completionId: "handover-test-002",
      completedBy: "值班员张工",
      stateToken: first.stateToken,
      acknowledgedWarnings: first.warnings,
      note: ""
    })
  });
  assert.equal(stale.status, 409);
});

test("event stream sends idle heartbeats without advancing business sequence", async (t) => {
  const server = createEdgeServer({ heartbeatIntervalMs: 20 }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const ticket = await terminalEventTicket(base, "mock-primary-terminal-token");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/events?surface=primary&ticket=${ticket}`);
  const events = await new Promise<Array<{ type: string; sequence: number; payload: unknown }>>((resolve, reject) => {
    const received: Array<{ type: string; sequence: number; payload: unknown }> = [];
    const timer = setTimeout(() => reject(new Error("heartbeat timeout")), 500);
    socket.on("message", (data) => {
      received.push(JSON.parse(data.toString()) as { type: string; sequence: number; payload: unknown });
      if (received.length === 2) {
        clearTimeout(timer);
        resolve(received);
      }
    });
    socket.once("error", reject);
  });
  socket.close();
  assert.equal(events[0]?.type, "snapshot");
  assert.equal(events[1]?.type, "heartbeat");
  assert.equal(events[1]?.sequence, events[0]?.sequence);
  assert.match((events[1]?.payload as { serverTime: string }).serverTime, /^\d{4}-\d{2}-\d{2}T/);
});

test("event stream rejects missing cross-role and replayed tickets", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const expectRejected = (url: string) =>
    new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("expected security close")), 1000);
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        try {
          assert.equal(code, 1008);
          assert.equal(reason.toString(), "TERMINAL_AUTH_REQUIRED");
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", () => undefined);
    });

  await expectRejected(`${base.replace("http", "ws")}/api/v1/events?surface=primary`);
  const ticket = await terminalEventTicket(base, "mock-secondary-terminal-token");
  await expectRejected(`${base.replace("http", "ws")}/api/v1/events?surface=primary&ticket=${ticket}`);
  await expectRejected(`${base.replace("http", "ws")}/api/v1/events?surface=secondary&ticket=${ticket}`);
});

test("configuration save cannot overwrite terminal runtime presence", () => {
  const engine = new SimulationEngine();
  engine.setTerminalPresence("secondary", false);
  const stale = engine.getConfiguration();
  stale.terminals.find((item) => item.role === "secondary")!.online = true;

  const saved = engine.updateConfiguration(stale);

  assert.equal(saved.terminals.find((item) => item.role === "secondary")?.online, false);
});

test("admin API rejects missing bearer session and accepts a valid PIN session", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const rejected = await fetch(`${base}/api/v1/admin/config`);
  assert.equal(rejected.status, 401);
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" })
  });
  assert.equal(login.status, 200);
  const session = (await login.json()) as { data: { token: string } };
  const accepted = await fetch(`${base}/api/v1/admin/config`, { headers: { authorization: `Bearer ${session.data.token}` } });
  assert.equal(accepted.status, 200);
});

test("admin PIN brute force is locked after five failures", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const attempt = (pin: string) =>
    fetch(`${base}/api/v1/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin })
    });

  for (let index = 0; index < 5; index += 1) assert.equal((await attempt("1111")).status, 401);
  const blocked = await attempt("2468");
  assert.equal(blocked.status, 429);
  assert.equal(((await blocked.json()) as { error: string }).error, "TOO_MANY_AUTH_ATTEMPTS");
});

test("admin PIN rotation revokes every old session and accepts only the new PIN", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (pin: string) => {
    const response = await fetch(`${base}/api/v1/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin })
    });
    return { response, body: (await response.json()) as { data?: { token: string }; error?: string } };
  };
  const first = (await login("2468")).body.data!.token;
  const second = (await login("2468")).body.data!.token;
  const changed = await fetch(`${base}/api/v1/admin/change-pin`, {
    method: "POST",
    headers: { authorization: `Bearer ${first}`, "content-type": "application/json" },
    body: JSON.stringify({ currentPin: "2468", newPin: "135790", confirmPin: "135790" })
  });
  assert.equal(changed.status, 200);
  assert.equal((await fetch(`${base}/api/v1/admin/config`, { headers: { authorization: `Bearer ${first}` } })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/admin/config`, { headers: { authorization: `Bearer ${second}` } })).status, 401);
  assert.equal((await login("2468")).response.status, 401);
  const relogin = await login("135790");
  assert.equal(relogin.response.status, 200);
  const auditsResponse = await fetch(`${base}/api/v1/admin/audits`, {
    headers: { authorization: `Bearer ${relogin.body.data!.token}` }
  });
  assert.equal(auditsResponse.status, 200);
  const audits = (await auditsResponse.json()) as { data: Array<{ action: string; detail: string }> };
  const audit = audits.data.find((item) => item.action === "轮换管理员 PIN");
  assert.ok(audit);
  assert.equal(audit.detail.includes("2468") || audit.detail.includes("135790"), false);
});

test("admin PIN rotation locks repeated wrong-current attempts without revoking the session", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" })
  });
  const token = ((await login.json()) as { data: { token: string } }).data.token;
  const attempt = (currentPin: string) =>
    fetch(`${base}/api/v1/admin/change-pin`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ currentPin, newPin: "135790", confirmPin: "135790" })
    });
  for (let index = 0; index < 5; index += 1) assert.equal((await attempt("0000")).status, 401);
  assert.equal((await attempt("2468")).status, 429);
  assert.equal((await fetch(`${base}/api/v1/admin/config`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
});

test("admin API returns 409 for a stale configuration and preserves the winner", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" })
  });
  const token = ((await login.json()) as { data: { token: string } }).data.token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const original = ((await (await fetch(`${base}/api/v1/admin/config`, { headers })).json()) as { data: AdminConfiguration }).data;
  const winner = structuredClone(original);
  renameRoom(winner, 0, "API 最新版本");
  assert.equal((await fetch(`${base}/api/v1/admin/config`, { method: "PUT", headers, body: JSON.stringify(winner) })).status, 200);

  const stale = structuredClone(original);
  renameRoom(stale, 0, "API 过期版本");
  const conflict = await fetch(`${base}/api/v1/admin/config`, { method: "PUT", headers, body: JSON.stringify(stale) });
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as { error: string }).error, "CONFIG_VERSION_CONFLICT");
  const current = ((await (await fetch(`${base}/api/v1/admin/config`, { headers })).json()) as { data: AdminConfiguration }).data;
  assert.equal(current.rooms[0].name, "API 最新版本");
});

test("admin resource query paginates, filters and clamps invalid page input", () => {
  const engine = new SimulationEngine();
  const first = engine.queryAdminResource("devices", { page: 1, pageSize: 4 });
  assert.equal(first.items.length, 4);
  assert.equal(first.page, 1);
  assert.equal(first.pageSize, 4);
  assert.equal(first.total, 18);
  assert.equal(first.totalPages, 5);

  const last = engine.queryAdminResource("devices", { page: 99, pageSize: 4 });
  assert.equal(last.page, 5);
  assert.equal(last.items.length, 2);

  const filtered = engine.queryAdminResource("devices", { q: "水浸", pageSize: 10 });
  assert.equal(filtered.total, 2);
  assert.ok(filtered.items.every((item) => "name" in item && item.name.includes("水浸")));

  const malformed = engine.queryAdminResource("devices", { page: Number.NaN, pageSize: Number.NaN });
  assert.equal(malformed.page, 1);
  assert.equal(malformed.pageSize, 10);
  assert.equal(malformed.items.length, 10);
});

test("admin resource API requires bearer auth and returns pagination metadata", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const rejected = await fetch(`${base}/api/v1/admin/resources/devices?page=2&pageSize=4`);
  assert.equal(rejected.status, 401);
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" })
  });
  const session = (await login.json()) as { data: { token: string } };
  const response = await fetch(`${base}/api/v1/admin/resources/devices?page=2&pageSize=4`, {
    headers: { authorization: `Bearer ${session.data.token}` }
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: { items: unknown[]; page: number; pageSize: number; total: number; totalPages: number } };
  assert.equal(body.data.page, 2);
  assert.equal(body.data.pageSize, 4);
  assert.equal(body.data.items.length, 4);
  assert.equal(body.data.total, 18);
  assert.equal(body.data.totalPages, 5);

  const corrected = await fetch(`${base}/api/v1/admin/resources/devices?page=invalid&pageSize=invalid`, {
    headers: { authorization: `Bearer ${session.data.token}` }
  });
  const correctedBody = (await corrected.json()) as { data: { page: number; pageSize: number; items: unknown[] } };
  assert.equal(correctedBody.data.page, 1);
  assert.equal(correctedBody.data.pageSize, 10);
  assert.equal(correctedBody.data.items.length, 10);
});

test("Mock EdgeCore passes the language-neutral shared API contract suite", async (t) => {
  const server = createEdgeServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" })
  });
  const adminToken = ((await login.json()) as { data: { token: string } }).data.token;

  const variables = { writableDeviceId: "living-main-light", sceneId: "scene-home" };
  const interpolate = (value: string) =>
    Object.entries(variables).reduce((result, [key, replacement]) => result.replaceAll(`{{${key}}}`, replacement), value);
  const interpolateBody = (value: unknown) => JSON.parse(interpolate(JSON.stringify(value))) as unknown;

  for (const contractCase of sharedContractCases) {
    const path = interpolate(contractCase.path);
    if (contractCase.method === "WS") {
      const ticket = await terminalEventTicket(base, "contract-primary-terminal-token");
      const event = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const separator = path.includes("?") ? "&" : "?";
        const socket = new WebSocket(`${base.replace("http", "ws")}${path}${separator}surface=primary&ticket=${ticket}`);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error(`${contractCase.name}: timeout`));
        }, 3000);
        socket.once("message", (data) => {
          clearTimeout(timer);
          socket.close();
          resolve(JSON.parse(data.toString()) as Record<string, unknown>);
        });
        socket.once("error", reject);
      });
      assert.equal(event.type, "snapshot", contractCase.name);
      assert.equal(typeof event.sequence, "number", contractCase.name);
      assert.ok(event.payload && typeof event.payload === "object", contractCase.name);
      for (const key of contractCase.requiredDataKeys)
        assert.ok(key in (event.payload as Record<string, unknown>), `${contractCase.name}: ${key}`);
      continue;
    }
    const response = await fetch(`${base}${path}`, {
      method: contractCase.method,
      headers: {
        ...(contractCase.auth === "admin" ? { authorization: `Bearer ${adminToken}` } : {}),
        ...(contractCase.auth === "terminal" ? { authorization: "Bearer contract-primary-terminal-token" } : {}),
        ...(contractCase.requestBody ? { "content-type": "application/json" } : {})
      },
      body: contractCase.requestBody ? JSON.stringify(interpolateBody(contractCase.requestBody)) : undefined
    });
    assert.equal(response.status, contractCase.expectedStatus, contractCase.name);
    const body = (await response.json()) as Record<string, unknown>;
    if (contractCase.bodyKind === "error") {
      assert.equal(typeof body.error, "string", contractCase.name);
      continue;
    }
    assert.equal(typeof body.sequence, "number", contractCase.name);
    assert.ok("data" in body, contractCase.name);
    if (contractCase.dataKind === "array") {
      assert.ok(Array.isArray(body.data), contractCase.name);
    } else if (contractCase.dataKind === "object") {
      assert.ok(body.data && typeof body.data === "object" && !Array.isArray(body.data), contractCase.name);
      const data = body.data as Record<string, unknown>;
      for (const key of contractCase.requiredDataKeys) assert.ok(key in data, `${contractCase.name}: ${key}`);
    }
  }
});

test("formal routes do not expose training or simulator capabilities", async (t) => {
  const server = createEdgeServer({ testSupport: true }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" })
  });
  const token = ((await login.json()) as { data: { token: string } }).data.token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  for (const path of [
    "/api/v1/admin/training",
    "/api/v1/admin/training/legacy/start",
    "/api/v1/admin/resources/training",
    "/api/v1/simulator/reset",
    "/api/v1/simulator/faults"
  ]) {
    const response = await fetch(`${base}${path}`, { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 404, path);
  }

  const testReset = await fetch(`${base}/api/v1/_test/reset`, { method: "POST", headers, body: "{}" });
  assert.equal(testReset.status, 200);
});

test("each mock bench exposes one stable control domain in health and pairing", async (t) => {
  const first = createEdgeServer().listen(0, "127.0.0.1");
  const second = createEdgeServer().listen(0, "127.0.0.1");
  await Promise.all([
    new Promise<void>((resolve) => first.once("listening", resolve)),
    new Promise<void>((resolve) => second.once("listening", resolve))
  ]);
  t.after(() => {
    first.close();
    second.close();
  });
  const base = (server: typeof first) => {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  };
  const firstBase = base(first);
  const secondBase = base(second);
  const health = async (edge: string) =>
    ((await (await fetch(`${edge}/api/v1/health`)).json()) as { data: { controlDomainId: string } }).data.controlDomainId;
  const firstId = await health(firstBase);
  assert.match(firstId, /^[0-9a-f-]{36}$/i);
  assert.equal(await health(firstBase), firstId);
  assert.notEqual(await health(secondBase), firstId);
  const pair = await fetch(`${firstBase}/api/v1/terminals/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingCode: "123456", deviceId: "android-domain-test", name: "副屏", role: "secondary", version: "0.1.0" })
  });
  assert.equal(pair.status, 200);
  const pairData = ((await pair.json()) as { data: { controlDomainId: string; controlDomainProofKey: string } }).data;
  assert.equal(pairData.controlDomainId, firstId);
  const nonce = Buffer.alloc(32, 5).toString("base64url");
  const derivedKey = Buffer.from(pairData.controlDomainProofKey, "base64url");
  const clientProof = createHmac("sha256", derivedKey).update(`client:${firstId}:android-domain-test:${nonce}`).digest("base64url");
  const challenge = await fetch(`${firstBase}/api/v1/control-domain/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "android-domain-test", nonce, clientProof })
  });
  assert.equal(challenge.status, 200);
  const challengeData = ((await challenge.json()) as { data: { nonce: string; proof: string } }).data;
  assert.equal(challengeData.nonce, nonce);
  assert.equal(
    challengeData.proof,
    createHmac("sha256", derivedKey).update(`server:${firstId}:android-domain-test:${nonce}`).digest("base64url")
  );
  const oracleAttempt = await fetch(`${firstBase}/api/v1/control-domain/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "android-domain-test", nonce, clientProof: Buffer.alloc(32).toString("base64url") })
  });
  assert.equal(oracleAttempt.status, 401);
});
