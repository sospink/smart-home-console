<script setup lang="ts">
import { computed } from "vue";
import type { Device, Scene } from "@smart-lab/contracts";
import { Clapperboard, House, LogOut, MoonStar, Power, Radio, ShieldCheck, Sparkles } from "lucide-vue-next";
import DeviceGlyph from "./DeviceGlyph.vue";
import homeIllustration from "../assets/illustrations/home-overview.svg";

const props = defineProps<{
  devices: Device[];
  scenes: Scene[];
  onlineCount: number;
  totalDeviceCount: number;
  poweredCount: number;
  alertCount: number;
  alertSummary: string;
  connected: boolean;
  cached: boolean;
  activeSceneId?: string;
  sceneBusy?: boolean;
}>();

const emit = defineEmits<{
  openDevice: [device: Device];
  runScene: [scene: Scene];
  openSection: [section: "devices" | "security" | "scenes"];
}>();

const visibleDevices = computed(() => props.devices.slice(0, 5));
const overviewTitle = computed(() => {
  if (!props.connected) return "连接中断，控制暂不可用";
  if (props.alertCount > 0) return `${props.alertCount} 项状态需要关注`;
  if (props.onlineCount < props.totalDeviceCount) return "核心设备已连接";
  return "家里，一切都好";
});
const overviewDescription = computed(() => {
  if (props.cached) return "当前显示最近一次可信状态，恢复连接后自动更新";
  if (props.alertCount > 0) return "可进入安防状态查看待处理与恢复中的事件";
  if (props.onlineCount < props.totalDeviceCount) return "已接入设备实时同步，待安装设备不会伪装在线";
  return "设备、场景与安防状态正在实时同步";
});

function stateLabel(device: Device) {
  if (device.kind === "light") return device.state.power ? `${device.state.brightness ?? 100}%` : "已关闭";
  if (device.kind === "cover") return `开合 ${device.state.position ?? 0}%`;
  if (device.kind === "media") return device.state.power ? `音量 ${device.state.volume ?? 0}%` : "已关闭";
  if (device.kind === "lock") return device.state.locked ? "已上锁" : "已解锁";
  if ("waterLeak" in device.state) return device.state.waterLeak ? "检测到水浸" : "正常";
  if ("contact" in device.state) return device.state.contact === "closed" ? "已关闭" : "已打开";
  if ("motion" in device.state) return device.state.motion ? "有人移动" : "无人移动";
  return device.health === "online" ? "在线" : "离线";
}

function sceneIcon(scene: Scene) {
  const identity = `${scene.id} ${scene.name}`.toLowerCase();
  if (identity.includes("away") || identity.includes("离家") || identity.includes("关闭")) return LogOut;
  if (identity.includes("sleep") || identity.includes("night") || identity.includes("夜间") || identity.includes("睡眠")) return MoonStar;
  if (identity.includes("movie") || identity.includes("观影")) return Clapperboard;
  if (identity.includes("home") || identity.includes("回家")) return House;
  return Sparkles;
}
</script>

<template>
  <section class="home-overview" data-testid="overview-panel">
    <div class="home-canvas">
      <img class="home-art" :src="homeIllustration" alt="" aria-hidden="true" />
      <header class="home-heading">
        <span>全屋状态</span>
        <h1>{{ overviewTitle }}</h1>
        <p>{{ overviewDescription }}</p>
      </header>

      <div class="home-status" aria-label="全屋关键状态">
        <button type="button" @click="emit('openSection', 'devices')">
          <span><Radio :size="16" />在线设备</span><strong>{{ onlineCount }}/{{ totalDeviceCount }}</strong>
          <small>{{ connected ? "实时连接" : "等待重连" }}</small>
        </button>
        <button type="button" @click="emit('openSection', 'devices')">
          <span><Power :size="16" />正在运行</span><strong>{{ poweredCount }}</strong
          ><small>个负载开启</small>
        </button>
        <button type="button" :class="{ attention: alertCount > 0 }" @click="emit('openSection', 'security')">
          <span><ShieldCheck :size="16" />安防状态</span><strong>{{ alertCount || "正常" }}</strong
          ><small>{{ alertSummary }}</small>
        </button>
      </div>

      <div class="home-hotspots" aria-label="空间设备快捷入口">
        <button
          v-for="(device, index) in visibleDevices.slice(0, 4)"
          :key="device.id"
          type="button"
          class="home-hotspot"
          :class="[`spot-${index}`, { offline: device.health === 'offline', active: device.state.power === true }]"
          :aria-label="`在空间图查看${device.name}详情`"
          @click="emit('openDevice', device)"
        >
          <span><DeviceGlyph :kind="device.kind" :sensor-type="'waterLeak' in device.state ? 'waterLeak' : undefined" :size="17" /></span>
          <b>{{ device.name }}</b
          ><small>{{ stateLabel(device) }}</small>
        </button>
      </div>

      <div class="home-scenes">
        <div><span>一键场景</span><small>执行前可进入场景页查看动作</small></div>
        <button
          v-for="scene in scenes.slice(0, 5)"
          :key="scene.id"
          type="button"
          :class="{ active: activeSceneId === scene.id }"
          :disabled="!connected || scene.enabled === false || sceneBusy"
          @click="emit('runScene', scene)"
        >
          <component :is="sceneIcon(scene)" :size="18" />
          <span>{{ scene.name }}</span>
          <small>{{ activeSceneId === scene.id ? "执行中" : `${scene.actions.length} 项` }}</small>
        </button>
        <button class="scene-more" type="button" @click="emit('openSection', 'scenes')">全部场景</button>
      </div>
    </div>

    <aside class="home-control-list">
      <header>
        <div><span>即时控制</span><strong>常用设备</strong></div>
        <button type="button" @click="emit('openSection', 'devices')">查看全部</button>
      </header>
      <button
        v-for="device in visibleDevices"
        :key="device.id"
        type="button"
        :class="{ offline: device.health === 'offline', active: device.state.power === true }"
        :aria-label="`查看${device.name}详情`"
        @click="emit('openDevice', device)"
      >
        <i><DeviceGlyph :kind="device.kind" :sensor-type="'waterLeak' in device.state ? 'waterLeak' : undefined" :size="21" /></i>
        <span
          ><strong>{{ device.name }}</strong
          ><small>{{ device.room }} · {{ stateLabel(device) }}</small></span
        >
        <em :title="device.health === 'online' ? '在线' : '离线'" />
      </button>
      <p v-if="!visibleDevices.length">还没有设置常用设备，可在工程管理中配置首页显示。</p>
    </aside>
  </section>
