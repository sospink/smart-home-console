import assert from "node:assert/strict";
import test from "node:test";
import { authoritativeNow, serverClockOffset } from "./clock.js";

test("both terminals derive display time from the same EdgeCore server clock", () => {
  const server = "2026-07-24T02:00:00.000Z";
  const primaryLocal = Date.parse("2026-07-24T01:59:40.000Z");
  const secondaryLocal = Date.parse("2026-07-24T02:03:30.000Z");
  assert.equal(authoritativeNow(primaryLocal, serverClockOffset(server, primaryLocal)).toISOString(), server);
  assert.equal(authoritativeNow(secondaryLocal, serverClockOffset(server, secondaryLocal)).toISOString(), server);
});

test("a backward local clock jump keeps the last server offset deterministic", () => {
  const offset = serverClockOffset("2026-07-24T02:00:00.000Z", Date.parse("2026-07-24T01:59:40.000Z"));
  assert.equal(authoritativeNow(Date.parse("2026-07-24T01:58:00.000Z"), offset).toISOString(), "2026-07-24T01:58:20.000Z");
  assert.equal(serverClockOffset("not-a-time"), 0);
});
