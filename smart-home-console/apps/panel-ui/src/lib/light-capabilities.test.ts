import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceCapability } from "@smart-lab/contracts";
import { kelvinColor, lightColorTemperaturePresets, lightEffectLabel, rangeProgress, valueFromVerticalPointer } from "./light-capabilities";

const colorTemperature: DeviceCapability = {
  property: "colorTemperature",
  label: "色温",
  type: "number",
  min: 2700,
  max: 5700,
  step: 100,
  unit: "K",
  writable: true
};

test("色温预设严格使用设备能力范围而不是固定 6500K", () => {
  assert.deepEqual(lightColorTemperaturePresets(colorTemperature), [
    { label: "暖光", value: 2700 },
    { label: "自然", value: 4200 },
    { label: "清亮", value: 5700 }
  ]);
});

test("范围进度会按能力上下限归一化并夹紧", () => {
  assert.equal(rangeProgress(2700, colorTemperature), 0);
  assert.equal(rangeProgress(4200, colorTemperature), 50);
  assert.equal(rangeProgress(6500, colorTemperature), 100);
});

test("色温插值经过自然白而不是 HSL 色相环中的绿色", () => {
  assert.equal(kelvinColor(2700, colorTemperature), "rgb(255 181 107)");
  assert.equal(kelvinColor(4200, colorTemperature), "rgb(255 235 202)");
  assert.equal(kelvinColor(5700, colorTemperature), "rgb(218 239 255)");
});

test("纵向拖动会从底部最小值映射到顶部最大值并按步长对齐", () => {
  const brightness: DeviceCapability = {
    property: "brightness",
    label: "亮度",
    type: "number",
    min: 1,
    max: 100,
    step: 1,
    writable: true
  };
  assert.equal(valueFromVerticalPointer(100, 100, 200, brightness), 100);
  assert.equal(valueFromVerticalPointer(300, 100, 200, brightness), 1);
  assert.equal(valueFromVerticalPointer(200, 100, 200, brightness), 51);
  assert.equal(valueFromVerticalPointer(20, 100, 200, brightness), 100);
  assert.equal(valueFromVerticalPointer(400, 100, 200, brightness), 1);
});

test("灯效展示不会暴露 HA 的空场景协议说明", () => {
  const raw = "空场景（灯不在任何情况模式时，上报该属性值）";
  assert.equal(lightEffectLabel(raw, raw), "常规");
  assert.equal(lightEffectLabel("", raw), "常规");
  assert.equal(lightEffectLabel("夜灯模式", "夜灯模式"), "夜灯");
});
