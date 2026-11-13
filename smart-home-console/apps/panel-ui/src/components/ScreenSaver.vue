<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { House, Wifi } from "lucide-vue-next";

const idle = ref(false);
const now = ref(new Date());
let idleTimer: number | undefined;
let clockTimer: number | undefined;

function arm() {
  idle.value = false;
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(
    () => {
      idle.value = true;
    },
    3 * 60 * 1000
  );
}

function dismiss() {
  arm();
  requestAnimationFrame(() => document.querySelector<HTMLElement>("button, [role='button'], input")?.focus());
}

function tick() {
  now.value = new Date();
}

function handleProximity(event: Event) {
  const near = (event as CustomEvent<{ near?: boolean }>).detail?.near;
  if (near) arm();
}

function handleScreenSaver(event: Event) {
  idle.value = (event as CustomEvent<{ active?: boolean }>).detail?.active ?? true;
}

onMounted(() => {
  for (const event of ["pointerdown", "pointermove", "keydown"] as const) window.addEventListener(event, arm, { passive: true });
  document.addEventListener("visibilitychange", arm);
  window.addEventListener("smart-lab:proximity", handleProximity);
  window.addEventListener("smart-lab:screen-saver", handleScreenSaver);
  tick();
  clockTimer = window.setInterval(tick, 30_000);
  arm();
});
onUnmounted(() => {
  for (const event of ["pointerdown", "pointermove", "keydown"] as const) window.removeEventListener(event, arm);
  document.removeEventListener("visibilitychange", arm);
  window.removeEventListener("smart-lab:proximity", handleProximity);
  window.removeEventListener("smart-lab:screen-saver", handleScreenSaver);
  window.clearTimeout(idleTimer);
  window.clearInterval(clockTimer);
});
</script>

<template>
  <Transition name="saver">
    <section v-if="idle" class="screen-saver" tabindex="0" @pointerdown="dismiss" @keydown.enter="dismiss" @keydown.space.prevent="dismiss">
      <div class="saver-mark"><House :size="46" /></div>
      <time>{{ now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</time>
      <p>{{ now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }) }}</p>
      <span><Wifi :size="14" /> 轻触唤醒控制台</span>
    </section>
  </Transition>
</template>

<style scoped>
.screen-saver {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  color: #f4f8fb;
  background:
    linear-gradient(90deg, rgba(5, 13, 24, 0.98), rgba(5, 13, 24, 0.54) 52%, rgba(5, 13, 24, 0.2)),
    url("../assets/scenes/night.svg") center / cover no-repeat,
    #07111f;
  cursor: pointer;
}
.screen-saver::before {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 50% 48%, rgba(78, 183, 255, 0.08), transparent 30%);
}
.saver-mark {
  width: 90px;
  height: 90px;
  display: grid;
  place-items: center;
  margin-bottom: 24px;
  color: var(--cyan);
  background: rgba(53, 211, 255, 0.06);
  border-radius: 50%;
  box-shadow:
    inset 0 0 35px rgba(53, 211, 255, 0.08),
    0 0 50px rgba(53, 211, 255, 0.06);
}
time {
  font-size: 70px;
  font-weight: 300;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
}
.screen-saver p {
  margin: 8px 0 30px;
  color: #91a2b1;
}
.screen-saver span {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #718393;
  font-size: 11px;
}
.saver-enter-active,
.saver-leave-active {
  transition: opacity 0.5s ease;
}
.saver-enter-from,
.saver-leave-to {
  opacity: 0;
}
</style>
