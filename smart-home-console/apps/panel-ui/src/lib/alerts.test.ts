import assert from "node:assert/strict";
import test from "node:test";
import type { AlertRecord } from "@smart-lab/contracts";
import type { Device } from "@smart-lab/contracts";
import { activeAlerts, alertRecoveryAvailability, featuredActiveAlert, unacknowledgedAlerts } from "./alerts";

const alert = (overrides: Partial<AlertRecord>): AlertRecord => ({
  id: "base",
  deviceId: "sensor-a",
  level: "info",
  title: "状态事件",
  message: "待核对",
  occurredAt: "2026-07-25T01:00:00.000Z",
  ...overrides
});

test("确认只退出待确认集合，恢复才退出活动告警集合", () => {
  const open = alert({ id: "open" });
  const acknowledged = alert({ id: "ack", acknowledgedAt: "2026-07-25T01:01:00.000Z" });
  const recovered = alert({
    id: "recovered",
    acknowledgedAt: "2026-07-25T01:01:00.000Z",
    recoveredAt: "2026-07-25T01:02:00.000Z"
  });

  assert.deepEqual(
    activeAlerts([open, acknowledged, recovered]).map((item) => item.id),
    ["open", "ack"]
  );
  assert.deepEqual(
    unacknowledgedAlerts([open, acknowledged, recovered]).map((item) => item.id),
    ["open"]
  );
});

test("活动告警按严重度、确认状态和时间稳定选出摘要", () => {
  const items = [
    alert({ id: "info-open", occurredAt: "2026-07-25T03:00:00.000Z" }),
    alert({ id: "critical-ack", level: "critical", acknowledgedAt: "2026-07-25T02:00:00.000Z" }),
    alert({ id: "critical-old", level: "critical", occurredAt: "2026-07-25T01:00:00.000Z" }),
    alert({ id: "critical-new", level: "critical", occurredAt: "2026-07-25T04:00:00.000Z" })
  ];

  assert.equal(featuredActiveAlert(items)?.id, "critical-new");
  assert.equal(featuredActiveAlert(items.filter((item) => item.id !== "critical-new"))?.id, "critical-old");
  assert.equal(featuredActiveAlert(items.filter((item) => !["critical-new", "critical-old"].includes(item.id)))?.id, "critical-ack");
});

test("恢复条件必须由在线设备的权威状态解除", () => {
  const conditioned = alert({ id: "water", recoveryProperty: "waterLeak", recoveryValue: false });
  const device = {
    id: "sensor-a",
    health: "online",
    state: { waterLeak: true }
  } as unknown as Device;

  assert.equal(alertRecoveryAvailability(conditioned, [device]).allowed, false);
  assert.equal(alertRecoveryAvailability(conditioned, [{ ...device, state: { waterLeak: false } }]).allowed, true);
  assert.equal(alertRecoveryAvailability(conditioned, [{ ...device, health: "offline" }]).allowed, false);
  assert.equal(alertRecoveryAvailability(alert({ id: "manual" }), [device]).allowed, true);
});

test("监控链路事件只能由设备在线状态解除", () => {
  const unavailable = alert({ id: "availability", recoveryProperty: "__health", recoveryValue: "online" });
  const device = { id: "sensor-a", health: "offline", state: {} } as unknown as Device;

  const blocked = alertRecoveryAvailability(unavailable, [device]);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /仍未恢复在线/);
  assert.equal(alertRecoveryAvailability(unavailable, [{ ...device, health: "online" }]).allowed, true);
});
