<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{ value: number | string; unit?: string }>();
const previous = ref(props.value);
const direction = ref<"up" | "down">("up");
const revision = ref(0);

watch(
  () => props.value,
  (next, old) => {
    previous.value = old;
    direction.value = Number(next) >= Number(old) ? "up" : "down";
    revision.value += 1;
  }
);
</script>

<template>
  <span class="rolling-number" :class="direction">
    <Transition :name="`roll-${direction}`">
      <span :key="revision" class="rolling-value">{{ value }}</span>
    </Transition>
    <small v-if="unit">{{ unit }}</small>
  </span>
</template>

<style scoped>
.rolling-number {
  position: relative;
  display: inline-grid;
  grid-template-columns: auto auto;
  align-items: baseline;
  justify-content: center;
  min-width: 1.4em;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
}
.rolling-value {
  grid-area: 1 / 1;
}
.rolling-number small {
  grid-column: 2;
  margin-left: 0.2em;
}
.roll-up-enter-active,
.roll-up-leave-active,
.roll-down-enter-active,
.roll-down-leave-active {
  transition:
    transform 260ms var(--ease-out),
    opacity 220ms ease;
}
.roll-up-enter-from {
  transform: translateY(72%);
  opacity: 0;
}
.roll-up-leave-to {
  transform: translateY(-72%);
  opacity: 0;
}
.roll-down-enter-from {
  transform: translateY(-72%);
  opacity: 0;
}
.roll-down-leave-to {
  transform: translateY(72%);
  opacity: 0;
}
</style>
