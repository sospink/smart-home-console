<script setup lang="ts">
import { computed } from "vue";
import type { Device } from "@smart-lab/contracts";

const props = defineProps<{ device: Device; compact?: boolean }>();

const variant = computed(() => {
  const id = props.device.id;
  const icon = props.device.display?.icon;
  if (icon === "ceiling") return "ceiling-round";
  if (id.startsWith("downlight")) return "downlight";
  if (id === "ambient-strip") return "strip";
  if (id === "bedroom-light") return "ceiling-square";
  if (id === "living-main-light") return "ceiling-round";
  if (id === "curtain-c3") return "curtain";
  if (id === "motion-sensor") return "motion";
  if (id.startsWith("door-sensor")) return "contact";
  if (id.startsWith("water-sensor")) return "water";
  if (id === "smart-lock") return "lock";
  if (id === "music-r11") return "music";
  if (id.includes("panel") || id === "voice-mini") return "panel";
  if (id.startsWith("switch-pro")) return "switch";
  if (props.device.kind === "light") return "ceiling-round";
  if (props.device.kind === "cover") return "curtain";
  if (props.device.kind === "media") return "music";
  if (props.device.kind === "sensor") return "motion";
  if (props.device.kind === "lock") return "lock";
  if (props.device.kind === "panel") return "panel";
  if (props.device.kind === "switch") return "switch";
  return "panel";
});

const visualStyle = computed(() => ({
  "--level": `${Math.max(0, Math.min(100, Number(props.device.state.brightness ?? (props.device.state.power ? 100 : 0))))}%`,
  "--curtain-gap": `${Math.max(0, Math.min(20, Number(props.device.state.position ?? 0) * 0.2))}px`
}));
</script>

<template>
  <div class="device-visual" :class="[variant, { compact, powered: device.state.power === true }]" :style="visualStyle" aria-hidden="true">
    <template v-if="variant === 'ceiling-round' || variant === 'downlight'">
      <span class="disc outer"><i /></span>
    </template>
    <template v-else-if="variant === 'ceiling-square'">
      <span class="square-shell"><i /></span>
    </template>
    <template v-else-if="variant === 'strip'">
      <span class="strip-body"><i /><i /><i /><i /></span>
    </template>
    <template v-else-if="variant === 'switch'">
      <span class="switch-shell"><i v-for="n in Number(device.state.channels ?? 1)" :key="n" /></span>
    </template>
    <template v-else-if="variant === 'curtain'">
      <span class="rail"><i /><i /></span><span class="curtain-cloth left" /><span class="curtain-cloth right" />
    </template>
    <template v-else-if="variant === 'motion'">
      <span class="sensor-pod"><i /></span><span class="sensor-base" />
    </template>
    <template v-else-if="variant === 'contact'">
      <span class="contact-main"><i /></span><span class="contact-side" />
    </template>
    <template v-else-if="variant === 'water'">
      <span class="water-puck"><i>≈</i></span>
    </template>
    <template v-else-if="variant === 'lock'">
      <span class="lock-body"><i class="camera" /><i class="handle" /><i class="keypad" /></span>
    </template>
    <template v-else-if="variant === 'music'">
      <span class="music-screen"
        ><i class="album" /><i class="wave"><b v-for="n in 5" :key="n" /></i
      ></span>
    </template>
    <template v-else-if="variant === 'panel'">
      <span class="panel-screen"><i class="panel-time">10:30</i><i class="panel-grid" /></span>
    </template>
  </div>
</template>

