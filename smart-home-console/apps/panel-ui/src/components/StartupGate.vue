<script setup lang="ts">
import { computed, ref } from "vue";
import { AlertTriangle, KeyRound, LoaderCircle, RefreshCw, Router, ShieldCheck, WifiOff } from "lucide-vue-next";
import { resolveEdgeBase } from "../lib/api";
import { useEdgeStore } from "../stores/edge";

defineProps<{ surface: "primary" | "secondary" }>();
const edge = useEdgeStore();
const endpoint = computed(() => {
  const raw = resolveEdgeBase() || window.location.origin;
  try {
    const url = new URL(raw, window.location.origin);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "地址不可识别";
  }
});
const waiting = computed(() => edge.loading && !edge.connectionIssue);
const hardwareWebAuth = import.meta.env.DEV && import.meta.env.VITE_HARDWARE_WEB_AUTH === "1";
const needsHardwareAuth = computed(() => hardwareWebAuth && edge.connectionIssue?.title === "终端认证失效");
const pin = ref("");
const authBusy = ref(false);
const authError = ref("");
const actionText = computed(() => {
  if (!edge.networkOnline) return "等待网络恢复";
  if (edge.retryInSeconds) return `${edge.retryInSeconds} 秒后自动重试`;
  return edge.loading ? "正在连接" : "立即重试";
});

