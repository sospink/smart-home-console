<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Device } from "@smart-lab/contracts";
import { Lightbulb, Power, Sparkles } from "lucide-vue-next";
import {
  kelvinColor,
  lightColorTemperaturePresets,
  lightEffectLabel,
  rangeProgress,
  valueFromVerticalPointer,
  writableCapability
} from "../lib/light-capabilities";
import { useEdgeStore } from "../stores/edge";

const props = withDefaults(defineProps<{ device: Device; source: "primary" | "secondary"; compact?: boolean }>(), { compact: false });
const edge = useEdgeStore();
const brightness = computed(() => writableCapability(props.device, "brightness"));
const colorTemperature = computed(() => writableCapability(props.device, "colorTemperature"));
const effect = computed(() => writableCapability(props.device, "effect"));
const power = computed(() => writableCapability(props.device, "power"));
const brightnessDraft = ref(0);
const temperatureDraft = ref(0);
const brightnessDragging = ref(false);
const brightnessTrack = ref<HTMLElement>();
const brightnessPending = computed(() => pending("brightness"));

watch(
  () => Number(props.device.state.brightness ?? brightness.value?.min ?? 0),
  (value) => {
    if (!brightnessDragging.value) brightnessDraft.value = value;
  },
  { immediate: true }
);
watch(brightnessPending, (value, previous) => {
  if (previous && !value && !brightnessDragging.value) {
    brightnessDraft.value = Number(props.device.state.brightness ?? brightness.value?.min ?? 0);
  }
});
watch(
  () => Number(props.device.state.colorTemperature ?? colorTemperature.value?.min ?? 0),
  (value) => (temperatureDraft.value = value),
  { immediate: true }
);

const presets = computed(() => lightColorTemperaturePresets(colorTemperature.value));
const temperatureTabIndex = computed(() => {
  if (!presets.value.length) return 0;
  return presets.value.reduce(
    (nearest, preset, index) =>
      Math.abs(preset.value - temperatureDraft.value) < Math.abs(presets.value[nearest].value - temperatureDraft.value) ? index : nearest,
    0
  );
});
const disabled = computed(() => !edge.connected || props.device.health === "offline");
const lightStyle = computed(() => {
  const brightnessLevel = Math.max(0, Math.min(100, brightnessDraft.value));
  const temperature = colorTemperature.value ? kelvinColor(temperatureDraft.value, colorTemperature.value) : "hsl(44 92% 76%)";
  return {
    "--light-level": `${props.device.state.power || brightnessDragging.value ? Math.max(4, brightnessLevel) : 0}%`,
    "--light-color": temperature,
    "--temperature-progress": `${colorTemperature.value ? rangeProgress(temperatureDraft.value, colorTemperature.value) : 0}%`,
    "--temperature-tab-index": temperatureTabIndex.value,
    "--brightness-progress": `${brightnessLevel}%`
  };
});

function pending(property: string) {
  return edge.isPropertyPending(props.device.id, property);
}

function send(property: string, value: string | number | boolean) {
  if (!disabled.value && !pending(property)) edge.sendCommand(props.device.id, property, value, props.source);
}

function canAdjustBrightness() {
  return Boolean(brightness.value) && !disabled.value && !pending("brightness");
}

function previewBrightness(clientY: number) {
  if (!brightness.value || !brightnessTrack.value) return;
  const rect = brightnessTrack.value.getBoundingClientRect();
  brightnessDraft.value = valueFromVerticalPointer(clientY, rect.top, rect.height, brightness.value);
}

function beginBrightnessDrag(event: PointerEvent) {
  if (!canAdjustBrightness()) return;
  brightnessDragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  previewBrightness(event.clientY);
}

function moveBrightnessDrag(event: PointerEvent) {
  if (brightnessDragging.value) previewBrightness(event.clientY);
}

function finishBrightnessDrag(event: PointerEvent) {
  if (!brightnessDragging.value) return;
  previewBrightness(event.clientY);
  brightnessDragging.value = false;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  if (brightnessDraft.value !== Number(props.device.state.brightness)) send("brightness", brightnessDraft.value);
}

