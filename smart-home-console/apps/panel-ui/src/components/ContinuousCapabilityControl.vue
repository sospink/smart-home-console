<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Device, DeviceCapability } from "@smart-lab/contracts";
import { AlertTriangle, Check, Gauge, LoaderCircle, SlidersHorizontal, Volume2 } from "lucide-vue-next";
import { capabilityPresetLabels, capabilityPresetValues, capabilityProgress } from "../lib/continuous-capability";
import { useEdgeStore } from "../stores/edge";

const props = withDefaults(
  defineProps<{
    device: Device;
    capability: DeviceCapability;
    source: "primary" | "secondary";
    prominent?: boolean;
    embedded?: boolean;
  }>(),
  { prominent: false, embedded: false }
);
const emit = defineEmits<{ preview: [value: number]; committed: [value: number] }>();
const edge = useEdgeStore();
const authoritativeValue = computed(() => Number(props.device.state[props.capability.property] ?? props.capability.min ?? 0));
const draft = ref(authoritativeValue.value);
const dragging = ref(false);
const pending = computed(() => edge.isPropertyPending(props.device.id, props.capability.property));
const disabled = computed(() => !edge.connected || props.device.health === "offline" || pending.value);
const feedback = computed(() => edge.propertyFeedback(props.device.id, props.capability.property));
const controlState = computed(() => (pending.value ? "pending" : feedback.value?.status));
const progress = computed(() => capabilityProgress(draft.value, props.capability));
const presetValues = computed(() => capabilityPresetValues(props.capability));
const presetLabels = computed(() => capabilityPresetLabels(props.capability));
const minValue = computed(() => props.capability.min ?? 0);
const maxValue = computed(() => props.capability.max ?? 100);
const stepValue = computed(() => (props.capability.step && props.capability.step > 0 ? props.capability.step : 1));
const icon = computed(() =>
  props.capability.property === "volume" ? Volume2 : props.capability.property === "position" ? SlidersHorizontal : Gauge
);
const stateLabel = computed(() => {
  if (controlState.value === "pending") return "正在同步";
  if (controlState.value === "confirmed") return "已同步";
  if (controlState.value === "failed") return "设备未确认";
  if (controlState.value === "timeout") return "确认超时";
  return "";
});

watch(
  authoritativeValue,
  (value) => {
    if (!dragging.value) {
      draft.value = value;
      emit("preview", value);
    }
  },
  { immediate: true }
);
watch(pending, (value, previous) => {
  if (previous && !value && !dragging.value) {
    draft.value = authoritativeValue.value;
    emit("preview", authoritativeValue.value);
  }
});

function preview(event: Event) {
  dragging.value = true;
  draft.value = Number((event.target as HTMLInputElement).value);
  emit("preview", draft.value);
}

function commit() {
  dragging.value = false;
  if (!disabled.value && draft.value !== authoritativeValue.value) {
    emit("committed", draft.value);
    void edge.sendCommand(props.device.id, props.capability.property, draft.value, props.source);
  }
}

function cancelPreview() {
  if (!dragging.value) return;
  dragging.value = false;
  draft.value = authoritativeValue.value;
  emit("preview", authoritativeValue.value);
}

function adjustByKeyboard(event: KeyboardEvent) {
  if (disabled.value) return;
  let next: number | undefined;
  if (event.key === "ArrowRight" || event.key === "ArrowUp") next = authoritativeValue.value + stepValue.value;
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = authoritativeValue.value - stepValue.value;
  if (event.key === "Home") next = minValue.value;
  if (event.key === "End") next = maxValue.value;
  if (next == null) return;
  event.preventDefault();
  const value = Math.min(maxValue.value, Math.max(minValue.value, next));
  draft.value = value;
  emit("preview", value);
  if (value !== authoritativeValue.value) {
    emit("committed", value);
    void edge.sendCommand(props.device.id, props.capability.property, value, props.source);
  }
}

function choose(value: number) {
  if (disabled.value || value === authoritativeValue.value) return;
  draft.value = value;
  emit("preview", value);
  emit("committed", value);
  void edge.sendCommand(props.device.id, props.capability.property, value, props.source);
}
</script>

