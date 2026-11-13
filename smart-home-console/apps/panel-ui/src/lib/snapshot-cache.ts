import type { SystemSnapshot } from "@smart-lab/contracts";

// v2 不再接受旧正式产品边界前的快照，避免断线时把已移除的训练/模拟场景带回 UI。
export const SNAPSHOT_CACHE_VERSION = 2;
export const SNAPSHOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = "smart-lab:last-snapshot";

export interface SnapshotCacheEntry {
  version: typeof SNAPSHOT_CACHE_VERSION;
  deploymentId: string;
  savedAt: string;
  snapshot: SystemSnapshot;
}

export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function snapshotCacheKey(controlDomain: string, surface: "primary" | "secondary") {
  return `${CACHE_PREFIX}:${encodeURIComponent(controlDomain || "same-origin")}:${surface}`;
}

export function snapshotDeploymentId(snapshot: SystemSnapshot) {
  const gateways = snapshot.health.gateways
    .map((gateway) => `${gateway.id}:${gateway.model}`)
    .sort()
    .join("|");
  return gateways || "unconfigured";
}

export function createCachedSnapshot(snapshot: SystemSnapshot, savedAt = new Date().toISOString()): SnapshotCacheEntry {
  // Pinia 会把快照包装成 Proxy，structuredClone 无法克隆 Proxy；合同快照是纯 JSON 数据，
  // 用 JSON 边界同时解除响应式代理并避免把任何运行时对象带进持久层。
  const copy = JSON.parse(JSON.stringify(snapshot)) as SystemSnapshot;
  // 进程重启后，旧的在途状态已无法证明仍在执行；只保留终态回执。
  copy.commands = copy.commands.filter((command) => command.status !== "pending").slice(0, 50);
  copy.executions = copy.executions.filter((execution) => execution.status !== "running").slice(0, 20);
  return {
    version: SNAPSHOT_CACHE_VERSION,
    deploymentId: snapshotDeploymentId(snapshot),
    savedAt,
    snapshot: copy
  };
}

export function readSnapshotCache(
  storage: SnapshotStorage,
  key: string,
  now = Date.now(),
  ttlMs = SNAPSHOT_CACHE_TTL_MS
): SnapshotCacheEntry | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const entry = JSON.parse(raw) as Partial<SnapshotCacheEntry>;
    const savedAt = Date.parse(entry.savedAt ?? "");
    if (
      entry.version !== SNAPSHOT_CACHE_VERSION ||
      !entry.snapshot ||
      !isSnapshot(entry.snapshot) ||
      typeof entry.deploymentId !== "string" ||
      entry.deploymentId !== snapshotDeploymentId(entry.snapshot) ||
      !Number.isFinite(savedAt) ||
      savedAt > now + 60_000 ||
      now - savedAt > ttlMs
    ) {
      safeRemove(storage, key);
      return undefined;
    }
    // 即使缓存来自旧版本，读取边界也再次清理非终态，避免伪造“执行中”。
    return createCachedSnapshot(entry.snapshot, entry.savedAt);
  } catch {
    safeRemove(storage, key);
    return undefined;
  }
}

export function writeSnapshotCache(storage: SnapshotStorage, key: string, snapshot: SystemSnapshot, savedAt?: string) {
  try {
    storage.setItem(key, JSON.stringify(createCachedSnapshot(snapshot, savedAt)));
  } catch {
    // WebView 隐私模式、存储禁用或配额耗尽都不能影响实时控制。
  }
}

export function cachedSnapshotAgeLabel(savedAt: string, now = Date.now()) {
  const ageMs = Math.max(0, now - Date.parse(savedAt));
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "刚刚保存";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function isSnapshot(value: unknown): value is SystemSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<SystemSnapshot>;
  return (
    typeof snapshot.sequence === "number" &&
    Array.isArray(snapshot.devices) &&
    Array.isArray(snapshot.scenes) &&
    Array.isArray(snapshot.alerts) &&
    Array.isArray(snapshot.commands) &&
    Array.isArray(snapshot.executions) &&
    Boolean(snapshot.health && typeof snapshot.health === "object" && Array.isArray(snapshot.health.gateways))
  );
}

function safeRemove(storage: SnapshotStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // 清理失败只会导致下次再次忽略，不影响启动。
  }
}
