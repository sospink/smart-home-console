import type { Device, DeviceCapability } from "@smart-lab/contracts";

export function writableCapability(device: Device, property: string) {
  return device.capabilities.find((item) => item.property === property && item.writable);
}

export function lightEffectLabel(label: string, value: unknown) {
  const candidate = label.trim() || String(value ?? "").trim();
  return candidate.startsWith("空场景") ? "常规" : candidate.replace(/模式$/, "");
}

export function lightColorTemperaturePresets(capability?: DeviceCapability) {
  if (!capability || capability.type !== "number" || capability.min == null || capability.max == null) return [];
  const min = Math.round(capability.min);
  const max = Math.round(capability.max);
  const step = capability.step && capability.step > 0 ? capability.step : 1;
  const middle = Math.round(((min + max) / 2 - min) / step) * step + min;
  return [
    { label: "暖光", value: min },
    { label: "自然", value: Math.min(max, Math.max(min, middle)) },
    { label: "清亮", value: max }
  ].filter((item, index, items) => items.findIndex((candidate) => candidate.value === item.value) === index);
}

export function rangeProgress(value: number, capability: DeviceCapability) {
  const min = capability.min ?? 0;
  const max = capability.max ?? 100;
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

export function valueFromVerticalPointer(clientY: number, top: number, height: number, capability: DeviceCapability) {
  const min = capability.min ?? 0;
  const max = capability.max ?? 100;
  const step = capability.step && capability.step > 0 ? capability.step : 1;
  if (height <= 0 || max <= min) return min;
  const progress = Math.min(1, Math.max(0, (top + height - clientY) / height));
  const stepped = min + Math.round(((max - min) * progress) / step) * step;
  return Math.min(max, Math.max(min, stepped));
}

export function kelvinColor(value: number, capability: DeviceCapability) {
  const progress = rangeProgress(value, capability) / 100;
  // 色温不是沿 HSL 色相环变化；直接从橙色插值到蓝色会经过绿色，
  // 在暗色灯光舞台上尤其像一块脏绿蒙层。用暖白→自然白→清冷白
  // 的分段 RGB 插值，保证中间色温仍然是中性灯光。
  const warm = [255, 181, 107] as const;
  const neutral = [255, 235, 202] as const;
  const cool = [218, 239, 255] as const;
  const [from, to, localProgress] = progress <= 0.5 ? [warm, neutral, progress * 2] : [neutral, cool, (progress - 0.5) * 2];
  const channels = from.map((channel, index) => Math.round(channel + (to[index] - channel) * localProgress));
  return `rgb(${channels.join(" ")})`;
}