function cancelBrightnessDrag(event: PointerEvent) {
  if (!brightnessDragging.value) return;
  brightnessDragging.value = false;
  brightnessDraft.value = Number(props.device.state.brightness ?? brightness.value?.min ?? 0);
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
}

function adjustBrightnessByKeyboard(event: KeyboardEvent) {
  if (!brightness.value || !canAdjustBrightness()) return;
  const min = brightness.value.min ?? 0;
  const max = brightness.value.max ?? 100;
  const step = brightness.value.step && brightness.value.step > 0 ? brightness.value.step : 1;
  let next: number | undefined;
  const authoritative = Number(props.device.state.brightness ?? min);
  if (event.key === "ArrowUp" || event.key === "ArrowRight") next = authoritative + step;
  if (event.key === "ArrowDown" || event.key === "ArrowLeft") next = authoritative - step;
  if (event.key === "Home") next = min;
  if (event.key === "End") next = max;
  if (next == null) return;
  event.preventDefault();
  brightnessDraft.value = Math.min(max, Math.max(min, next));
  send("brightness", brightnessDraft.value);
}
</script>

<template>
  <section class="light-capability-panel" :class="{ compact, offline: device.health === 'offline' }" :style="lightStyle">
    <div
      v-if="brightness"
      class="light-stage brightness-slider"
      :class="{ dragging: brightnessDragging, pending: pending('brightness'), disabled }"
      role="slider"
      tabindex="0"
      :aria-label="`${device.name}亮度，上下滑动调节`"
      aria-orientation="vertical"
      :aria-valuemin="brightness.min"
      :aria-valuemax="brightness.max"
      :aria-valuenow="brightnessDraft"
      :aria-valuetext="`${brightnessDraft}%`"
      :aria-disabled="disabled || pending('brightness')"
      @pointerdown="beginBrightnessDrag"
      @pointermove="moveBrightnessDrag"
      @pointerup="finishBrightnessDrag"
      @pointercancel="cancelBrightnessDrag"
      @keydown="adjustBrightnessByKeyboard"
    >
      <div ref="brightnessTrack" class="light-column"><span /></div>
      <div class="light-reading">
        <strong>{{ brightnessDragging || device.state.power ? brightnessDraft : 0 }}%</strong>
        <small v-if="pending('brightness')" class="inline-sync" role="status"><i />正在同步</small>
        <small v-else-if="brightnessDragging">松手应用</small>
      </div>
    </div>

    <div class="light-controls">
      <header>
        <div>
          <span>{{ device.room }} · 智能灯光</span>
          <h2>{{ device.name }}</h2>
        </div>
        <span class="capability-count">{{ device.capabilities.filter((item) => item.writable).length }} 项能力</span>
      </header>

      <p v-if="device.health === 'offline'" class="light-offline-note">设备离线，以下为最后已知状态</p>

      <div v-if="colorTemperature" class="control-block temperature-control" :class="{ pending: pending('colorTemperature') }">
        <div class="control-label">
          <span><Lightbulb :size="17" />色温</span><strong>{{ temperatureDraft }}K</strong>
        </div>
        <div class="temperature-tabs" role="tablist" aria-label="色温选择">
          <i class="temperature-tab-indicator" aria-hidden="true" />
          <button
            v-for="(preset, index) in presets"
            :key="preset.value"
            role="tab"
            :aria-selected="temperatureTabIndex === index"
            :class="{ active: temperatureTabIndex === index }"
            :disabled="disabled || pending('colorTemperature')"
            @click="send('colorTemperature', preset.value)"
          >
            <span />{{ preset.label }}
          </button>
        </div>
      </div>

      <div v-if="effect?.options?.length" class="control-block effect-control" :class="{ pending: pending('effect') }">
        <div class="control-label">
          <span><Sparkles :size="17" />{{ effect.label }}</span>
        </div>
        <div class="effect-options">
          <button
            v-for="option in effect.options"
            :key="String(option.value)"
            :class="{ active: device.state.effect === option.value }"
            :disabled="disabled || pending('effect')"
            @click="send('effect', option.value)"
          >
            {{ lightEffectLabel(option.label, option.value) }}
          </button>
        </div>
      </div>

      <footer>
        <button
          v-if="power"
          class="light-power"
          :class="{ on: device.state.power, pending: pending('power') }"
          :disabled="disabled || pending('power')"
          :aria-label="`${device.name}${device.state.power ? '关闭' : '开启'}`"
          @click="send('power', !device.state.power)"
        >
          <Power :size="20" />{{ device.state.power ? "关闭" : "开启" }}
        </button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.light-capability-panel {
  display: grid;
  grid-template-columns: minmax(180px, 0.78fr) minmax(300px, 1.22fr);
  gap: 24px;
  min-height: 420px;
  color: var(--text);
  container-type: inline-size;
}
.light-stage {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 390px;
  border-radius: 28px;
  background: color-mix(in srgb, var(--light-stage-base) var(--light-stage-base-weight), var(--light-color) var(--light-stage-tint-weight));
  box-shadow: var(--light-stage-shadow);
  overflow: hidden;
}
.brightness-slider {
  touch-action: none;
  user-select: none;
  cursor: ns-resize;
  outline: none;
}
.brightness-slider:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cyan) 62%, transparent);
}
.brightness-slider.pending {
  cursor: progress;
  opacity: 0.68;
}
.brightness-slider.disabled {
  cursor: not-allowed;
  opacity: 0.54;
}
.light-stage::after {
  content: "";
  position: absolute;
  inset: 24% 10% -32%;
  background: radial-gradient(ellipse, var(--light-color), transparent 68%);
  opacity: calc(var(--light-level, 0%) / 150%);
  filter: blur(24px);
  transition: opacity 0.3s ease;
}
:global(:root[data-theme="dark"] .light-stage::after) {
  inset: 28% 12% -34%;
  opacity: calc(var(--light-level, 0%) / 210%);
  filter: blur(30px);
}
.light-column {
  position: relative;
  z-index: 1;
  width: 108px;
  height: 270px;
  border-radius: 52px 52px 46px 46px;
  background: color-mix(
    in srgb,
    var(--light-column-base) var(--light-column-base-weight),
    var(--light-color) var(--light-column-tint-weight)
  );
  box-shadow: var(--light-column-shadow);
  overflow: hidden;
  transition: transform 0.18s ease;
}
.brightness-slider.dragging .light-column {
  transform: scale(1.025);
}
.light-column span {
  position: absolute;
  inset: auto 0 0;
  height: var(--light-level);
  background: linear-gradient(to bottom, color-mix(in srgb, var(--light-color) 72%, white), var(--light-color));
  box-shadow: 0 -12px 36px var(--light-color);
  transition:
    height 0.25s ease,
    background 0.25s ease;
}
.light-reading {
  position: absolute;
  z-index: 2;
  top: 22px;
  left: 24px;
  display: flex;
  flex-direction: column;
}
.light-reading strong {
  font-size: 30px;
  font-weight: 500;
  letter-spacing: -0.04em;
}
.light-reading small {
  color: var(--muted);
}
.light-reading .inline-sync {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.inline-sync i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cyan) 14%, transparent);
  animation: sync-pulse 0.9s ease-in-out infinite;
}
.light-controls {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 5px 0;
}
.light-controls > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.light-offline-note {
  margin: -4px 0 0;
  padding: 9px 12px;
  color: var(--warning-text);
  background: var(--warning-card);
  border-radius: 13px;
  font-size: 11px;
}
.light-controls header span {
  font-size: 12px;
  color: var(--muted);
}
.light-controls h2 {
  margin: 5px 0 0;
  font-size: 25px;
  font-weight: 620;
}
.capability-count {
  padding: 7px 10px;
  border-radius: 999px;
  background: var(--card-soft);
}
.control-block {
  display: grid;
  gap: 10px;
  transition: opacity 0.2s ease;
}
.control-block.pending {
  opacity: 0.62;
}
.control-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.control-label span {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-soft);
}
.control-label strong {
  font-size: 14px;
}
.control-label small {
  font-size: 11px;
  color: var(--muted);
}
.temperature-tabs {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  min-height: 52px;
  padding: 4px;
  border-radius: 17px;
  background: var(--temperature-tabs);
  box-shadow: var(--temperature-track-shadow);
  overflow: hidden;
}
.temperature-tab-indicator {
  position: absolute;
  z-index: 0;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc((100% - 8px) / 3);
  border-radius: 13px;
  background: var(--temperature-tab-indicator);
  box-shadow: var(--temperature-tab-shadow);
  transform: translateX(calc(var(--temperature-tab-index) * 100%));
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.temperature-tabs button {
  position: relative;
  z-index: 1;
  min-height: 44px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: var(--temperature-tab-text);
  font: inherit;
  font-size: 13px;
  font-weight: 560;
  cursor: pointer;
  transition:
    color 0.18s ease,
    transform 0.18s ease;
}
.temperature-tabs button span {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 7px;
  border-radius: 50%;
  vertical-align: 1px;
}
.temperature-tabs button:nth-of-type(1) span {
  background: #ff983f;
}
.temperature-tabs button:nth-of-type(2) span {
  background: #e9c986;
}
.temperature-tabs button:nth-of-type(3) span {
  background: #9bcce2;
}
.temperature-tabs button.active {
  color: var(--temperature-tab-active-text);
  font-weight: 680;
}
:global(:root[data-theme="dark"] .temperature-tabs button.active) {
  text-shadow: 0 1px 5px rgba(0, 0, 0, 0.18);
}
.temperature-tabs button:active {
  transform: scale(0.96);
}
.effect-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}
.effect-options button {
  min-height: 48px;
  padding: 0 14px;
  border: 0;
  border-radius: 14px;
  background: var(--light-effect-background);
  color: var(--light-effect-text);
  font: inherit;
  font-size: 13px;
  font-weight: 560;
  cursor: pointer;
  box-shadow: var(--light-effect-shadow);
  transition:
    transform 0.16s ease,
    background 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}
