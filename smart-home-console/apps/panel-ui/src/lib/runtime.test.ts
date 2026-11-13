import assert from "node:assert/strict";
import test from "node:test";
import type { CommandRecord } from "@smart-lab/contracts";
import { pendingCommandsByDevice, pendingCommandsByProperty } from "./runtime";

function command(id: string, deviceId: string, status: CommandRecord["status"]): CommandRecord {
  return {
    id,
    requestId: `request-${id}`,
    deviceId,
    property: "power",
    value: true,
    source: "primary",
    status,
    createdAt: "2026-07-25T00:00:00Z"
  };
}

test("首次快照会还原每台设备最新的未决命令", () => {
  const newest = command("newest", "light-1", "pending");
  const result = pendingCommandsByDevice([
    newest,
    command("older", "light-1", "pending"),
    command("done", "curtain-1", "confirmed"),
    command("pending-curtain", "curtain-2", "pending")
  ]);

  assert.equal(result["light-1"], newest);
  assert.equal(result["curtain-1"], undefined);
  assert.equal(result["curtain-2"]?.id, "pending-curtain");
});

test("同一设备不同属性的未决命令互不覆盖", () => {
  const power = command("power", "light-1", "pending");
  const brightness = { ...command("brightness", "light-1", "pending"), property: "brightness", value: 72 };
  const result = pendingCommandsByProperty([brightness, power]);

  assert.equal(result["light-1.power"], power);
  assert.equal(result["light-1.brightness"], brightness);
  assert.equal(Object.keys(result).length, 2);
});