<style scoped>
.device-visual {
  --device-glow: rgba(21, 171, 255, 0.34);
  position: relative;
  width: 96px;
  height: 72px;
  display: grid;
  place-items: center;
  perspective: 320px;
  filter: drop-shadow(0 12px 14px rgba(0, 4, 14, 0.34));
}
.device-visual.compact {
  width: 58px;
  height: 48px;
  transform: scale(0.82);
  transform-origin: center;
}
.device-visual::after {
  content: "";
  position: absolute;
  left: 18%;
  right: 18%;
  bottom: 4px;
  height: 8px;
  background: radial-gradient(ellipse, rgba(1, 5, 13, 0.72), transparent 70%);
  filter: blur(3px);
}
.disc {
  position: relative;
  z-index: 1;
  width: 72px;
  height: 24px;
  display: grid;
  place-items: center;
  background: linear-gradient(180deg, #fcffff 0 34%, #c6d1da 54%, #748493 100%);
  border: 1px solid rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  box-shadow:
    inset 0 -5px 10px rgba(34, 57, 75, 0.26),
    0 0 0 3px rgba(111, 190, 236, 0.08),
    0 7px 16px rgba(0, 5, 18, 0.45);
  transform: rotateX(57deg);
}
.disc i {
  width: 48px;
  height: 13px;
  border-radius: 50%;
  background: radial-gradient(circle, #fff9d8, #ffe777 46%, #c7a331 68%, #576474 72%);
  box-shadow: 0 0 calc(5px + var(--level) * 0.16) rgba(255, 220, 91, 0.78);
  opacity: 0.24;
  transition:
    opacity 360ms ease,
    filter 360ms ease,
    box-shadow 360ms ease;
}
.powered .disc i {
  opacity: calc(0.45 + var(--level) * 0.0055);
  filter: brightness(calc(0.8 + var(--level) * 0.006));
}
.downlight .disc {
  width: 58px;
  height: 27px;
  background: linear-gradient(180deg, #ffffff, #b9c5d0 62%, #65717d);
}
.downlight .disc i {
  width: 32px;
  height: 14px;
}
.square-shell {
  position: relative;
  z-index: 1;
  width: 62px;
  height: 49px;
  padding: 5px;
  background: linear-gradient(145deg, #fff, #cbd5df);
  border-radius: 8px;
  box-shadow:
    inset -5px -6px 10px rgba(64, 81, 95, 0.18),
    0 7px 13px rgba(0, 4, 14, 0.4);
  transform: rotateX(15deg) rotateY(-8deg);
}
.square-shell i {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 6px;
  background: radial-gradient(circle, #fffdf0, #f7e9a6 70%, #b5bdc7);
  box-shadow: 0 0 calc(5px + var(--level) * 0.14) rgba(255, 226, 107, 0.52);
  opacity: 0.28;
  transition:
    opacity 360ms ease,
    box-shadow 360ms ease;
}
.powered .square-shell i {
  opacity: calc(0.45 + var(--level) * 0.0055);
}
.strip-body {
  z-index: 1;
  width: 74px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 4px 8px;
  background: linear-gradient(180deg, #ecd294, #8f6324);
  border: 2px solid #ead59d;
  border-radius: 3px;
  box-shadow: 0 0 14px rgba(255, 184, 61, 0.35);
  transform: rotateX(18deg);
}
.strip-body i {
  width: 8px;
  height: 6px;
  background: #fff1a8;
  box-shadow: 0 0 7px #ffcc4b;
  border-radius: 1px;
}
.switch-shell {
  z-index: 1;
  width: 62px;
  height: 64px;
  display: flex;
  gap: 2px;
  padding: 7px;
  background: linear-gradient(145deg, #fff, #b8c3ce);
  border-radius: 8px;
  box-shadow:
    inset -5px -7px 10px rgba(63, 76, 88, 0.2),
    0 9px 17px rgba(0, 4, 14, 0.42);
  transform: rotateY(-7deg);
}
.switch-shell i {
  flex: 1;
  border: 1px solid rgba(100, 117, 134, 0.22);
  border-radius: 3px;
  background: linear-gradient(160deg, #f9fbfd, #d4dbe2);
  box-shadow: inset 1px 1px rgba(255, 255, 255, 0.9);
}
.rail {
  position: absolute;
  z-index: 2;
  top: 8px;
  width: 84px;
  height: 7px;
  background: linear-gradient(#e9f0f4, #788796);
  border-radius: 4px;
  box-shadow: 0 4px 7px rgba(0, 2, 8, 0.5);
}
.rail i {
  position: absolute;
  top: 5px;
  width: 5px;
  height: 8px;
  background: #97a7b7;
}
.rail i:first-child {
  left: 24px;
}
.rail i:last-child {
  right: 24px;
}
.curtain-cloth {
  position: absolute;
  z-index: 1;
  top: 15px;
  bottom: 8px;
  width: 36px;
  background: repeating-linear-gradient(90deg, #f2f7fb 0 5px, #b8c8d6 6px 9px);
  box-shadow: inset 0 -9px 12px rgba(47, 69, 88, 0.25);
  transition:
    transform 520ms var(--ease-out),
    left 520ms var(--ease-out),
    right 520ms var(--ease-out);
}
.curtain-cloth.left {
  left: calc(7px - var(--curtain-gap));
  transform: scaleX(calc(1 - var(--curtain-gap) / 52px));
  transform-origin: left;
  border-radius: 3px 0 4px 4px;
}
.curtain-cloth.right {
  right: calc(7px - var(--curtain-gap));
  transform: scaleX(calc(1 - var(--curtain-gap) / 52px));
  transform-origin: right;
  border-radius: 0 3px 4px 4px;
}
.sensor-pod {
  z-index: 1;
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  background: linear-gradient(145deg, #fff, #bcc9d4);
  border-radius: 14px 14px 20px 20px;
  box-shadow:
    inset -5px -5px 8px rgba(55, 72, 87, 0.18),
    0 8px 15px rgba(0, 4, 14, 0.45);
}
.sensor-pod i {
  width: 26px;
  height: 26px;
  background: radial-gradient(circle at 38% 32%, #eafaff, #78b7d5 42%, #1f526c 74%);
  border: 3px solid #d8e3eb;
  border-radius: 50%;
  box-shadow: 0 0 10px rgba(64, 191, 255, 0.34);
}
.sensor-base {
  position: absolute;
  z-index: 0;
  bottom: 6px;
  width: 42px;
  height: 12px;
  background: linear-gradient(#c7d3dc, #738290);
  border-radius: 50%;
}
.contact-main,
.contact-side {
  z-index: 1;
  background: linear-gradient(145deg, #fff, #bbc7d1);
  box-shadow:
    inset -3px -4px 7px rgba(61, 78, 92, 0.17),
    0 8px 12px rgba(0, 3, 12, 0.42);
}
.contact-main {
  width: 28px;
  height: 58px;
  border-radius: 7px;
}
.contact-main i {
  display: block;
  width: 5px;
  height: 5px;
  margin: 8px auto;
  background: #66d5ff;
  border-radius: 50%;
  box-shadow: 0 0 7px #47c8ff;
}
.contact-side {
  position: absolute;
  right: 20px;
  width: 13px;
  height: 42px;
  border-radius: 5px;
}
.water-puck {
  z-index: 1;
  width: 58px;
  height: 30px;
  display: grid;
  place-items: center;
  color: #55c9ff;
  background: linear-gradient(180deg, #fff, #b6c4d0 70%, #7a8a99);
  border-radius: 50%;
  box-shadow:
    inset 0 -7px 10px rgba(62, 78, 92, 0.22),
    0 8px 14px rgba(0, 3, 12, 0.48);
}
.water-puck i {
  font-style: normal;
  font-size: 21px;
  font-weight: 700;
  text-shadow: 0 0 8px rgba(50, 193, 255, 0.6);
}
.lock-body {
  position: relative;
  z-index: 1;
  width: 27px;
  height: 69px;
  background: linear-gradient(90deg, #17212c, #44515d 50%, #101820);
  border: 1px solid #758696;
  border-radius: 5px;
  box-shadow:
    inset 2px 0 4px rgba(255, 255, 255, 0.13),
    0 8px 14px rgba(0, 2, 9, 0.58);
}
.lock-body .camera {
  position: absolute;
  left: 9px;
  top: 7px;
  width: 8px;
  height: 8px;
  background: #219edb;
  border: 2px solid #8898a5;
  border-radius: 50%;
}
.lock-body .handle {
  position: absolute;
  left: 22px;
  top: 28px;
  width: 28px;
  height: 7px;
  background: linear-gradient(#7f8d98, #222e38);
  border-radius: 4px;
  transform: rotate(-3deg);
  box-shadow: 0 4px 5px rgba(0, 0, 0, 0.35);
}
.lock-body .keypad {
  position: absolute;
  left: 7px;
  top: 23px;
  width: 12px;
  height: 26px;
  background: repeating-linear-gradient(0deg, rgba(68, 214, 255, 0.6) 0 2px, transparent 2px 7px);
  opacity: 0.55;
}
.music-screen,
.panel-screen {
  position: relative;
  z-index: 1;
  width: 70px;
  height: 54px;
  padding: 6px;
  background: linear-gradient(145deg, #263543, #050a10);
  border: 2px solid #8b9ba8;
  border-radius: 5px;
  box-shadow:
    inset 0 0 12px rgba(22, 141, 220, 0.18),
    0 9px 16px rgba(0, 2, 8, 0.55);
  transform: rotateY(-5deg);
}
.music-screen {
  background: linear-gradient(145deg, #10304d, #071019);
}
.music-screen .album {
  display: block;
  width: 24px;
  height: 24px;
  background: linear-gradient(145deg, #ffbd55, #7945f3);
  border-radius: 3px;
}
.music-screen .wave {
  position: absolute;
  left: 36px;
  right: 7px;
  bottom: 10px;
  height: 17px;
  display: flex;
  align-items: flex-end;
  gap: 2px;
}
.music-screen .wave b {
  flex: 1;
  height: 35%;
  background: #40caff;
  border-radius: 2px;
  box-shadow: 0 0 5px rgba(64, 202, 255, 0.45);
}
.powered .music-screen .wave b {
  animation: meter 720ms ease-in-out 3 alternate;
}
.powered .music-screen .wave b:nth-child(2) {
  animation-delay: 90ms;
}
.powered .music-screen .wave b:nth-child(3) {
  animation-delay: 180ms;
}
.powered .music-screen .wave b:nth-child(4) {
  animation-delay: 60ms;
}
.powered .music-screen .wave b:nth-child(5) {
  animation-delay: 140ms;
}
.panel-screen {
  background: linear-gradient(145deg, #0e88c4, #071421 62%);
}
.panel-time {
  display: block;
  color: #fff;
  font-size: 8px;
  font-style: normal;
  letter-spacing: 0.06em;
}
.panel-grid {
  position: absolute;
  left: 7px;
  right: 7px;
  bottom: 7px;
  height: 24px;
  background:
    linear-gradient(90deg, #54d2ff 45%, transparent 45%) 0 0/13px 10px,
    linear-gradient(#54d2ff 45%, transparent 45%) 0 0/13px 10px;
  opacity: 0.55;
  border-radius: 2px;
}
@keyframes meter {
  0% {
    height: 22%;
  }
  45% {
    height: 92%;
  }
  75% {
    height: 48%;
  }
  100% {
    height: 76%;
  }
}
</style>
