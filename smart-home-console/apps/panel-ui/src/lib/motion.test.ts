import assert from "node:assert/strict";
import test from "node:test";
import { isMotionMode, resolveMotionMode } from "./motion";

test("动效档位只接受三个稳定值", () => {
  assert.equal(isMotionMode("full"), true);
  assert.equal(isMotionMode("reduced"), true);
  assert.equal(isMotionMode("off"), true);
  assert.equal(isMotionMode("fast"), false);
  assert.equal(isMotionMode(null), false);
});

test("无显式偏好时尊重系统减少动态效果设置", () => {
  assert.equal(resolveMotionMode(null, false), "full");
  assert.equal(resolveMotionMode(null, true), "reduced");
  assert.equal(resolveMotionMode("off", false), "off");
  assert.equal(resolveMotionMode("full", true), "full");
});