.effect-options button.active {
  background: var(--cyan);
  color: white;
  box-shadow:
    0 6px 16px color-mix(in srgb, var(--cyan) 28%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.26);
}
:global(:root[data-theme="dark"] .effect-options button.active) {
  box-shadow:
    0 7px 18px color-mix(in srgb, var(--cyan) 22%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.22);
}
:global(:root[data-theme="dark"] .light-power:not(.on)) {
  background: var(--light-effect-background);
  box-shadow: var(--light-effect-shadow);
}
.effect-options button:not(.active):active {
  transform: scale(0.96);
  background: var(--control-hover);
}
button:disabled,
input:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}
.light-controls footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin-top: auto;
  padding-top: 4px;
  color: var(--muted);
  font-size: 11px;
}
.light-power {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 104px;
  min-height: 48px;
  justify-content: center;
  border: 0;
  border-radius: 16px;
  background: var(--control);
  color: var(--text);
  font: inherit;
  font-weight: 600;
}
.light-power.on {
  background: var(--cyan);
  color: #fff;
  box-shadow: 0 6px 16px color-mix(in srgb, var(--cyan) 24%, transparent);
}
.light-power.pending {
  animation: command-pulse 1.1s ease-in-out infinite;
}
@keyframes command-pulse {
  50% {
    opacity: 0.58;
  }
}
@keyframes sync-pulse {
  50% {
    opacity: 0.38;
    transform: scale(0.78);
  }
}
.compact {
  min-height: 0;
  grid-template-columns: 1fr;
  gap: 12px;
  padding: 0 14px 16px;
  overflow: auto;
}
.compact .light-stage {
  min-height: 185px;
  border-radius: 22px;
}
.compact .light-column {
  width: 70px;
  height: 142px;
}
.compact .light-reading {
  top: 16px;
  left: 16px;
}
.compact .light-reading strong {
  font-size: 24px;
}
.compact .light-controls {
  gap: 14px;
  padding: 0;
}
.compact .light-controls > header {
  display: none;
}
.compact .effect-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.compact .effect-options button {
  width: 100%;
  min-width: 0;
  justify-content: center;
  padding-inline: 8px;
}
@container (max-width:650px) {
  .light-capability-panel {
    grid-template-columns: 1fr;
  }
  .light-stage {
    min-height: 220px;
  }
  .light-column {
    width: 82px;
    height: 170px;
  }
  .light-reading strong {
    font-size: 24px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .light-column,
  .light-column span {
    transition: none;
  }
  .light-power.pending {
    animation: none;
  }
  .inline-sync i {
    animation: none;
  }
}
</style>