async function connectHardware() {
  if (authBusy.value || !/^\d{6,12}$/.test(pin.value)) return;
  authBusy.value = true;
  authError.value = "";
  try {
    const response = await fetch("/__smart_lab/hardware-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: pin.value })
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    pin.value = "";
    if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
    await edge.reconnectNow();
  } catch (error) {
    const code = error instanceof Error ? error.message : "HARDWARE_AUTH_FAILED";
    authError.value =
      code === "INVALID_ADMIN_PIN"
        ? "工程 PIN 不正确"
        : code === "TOO_MANY_AUTH_ATTEMPTS"
          ? "尝试次数过多，主屏已锁定 15 分钟，请停止重试"
          : "真机授权失败，请确认主屏在线后重试";
  } finally {
    authBusy.value = false;
  }
}
</script>

<template>
  <main class="startup-gate" role="status" aria-live="polite">
    <section class="startup-stage">
      <div class="startup-mark" :class="{ failed: !waiting }">
        <LoaderCircle v-if="waiting" :size="32" class="startup-spinner" />
        <WifiOff v-else-if="!edge.networkOnline" :size="30" />
        <AlertTriangle v-else :size="30" />
      </div>
      <span class="startup-eyebrow">{{ surface === "primary" ? "主屏本地中枢" : "副屏控制终端" }}</span>
      <h1>{{ waiting ? "正在建立控制域" : (edge.connectionIssue?.title ?? "控制系统启动未完成") }}</h1>
      <p>
        {{
          waiting
            ? "正在读取 EdgeCore 权威快照，完成前不会显示或开放任何设备控制。"
            : (edge.connectionIssue?.detail ?? "尚未取得本次启动的权威状态，工作台保持锁定。")
        }}
      </p>

      <div class="startup-facts">
        <span
          ><Router :size="17" /><small>当前 EdgeCore</small><strong>{{ endpoint }}</strong></span
        >
        <span><ShieldCheck :size="17" /><small>控制状态</small><strong>未解锁</strong></span>
      </div>

      <form v-if="needsHardwareAuth" class="hardware-auth" @submit.prevent="connectHardware">
        <label for="hardware-pin"><KeyRound :size="16" />工程管理 PIN</label>
        <div>
          <input
            id="hardware-pin"
            v-model="pin"
            type="password"
            inputmode="numeric"
            autocomplete="current-password"
            maxlength="12"
            placeholder="输入主屏首次设置的 6–12 位 PIN"
            autofocus
          />
          <button type="submit" :disabled="authBusy || !/^\d{6,12}$/.test(pin)">
            <LoaderCircle v-if="authBusy" :size="17" class="spinning" />
            <ShieldCheck v-else :size="17" />{{ authBusy ? "正在授权" : "连接真实设备" }}
          </button>
        </div>
        <small v-if="authError" class="auth-error">{{ authError }}</small>
        <small v-else>PIN 仅用于本机本次认证，不会写入浏览器或项目文件。</small>
      </form>
      <button v-else :disabled="edge.loading || !edge.networkOnline" @click="edge.reconnectNow">
        <RefreshCw :size="17" :class="{ spinning: waiting }" />{{ actionText }}
      </button>
      <small class="startup-help">
        {{
          surface === "primary"
            ? "若长时间无法启动，请检查本机 EdgeCore 服务与 8787 端口。"
            : "若地址错误，请在终端工程设置中重新发现主屏或输入主屏 IP。"
        }}
      </small>
    </section>
  </main>
</template>

<style scoped>
.startup-gate {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 32px;
  color: var(--text);
  background: radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--cyan-soft) 42%, transparent), transparent 34%), var(--canvas);
}
.startup-stage {
  display: flex;
  width: min(560px, 100%);
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.startup-mark {
  display: grid;
  width: 68px;
  height: 68px;
  margin-bottom: 22px;
  place-items: center;
  color: var(--cyan);
  background: var(--cyan-soft);
  border-radius: 22px;
}
.startup-mark.failed {
  color: var(--warning-text);
  background: var(--warning-card);
}
.startup-eyebrow {
  color: var(--cyan);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
}
h1 {
  margin: 10px 0 10px;
  font-size: clamp(25px, 3vw, 34px);
  letter-spacing: -0.03em;
}
p {
  max-width: 520px;
  margin: 0;
  color: var(--text-soft);
  font-size: 14px;
  line-height: 1.75;
}
.startup-facts {
  display: flex;
  width: 100%;
  margin: 30px 0 24px;
  padding: 18px 0;
  background: var(--surface-soft);
  border-radius: 18px;
}
.startup-facts span {
  display: grid;
  min-width: 0;
  flex: 1;
  grid-template-columns: auto 1fr;
  gap: 2px 9px;
  align-items: center;
  padding: 0 22px;
  text-align: left;
}
.startup-facts span + span {
  border-left: 1px solid var(--line-strong);
}
.startup-facts :deep(svg) {
  grid-row: 1 / 3;
  color: var(--muted);
}
.startup-facts small {
  color: var(--muted);
  font-size: 10px;
}
.startup-facts strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button {
  display: inline-flex;
  min-width: 160px;
  min-height: 46px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 22px;
  color: white;
  background: var(--cyan);
  border-radius: 14px;
  font-size: 13px;
  font-weight: 700;
}
button:disabled {
  color: var(--muted);
  background: var(--control);
  cursor: default;
}
.startup-help {
  margin-top: 16px;
  color: var(--muted);
  font-size: 11px;
}
.hardware-auth {
  width: min(470px, 100%);
}
.hardware-auth > label {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 9px;
  color: var(--text-soft);
  font-size: 12px;
  font-weight: 700;
  text-align: left;
}
.hardware-auth > div {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 9px;
}
.hardware-auth input {
  min-width: 0;
  min-height: 46px;
  padding: 0 15px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  outline: none;
}
.hardware-auth input:focus {
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px var(--cyan-soft);
}
.hardware-auth button {
  min-width: 146px;
}
.hardware-auth > small {
  display: block;
  margin-top: 9px;
  color: var(--muted);
  font-size: 11px;
  text-align: left;
}
.hardware-auth > small.auth-error {
  color: var(--danger);
}
.startup-spinner,
.spinning {
  animation: startup-spin 900ms linear infinite;
}
@keyframes startup-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-height: 420px) {
  .startup-gate {
    padding: 14px 28px;
  }
  .startup-mark {
    width: 50px;
    height: 50px;
    margin-bottom: 10px;
    border-radius: 16px;
  }
  h1 {
    margin: 6px 0;
    font-size: 22px;
  }
  p {
    font-size: 12px;
  }
  .startup-facts {
    margin: 15px 0 12px;
    padding: 10px 0;
  }
  button {
    min-height: 38px;
  }
  .startup-help {
    margin-top: 8px;
  }
}
@media (max-height: 320px) and (min-width: 900px) {
  .startup-gate {
    padding: 18px 54px;
  }
  .startup-stage {
    display: grid;
    width: min(1180px, 100%);
    grid-template-columns: 64px minmax(330px, 1fr) minmax(430px, 0.9fr);
    grid-template-rows: auto auto auto;
    column-gap: 24px;
    text-align: left;
  }
  .startup-mark {
    grid-column: 1;
    grid-row: 1 / 4;
    width: 58px;
    height: 58px;
    margin: 0;
    align-self: center;
  }
  .startup-eyebrow {
    grid-column: 2;
    grid-row: 1;
  }
  h1 {
    grid-column: 2;
    grid-row: 2;
    margin: 4px 0;
    font-size: 25px;
  }
  p {
    grid-column: 2;
    grid-row: 3;
    font-size: 12px;
    line-height: 1.5;
  }
  .startup-facts {
    grid-column: 3;
    grid-row: 1 / 3;
    margin: 0;
    padding: 12px 0;
  }
  button {
    grid-column: 3;
    grid-row: 3;
    min-height: 38px;
    margin-top: 9px;
    justify-self: start;
  }
  .startup-help {
    position: absolute;
    right: 54px;
    bottom: 10px;
    margin: 0;
    font-size: 9px;
  }
}
</style>