</template>

<style scoped>
.home-overview {
  height: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 332px;
  gap: 18px;
}
.home-canvas {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border-radius: 28px;
  background: var(--home-canvas);
  box-shadow: 0 18px 55px rgba(51, 64, 61, 0.1);
  isolation: isolate;
}
.home-art {
  position: absolute;
  z-index: 0;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 55% center;
  pointer-events: none;
}
.home-canvas::before,
.home-canvas::after {
  content: "";
  position: absolute;
  z-index: 1;
  inset: 0;
  pointer-events: none;
}
.home-canvas::before {
  background: var(--home-canvas-overlay);
}
.home-canvas::after {
  background: var(--home-canvas-shade);
}
.home-heading {
  position: absolute;
  z-index: 2;
  top: 34px;
  left: 38px;
  width: min(420px, 42%);
}
.home-heading > span,
.home-scenes > div > span,
.home-control-list header span {
  color: var(--cyan);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
}
.home-heading h1 {
  margin: 10px 0 7px;
  color: var(--home-heading);
  font-size: clamp(27px, 2.3vw, 42px);
  font-weight: 650;
  letter-spacing: -0.045em;
}
.home-heading p {
  margin: 0;
  color: var(--home-copy);
  font-size: 12px;
}
.home-status {
  position: absolute;
  z-index: 2;
  top: 152px;
  left: 38px;
  display: flex;
  align-items: stretch;
}
.home-status button {
  min-width: 132px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 18px;
  padding: 9px 21px;
  color: var(--home-status-text);
  background: transparent;
  border-left: 1px solid rgba(47, 64, 58, 0.14);
  text-align: left;
}
.home-status button:first-child {
  padding-left: 0;
  border-left: 0;
}
.home-status button:hover strong,
.home-status button:focus-visible strong {
  color: var(--cyan);
}
.home-status span {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.home-status strong {
  grid-row: 1 / 3;
  grid-column: 2;
  align-self: center;
  color: var(--home-status-strong);
  font-size: 22px;
  font-weight: 620;
  font-variant-numeric: tabular-nums;
  transition: color 160ms ease;
}
.home-status small {
  color: var(--home-status-muted);
  font-size: 11px;
}
.home-status .attention strong {
  color: var(--danger);
}
.home-hotspot {
  position: absolute;
  z-index: 3;
  min-width: 132px;
  display: grid;
  grid-template-columns: 32px 1fr;
  column-gap: 8px;
  padding: 8px 10px 8px 8px;
  color: var(--home-hotspot-text);
  background: var(--home-hotspot);
  border: 1px solid var(--home-hotspot-border);
  border-radius: 15px;
  box-shadow: 0 10px 26px rgba(42, 57, 52, 0.13);
  backdrop-filter: blur(12px) saturate(1.1);
  text-align: left;
  transition:
    transform 180ms var(--ease-out),
    box-shadow 180ms ease;
}
.home-hotspot:hover,
.home-hotspot:focus-visible {
  transform: translateY(-3px);
  box-shadow: 0 15px 32px rgba(42, 57, 52, 0.18);
}
.home-hotspot > span {
  grid-row: 1 / 3;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  color: var(--home-hotspot-icon);
  background: var(--home-hotspot-icon-surface);
  border-radius: 11px;
}
.home-hotspot.active > span {
  color: var(--cyan);
  background: var(--cyan-soft);
}
.home-hotspot b {
  max-width: 112px;
  overflow: hidden;
  font-size: 11px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-hotspot small {
  color: var(--home-hotspot-muted);
  font-size: 11px;
}
.home-hotspot.offline {
  opacity: 0.62;
}
.spot-0 {
  top: 41%;
  left: 44%;
}
.spot-1 {
  top: 23%;
  right: 8%;
}
.spot-2 {
  top: 48%;
  right: 6%;
}
.spot-3 {
  top: 58%;
  left: 27%;
}
.home-scenes {
  position: absolute;
  z-index: 4;
  right: 22px;
  bottom: 20px;
  left: 22px;
  min-height: 92px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 15px;
  color: #eef5f2;
  background: rgba(30, 42, 39, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 20px;
  box-shadow: 0 15px 42px rgba(18, 28, 25, 0.22);
  backdrop-filter: blur(18px) saturate(1.08);
}
.home-scenes > div {
  min-width: 130px;
  display: grid;
  gap: 4px;
  padding: 0 10px 0 4px;
}
.home-scenes > div small {
  color: rgba(232, 242, 237, 0.57);
  font-size: 11px;
}
.home-scenes > button {
  min-width: 86px;
  min-height: 60px;
  display: grid;
  grid-template-columns: 22px 1fr;
  align-content: center;
  gap: 3px 6px;
  padding: 8px 11px;
  color: rgba(243, 248, 246, 0.8);
  background: rgba(255, 255, 255, 0.06);
  border-radius: 14px;
  text-align: left;
  transition:
    background 160ms ease,
    transform 160ms var(--ease-out);
}
.home-scenes > button:hover,
.home-scenes > button:focus-visible,
.home-scenes > button.active {
  color: #fff;
  background: rgba(50, 170, 255, 0.22);
  transform: translateY(-2px);
}
.home-scenes > button:disabled {
  opacity: 0.52;
  transform: none;
}
.home-scenes button > svg {
  grid-row: 1 / 3;
  align-self: center;
  color: #7ccaff;
}
.home-scenes button span {
  font-size: 11px;
  font-weight: 650;
}
.home-scenes button small {
  color: rgba(239, 247, 244, 0.52);
  font-size: 11px;
}
.home-scenes .scene-more {
  min-width: 72px;
  display: block;
  color: #9bcde9;
  background: transparent;
  text-align: center;
}
.home-control-list {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 24px 18px 18px;
  background: var(--card);
  border-radius: 25px;
  box-shadow: var(--shadow-panel);
}
.home-control-list header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  padding: 0 6px 13px;
}
.home-control-list header div {
  display: grid;
  gap: 5px;
}
.home-control-list header strong {
  font-size: 19px;
  font-weight: 650;
}
.home-control-list header button {
  min-height: 44px;
  color: var(--cyan);
  background: transparent;
  font-size: 11px;
}
.home-control-list > button {
  min-height: 74px;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 8px;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  color: var(--text);
  background: transparent;
  border-radius: 16px;
  text-align: left;
  transition:
    background 160ms ease,
    transform 160ms var(--ease-out);
}
.home-control-list > button:hover,
.home-control-list > button:focus-visible {
  background: var(--card-soft);
  transform: translateX(3px);
}
.home-control-list > button i {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--text-soft);
  background: var(--card-soft);
  border-radius: 15px;
  font-style: normal;
}
.home-control-list > button.active i {
  color: var(--cyan);
  background: var(--cyan-soft);
}
.home-control-list > button > span {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.home-control-list > button strong,
.home-control-list > button small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-control-list > button strong {
  font-size: 12px;
  font-weight: 650;
}
.home-control-list > button small {
  color: var(--muted);
  font-size: 11px;
}
.home-control-list > button em {
  width: 7px;
  height: 7px;
  background: var(--green);
  border-radius: 50%;
  box-shadow: 0 0 0 4px var(--green-soft);
}
.home-control-list > button.offline {
  opacity: 0.56;
}
.home-control-list > button.offline em {
  background: var(--danger);
  box-shadow: 0 0 0 4px var(--danger-soft);
}
.home-control-list > p {
  margin: auto 10px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
}
@media (max-width: 1380px) {
  .home-overview {
    grid-template-columns: minmax(0, 1fr) 292px;
  }
  .home-status button {
    min-width: 118px;
    gap: 3px 10px;
    padding-inline: 15px;
  }
  .home-scenes > div {
    min-width: 104px;
  }
  .home-scenes > button {
    min-width: 78px;
  }
}
@media (max-width: 1080px) {
  .home-overview {
    grid-template-columns: minmax(0, 1fr) 250px;
  }
  .home-status button:nth-child(2) {
    display: none;
  }
  .home-scenes > button:nth-of-type(n + 4) {
    display: none;
  }
  .spot-1,
  .spot-2 {
    display: none;
  }
}
@media (max-height: 760px) {
  .home-heading {
    top: 23px;
  }
  .home-status {
    top: 120px;
  }
  .home-scenes {
    min-height: 78px;
    padding-block: 9px;
  }
  .home-scenes > button {
    min-height: 54px;
  }
  .home-control-list {
    padding-top: 16px;
  }
  .home-control-list > button {
    min-height: 62px;
  }
}
</style>
