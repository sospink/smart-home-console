import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceCapability } from "@smart-lab/contracts";
import { capabilityPresetLabels, capabilityPresetValues, capabilityProgress } from "./continuous-capability";

const position: DeviceCapability = {
  property: "position",
  label: "开合位置",
  type: "number",
  min: 0,
  max: 100,
  step: 1,
  unit: "%",
  writable: true
};

test("连续能力进度按设备范围换算并夹紧", () => {
  assert.equal(capabilityProgress(-10, position), 0);
  assert.equal(capabilityProgress(72, position), 72);
  assert.equal(capabilityProgress(120, position), 100);
});

test("窗帘能力生成语义化快捷位置", () => {
  assert.deepEqual(capabilityPresetLabels(position), ["全闭", "半开", "全开"]);
  assert.deepEqual(capabilityPresetValues(position), [0, 50, 100]);
});

test("中间预设遵守能力步长", () => {
  const temperature = { ...position, property: "targetTemperature", min: 16, max: 30, step: 0.5, unit: "℃" };
  assert.deepEqual(capabilityPresetValues(temperature), [16, 23, 30]);
  assert.deepEqual(capabilityPresetLabels(temperature), ["低", "舒适", "高"]);
});
