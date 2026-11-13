import assert from "node:assert/strict";
import test from "node:test";
import { sequenceDecision } from "./sequence.js";

test("event sequence applies contiguous events", () => assert.equal(sequenceDecision(20, 21), "apply"));
test("event sequence ignores stale and duplicate events", () => {
  assert.equal(sequenceDecision(20, 20), "ignore");
  assert.equal(sequenceDecision(20, 19), "ignore");
});
test("event sequence requests snapshot recovery for a gap", () => assert.equal(sequenceDecision(20, 23), "recover"));
test("snapshot events always replace local state", () => assert.equal(sequenceDecision(20, 55, true), "apply"));
