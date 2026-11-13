import type { DeviceCapability } from "@smart-lab/contracts";

export function capabilityProgress(value: number, capability: DeviceCapability) {
  const min = capability.min ?? 0;
  const max = capability.max ?? 100;
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

export function capabilityPresetLabels(capability: DeviceCapability) {
  if (capability.property === "position") return ["全闭", "半开", "全开"];
  if (capability.property === "volume") return ["静音", "适中", "最大"];
  if (/temperature/i.test(capability.property)) return ["低", "舒适", "高"];
  if (/angle|tilt/i.test(capability.property)) return ["最小", "居中", "最大"];
  return ["最小", "中间", "最大"];
}

export function capabilityPresetValues(capability: DeviceCapability) {
  const min = capability.min ?? 0;
  const max = capability.max ?? 100;
  const step = capability.step && capability.step > 0 ? capability.step : 1;
  const middle = min + Math.round((max - min) / 2 / step) * step;
  return [min, Math.min(max, middle), max];
}
