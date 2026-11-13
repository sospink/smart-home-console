<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { BellRing, Check, ChevronRight, CircleAlert, Clock3, History, LoaderCircle, X, XCircle } from "lucide-vue-next";
import { useEdgeStore } from "../stores/edge";

type ReceiptKind = "command" | "scene" | "alert";
type ReceiptState = "pending" | "success" | "warning" | "failed";
interface Receipt {
  id: string;
  kind: ReceiptKind;
  state: ReceiptState;
  title: string;
  detail: string;
  source: string;
  at: string;
}

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
const edge = useEdgeStore();
const open = ref(false);
const root = ref<HTMLElement>();

const sourceLabel: Record<string, string> = {
  primary: "主屏",
  secondary: "副屏",
  admin: "管理端",
  automation: "自动联动"
};

const receipts = computed<Receipt[]>(() => {
  const commands = (edge.snapshot?.commands ?? []).map((command) => {
    const device = edge.devices.find((item) => item.id === command.deviceId);
    const capability = device?.capabilities.find((item) => item.property === command.property);
    const state: ReceiptState = command.status === "confirmed" ? "success" : command.status === "pending" ? "pending" : "failed";
    return {
      id: `command-${command.id}`,
      kind: "command" as const,
      state,
      title: device?.name ?? command.deviceId,
      detail:
        command.status === "confirmed"
          ? `${capability?.label ?? command.property}已由设备确认`
          : command.status === "pending"
            ? `${capability?.label ?? command.property}等待设备确认`
            : command.error || `${capability?.label ?? command.property}控制未完成`,
      source: sourceLabel[command.source] ?? command.source,
      at: command.confirmedAt ?? command.createdAt
    };
  });

  const executions = (edge.snapshot?.executions ?? []).map((execution) => {
    const scene = edge.scenes.find((item) => item.id === execution.sceneId);
    const state: ReceiptState =
      execution.status === "completed"
        ? "success"
        : execution.status === "running"
          ? "pending"
          : execution.status === "partial"
            ? "warning"
            : "failed";
    return {
      id: `scene-${execution.id}`,
      kind: "scene" as const,
      state,
      title: `${scene?.name ?? execution.sceneId}场景`,
      detail:
        execution.status === "running"
          ? `正在执行 ${execution.completedActions}/${execution.totalActions}`
          : execution.status === "completed"
            ? `${execution.totalActions} 项动作已完成`
            : execution.status === "partial"
              ? `${execution.completedActions}/${execution.totalActions} 项完成，请检查失败动作`
              : "场景执行失败，请检查设备链路",
      source: sourceLabel[execution.source] ?? execution.source,
      at: execution.finishedAt ?? execution.startedAt
    };
  });

  const alerts = edge.alerts.map((alert) => ({
    id: `alert-${alert.id}`,
    kind: "alert" as const,
    state: (alert.recoveredAt ? "success" : alert.acknowledgedAt ? "warning" : "failed") as ReceiptState,
    title: alert.title,
    detail: alert.recoveredAt ? "告警已恢复" : alert.acknowledgedAt ? "告警已确认，等待设备恢复" : alert.message,
    source: alert.level === "warning" ? "运维事件" : alert.level === "critical" ? "安防事件" : "状态事件",
    at: alert.recoveredAt ?? alert.acknowledgedAt ?? alert.occurredAt
  }));

  return [...commands, ...executions, ...alerts].sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 16);
});

const attentionCount = computed(
  () =>
    (edge.snapshot?.commands ?? []).filter((item) => item.status === "pending").length +
    (edge.snapshot?.executions ?? []).filter((item) => item.status === "running").length +
    edge.activeAlerts.length
);

function kindText(kind: ReceiptKind) {
  return kind === "command" ? "设备" : kind === "scene" ? "场景" : "告警";
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--:--"
    : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function onDocumentPointer(event: PointerEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}

function onDocumentKey(event: KeyboardEvent) {
  if (event.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointer);
  document.addEventListener("keydown", onDocumentKey);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocumentPointer);
  document.removeEventListener("keydown", onDocumentKey);
});
</script>

