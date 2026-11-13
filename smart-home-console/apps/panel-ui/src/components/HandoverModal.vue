<script setup lang="ts">
import type { HandoverChecklist, HandoverCompletion } from "@smart-lab/contracts";
import { nextTick, onMounted, ref } from "vue";

defineProps<{
  busy: boolean;
  error: string;
  checklist?: HandoverChecklist;
  completion?: HandoverCompletion;
  acknowledgements: Record<string, boolean>;
  completedBy: string;
  note: string;
}>();
const emit = defineEmits<{
  close: [];
  complete: [];
  "update:completed-by": [value: string];
  "update:note": [value: string];
  acknowledge: [warning: string, checked: boolean];
}>();
const dialog = ref<HTMLDialogElement>();

function label(code: string) {
  return (
    {
      ACTIVE_CRITICAL_ALERT: "有严重告警未恢复",
      ACTIVE_OPERATION: "有操作执行中",
      OFFLINE_GATEWAY: "网关离线",
      BENCH_NOT_RESET: "设备未回到基线",
      ACTIVE_NONCRITICAL_ALERTS: "有一般告警未恢复",
      OFFLINE_DEVICES: "有设备离线，值可能已过期",
      MANUAL_BASELINE_CHECK: "有设备需现场核对",
      PAIRED_TERMINALS_OFFLINE: "主副屏未全部在线"
    }[code] ?? code
  );
}

function localTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { hour12: false });
}

onMounted(async () => {
  dialog.value?.showModal();
  await nextTick();
  dialog.value?.querySelector<HTMLElement>("input, button")?.focus();
});
</script>

<template>
  <dialog ref="dialog" class="handover-modal" aria-label="运行交接检查" @cancel.prevent="emit('close')">
    <header><h2>运行交接检查</h2></header>
    <div class="content">
      <p v-if="error" class="alert error">{{ error }}</p>
      <template v-if="completion">
        <p class="alert success">交接已留档</p>
        <section class="last-completion">
          <strong>{{ completion.completedBy }} · {{ localTime(completion.completedAt) }}</strong>
          <span>确认风险：{{ completion.acknowledgedWarnings.length ? completion.acknowledgedWarnings.map(label).join("、") : "无" }}</span>
          <span v-if="completion.note">备注：{{ completion.note }}</span>
        </section>
      </template>
      <template v-else-if="checklist">
        <section v-if="checklist.lastCompletion" class="last-completion" aria-label="最近一次交接">
          <small>最近一次交接</small>
          <strong>{{ checklist.lastCompletion.completedBy }} · {{ localTime(checklist.lastCompletion.completedAt) }}</strong>
          <span v-if="checklist.lastCompletion.acknowledgedWarnings.length">
            已确认：{{ checklist.lastCompletion.acknowledgedWarnings.map(label).join("、") }}
          </span>
          <span v-if="checklist.lastCompletion.note">备注：{{ checklist.lastCompletion.note }}</span>
        </section>
        <p v-else class="alert info">本实训台暂无历史交接记录</p>
        <p class="summary-line">
          基线 {{ checklist.summary.baselineReady }} · 待复位 {{ checklist.summary.baselineNotReady }} · 人工核对
          {{ checklist.summary.baselineManualCheck }} · 屏在线 {{ checklist.summary.onlineTerminals }}/{{
            checklist.summary.pairedTerminals
          }}
        </p>
        <section v-if="checklist.blockers.length" class="alert error">
          <strong>必须先处理</strong>
          <div v-for="blocker in checklist.blockers" :key="blocker">{{ label(blocker) }}</div>
        </section>
        <section v-if="checklist.warnings.length" class="warning-list">
          <strong>可交接风险（逐项确认）</strong>
          <label v-for="warning in checklist.warnings" :key="warning">
            <input
              :checked="acknowledgements[warning]"
              type="checkbox"
              @change="emit('acknowledge', warning, ($event.target as HTMLInputElement).checked)"
            /><span>{{ label(warning) }}</span>
          </label>
        </section>
        <label class="note"
          >检查人 / 值班人<input
            :value="completedBy"
            maxlength="40"
            placeholder="2–40 字，如：设备管理员"
            @input="emit('update:completed-by', ($event.target as HTMLInputElement).value)"
        /></label>
        <label class="note"
          >交接备注<textarea
            :value="note"
            maxlength="200"
            placeholder="如：卧室灯已现场断电，等待设备维修"
            @input="emit('update:note', ($event.target as HTMLTextAreaElement).value)"
          />
        </label>
      </template>
    </div>
    <footer class="actions">
      <button :disabled="busy" @click="emit('close')">{{ completion ? "完成" : "取消" }}</button>
      <button
        v-if="!completion"
        class="primary"
        :disabled="
          busy ||
          !checklist?.canComplete ||
          completedBy.trim().length < 2 ||
          checklist.warnings.some((warning) => !acknowledgements[warning])
        "
        @click="emit('complete')"
      >
        {{ busy ? "正在留档…" : "确认风险并留档" }}
      </button>
    </footer>
  </dialog>
</template>

<style scoped>
.handover-modal {
  width: min(760px, calc(100vw - 40px));
  max-height: calc(100vh - 24px);
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--card);
  color: var(--text);
  box-shadow: var(--shadow-float);
}
.handover-modal::backdrop {
  background: rgba(15, 23, 42, 0.48);
}
.handover-modal header,
.handover-modal footer,
.content {
  padding: 18px 22px;
}
.handover-modal header {
  border-bottom: 1px solid var(--line);
}
.handover-modal h2 {
  margin: 0;
  font-size: 19px;
}
.content {
  max-height: calc(100vh - 170px);
  overflow-y: auto;
  color: var(--text-soft);
  line-height: 1.7;
}
.alert {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: 12px;
}
.alert.info {
  background: color-mix(in srgb, var(--cyan) 10%, var(--card));
}
.alert.success {
  background: color-mix(in srgb, var(--green) 12%, var(--card));
}
.alert.error {
  background: color-mix(in srgb, var(--danger) 12%, var(--card));
}
.summary-line,
.note,
.warning-list {
  color: var(--muted);
}
.last-completion {
  display: grid;
  gap: 4px;
  margin-bottom: 16px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--card-soft);
  color: var(--muted);
}
.last-completion strong {
  color: var(--text);
}
.warning-list,
.note {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}
.warning-list label {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 44px;
  padding: 11px 12px;
  border-radius: 12px;
  background: var(--card-soft);
  color: var(--text);
}
.warning-list input {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
}
.note input,
.note textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card-soft);
  color: var(--text);
  font: inherit;
}
.note textarea {
  min-height: 76px;
  resize: vertical;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid var(--line);
}
.actions button {
  min-height: 44px;
  padding: 0 18px;
  border: 0;
  border-radius: 12px;
  background: var(--card-soft);
  color: var(--text);
  font: inherit;
}
.actions .primary {
  background: var(--accent);
  color: white;
}
.actions button:disabled {
  opacity: 0.45;
}
.actions button:focus-visible,
.note :is(input, textarea):focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: 2px;
}
</style>
