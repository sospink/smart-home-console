import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { edgeTarget, hardwareIdentity, keychainService } from "./hardware-web-runtime.mjs";

/* global AbortSignal, fetch */

async function pairingCode() {
  const supplied = process.env.SMART_LAB_PAIRING_CODE?.trim() || process.argv[2]?.trim();
  if (supplied) return supplied;
  if (!stdin.isTTY) throw new Error("缺少一次性 6 位配对码");
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (await prompt.question("输入主屏“终端管理”显示的一次性 6 位配对码：")).trim();
  } finally {
    prompt.close();
  }
}

const target = edgeTarget();
const code = await pairingCode();
if (!/^\d{6}$/.test(code)) throw new Error("配对码必须为 6 位数字");
const identity = await hardwareIdentity(target);
const deviceId = `browser-dev-${createHash("sha256").update(hostname()).digest("hex").slice(0, 16)}`;
const response = await fetch(`${target}/api/v1/terminals/pair`, {
  method: "POST",
  signal: AbortSignal.timeout(8_000),
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    pairingCode: code,
    deviceId,
    name: "本地浏览器调试终端",
    role: "secondary",
    version: "web-dev"
  })
});
const envelope = await response.json().catch(() => ({}));
if (!response.ok) {
  const message = envelope?.error === "INVALID_PAIRING_CODE" ? "配对码错误或已经使用" : envelope?.error || `HTTP ${response.status}`;
  throw new Error(`本地浏览器配对失败：${message}`);
}
if (envelope?.data?.controlDomainId !== identity.controlDomainId || typeof envelope?.data?.token !== "string") {
  throw new Error("配对响应的控制域身份不一致，已拒绝保存令牌");
}
execFileSync(
  "/usr/bin/security",
  ["add-generic-password", "-U", "-a", identity.controlDomainId, "-s", keychainService(target), "-w", envelope.data.token],
  { stdio: "ignore" }
);
stdout.write(`本地浏览器已配对到 ${target}（${identity.version}），令牌仅保存在 macOS 钥匙串。\n`);
