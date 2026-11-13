export type MotionMode = "full" | "reduced" | "off";

export const motionModeLabels: Record<MotionMode, string> = {
  full: "完整",
  reduced: "精简",
  off: "关闭"
};

export function isMotionMode(value: string | null): value is MotionMode {
  return value === "full" || value === "reduced" || value === "off";
}

export function resolveMotionMode(stored: string | null, prefersReducedMotion: boolean): MotionMode {
  if (isMotionMode(stored)) return stored;
  return prefersReducedMotion ? "reduced" : "full";
}
