import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_IDLE_TIMEOUT_MS, adminIdleState, idleRemainingLabel } from "./admin-idle";

test("管理台闲置计时依次进入正常、预警和锁定状态", () => {
  const startedAt = 1_000;
  assert.deepEqual(adminIdleState(startedAt, startedAt + 7 * 60_000), {
    remainingMs: 3 * 60_000,
    warning: false,
    expired: false
  });
  assert.deepEqual(adminIdleState(startedAt, startedAt + 8 * 60_000), {
    remainingMs: 2 * 60_000,
    warning: true,
    expired: false
  });
  assert.deepEqual(adminIdleState(startedAt, startedAt + ADMIN_IDLE_TIMEOUT_MS), {
    remainingMs: 0,
    warning: false,
    expired: true
  });
});

test("本机时钟回拨不会制造超出上限的闲置时间", () => {
  assert.equal(adminIdleState(10_000, 1_000).remainingMs, ADMIN_IDLE_TIMEOUT_MS);
  assert.equal(idleRemainingLabel(61_000), "1 分 01 秒");
  assert.equal(idleRemainingLabel(9_100), "10 秒");
});
