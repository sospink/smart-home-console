import { createHash } from "node:crypto";

/* global AbortSignal, fetch */

export const defaultEdgeTarget = "http://192.168.251.124:8787";

export function edgeTarget() {
  return (process.env.EDGE_TARGET?.trim() || defaultEdgeTarget).replace(/\/+$/, "");
}

export function keychainService(target) {
  const digest = createHash("sha256").update(target).digest("hex").slice(0, 20);
  return `cn.zhijing.smartlab.hardware-web.${digest}`;
}

export async function hardwareIdentity(target) {
  const response = await fetch(`${target}/api/v1/health`, { signal: AbortSignal.timeout(6_000) });
  if (!response.ok) throw new Error(`主屏 EdgeCore 健康检查失败：HTTP ${response.status}`);
  const envelope = await response.json();
  const health = envelope?.data;
  if (health?.mode !== "hardware" || typeof health.controlDomainId !== "string") {
    throw new Error("目标不是正式硬件 EdgeCore，已拒绝启动真机代理");
  }
  return { controlDomainId: health.controlDomainId, version: health.version };
}