<template>
  <section
    class="continuous-control command-surface"
    :data-testid="`continuous-${device.id}-${capability.property}`"
    :class="[{ prominent, embedded, dragging, disabled }, controlState]"
    :style="{ '--value-progress': `${progress}%` }"
  >
    <header>
      <span><component :is="icon" :size="16" />{{ capability.label }}</span>
      <span v-if="stateLabel" class="control-state" :class="controlState" :title="stateLabel" role="status" :aria-label="stateLabel">
        <LoaderCircle v-if="controlState === 'pending'" :size="14" />
        <Check v-else-if="controlState === 'confirmed'" :size="14" />
        <AlertTriangle v-else :size="14" />
      </span>
      <strong
        >{{ draft }}<small>{{ capability.unit }}</small></strong
      >
    </header>
    <div class="magnetic-track">
      <input
        v-model.number="draft"
        type="range"
        :aria-label="`${device.name}${capability.label}`"
        :aria-valuetext="`${draft}${capability.unit ?? ''}`"
        :min="minValue"
        :max="maxValue"
        :step="stepValue"
        :disabled="disabled"
        @input="preview"
        @change="commit"
        @pointercancel="cancelPreview"
        @keydown="adjustByKeyboard"
      />
    </div>
    <div class="value-presets">
      <button
        v-for="(value, index) in presetValues"
        :key="value"
        :class="{ active: draft === value }"
        :disabled="disabled"
        @click="choose(value)"
      >
        <i />{{ presetLabels[index] }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.continuous-control {
  position: relative;
  display: grid;
  gap: 7px;
  padding: 8px 4px 2px;
  border-radius: 18px;
  background: transparent;
  overflow: hidden;
  transition:
    background 0.2s ease,
    opacity 0.2s ease;
}
.continuous-control.prominent {
  margin: 2px 14px 0;
  padding: 10px 2px 3px;
}
.continuous-control.embedded {
  height: 100%;
  min-height: 0;
  align-content: center;
  padding: 10px 14px 8px;
  background: var(--card-soft);
}
header {
  position: relative;
  display: flex;
  align-items: center;
}
header > span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 11px;
}
header strong {
  margin-left: auto;
  color: var(--text);
  font-size: 21px;
  font-weight: 620;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.03em;
}
.prominent header strong {
  font-size: 28px;
}
header small {
  margin-left: 2px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}
.control-state {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  margin-left: 7px;
  border-radius: 50%;
}
.control-state.pending {
  color: var(--cyan);
  background: var(--cyan-soft);
}
.control-state.pending :deep(svg) {
  animation: control-spin 0.85s linear infinite;
}
.control-state.confirmed {
  color: var(--green);
  background: var(--green-soft);
}
.control-state.failed,
.control-state.timeout {
  color: var(--danger);
  background: var(--danger-soft);
}
.magnetic-track {
  display: grid;
  align-items: center;
  min-height: 44px;
}
.magnetic-track input[type="range"] {
  width: 100%;
  height: 44px;
  margin: 0;
  appearance: none;
  background: transparent;
  touch-action: pan-y;
  cursor: ew-resize;
}
.magnetic-track input[type="range"]:focus-visible {
  outline: none;
}
.magnetic-track:has(input:focus-visible) {
  border-radius: 16px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--cyan) 70%, transparent);
}
.magnetic-track input[type="range"]::-webkit-slider-runnable-track {
  height: 16px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--cyan) 0 var(--value-progress), var(--control) var(--value-progress));
  box-shadow: none;
}
.magnetic-track input[type="range"]::-webkit-slider-thumb {
  width: 30px;
  height: 30px;
  margin-top: -7px;
  appearance: none;
  border: 6px solid var(--card);
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 5px 14px rgba(32, 66, 88, 0.22);
  transition: transform 0.16s ease;
}
.embedded .magnetic-track input[type="range"]::-webkit-slider-thumb {
  border-color: var(--card-soft);
}
.dragging .magnetic-track input[type="range"]::-webkit-slider-thumb {
  transform: scale(1.12);
}
.value-presets {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
}
.value-presets button {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 12px;
  background: transparent;
  color: var(--muted);
  font-size: 10px;
  transition:
    color 0.16s ease,
    background 0.16s ease,
    transform 0.16s ease;
}
.value-presets button i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--faint);
  transition: background 0.16s ease;
}
.value-presets button.active {
  background: var(--selected);
  color: var(--cyan);
  font-weight: 650;
}
.value-presets button.active i {
  background: var(--cyan);
}
.value-presets button:active {
  transform: scale(0.96);
}
.disabled:not(.pending) {
  opacity: 0.48;
}
button:disabled,
input:disabled {
  cursor: not-allowed;
}
@media (prefers-reduced-motion: reduce) {
  .continuous-control,
  .magnetic-track input[type="range"]::-webkit-slider-thumb,
  .value-presets button {
    transition: none;
  }
  .control-state.pending :deep(svg) {
    animation: none;
  }
}
@media (max-height: 360px) {
  .continuous-control.embedded {
    padding-block: 5px;
  }
  .embedded .value-presets {
    display: none;
  }
}
@keyframes control-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
