<script setup lang="ts">
import { computed } from "vue";
import { RefreshCw, XCircle } from "lucide-vue-next";
import { useEdgeStore } from "../stores/edge";

const edge = useEdgeStore();
const signal = computed(() => edge.syncPulse);
const device = computed(() => edge.devices.find((item) => item.id === signal.value?.deviceId));
const sourceText = computed(() =>
  signal.value?.source === "primary"
    ? "主屏"
    : signal.value?.source === "secondary"
      ? "副屏"
      : signal.value?.source === "admin"
        ? "管理端"
        : "自动联动"
);
</script>

<template>
  <Transition name="sync-pop">
    <div v-if="signal" class="sync-pulse" :class="signal.status">
      <span class="sync-orbit"><RefreshCw v-if="signal.status === 'confirmed'" :size="16" /><XCircle v-else :size="16" /></span>
      <span
        ><strong>{{ sourceText }}同步</strong
        ><small>{{ device?.name ?? signal.deviceId }} · {{ signal.status === "confirmed" ? "状态已确认" : "控制失败" }}</small></span
      >
    </div>
  </Transition>
</template>

<style scoped>
.sync-pulse {
  position: fixed;
  z-index: 70;
  right: 24px;
  top: 78px;
  min-width: 210px;
  display: grid;
  grid-template-columns: 38px 1fr;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  color: var(--green);
  background: color-mix(in srgb, var(--card) 96%, transparent);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow:
    var(--shadow-float),
    0 0 28px color-mix(in srgb, var(--green) 9%, transparent);
  backdrop-filter: blur(10px);
  pointer-events: none;
}
.sync-pulse.failed,
.sync-pulse.timeout {
  color: var(--danger);
}
.sync-orbit {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, currentColor 13%, transparent);
  box-shadow: 0 0 18px color-mix(in srgb, currentColor 22%, transparent);
}
.sync-orbit :deep(svg) {
  animation: sync-turn 650ms var(--ease-out);
}
.sync-pulse > span:last-child {
  display: grid;
  gap: 3px;
}
.sync-pulse strong {
  color: var(--text);
  font-size: 11px;
}
.sync-pulse small {
  color: var(--muted);
  font-size: 8px;
}
.sync-pop-enter-active,
.sync-pop-leave-active {
  transition:
    transform 320ms var(--ease-out),
    opacity 260ms ease;
}
.sync-pop-enter-from,
.sync-pop-leave-to {
  transform: translateX(24px) scale(0.94);
  opacity: 0;
}
@keyframes sync-turn {
  from {
    transform: rotate(-140deg) scale(0.7);
  }
  to {
    transform: rotate(0) scale(1);
  }
}
</style>
