<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from "vue";
import { CloudSun, Moon, Sun, Waves, Wifi, X } from "lucide-vue-next";
import { useEdgeStore } from "../stores/edge";
import { useTheme } from "../composables/theme";
import { useMotionPreference } from "../composables/motion";
import { motionModeLabels } from "../lib/motion";
import { authoritativeNow, serverClockOffset } from "../lib/clock";
import { cachedSnapshotAgeLabel } from "../lib/snapshot-cache";
import OperationReceiptCenter from "./OperationReceiptCenter.vue";
import { nativeBridge } from "../lib/terminal-runtime";

const MotionPreferenceControl = defineAsyncComponent(() => import("./MotionPreferenceControl.vue"));
const TerminalSurfaceMenu = defineAsyncComponent(() => import("./TerminalSurfaceMenu.vue"));

defineProps<{ compact?: boolean; title?: string }>();
const edge = useEdgeStore();
const { isDark, toggleTheme } = useTheme();
const { motionMode } = useMotionPreference();
const motionOpen = ref(false);
const motionRoot = ref<HTMLElement>();
const nativeRuntimeAvailable = Boolean(nativeBridge());
const now = ref(new Date());
const serverOffsetMs = ref(0);
let timer: number | undefined;

const authoritativeTime = computed(() => authoritativeNow(now.value.getTime(), serverOffsetMs.value));
const deploymentIdentity = computed(() => edge.health?.gateways[0]?.name ?? "本地实训台");
const connectionText = computed(() => {
  if (edge.connected) return "已连接";
  if (edge.cachedSnapshotAt) return `离线缓存 · ${cachedSnapshotAgeLabel(edge.cachedSnapshotAt, now.value.getTime())}`;
  if (edge.retryInSeconds) return `${edge.retryInSeconds}秒后重试`;
  return "正在连接";
});

watch(
  () => edge.health?.serverTime,
  (serverTime) => {
    if (!serverTime) return;
    serverOffsetMs.value = serverClockOffset(serverTime);
  },
  { immediate: true }
);

onMounted(() => {
  timer = window.setInterval(() => {
    now.value = new Date();
  }, 1000);
  document.addEventListener("pointerdown", closeMotionOutside);
  document.addEventListener("keydown", closeMotionOnEscape);
});
onUnmounted(() => {
  window.clearInterval(timer);
  document.removeEventListener("pointerdown", closeMotionOutside);
  document.removeEventListener("keydown", closeMotionOnEscape);
});

function closeMotionOutside(event: PointerEvent) {
  if (motionOpen.value && motionRoot.value && !motionRoot.value.contains(event.target as Node)) motionOpen.value = false;
}

function closeMotionOnEscape(event: KeyboardEvent) {
  if (event.key === "Escape") motionOpen.value = false;
}

const pad = (value: number) => String(value).padStart(2, "0");
</script>

