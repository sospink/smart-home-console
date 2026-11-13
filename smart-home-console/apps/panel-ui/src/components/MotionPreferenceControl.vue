<script setup lang="ts">
import { motionModeLabels, type MotionMode } from "../lib/motion";
import { useMotionPreference } from "../composables/motion";

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
const { motionMode, setMotionMode } = useMotionPreference();
const options: Array<{ value: MotionMode; detail: string }> = [
  { value: "full", detail: "完整状态轨迹" },
  { value: "reduced", detail: "减少循环效果" },
  { value: "off", detail: "保留静态反馈" }
];
</script>

<template>
  <div class="motion-preference" :class="{ compact }">
    <div v-if="!compact" class="preference-copy">
      <strong>界面动效</strong>
      <small>只改变视觉表现，不改变命令确认和设备状态</small>
    </div>
    <div class="motion-options" aria-label="界面动效偏好">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        :class="{ active: motionMode === option.value }"
        :aria-pressed="motionMode === option.value"
        :aria-label="`动效${motionModeLabels[option.value]}`"
        @click="setMotionMode(option.value)"
      >
        <strong>{{ motionModeLabels[option.value] }}</strong>
        <small v-if="!compact">{{ option.detail }}</small>
      </button>
    </div>
  </div>
</template>

<style scoped>
.motion-preference {
  display: grid;
  grid-template-columns: minmax(210px, 1fr) minmax(360px, 1.4fr);
  align-items: center;
  gap: 18px;
}
.preference-copy {
  display: grid;
  gap: 5px;
}
.preference-copy strong {
  color: var(--text);
  font-size: 13px;
}
.preference-copy small {
  color: var(--muted);
  font-size: 9px;
}
.motion-options {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
  padding: 4px;
  background: var(--control);
  border-radius: 16px;
}
.motion-options button {
  min-height: 52px;
  display: grid;
  place-content: center;
  gap: 3px;
  color: var(--muted);
  background: transparent;
  border-radius: 12px;
  transition:
    color 160ms ease,
    background-color 160ms ease,
    box-shadow 180ms ease,
    transform 160ms var(--ease-out);
}
.motion-options button:active {
  transform: scale(0.97);
}
.motion-options button.active {
  color: var(--cyan);
  background: var(--card);
  box-shadow: var(--shadow-control);
}
.motion-options strong {
  color: inherit;
  font-size: 11px;
  font-weight: 650;
}
.motion-options small {
  color: var(--muted);
  font-size: 8px;
}
.motion-preference.compact {
  display: block;
}
.compact .motion-options button {
  min-height: 44px;
}
@media (max-width: 900px) {
  .motion-preference:not(.compact) {
    grid-template-columns: 1fr;
  }
}
</style>
