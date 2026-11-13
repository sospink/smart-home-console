import assert from "node:assert/strict";
import test from "node:test";
import type { SystemSnapshot } from "@smart-lab/contracts";
import {
  cachedSnapshotAgeLabel,
  createCachedSnapshot,
  readSnapshotCache,
  SNAPSHOT_CACHE_VERSION,
  snapshotCacheKey,
  writeSnapshotCache,
  type SnapshotStorage
} from "./snapshot-cache";

const NOW = Date.parse("2026-07-25T08:00:00.000Z");

function snapshot(): SystemSnapshot {
  return {
    sequence: 42,
    devices: [],
    scenes: [],
    alerts: [],
    commands: [
      {
        id: "pending",
        requestId: "r1",
        deviceId: "light",
        property: "power",
        value: true,
        source: "primary",
        status: "pending",
        createdAt: "2026-07-25T07:58:00.000Z"
      },
      {
        id: "done",
        requestId: "r2",
        deviceId: "light",
        property: "power",
        value: false,
        source: "primary",
        status: "confirmed",
        createdAt: "2026-07-25T07:57:00.000Z"
      }
    ],
    executions: [
      {
        id: "running",
        sceneId: "home",
        source: "primary",
        status: "running",
        completedActions: 1,
        totalActions: 2,
        startedAt: "2026-07-25T07:58:00.000Z"
      },
      {
        id: "complete",
        sceneId: "away",
        source: "secondary",
        status: "completed",
        completedActions: 2,
        totalActions: 2,
        startedAt: "2026-07-25T07:50:00.000Z",
        finishedAt: "2026-07-25T07:50:02.000Z"
      }
    ],
    health: {
      controlDomainId: "00000000-0000-4000-8000-000000000000",
      mode: "test-fixture",
      version: "test",
      serverTime: "2026-07-25T08:00:00.000Z",
      uptimeSeconds: 10,
      gateways: [
        {
          id: "gw-1",
          name: "一号台",
          model: "DMWG03LM",
          firmware: "test",
          status: "online",
          latencyMs: 10,
          lastHeartbeatAt: "2026-07-25T08:00:00.000Z",
          mode: "test-fixture"
        }
      ]
    }
  };
}

class MemoryStorage implements SnapshotStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("有效缓存可往返且不会恢复旧 pending / running", () => {
  const storage = new MemoryStorage();
  const key = snapshotCacheKey("http://edge-a:8787", "primary");
  writeSnapshotCache(storage, key, snapshot(), "2026-07-25T07:59:00.000Z");
  const cached = readSnapshotCache(storage, key, NOW);
  assert.equal(cached?.snapshot.sequence, 42);
  assert.deepEqual(
    cached?.snapshot.commands.map((item) => item.id),
    ["done"]
  );
  assert.deepEqual(
    cached?.snapshot.executions.map((item) => item.id),
    ["complete"]
  );
  assert.equal(cached?.savedAt, "2026-07-25T07:59:00.000Z");
});

test("响应式代理形态的快照仍可落盘", () => {
  const storage = new MemoryStorage();
  const proxied = new Proxy(snapshot(), {});
  assert.doesNotThrow(() => writeSnapshotCache(storage, "proxy", proxied));
  assert.ok(storage.getItem("proxy"));
});

test("控制域和屏幕角色使用不同缓存键", () => {
  assert.notEqual(snapshotCacheKey("edge-a", "primary"), snapshotCacheKey("edge-b", "primary"));
  assert.notEqual(snapshotCacheKey("edge-a", "primary"), snapshotCacheKey("edge-a", "secondary"));
});

test("损坏、旧边界版本、未来版本和超过 24 小时的缓存会被删除", () => {
  for (const raw of [
    "not-json",
    JSON.stringify({ ...createCachedSnapshot(snapshot()), version: 1 }),
    JSON.stringify({ ...createCachedSnapshot(snapshot()), version: SNAPSHOT_CACHE_VERSION + 1 }),
    JSON.stringify(createCachedSnapshot(snapshot(), "2026-07-23T07:59:00.000Z"))
  ]) {
    const storage = new MemoryStorage();
    storage.setItem("key", raw);
    assert.equal(readSnapshotCache(storage, "key", NOW), undefined);
    assert.equal(storage.getItem("key"), null);
  }
});

test("存储被禁用或配额耗尽不会阻断页面", () => {
  const unavailable: SnapshotStorage = {
    getItem() {
      throw new Error("disabled");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {
      throw new Error("disabled");
    }
  };
  assert.doesNotThrow(() => writeSnapshotCache(unavailable, "key", snapshot()));
  assert.equal(readSnapshotCache(unavailable, "key", NOW), undefined);
});

test("缓存年龄使用现场可读粒度", () => {
  assert.equal(cachedSnapshotAgeLabel("2026-07-25T07:59:40.000Z", NOW), "刚刚保存");
  assert.equal(cachedSnapshotAgeLabel("2026-07-25T07:40:00.000Z", NOW), "20 分钟前");
  assert.equal(cachedSnapshotAgeLabel("2026-07-25T05:00:00.000Z", NOW), "3 小时前");
});
