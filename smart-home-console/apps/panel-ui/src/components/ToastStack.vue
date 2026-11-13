<script setup lang="ts">
import { computed } from "vue";
import { Check, LoaderCircle, TriangleAlert } from "lucide-vue-next";
import { useEdgeStore } from "../stores/edge";

const edge = useEdgeStore();
const latest = computed(() =>
  Object.values(edge.feedbackByProperty)
    .sort((a, b) => b.changedAt - a.changedAt)
    .slice(0, 3)
    .flatMap((feedback) => edge.snapshot?.commands.find((command) => command.id === feedback.id) ?? [])
);
</script>

<template>
  <TransitionGroup name="toast" tag="div" class="toast-stack">
    <div v-if="edge.operationNotice" :key="edge.operationNotice.id" class="toast failed operation-notice" role="alert">
      <TriangleAlert :size="16" />
      <span
        ><strong>{{ edge.operationNotice.title }}</strong
        >{{ edge.operationNotice.detail }}</span
      >
    </div>
    <div v-for="command in latest" :key="command.id" class="toast" :class="command.status">
      <LoaderCircle v-if="command.status === 'pending'" class="spin" :size="16" />
      <Check v-else-if="command.status === 'confirmed'" :size="16" />
      <TriangleAlert v-else :size="16" />
      <span
        ><strong>{{ edge.devices.find((item) => item.id === command.deviceId)?.name }}</strong
        >{{ command.status === "pending" ? "等待设备确认" : command.status === "confirmed" ? "状态已确认" : command.error }}</span
      >
    </div>
  </TransitionGroup>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  z-index: 50;
  right: 24px;
  bottom: 22px;
  display: grid;
  gap: 8px;
  pointer-events: none;
}
.toast {
  min-width: 238px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  color: var(--muted);
  background: color-mix(in srgb, var(--card) 97%, transparent);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow-float);
  font-size: 10px;
}
.toast strong {
  display: block;
  color: var(--text);
  font-size: 11px;
  margin-bottom: 2px;
}
.toast.pending {
  color: var(--gold);
}
.toast.confirmed {
  color: var(--green);
}
.toast.failed {
  color: var(--danger);
}
.operation-notice {
  max-width: 320px;
}
.spin {
  animation: spin 850ms linear infinite;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 260ms var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(24px);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1180px) {
  .toast-stack {
    right: 12px;
    bottom: 12px;
  }
  .toast {
    min-width: 210px;
    padding: 9px 12px;
  }
}
</style>