<template>
  <div ref="root" class="receipt-center" :class="{ compact }">
    <button
      type="button"
      class="receipt-trigger header-tool-button"
      aria-label="查看操作回执"
      :aria-expanded="open"
      aria-controls="operation-receipt-panel"
      @click="open = !open"
    >
      <History :size="17" />
      <i v-if="attentionCount">{{ Math.min(attentionCount, 9) }}{{ attentionCount > 9 ? "+" : "" }}</i>
    </button>

    <Transition name="receipt-pop">
      <section v-if="open" id="operation-receipt-panel" class="receipt-panel" aria-label="最近操作回执">
        <header>
          <div>
            <span class="eyebrow">操作回执</span>
            <strong>最近状态</strong>
            <small>来自 EdgeCore 权威记录</small>
          </div>
          <button type="button" aria-label="关闭操作回执" @click="open = false"><X :size="17" /></button>
        </header>

        <div v-if="receipts.length" class="receipt-list" aria-live="polite">
          <article v-for="receipt in receipts" :key="receipt.id" :class="receipt.state">
            <span class="receipt-icon">
              <LoaderCircle v-if="receipt.state === 'pending'" class="spin" :size="16" />
              <Check v-else-if="receipt.state === 'success'" :size="16" />
              <CircleAlert v-else-if="receipt.state === 'warning'" :size="16" />
              <XCircle v-else :size="16" />
            </span>
            <div class="receipt-copy">
              <span
                ><b>{{ kindText(receipt.kind) }}</b
                ><em>{{ receipt.source }}</em
                ><time>{{ formatTime(receipt.at) }}</time></span
              >
              <strong>{{ receipt.title }}</strong>
              <small>{{ receipt.detail }}</small>
            </div>
            <ChevronRight :size="14" />
          </article>
        </div>
        <div v-else class="receipt-empty">
          <Clock3 :size="24" /><strong>暂无操作记录</strong><small>执行设备控制或场景后将在这里显示</small>
        </div>

        <footer v-if="edge.activeAlerts.length">
          <BellRing :size="14" />
          <template v-if="edge.unacknowledgedAlerts.length">{{ edge.unacknowledgedAlerts.length }} 条告警仍待确认</template>
          <template v-else>{{ edge.activeAlerts.length }} 条告警已确认，仍待设备恢复</template>
        </footer>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.receipt-center {
  position: relative;
}
.header-tool-button {
  position: relative;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--control);
  border-radius: 50%;
}
.receipt-trigger i {
  position: absolute;
  right: -2px;
  top: -2px;
  min-width: 17px;
  height: 17px;
  display: grid;
  place-items: center;
  padding: 0 4px;
  color: #fff;
  background: var(--danger);
  border: 2px solid var(--header-surface);
  border-radius: 10px;
  font:
    700 8px/1 system-ui,
    sans-serif;
  font-style: normal;
}
.receipt-panel {
  position: absolute;
  z-index: 120;
  top: calc(100% + 10px);
  right: -50px;
  width: min(420px, calc(100vw - 24px));
  max-height: calc(100vh - 92px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  color: var(--text);
  background: color-mix(in srgb, var(--card) 98%, transparent);
  border: 1px solid var(--line);
  border-radius: 22px;
  box-shadow: var(--shadow-float);
  backdrop-filter: blur(18px) saturate(1.15);
  overflow: hidden;
}
.receipt-panel > header {
  min-height: 82px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
}
.receipt-panel > header > div {
  display: grid;
  grid-template-columns: auto auto;
  align-items: baseline;
  gap: 3px 9px;
}
.receipt-panel > header strong {
  font-size: 16px;
}
.receipt-panel > header small {
  grid-column: 1 / -1;
  color: var(--muted);
  font-size: 9px;
}
.receipt-panel > header button {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--control);
  border-radius: 50%;
}
.receipt-list {
  min-height: 0;
  overflow: auto;
  padding: 7px 10px 10px;
}
.receipt-list article {
  min-height: 70px;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 14px;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
}
.receipt-list article:last-child {
  border-bottom: 0;
}
.receipt-list article.pending {
  color: var(--gold);
}
.receipt-list article.success {
  color: var(--green);
}
.receipt-list article.warning {
  color: var(--gold);
}
.receipt-list article.failed {
  color: var(--danger);
}
.receipt-icon {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, currentColor 11%, transparent);
  border-radius: 50%;
}
.receipt-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.receipt-copy > span {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 8px;
}
.receipt-copy b {
  color: currentColor;
  font-weight: 650;
}
.receipt-copy em {
  font-style: normal;
}
.receipt-copy time {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.receipt-copy strong {
  overflow: hidden;
  color: var(--text);
  font-size: 11px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.receipt-copy small {
  overflow: hidden;
  color: var(--muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.receipt-empty {
  min-height: 190px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 7px;
  color: var(--faint);
}
.receipt-empty strong {
  color: var(--text);
  font-size: 12px;
}
.receipt-empty small {
  color: var(--muted);
  font-size: 9px;
}
.receipt-panel > footer {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 18px;
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 9px;
}
.receipt-pop-enter-active,
.receipt-pop-leave-active {
  transition:
    opacity 180ms ease,
    transform 240ms var(--ease-out);
  transform-origin: top right;
}
.receipt-pop-enter-from,
.receipt-pop-leave-to {
  opacity: 0;
  transform: translateY(-7px) scale(0.97);
}
.spin {
  animation: spin 850ms linear infinite;
}
.compact .receipt-panel {
  max-height: calc(100vh - 72px);
}
@media (max-height: 360px) {
  .receipt-panel,
  .compact .receipt-panel {
    top: calc(100% + 4px);
    max-height: calc(100vh - 50px);
    border-radius: 16px;
  }
  .receipt-panel > header {
    min-height: 58px;
    padding-block: 8px;
  }
  .receipt-list article {
    min-height: 58px;
    padding-block: 7px;
  }
}
</style>
