export const ADMIN_IDLE_TIMEOUT_MS = 10 * 60_000;
export const ADMIN_IDLE_WARNING_MS = 2 * 60_000;

export type AdminIdleState = {
  remainingMs: number;
  warning: boolean;
  expired: boolean;
};

export function adminIdleState(
  lastActivityAt: number,
  now = Date.now(),
  timeoutMs = ADMIN_IDLE_TIMEOUT_MS,
  warningMs = ADMIN_IDLE_WARNING_MS
): AdminIdleState {
  const elapsed = Math.max(0, now - lastActivityAt);
  const remainingMs = Math.max(0, timeoutMs - elapsed);
  return {
    remainingMs,
    warning: remainingMs > 0 && remainingMs <= warningMs,
    expired: remainingMs === 0
  };
}

export function idleRemainingLabel(remainingMs: number) {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const tail = seconds % 60;
  return minutes ? `${minutes} 分 ${String(tail).padStart(2, "0")} 秒` : `${tail} 秒`;
}