<template>
  <header class="system-header" :class="{ compact }">
    <div class="header-identity">
      <div class="header-signal"><span /><span /><span /></div>
      <span class="system-index" :title="`当前控制域：${deploymentIdentity}`">{{ deploymentIdentity }}</span>
    </div>
    <div class="brand">
      <strong :class="{ 'long-title': title }">{{ title ?? "知境" }}</strong>
      <i />
      <span>{{ compact ? "副屏控制台" : "空间智控中心" }}</span>
    </div>
    <div class="system-meta">
      <span class="date"
        >{{ authoritativeTime.getFullYear() }}-{{ pad(authoritativeTime.getMonth() + 1) }}-{{ pad(authoritativeTime.getDate()) }}</span
      >
      <time :title="edge.health?.serverTime ? '时间基准：主屏 EdgeCore' : '时间基准：本机'"
        >{{ pad(authoritativeTime.getHours()) }}:{{ pad(authoritativeTime.getMinutes()) }}:{{ pad(authoritativeTime.getSeconds()) }}</time
      >
      <span class="weather" title="采购清单未提供温度传感器，禁止显示伪造读数"><CloudSun :size="15" /> --°C</span>
      <span class="divider" />
      <button
        :class="['connection', edge.connected ? 'online' : 'offline']"
        role="status"
        :disabled="edge.connected || !edge.networkOnline"
        :aria-label="edge.connected ? 'EdgeCore 已连接' : `EdgeCore 连接中断，${connectionText}，当前仅可查看，点击立即重连`"
        :title="
          edge.connected
            ? 'EdgeCore 已连接'
            : `${edge.connectionIssue?.title ?? '连接中断'} · ${edge.cachedSnapshotAt ? `显示${cachedSnapshotAgeLabel(edge.cachedSnapshotAt, now.getTime())}的只读缓存` : (edge.connectionIssue?.detail ?? '当前显示最后已知状态')} · 已重试 ${edge.reconnectAttempt} 次 · 点击立即重连`
        "
        @click="edge.reconnectNow"
      >
        <Wifi :size="17" /><b>{{ connectionText }}</b>
      </button>
      <span class="runtime-state" title="正式设备控制链路">正式运行</span>
      <OperationReceiptCenter :compact="compact" />
      <TerminalSurfaceMenu v-if="nativeRuntimeAvailable" />
      <div ref="motionRoot" class="motion-menu">
        <button
          class="header-button"
          :aria-label="`动效设置（${motionModeLabels[motionMode]}）`"
          :aria-expanded="motionOpen"
          aria-controls="motion-preference-popover"
          @click="motionOpen = !motionOpen"
        >
          <Waves :size="17" />
        </button>
        <Transition name="tool-pop">
          <section v-if="motionOpen" id="motion-preference-popover" class="motion-popover">
            <header>
              <div>
                <strong>界面动效</strong><small>当前：{{ motionModeLabels[motionMode] }}</small>
              </div>
              <button aria-label="关闭动效设置" @click="motionOpen = false"><X :size="16" /></button>
            </header>
            <MotionPreferenceControl compact />
          </section>
        </Transition>
      </div>
      <button
        class="header-button"
        :aria-label="isDark ? '切换至浅色主题' : '切换至深色主题'"
        :title="isDark ? '切换至浅色主题' : '切换至深色主题'"
        :aria-pressed="isDark"
        @click="toggleTheme"
      >
        <Sun v-if="isDark" :size="17" />
        <Moon v-else :size="17" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.system-header {
  position: relative;
  z-index: 10;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 30px;
  background: var(--header-surface);
  border-bottom: 0;
  box-shadow: 0 8px 30px rgba(40, 47, 58, 0.035);
  backdrop-filter: blur(24px) saturate(1.3);
}
.system-header.compact {
  height: 60px;
}
.header-identity {
  position: absolute;
  left: 30px;
  display: flex;
  align-items: center;
  gap: 14px;
}
.header-signal {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 17px;
  opacity: 0.8;
}
.header-signal span {
  width: 3px;
  background: var(--cyan);
  border-radius: 3px;
  box-shadow: none;
}
.system-index {
  max-width: 180px;
  overflow: hidden;
  padding: 7px 10px;
  color: var(--text);
  background: var(--selected);
  border-radius: 999px;
  text-overflow: ellipsis;
  white-space: nowrap;
  font:
    600 11px/1 ui-monospace,
    SFMono-Regular,
    monospace;
  letter-spacing: 0.06em;
}
.header-signal span:nth-child(1) {
  height: 7px;
}
.header-signal span:nth-child(2) {
  height: 12px;
}
.header-signal span:nth-child(3) {
  height: 17px;
}
.brand {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 14px;
  white-space: nowrap;
}
.brand strong {
  font-size: 23px;
  font-weight: 650;
  letter-spacing: 0.14em;
  color: var(--text);
}
.compact .brand strong {
  font-size: 20px;
}
.brand strong.long-title {
  font-size: 20px;
  letter-spacing: 0.08em;
}
.brand i {
  width: 4px;
  height: 4px;
  background: var(--faint);
  border-radius: 50%;
}
.brand span {
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.16em;
}
.system-meta {
  display: flex;
  align-items: center;
  gap: 13px;
  color: var(--muted);
  font-size: 11px;
}
.system-meta time {
  color: var(--text);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.weather,
.connection,
.runtime-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.connection.online {
  color: var(--cyan);
}
.connection.offline {
  color: var(--danger);
  cursor: pointer;
}
.connection {
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  padding: 0 8px;
  background: transparent;
  border: 0;
  font: inherit;
}
.connection:disabled {
  opacity: 1;
  cursor: default;
}
.connection.offline:hover,
.connection.offline:focus-visible {
  color: var(--warning-text);
}
.connection b {
  font-size: 11px;
  font-weight: 550;
  white-space: nowrap;
}
.runtime-state {
  color: var(--green);
  font:
    11px/1 ui-monospace,
    SFMono-Regular,
    monospace;
  letter-spacing: 0.12em;
}
.divider {
  display: none;
}
.header-button {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--control);
  border: 0;
  border-radius: 50%;
  transition:
    color 160ms ease,
    background-color 160ms ease,
    transform 220ms var(--ease-out);
}
.motion-menu {
  position: relative;
}
.motion-popover {
  position: absolute;
  z-index: 120;
  top: calc(100% + 10px);
  right: -50px;
  width: 310px;
  padding: 12px;
  color: var(--text);
  background: color-mix(in srgb, var(--card) 98%, transparent);
  border: 0;
  border-radius: 18px;
  box-shadow: var(--shadow-float);
  backdrop-filter: blur(18px) saturate(1.15);
}
.motion-popover > header {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 3px 8px 7px;
}
.motion-popover > header div {
  display: grid;
  gap: 2px;
}
.motion-popover > header strong {
  font-size: 12px;
}
.motion-popover > header small {
  color: var(--muted);
  font-size: 11px;
}
.motion-popover > header button {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: transparent;
  border-radius: 50%;
}
.tool-pop-enter-active,
.tool-pop-leave-active {
  transition:
    opacity 180ms ease,
    transform 240ms var(--ease-out);
  transform-origin: top right;
}
.tool-pop-enter-from,
.tool-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}
.header-button:hover {
  color: var(--cyan);
  background: var(--selected);
}
.header-button:active {
  transform: rotate(18deg) scale(0.94);
}
@media (max-width: 1180px) {
  .date,
  .weather,
  .runtime-state {
    display: none;
  }
  .brand {
    left: 42%;
  }
  .connection b {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
}
@media (max-width: 900px) {
  .system-header {
    height: 64px;
    padding: 0 14px;
  }
  .system-header.compact {
    height: 60px;
  }
  .header-identity,
  .system-meta > time {
    display: none;
  }
  .brand {
    left: 18px;
    transform: translateY(-50%);
  }
  .brand i,
  .brand span {
    display: none;
  }
  .brand strong,
  .compact .brand strong,
  .brand strong.long-title {
    font-size: 18px;
    letter-spacing: 0.08em;
  }
  .system-meta {
    gap: 7px;
  }
}
@media (max-height: 360px) {
  .system-header.compact {
    height: 44px;
  }
  .compact .brand strong {
    font-size: 17px;
  }
  .compact .brand span {
    font-size: 11px;
  }
  .compact .system-meta {
    gap: 9px;
  }
  .motion-popover {
    top: calc(100% + 4px);
  }
}
</style>
