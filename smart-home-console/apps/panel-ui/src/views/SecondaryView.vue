<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { Device, Scene } from "@smart-lab/contracts";
import {
  AlertTriangle,
  Blinds,
  ChevronRight,
  CircleStop,
  CloudSun,
  DoorClosed,
  CheckCircle2,
  ChevronsRightLeft,
  Clock3,
  LampCeiling,
  Music2,
  Play,
  Power,
  ShieldCheck,
  Sparkles,
  Wifi,
  X
} from "lucide-vue-next";
import SystemHeader from "../components/SystemHeader.vue";
import ToastStack from "../components/ToastStack.vue";
import RollingNumber from "../components/RollingNumber.vue";
import LightCapabilityPanel from "../components/LightCapabilityPanel.vue";
import ContinuousCapabilityControl from "../components/ContinuousCapabilityControl.vue";
import { featuredActiveAlert } from "../lib/alerts";
import { cachedSnapshotAgeLabel } from "../lib/snapshot-cache";
import { useEdgeStore } from "../stores/edge";

type FocusControl = "light" | "curtain" | "music";
const LocalMusicPlayer = defineAsyncComponent(() => import("../components/LocalMusicPlayer.vue"));
const ScreenSaver = defineAsyncComponent(() => import("../components/ScreenSaver.vue"));
const slotRequirements: Record<FocusControl, string[]> = {
  light: ["power", "brightness"],
  curtain: ["position", "motor"],
  music: ["power", "volume"]
};

const edge = useEdgeStore();
const visibleScenes = computed(() => edge.scenes);
const cacheClock = ref(Date.now());
let cacheClockTimer: number | undefined;
onMounted(() => {
  cacheClockTimer = window.setInterval(() => (cacheClock.value = Date.now()), 30_000);
});
onUnmounted(() => window.clearInterval(cacheClockTimer));
const cacheAge = computed(() => (edge.cachedSnapshotAt ? cachedSnapshotAgeLabel(edge.cachedSnapshotAt, cacheClock.value) : undefined));
const activeControl = ref<FocusControl>("light");
const selectedAlertId = ref<string>();
const alertAction = ref<"idle" | "pending" | "failed">("idle");
const alertActionError = ref("");
const alertSummaryButton = ref<HTMLButtonElement>();
const alertDialogBackdrop = ref<HTMLElement>();
const allLightsButton = ref<HTMLButtonElement>();
const allLightsConfirmBackdrop = ref<HTMLElement>();
const allLightsConfirmIds = ref<string[]>([]);
function supportsSlot(device: Device, slot: FocusControl) {
  return slotRequirements[slot].every((property) =>
    device.capabilities.some((capability) => capability.property === property && capability.writable)
  );
}
const usesLegacySlotFallback = computed(() => edge.devices.every((item) => !item.display?.secondarySlot));
function slotDevice(slot: FocusControl) {
  return computed(
    () =>
      edge.devices.find((item) => item.display?.secondarySlot === slot && supportsSlot(item, slot)) ??
      (usesLegacySlotFallback.value ? edge.devices.find((item) => supportsSlot(item, slot)) : undefined)
  );
}
const light = slotDevice("light");
const curtain = slotDevice("curtain");
const music = slotDevice("music");
const curtainPositionCapability = computed(() =>
  curtain.value?.capabilities.find((item) => item.property === "position" && item.type === "number" && item.writable)
);
const curtainDraft = ref(0);
const allLightDevices = computed(() => edge.devices.filter((item) => item.kind === "light"));
const writablePowerLights = computed(() =>
  allLightDevices.value.filter(
    (item) => item.kind === "light" && item.capabilities.some((capability) => capability.property === "power" && capability.writable)
  )
);
const activePowerLights = computed(() => writablePowerLights.value.filter((item) => item.state.power === true));
const actionablePowerLights = computed(() => activePowerLights.value.filter((item) => item.health !== "offline"));
const excludedActiveLights = computed(
  () => allLightDevices.value.filter((item) => item.state.power === true).length - actionablePowerLights.value.length
);
const allLightsSummary = computed(() => {
  if (!allLightDevices.value.length) return "未发现灯具";
  if (!actionablePowerLights.value.length) return excludedActiveLights.value ? `${excludedActiveLights.value} 盏不可总控` : "当前均已关闭";
  return excludedActiveLights.value
    ? `${actionablePowerLights.value.length} 盏可关闭 · ${excludedActiveLights.value} 盏不可总控`
    : `${actionablePowerLights.value.length} 盏开启`;
});
const activeDevice = computed(() =>
  activeControl.value === "light" ? light.value : activeControl.value === "curtain" ? curtain.value : music.value
);
const controlScope = computed(() => (activeDevice.value ? `${activeDevice.value.room}控制` : "快捷控制待配置"));
const onlineGateways = computed(() => edge.health?.gateways.filter((item) => item.status === "online").length ?? 0);
const configuredGateways = computed(() => edge.health?.gateways.length ?? 0);
const gatewaySummary = computed(() => {
  if (!configuredGateways.value) return "网关待配置";
  return `${edge.cachedSnapshotAt ? "上次 " : ""}${onlineGateways.value}/${configuredGateways.value} 网关在线`;
});
const featuredAlert = computed(() => featuredActiveAlert(edge.alerts));
const acknowledgedActiveCount = computed(() => edge.activeAlerts.length - edge.unacknowledgedAlerts.length);
const alertCountSummary = computed(() => {
  const parts = [];
  if (edge.unacknowledgedAlerts.length) parts.push(`${edge.unacknowledgedAlerts.length} 条待确认`);
  if (acknowledgedActiveCount.value) parts.push(`${acknowledgedActiveCount.value} 条处理中`);
  return parts.join(" · ");
});
const selectedAlert = computed(() => edge.alerts.find((item) => item.id === selectedAlertId.value));
const selectedAlertDevice = computed(() => edge.devices.find((item) => item.id === selectedAlert.value?.deviceId));
const entrySummary = computed(() => {
  const contacts = edge.devices.filter((item) => item.capabilities.some((capability) => capability.property === "contact"));
  if (!contacts.length) return { state: "门窗待配置", detail: "未发现门窗传感器", warning: true };
  const online = contacts.filter((item) => item.health === "online");
  const open = online.filter((item) => item.state.contact === "open");
  if (open.length) return { state: "门窗开启", detail: `${open.length} 处开启`, warning: true };
  if (online.length !== contacts.length)
    return { state: "状态不完整", detail: `${online.length}/${contacts.length} 传感器在线`, warning: true };
  return { state: "门窗已关", detail: `${contacts.length} 个传感器状态正常`, warning: false };
});
const safetySummary = computed(() => {
  if (featuredAlert.value)
    return {
      state: featuredAlert.value.acknowledgedAt ? "异常处理中" : "有事件待确认",
      detail: alertCountSummary.value,
      warning: true
    };
  const devices = edge.devices.filter((item) => item.kind === "sensor" || item.kind === "lock");
  if (!devices.length) return { state: "安防待配置", detail: "未发现安防节点", warning: true };
  const unavailable = devices.filter((item) => item.health !== "online");
  if (unavailable.length) return { state: "状态不完整", detail: `${unavailable.length} 个安防节点不可用`, warning: true };
  return { state: "未发现异常", detail: `${devices.length} 个安防节点在线`, warning: false };
});
const curtainPositionLabel = computed(() => {
  if (curtainDraft.value <= 0) return "全闭";
  if (curtainDraft.value < 25) return "微启";
  if (curtainDraft.value < 65) return "半开";
  if (curtainDraft.value < 100) return "大开";
  return "全开";
});
const curtainStageStyle = computed(() => ({
  "--curtain-panel-width": `${50 - curtainDraft.value * 0.42}%`,
  "--curtain-daylight": `${0.18 + curtainDraft.value * 0.007}`,
  "--curtain-fold-size": `${Math.max(8, 18 - curtainDraft.value * 0.08)}px`
}));

watch(
  () => Number(curtain.value?.state.position ?? 0),
  (value) => (curtainDraft.value = value),
  { immediate: true }
);

type SceneRunState = "running" | "completed" | "partial" | "failed" | "idle";

function latestExecution(sceneId: string) {
  return edge.snapshot?.executions.find((item) => item.sceneId === sceneId);
}

function sceneRunState(scene: Scene): SceneRunState {
  if (edge.requestingSceneIds[scene.id]) return "running";
  const current = edge.snapshot?.executions[0];
  return current?.sceneId === scene.id ? current.status : "idle";
}

function sceneStatusText(scene: Scene) {
  if (edge.requestingSceneIds[scene.id]) return "正在发送请求";
  const active = edge.activeExecution;
  if (active && active.sceneId !== scene.id) {
    const source =
      active.source === "primary" ? "主屏" : active.source === "secondary" ? "本屏" : active.source === "admin" ? "后台" : "自动联动";
    const name = edge.scenes.find((item) => item.id === active.sceneId)?.name ?? "其他";
    return `${source}正在执行${name}`;
  }
  const execution = latestExecution(scene.id);
  if (!execution) return `${scene.actions.length} 项联动`;
  if (edge.snapshot?.executions[0]?.sceneId !== scene.id) return "上次已执行";
  const source =
    execution.source === "primary" ? "主屏" : execution.source === "secondary" ? "本屏" : execution.source === "admin" ? "后台" : "自动";
  if (execution.status === "running") return `${source}执行 · ${execution.completedActions}/${execution.totalActions}`;
  if (execution.status === "partial") return `部分完成 · ${execution.completedActions}/${execution.totalActions}`;
  if (execution.status === "failed") return "执行失败";
  return `${source}已完成`;
}

function toggle(device?: Device) {
  if (device && device.health !== "offline" && edge.connected) edge.sendCommand(device.id, "power", !device.state.power, "secondary");
}

function feedback(device?: Device) {
  if (device && edge.isDeviceRequesting(device.id)) return "pending";
  return device ? edge.feedbackByDevice[device.id]?.status : undefined;
}

function propertyPending(device: Device | undefined, property: string) {
  return Boolean(device && edge.isPropertyPending(device.id, property));
}

function setValue(device: Device | undefined, property: string, value: number | string) {
  if (device && device.health !== "offline" && edge.connected) edge.sendCommand(device.id, property, value, "secondary");
}

async function requestAllLightsOff() {
  if (!edge.connected || !actionablePowerLights.value.length) return;
  allLightsConfirmIds.value = actionablePowerLights.value.map((device) => device.id);
  await nextTick();
  allLightsConfirmBackdrop.value?.focus();
}

async function closeAllLightsConfirmation() {
  allLightsConfirmIds.value = [];
  await nextTick();
  allLightsButton.value?.focus();
}

function confirmAllLightsOff() {
  if (!edge.connected || !allLightsConfirmIds.value.length) return;
  const ids = new Set(allLightsConfirmIds.value);
  allLightsConfirmIds.value = [];
  for (const device of actionablePowerLights.value.filter((item) => ids.has(item.id))) {
    edge.sendCommand(device.id, "power", false, "secondary");
  }
}

const allLightsConfirmDevices = computed(() =>
  allLightsConfirmIds.value
    .map((id) => actionablePowerLights.value.find((device) => device.id === id))
    .filter((device): device is Device => Boolean(device))
);
const allLightsConfirmChanged = computed(() => allLightsConfirmDevices.value.length !== allLightsConfirmIds.value.length);

function trapDialogFocus(event: KeyboardEvent, backdrop: HTMLElement | undefined) {
  if (!backdrop) return;
  const focusable = [
    ...backdrop.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex='-1'])")
  ];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === backdrop)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === backdrop)) {
    event.preventDefault();
    first.focus();
  }
}

function formatAlertTime(value?: string) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

async function openAlert(alertId: string) {
  selectedAlertId.value = alertId;
  alertAction.value = "idle";
  alertActionError.value = "";
  await nextTick();
  alertDialogBackdrop.value?.focus();
}

async function closeAlert() {
  if (alertAction.value === "pending") return;
  selectedAlertId.value = undefined;
  alertActionError.value = "";
  await nextTick();
  alertSummaryButton.value?.focus();
}

async function acknowledgeSelectedAlert() {
  const alert = selectedAlert.value;
  if (!alert || alert.acknowledgedAt || alertAction.value === "pending" || !edge.connected) return;
  alertAction.value = "pending";
  alertActionError.value = "";
  try {
    await edge.acknowledgeAlert(alert.id, "secondary");
    alertAction.value = "idle";
  } catch (error) {
    alertAction.value = "failed";
    alertActionError.value = error instanceof Error ? error.message : "确认失败，请重试";
  }
}

function slotSummary(device: Device | undefined, slot: FocusControl) {
  if (!device) return "待配置";
  const value =
    slot === "light"
      ? device.state.power
        ? `${device.state.brightness}%`
        : "已关闭"
      : slot === "curtain"
        ? `开启 ${device.state.position ?? 0}%`
        : device.state.power
          ? `音量 ${device.state.volume}%`
          : "已关闭";
  return device.health === "offline" ? `离线 · 上次 ${value}` : value;
}
</script>

<template>
  <main class="secondary-shell" :inert="Boolean(allLightsConfirmIds.length || selectedAlert)">
    <SystemHeader compact />
    <section class="secondary-workspace" :class="{ readonly: !edge.connected }">
      <div v-if="!edge.connected" class="offline-lock">
        <AlertTriangle :size="17" />
        <span
          ><strong>{{ edge.cachedSnapshotAt ? `离线缓存 · ${cacheAge}` : (edge.connectionIssue?.title ?? "本地控制服务连接中断") }}</strong
          ><small
            >{{
              edge.cachedSnapshotAt
                ? "以下为上次同步状态，仅供查看，所有控制已锁定"
                : (edge.connectionIssue?.detail ?? "当前保留最后已知状态")
            }}
            · {{ edge.networkOnline ? (edge.retryInSeconds ? `${edge.retryInSeconds} 秒后重试` : "正在连接") : "等待网络恢复" }}</small
          ></span
        >
        <button :disabled="!edge.networkOnline" @click="edge.reconnectNow">{{ edge.networkOnline ? "立即重连" : "网络不可用" }}</button>
      </div>

      <header class="secondary-overview">
        <div class="home-title">
          <span class="eyebrow">全屋状态</span>
          <strong>{{ controlScope }}</strong>
          <small>{{ edge.cachedSnapshotAt ? `上次同步 ${edge.onlineCount} 个设备在线` : `${edge.onlineCount} 个设备在线` }}</small>
        </div>
        <div class="ambient-status">
          <CloudSun :size="18" />
          <strong>--°</strong>
          <span>环境待接入</span>
          <i />
          <Wifi :size="16" />
          <span>{{ gatewaySummary }}</span>
        </div>
        <button
          ref="allLightsButton"
          v-ripple
          class="all-off"
          :disabled="!edge.connected || !actionablePowerLights.length"
          @click="requestAllLightsOff"
        >
          <Power :size="17" /><span
            ><strong>全屋关灯</strong><small>{{ allLightsSummary }}</small></span
          >
        </button>
      </header>

      <nav class="scene-rail" aria-label="常用场景">
        <span class="rail-label">常用场景</span>
        <button
          v-for="scene in visibleScenes"
          :key="scene.id"
          v-ripple
          class="scene-action pressable"
          :class="[sceneRunState(scene), `scene-${scene.id.replace('scene-', '')}`]"
          :disabled="
            !edge.connected || scene.enabled === false || Boolean(edge.activeExecution) || Object.keys(edge.requestingSceneIds).length > 0
          "
          @click="void edge.executeScene(scene.id, 'secondary')"
        >
          <Sparkles :size="16" />
          <span
            ><strong>{{ scene.name }}</strong
            ><small>{{ sceneStatusText(scene) }}</small></span
          >
          <span class="scene-action-status"><i /><ChevronRight :size="14" /></span>
        </button>
      </nav>

      <section class="control-deck">
        <nav class="device-switcher" aria-label="设备类型">
          <span class="switcher-label">设备控制</span>
          <button :class="{ active: activeControl === 'light', unconfigured: !light }" @click="activeControl = 'light'">
            <LampCeiling :size="20" />
            <span
              ><strong>灯光</strong><small>{{ slotSummary(light, "light") }}</small></span
            >
          </button>
          <button :class="{ active: activeControl === 'curtain', unconfigured: !curtain }" @click="activeControl = 'curtain'">
            <Blinds :size="20" />
            <span
              ><strong>窗帘</strong><small>{{ slotSummary(curtain, "curtain") }}</small></span
            >
          </button>
          <button :class="{ active: activeControl === 'music', unconfigured: !music }" @click="activeControl = 'music'">
            <Music2 :size="20" />
            <span
              ><strong>音乐</strong><small>{{ slotSummary(music, "music") }}</small></span
            >
          </button>
        </nav>

        <Transition name="focus-swap" mode="out-in">
          <article
            v-if="activeControl === 'light' && light"
            key="light"
            class="focus-control light-focus command-surface"
            :class="feedback(light)"
          >
            <LightCapabilityPanel :device="light" source="secondary" />
          </article>

          <article
            v-else-if="activeControl === 'curtain' && curtain"
            key="curtain"
            class="focus-control curtain-focus command-surface"
            :class="feedback(curtain)"
          >
            <div class="focus-copy">
              <span>{{ curtain.room }} · 窗帘</span>
              <h1>{{ curtain?.name }}</h1>
              <p>{{ curtain.health === "offline" ? "设备离线，以下为最后已知状态" : "当前位置已同步，可直接拖动或使用快捷动作" }}</p>
            </div>
            <div class="focus-value">
              <strong><RollingNumber :value="curtainDraft" unit="%" /></strong
              ><small>{{ curtain.health === "offline" ? "上次位置" : "开合位置" }}</small>
            </div>
            <div v-if="curtain" class="curtain-stage" :style="curtainStageStyle" data-testid="curtain-spatial-control" aria-hidden="true">
              <div class="curtain-window-view">
                <i class="view-sun" />
                <i class="view-horizon" />
                <i class="view-building building-a" />
                <i class="view-building building-b" />
                <i class="window-mullion vertical" />
                <i class="window-mullion horizontal" />
              </div>
              <div class="curtain-track"><i v-for="n in 11" :key="n" /></div>
              <div class="curtain-panel left"><i /></div>
              <div class="curtain-panel right"><i /></div>
              <div class="curtain-stage-status">
                <i /><span>{{ curtain.health === "offline" ? "上次位置" : "实时位置" }}</span
                ><strong>{{ curtainPositionLabel }}</strong>
              </div>
              <div class="curtain-floor-shadow" />
            </div>
            <div v-if="curtain" class="curtain-control-dock">
              <ContinuousCapabilityControl
                v-if="curtainPositionCapability"
                class="curtain-position-control"
                :device="curtain"
                :capability="curtainPositionCapability"
                source="secondary"
                embedded
                @preview="curtainDraft = $event"
              />
              <div class="curtain-actions">
                <button
                  :disabled="!edge.connected || curtain.health === 'offline' || propertyPending(curtain, 'motor')"
                  @click="setValue(curtain, 'motor', 'open')"
                >
                  <Play :size="15" />打开
                </button>
                <button
                  :disabled="!edge.connected || curtain.health === 'offline' || propertyPending(curtain, 'motor')"
                  class="selected"
                  @click="setValue(curtain, 'motor', 'stop')"
                >
                  <CircleStop :size="15" />停止
                </button>
                <button
                  :disabled="!edge.connected || curtain.health === 'offline' || propertyPending(curtain, 'motor')"
                  @click="setValue(curtain, 'motor', 'close')"
                >
                  <ChevronsRightLeft :size="15" />关闭
                </button>
              </div>
            </div>
          </article>

          <article
            v-else-if="activeControl === 'music' && music"
            key="music"
            class="focus-control music-focus command-surface"
            :class="feedback(music)"
          >
            <LocalMusicPlayer
              :enabled="Boolean(music?.state.power)"
              :volume="Number(music?.state.volume ?? 0)"
              :device-name="music?.name"
              :unavailable="!edge.connected || music?.health === 'offline'"
              :power-pending="propertyPending(music, 'power')"
              :volume-pending="propertyPending(music, 'volume')"
              @power:toggle="toggle(music)"
              @volume:change="setValue(music, 'volume', $event)"
            />
          </article>

          <article v-else key="unconfigured" class="focus-control slot-empty">
            <div>
              <AlertTriangle :size="28" />
              <span>快捷控制待配置</span>
              <strong>{{ activeControl === "light" ? "灯光" : activeControl === "curtain" ? "窗帘" : "音乐" }}槽位没有可用设备</strong>
              <small>请在管理后台“房间与设备”中选择具备所需能力的设备。</small>
            </div>
          </article>
        </Transition>

        <aside class="home-brief">
          <header><span>家庭状态</span><small>实时</small></header>
          <div class="brief-primary" :class="{ warning: safetySummary.warning }">
            <ShieldCheck v-if="!safetySummary.warning" :size="28" />
            <AlertTriangle v-else :size="28" />
            <span
              ><strong>{{ safetySummary.state }}</strong
              ><small>{{ safetySummary.detail }}</small></span
            >
          </div>
          <div class="brief-row" :class="{ warning: entrySummary.warning }">
            <AlertTriangle v-if="entrySummary.warning" :size="17" />
            <DoorClosed v-else :size="17" /><span
              ><strong>{{ entrySummary.state }}</strong
              ><small>{{ entrySummary.detail }}</small></span
            >
          </div>
          <div class="brief-row">
            <Wifi :size="17" /><span
              ><strong>{{ gatewaySummary }}</strong
              ><small>{{ edge.health?.gateways[0]?.name ?? "本地状态链路" }}</small></span
            >
          </div>
          <button
            v-if="featuredAlert"
            ref="alertSummaryButton"
            class="alert-summary"
            :aria-label="`查看告警：${featuredAlert.title}`"
            @click="openAlert(featuredAlert.id)"
          >
            <span
              ><b>{{ featuredAlert.title }}</b
              ><small>{{ alertCountSummary }}</small></span
            ><ChevronRight :size="14" />
          </button>
        </aside>
      </section>
    </section>
    <Teleport to="body">
      <Transition name="alert-dialog">
        <div
          v-if="allLightsConfirmIds.length"
          ref="allLightsConfirmBackdrop"
          class="bulk-confirm-backdrop"
          tabindex="-1"
          @click.self="closeAllLightsConfirmation"
          @keydown.esc="closeAllLightsConfirmation"
          @keydown.tab="trapDialogFocus($event, allLightsConfirmBackdrop)"
        >
          <section role="dialog" aria-modal="true" aria-labelledby="all-lights-confirm-title" class="bulk-confirm-dialog">
            <header>
              <span><Power :size="18" />全屋灯光</span>
              <button aria-label="关闭确认对话框" @click="closeAllLightsConfirmation"><X :size="20" /></button>
            </header>
            <div class="bulk-confirm-copy">
              <span>将关闭 {{ allLightsConfirmDevices.length }} 盏灯</span>
              <h2 id="all-lights-confirm-title">确认关闭全屋灯光</h2>
              <p>每盏灯会分别等待设备确认；中途失败时以操作回执为准，不会把未确认设备显示为已关闭。</p>
            </div>
            <ul aria-label="本次将关闭的灯具">
              <li v-for="device in allLightsConfirmDevices" :key="device.id">
                <LampCeiling :size="16" />{{ device.room }} · {{ device.name }}
              </li>
            </ul>
            <p v-if="excludedActiveLights" class="bulk-exclusion">
              <AlertTriangle :size="15" />另有 {{ excludedActiveLights }} 盏离线或不支持总控，本次不会操作。
            </p>
            <p v-if="allLightsConfirmChanged" role="status" class="bulk-exclusion">
              <AlertTriangle :size="15" />设备状态已变化，清单已按当前可控状态更新。
            </p>
            <footer>
              <button class="bulk-cancel" @click="closeAllLightsConfirmation">取消</button>
              <button class="bulk-confirm" :disabled="!allLightsConfirmDevices.length" @click="confirmAllLightsOff">
                {{ allLightsConfirmDevices.length ? `确认关闭 ${allLightsConfirmDevices.length} 盏灯` : "没有可关闭的灯具" }}
              </button>
            </footer>
          </section>
        </div>
      </Transition>
      <Transition name="alert-dialog">
        <div
          v-if="selectedAlert"
          ref="alertDialogBackdrop"
          class="secondary-alert-backdrop"
          tabindex="-1"
          @click.self="closeAlert"
          @keydown.esc="closeAlert"
          @keydown.tab="trapDialogFocus($event, alertDialogBackdrop)"
        >
          <section role="dialog" aria-modal="true" aria-labelledby="secondary-alert-title" class="secondary-alert-dialog">
            <header>
              <span class="alert-level"
                ><AlertTriangle :size="18" />{{
                  selectedAlert.level === "critical" ? "紧急告警" : selectedAlert.level === "warning" ? "运维事件" : "状态事件"
                }}</span
              >
              <button aria-label="关闭告警详情" :disabled="alertAction === 'pending'" @click="closeAlert"><X :size="20" /></button>
            </header>
            <div class="alert-dialog-copy">
              <span>{{ selectedAlertDevice?.room ?? "未知区域" }} · {{ selectedAlertDevice?.name ?? selectedAlert.deviceId }}</span>
              <h2 id="secondary-alert-title">{{ selectedAlert.title }}</h2>
              <p>{{ selectedAlert.message }}</p>
            </div>
            <dl>
              <div>
                <dt><Clock3 :size="15" />发生时间</dt>
                <dd>{{ formatAlertTime(selectedAlert.occurredAt) }}</dd>
              </div>
              <div>
                <dt>当前状态</dt>
                <dd>{{ selectedAlert.recoveredAt ? "已恢复" : selectedAlert.acknowledgedAt ? "已确认，等待设备恢复" : "待确认" }}</dd>
              </div>
            </dl>
            <p class="alert-boundary"><CheckCircle2 :size="16" />确认仅表示操作员已知悉，不会清除设备异常或伪造恢复状态。</p>
            <p v-if="alertActionError" role="alert" class="alert-action-error">确认失败：{{ alertActionError }}</p>
            <footer>
              <button class="alert-cancel" :disabled="alertAction === 'pending'" @click="closeAlert">稍后处理</button>
              <button
                class="alert-confirm"
                :disabled="!edge.connected || Boolean(selectedAlert.acknowledgedAt) || alertAction === 'pending'"
                @click="acknowledgeSelectedAlert"
              >
                {{
                  selectedAlert.acknowledgedAt
                    ? "已确认"
                    : alertAction === "pending"
                      ? "确认中…"
                      : alertAction === "failed"
                        ? "重试确认"
                        : edge.connected
                          ? "确认已知悉"
                          : "连接中断，无法确认"
                }}
              </button>
            </footer>
          </section>
        </div>
      </Transition>
    </Teleport>
    <ToastStack />
    <ScreenSaver />
  </main>
</template>

<style scoped>
.secondary-shell {
  width: 100vw;
  height: 100vh;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #07111f;
}
.secondary-workspace {
  position: relative;
  height: calc(100vh - 60px);
  display: grid;
  grid-template-rows: 58px 78px minmax(0, 1fr);
  gap: 10px;
  padding: 14px 16px 16px;
  background: radial-gradient(circle at 54% 40%, rgba(53, 211, 255, 0.045), transparent 34%), #07111f;
}
.secondary-overview {
  display: flex;
  align-items: center;
  gap: 28px;
  padding: 0 18px;
  background: rgba(255, 255, 255, 0.025);
  border-bottom: 1px solid rgba(150, 182, 207, 0.08);
}
.home-title {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 255px;
}
.home-title strong {
  color: #f4f8fb;
  font-size: 20px;
  font-weight: 600;
}
.home-title small,
.ambient-status span,
.all-off small {
  color: #718393;
  font-size: 9px;
}
.ambient-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #91a2b1;
}
.ambient-status strong {
  color: #f4f8fb;
  font-size: 18px;
  font-weight: 500;
}
.ambient-status i {
  width: 1px;
  height: 18px;
  margin: 0 5px;
  background: rgba(150, 182, 207, 0.12);
}
.all-off {
  min-width: 126px;
  height: 40px;
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: #d8e2e9;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(150, 182, 207, 0.1);
  border-radius: 20px;
}
.all-off span {
  display: grid;
  gap: 1px;
  text-align: left;
}
.all-off strong {
  font-size: 10px;
  font-weight: 550;
}
.all-off:hover {
  color: #fff;
  background: rgba(53, 211, 255, 0.08);
  border-color: rgba(53, 211, 255, 0.24);
}
.scene-rail {
  display: flex;
  align-items: stretch;
  gap: 1px;
  min-width: 0;
  padding: 1px;
  background: rgba(150, 182, 207, 0.07);
  border-radius: 9px;
  overflow: hidden;
}
.rail-label {
  width: 104px;
  flex: 0 0 104px;
  display: grid;
  place-items: center;
  color: #8293a2;
  background: #0a1727;
  font-size: 10px;
}
.scene-action {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 28px 1fr 16px;
  align-items: center;
  gap: 8px;
  padding: 0 15px;
  color: #8698a7;
  background: #0a1727;
  text-align: left;
  transition:
    color 160ms ease,
    background-color 160ms ease;
}
.scene-action:hover {
  color: var(--cyan);
  background: #0d1d30;
}
.scene-action span {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.scene-action strong {
  color: #e9f0f5;
  font-size: 12px;
  font-weight: 550;
}
.scene-action small {
  color: #607283;
  font-size: 8px;
}
.scene-action-status {
  display: grid !important;
  place-items: center;
}
.scene-action-status i {
  display: none;
  width: 7px;
  height: 7px;
  background: currentColor;
  border-radius: 50%;
}
.scene-action.running,
.scene-action.completed,
.scene-action.partial,
.scene-action.failed {
  position: relative;
  overflow: hidden;
}
.scene-action.scene-home {
  --scene-state: #36cfa2;
}
.scene-action.scene-away {
  --scene-state: #f1a83b;
}
.scene-action.scene-movie {
  --scene-state: #8f79ff;
}
.scene-action.scene-sleep {
  --scene-state: #687bdc;
}
.scene-action.running,
.scene-action.completed {
  color: var(--scene-state);
  background: color-mix(in srgb, var(--scene-state) 10%, #0a1727);
}
.scene-action.partial {
  color: var(--gold);
}
.scene-action.failed {
  color: var(--danger);
}
.scene-action.completed .scene-action-status i,
.scene-action.partial .scene-action-status i,
.scene-action.failed .scene-action-status i {
  display: block;
}
.scene-action.completed .scene-action-status svg,
.scene-action.partial .scene-action-status svg,
.scene-action.failed .scene-action-status svg {
  display: none;
}
.scene-action.running::after {
  content: "";
  position: absolute;
  inset: auto 0 0;
  height: 2px;
  background: currentColor;
  transform-origin: left;
  animation: secondary-scene-progress 1.15s ease-in-out infinite;
}
.scene-action.running > svg:first-child {
  animation: secondary-scene-pulse 1.1s ease-in-out infinite;
}
.control-deck {
  min-height: 0;
  display: grid;
  grid-template-columns: 176px minmax(390px, 1fr) 218px;
  gap: 1px;
  padding: 1px;
  background: rgba(150, 182, 207, 0.07);
  border-radius: 10px;
  overflow: hidden;
}
.device-switcher,
.focus-control,
.home-brief {
  background: #0a1727;
}
.device-switcher {
  display: flex;
  flex-direction: column;
  padding: 18px 10px;
}
.switcher-label {
  padding: 0 10px 12px;
  color: #536575;
  font-size: 8px;
  letter-spacing: 0.16em;
}
.device-switcher button {
  min-height: 66px;
  display: grid;
  grid-template-columns: 32px 1fr;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  color: #697c8c;
  background: transparent;
  border-radius: 7px;
  text-align: left;
  transition:
    color 160ms ease,
    background-color 160ms ease;
}
.device-switcher button:hover {
  color: #b8c7d2;
  background: rgba(255, 255, 255, 0.035);
}
.device-switcher button.active {
  color: var(--cyan);
  background: rgba(53, 211, 255, 0.075);
}
.device-switcher button.unconfigured small {
  color: var(--gold);
}
.device-switcher button span {
  display: grid;
  gap: 4px;
}
.device-switcher strong {
  color: #e9f0f5;
  font-size: 11px;
  font-weight: 550;
}
.device-switcher small {
  color: #607283;
  font-size: 8px;
}
.focus-control {
  position: relative;
  min-width: 0;
  padding: 26px 30px;
  overflow: hidden;
  isolation: isolate;
}
.slot-empty {
  display: grid;
  place-items: center;
}
.slot-empty > div {
  max-width: 360px;
  display: grid;
  justify-items: center;
  gap: 9px;
  color: var(--warning);
  text-align: center;
}
.slot-empty span {
  color: var(--muted);
  font-size: 9px;
  letter-spacing: 0.12em;
}
.slot-empty strong {
  color: var(--text);
  font-size: 19px;
  font-weight: 600;
}
.slot-empty small {
  color: var(--muted);
  font-size: 10px;
}
.focus-control::before {
  content: "";
  position: absolute;
  z-index: -1;
  right: -70px;
  top: -100px;
  width: 340px;
  height: 340px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(53, 211, 255, 0.1), transparent 66%);
}
.light-focus::before {
  background: radial-gradient(circle, rgba(255, 205, 124, 0.13), transparent 66%);
}
.music-focus::before {
  background: radial-gradient(circle, rgba(143, 125, 255, 0.13), transparent 66%);
}
.focus-copy > span {
  color: #617586;
  font:
    8px/1 ui-monospace,
    SFMono-Regular,
    monospace;
  letter-spacing: 0.14em;
}
.focus-copy h1 {
  margin: 10px 0 5px;
  color: #f4f8fb;
  font-size: 22px;
  font-weight: 560;
  letter-spacing: -0.02em;
}
.focus-copy p {
  margin: 0;
  color: #718393;
  font-size: 9px;
}
.focus-value {
  position: absolute;
  top: 24px;
  right: 30px;
  display: grid;
  justify-items: end;
  gap: 3px;
}
.focus-value strong {
  color: #f4f8fb;
  font-size: 33px;
  font-weight: 350;
}
.focus-value small {
  color: #607283;
  font-size: 8px;
}
.focus-device {
  position: absolute;
  right: 94px;
  bottom: 58px;
  transform: scale(1.72);
  transform-origin: center;
  opacity: 0.48;
  filter: saturate(0.65);
}
.curtain-stage {
  position: absolute;
  top: 104px;
  right: 30px;
  bottom: 176px;
  left: 30px;
  min-height: 190px;
  overflow: hidden;
  background: linear-gradient(180deg, color-mix(in srgb, var(--selected) 70%, var(--card)), var(--card-soft)), var(--card-soft);
  border: 1px solid var(--line);
  border-radius: 26px;
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.62),
    inset 0 -30px 70px color-mix(in srgb, var(--text) 4%, transparent);
}
.curtain-window-view {
  position: absolute;
  inset: 20px 24px 28px;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.42), transparent 34%),
    linear-gradient(180deg, #cfeaff 0 52%, #e6eff1 52% 68%, #bdc8c6 68% 100%);
  border: 10px solid color-mix(in srgb, var(--card) 82%, #ccd6dc);
  border-radius: 12px 12px 5px 5px;
  box-shadow:
    0 18px 45px rgba(72, 104, 122, 0.1),
    inset 0 0 50px rgba(255, 255, 255, 0.58);
  opacity: var(--curtain-daylight);
  transition: opacity 420ms var(--ease-out);
}
.view-sun {
  position: absolute;
  top: 14%;
  right: 19%;
  width: 64px;
  height: 64px;
  background: rgba(255, 243, 191, 0.92);
  border-radius: 50%;
  box-shadow: 0 0 60px 20px rgba(255, 233, 156, 0.48);
}
.view-horizon {
  position: absolute;
  right: -5%;
  bottom: 18%;
  left: -5%;
  height: 28%;
  background:
    radial-gradient(ellipse at 15% 100%, #7f9c91 0 30%, transparent 31%),
    radial-gradient(ellipse at 48% 100%, #91aa9e 0 36%, transparent 37%),
    radial-gradient(ellipse at 82% 100%, #738f84 0 32%, transparent 33%);
  opacity: 0.55;
}
.view-building {
  position: absolute;
  bottom: 0;
  background: repeating-linear-gradient(90deg, transparent 0 13px, rgba(255, 255, 255, 0.52) 14px 18px), #aab8bb;
  border-radius: 3px 3px 0 0;
  opacity: 0.5;
}
.building-a {
  right: 8%;
  width: 20%;
  height: 34%;
}
.building-b {
  right: 31%;
  width: 14%;
  height: 22%;
}
.window-mullion {
  position: absolute;
  z-index: 2;
  background: color-mix(in srgb, var(--card) 86%, #ccd6dc);
  box-shadow: 0 2px 5px rgba(53, 71, 84, 0.1);
}
.window-mullion.vertical {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 8px;
  transform: translateX(-50%);
}
.window-mullion.horizontal {
  top: 56%;
  right: 0;
  left: 0;
  height: 7px;
}
.curtain-track {
  position: absolute;
  z-index: 7;
  top: 15px;
  right: 20px;
  left: 20px;
  height: 13px;
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding-inline: 6%;
  background: linear-gradient(180deg, #f9fbfc, #cdd6dc 58%, #b2bdc4);
  border: 1px solid rgba(97, 111, 120, 0.12);
  border-radius: 8px;
  box-shadow: 0 5px 12px rgba(60, 74, 84, 0.16);
}
.curtain-track i {
  width: 3px;
  height: 7px;
  background: #aebac1;
  border-radius: 2px;
}
.curtain-panel {
  position: absolute;
  z-index: 5;
  top: 25px;
  bottom: 24px;
  width: var(--curtain-panel-width);
  min-width: 8%;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.56), transparent 24%),
    repeating-linear-gradient(
      90deg,
      #eef3f5 0,
      #d4dde2 calc(var(--curtain-fold-size) * 0.42),
      #fafcfd calc(var(--curtain-fold-size) * 0.74),
      #c5d0d6 var(--curtain-fold-size)
    );
  box-shadow:
    inset 0 -22px 34px rgba(81, 101, 113, 0.13),
    8px 12px 25px rgba(48, 64, 75, 0.1);
  transition: width 480ms var(--ease-out);
}
.curtain-panel.left {
  left: 20px;
  border-radius: 7px 0 12px 9px;
}
.curtain-panel.right {
  right: 20px;
  border-radius: 0 7px 9px 12px;
}
.curtain-panel > i {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 10px;
  background: linear-gradient(90deg, rgba(123, 143, 154, 0.18), transparent);
}
.curtain-panel.left > i {
  right: 0;
}
.curtain-panel.right > i {
  left: 0;
  transform: scaleX(-1);
}
.curtain-stage-status {
  position: absolute;
  z-index: 9;
  bottom: 16px;
  left: 50%;
  min-width: 122px;
  height: 34px;
  display: grid;
  grid-template-columns: 7px 1fr auto;
  align-items: center;
  gap: 7px;
  padding: 0 12px;
  color: var(--text-soft);
  background: color-mix(in srgb, var(--card) 86%, transparent);
  border: 1px solid color-mix(in srgb, var(--line-strong) 70%, transparent);
  border-radius: 18px;
  box-shadow: 0 8px 24px rgba(44, 61, 72, 0.1);
  backdrop-filter: blur(12px);
  transform: translateX(-50%);
  font-size: 8px;
}
.curtain-stage-status i {
  width: 6px;
  height: 6px;
  background: var(--green);
  border-radius: 50%;
  box-shadow: 0 0 0 4px var(--green-soft);
}
.curtain-stage-status strong {
  color: var(--text);
  font-size: 9px;
  font-weight: 600;
}
.curtain-floor-shadow {
  position: absolute;
  z-index: 8;
  right: 8%;
  bottom: -14px;
  left: 8%;
  height: 30px;
  background: radial-gradient(ellipse, rgba(51, 67, 77, 0.16), transparent 68%);
  filter: blur(6px);
}
.curtain-control-dock {
  position: absolute;
  right: 30px;
  bottom: 24px;
  left: 30px;
  min-height: 126px;
  display: grid;
  grid-template-columns: minmax(280px, 1fr) auto;
  align-items: stretch;
  gap: 12px;
}
.curtain-position-control {
  min-width: 0;
  border-radius: 20px;
}
.curtain-control-dock .curtain-actions {
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(64px, 1fr));
  align-items: stretch;
  gap: 6px;
  margin: 0;
  padding: 6px;
  background: var(--card-soft);
  border-radius: 20px;
}
.curtain-control-dock .curtain-actions button {
  min-width: 68px;
  min-height: 52px;
  padding: 0 14px;
  border-radius: 15px;
}
.focus-control > input {
  width: calc(100% - 76px);
  margin-top: 52px;
  height: 44px;
  accent-color: var(--cyan);
  background: transparent;
}
.preset-row,
.curtain-actions,
.transport-row {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
}
.preset-row > span {
  margin-right: 5px;
  color: #607283;
  font-size: 9px;
}
.preset-row button,
.curtain-actions button,
.transport-row button {
  min-width: 64px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #7f91a1;
  background: rgba(255, 255, 255, 0.035);
  border-radius: 17px;
  font-size: 9px;
}
.preset-row button:disabled,
.curtain-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
.focus-swap-enter-active,
.focus-swap-leave-active {
  transition:
    opacity 180ms ease,
    transform 220ms cubic-bezier(0.2, 0.75, 0.25, 1);
}
.focus-swap-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.99);
}
.focus-swap-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.995);
}
.preset-row button:hover,
.preset-row button.selected,
.curtain-actions button.selected {
  color: #f4f8fb;
  background: rgba(53, 211, 255, 0.1);
}
.master-action {
  position: absolute;
  right: 28px;
  bottom: 27px;
  width: 50px;
  height: 50px;
  display: grid;
  place-items: center;
  color: #718393;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(150, 182, 207, 0.12);
  border-radius: 50%;
}
.master-action.active,
.play-action.active {
  color: #07111f;
  background: var(--cyan);
  border-color: var(--cyan);
}
.transport-row {
  justify-content: center;
}
.transport-row > span {
  min-width: 90px;
  display: flex;
  align-items: center;
  gap: 7px;
  color: #718393;
  font-size: 9px;
}
.transport-row .play-action {
  width: 46px;
  min-width: 46px;
  height: 46px;
  border-radius: 50%;
}
.home-brief {
  padding: 20px 18px;
}
.home-brief > header {
  display: flex;
  justify-content: space-between;
  padding-bottom: 14px;
  color: #dfe8ee;
  border-bottom: 1px solid rgba(150, 182, 207, 0.07);
  font-size: 11px;
}
.home-brief > header small {
  color: var(--green);
  font-size: 8px;
}
.brief-primary {
  min-height: 78px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--green);
  border-bottom: 1px solid rgba(150, 182, 207, 0.07);
}
.brief-primary.warning {
  color: var(--danger);
}
.brief-row.warning {
  color: var(--warning);
}
.brief-primary span,
.brief-row span {
  display: grid;
  gap: 4px;
}
.brief-primary strong,
.brief-row strong {
  color: #e9f0f5;
  font-size: 10px;
  font-weight: 550;
}
.brief-primary small,
.brief-row small {
  color: #607283;
  font-size: 8px;
}
.brief-row {
  min-height: 56px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: #758899;
  border-bottom: 1px solid rgba(150, 182, 207, 0.06);
}
.alert-summary {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 9px;
  padding: 0 10px;
  color: #d8a6ad;
  background: rgba(255, 113, 133, 0.06);
  border-radius: 6px;
  font-size: 8px;
  text-align: left;
}
.alert-summary > span {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.alert-summary b,
.alert-summary small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.alert-summary b {
  font-weight: 650;
}
.alert-summary small {
  color: var(--muted);
  font-size: 8px;
}
.secondary-alert-backdrop {
  position: fixed;
  z-index: 90;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(13, 18, 24, 0.42);
  backdrop-filter: blur(8px);
}
.bulk-confirm-backdrop {
  position: fixed;
  z-index: 95;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(13, 18, 24, 0.42);
  backdrop-filter: blur(8px);
}
.bulk-confirm-dialog {
  width: min(520px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 22px;
  color: var(--text);
  background: var(--card);
  border-radius: 24px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.24);
}
.bulk-confirm-dialog > header,
.bulk-confirm-dialog > footer,
.bulk-confirm-dialog > header span,
.bulk-confirm-dialog li,
.bulk-exclusion {
  display: flex;
  align-items: center;
}
.bulk-confirm-dialog > header {
  justify-content: space-between;
}
.bulk-confirm-dialog > header span {
  gap: 8px;
  color: var(--cyan);
  font-size: 12px;
  font-weight: 650;
}
.bulk-confirm-dialog > header button {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--control);
  border-radius: 50%;
}
.bulk-confirm-copy {
  padding: 12px 2px 16px;
}
.bulk-confirm-copy > span {
  color: var(--muted);
  font-size: 11px;
}
.bulk-confirm-copy h2 {
  margin: 7px 0 8px;
  font-size: 24px;
}
.bulk-confirm-copy p {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
  line-height: 1.6;
}
.bulk-confirm-dialog ul {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 10px;
  background: var(--card-soft);
  border-radius: 16px;
  list-style: none;
}
.bulk-confirm-dialog li {
  min-height: 36px;
  gap: 9px;
  padding: 0 8px;
  color: var(--text-soft);
  font-size: 11px;
}
.bulk-exclusion {
  gap: 7px;
  margin: 12px 2px 0;
  color: var(--warning-text);
  font-size: 11px;
}
.bulk-confirm-dialog > footer {
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}
.bulk-confirm-dialog > footer button {
  min-height: 46px;
  padding: 0 18px;
  border-radius: 14px;
  font-size: 11px;
  font-weight: 650;
}
.bulk-cancel {
  color: var(--text-soft);
  background: var(--control);
}
.bulk-confirm {
  color: #fff;
  background: var(--cyan);
}
.bulk-confirm:disabled {
  color: var(--muted);
  background: var(--control);
}
.secondary-alert-dialog {
  width: min(520px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 22px;
  color: var(--text);
  background: var(--card);
  border-radius: 24px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.24);
}
.secondary-alert-dialog > header,
.secondary-alert-dialog > footer,
.secondary-alert-dialog dl > div,
.alert-boundary {
  display: flex;
  align-items: center;
}
.secondary-alert-dialog > header {
  justify-content: space-between;
}
.alert-level {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--danger);
  font-size: 12px;
  font-weight: 650;
}
.secondary-alert-dialog > header button {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--control);
  border: 0;
  border-radius: 50%;
}
.alert-dialog-copy {
  padding: 12px 2px 18px;
}
.alert-dialog-copy > span {
  color: var(--muted);
  font-size: 10px;
}
.alert-dialog-copy h2 {
  margin: 7px 0 8px;
  font-size: 24px;
  line-height: 1.25;
}
.alert-dialog-copy p {
  margin: 0;
  color: var(--text-soft);
  font-size: 13px;
  line-height: 1.65;
}
.secondary-alert-dialog dl {
  margin: 0;
  padding: 4px 14px;
  background: var(--card-soft);
  border-radius: 16px;
}
.secondary-alert-dialog dl > div {
  min-height: 46px;
  justify-content: space-between;
  gap: 18px;
}
.secondary-alert-dialog dt {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 10px;
}
.secondary-alert-dialog dd {
  margin: 0;
  font-size: 11px;
  text-align: right;
}
.alert-boundary {
  gap: 8px;
  margin: 14px 2px 0;
  color: var(--warning-text);
  font-size: 10px;
  line-height: 1.5;
}
.alert-action-error {
  margin: 10px 2px 0;
  color: var(--danger);
  font-size: 10px;
}
.secondary-alert-dialog > footer {
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}
.secondary-alert-dialog > footer button {
  min-width: 112px;
  min-height: 46px;
  padding: 0 18px;
  border: 0;
  border-radius: 14px;
  font-size: 11px;
  font-weight: 600;
}
.alert-cancel {
  color: var(--text-soft);
  background: var(--control);
}
.alert-confirm {
  color: #fff;
  background: var(--danger);
}
.secondary-alert-dialog button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}
.alert-dialog-enter-active,
.alert-dialog-leave-active {
  transition: opacity 180ms ease;
}
.alert-dialog-enter-active .secondary-alert-dialog,
.alert-dialog-leave-active .secondary-alert-dialog {
  transition: transform 180ms var(--ease-out);
}
.alert-dialog-enter-from,
.alert-dialog-leave-to {
  opacity: 0;
}
.alert-dialog-enter-from .secondary-alert-dialog,
.alert-dialog-leave-to .secondary-alert-dialog {
  transform: translateY(10px) scale(0.98);
}
html[data-motion="off"] .alert-dialog-enter-active,
html[data-motion="off"] .alert-dialog-leave-active,
html[data-motion="off"] .alert-dialog-enter-active .secondary-alert-dialog,
html[data-motion="off"] .alert-dialog-leave-active .secondary-alert-dialog {
  transition: none;
}
.offline-lock {
  position: fixed;
  z-index: 30;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 13px;
  color: var(--gold);
  background: rgba(47, 34, 17, 0.96);
  border-radius: 8px;
  box-shadow: var(--shadow-float);
}
.offline-lock span {
  display: grid;
  gap: 2px;
}
.offline-lock strong {
  font-size: 10px;
}
.offline-lock small {
  color: #c9a36a;
  font-size: 8px;
}
.offline-lock > button {
  min-height: 30px;
  padding: 0 10px;
  color: var(--warning-text);
  background: color-mix(in srgb, var(--warning-card) 70%, var(--card));
  border: 0;
  border-radius: 9px;
  font-size: 9px;
  white-space: nowrap;
}
.readonly .control-deck,
.readonly .scene-rail {
  filter: saturate(0.5);
  opacity: 0.72;
}
@media (max-width: 1100px) {
  .secondary-workspace {
    padding-inline: 12px;
  }
  .control-deck {
    grid-template-columns: 156px minmax(370px, 1fr) 196px;
  }
  .home-title {
    min-width: 220px;
  }
  .scene-action {
    padding-inline: 10px;
  }
  .focus-control {
    padding-inline: 24px;
  }
}
@media (max-width: 820px) {
  .secondary-workspace {
    padding-inline: 10px;
  }
  .home-title {
    min-width: 170px;
  }
  .control-deck {
    grid-template-columns: 132px minmax(280px, 1fr) 174px;
    gap: 9px;
  }
  .device-switcher,
  .home-brief {
    min-width: 0;
  }
  .scene-action strong,
  .scene-action small,
  .device-switcher strong,
  .device-switcher small,
  .brief-row strong,
  .brief-row small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    word-break: keep-all;
  }
}
@media (max-height: 700px) and (min-height: 361px) {
  .curtain-stage {
    top: 86px;
    right: 22px;
    bottom: 110px;
    left: 22px;
    min-height: 118px;
    border-radius: 18px;
  }
  .curtain-window-view {
    inset: 13px 16px 18px;
    border-width: 6px;
  }
  .view-sun {
    width: 42px;
    height: 42px;
  }
  .curtain-track {
    top: 9px;
    right: 13px;
    left: 13px;
    height: 9px;
  }
  .curtain-panel {
    top: 16px;
    bottom: 14px;
  }
  .curtain-panel.left {
    left: 13px;
  }
  .curtain-panel.right {
    right: 13px;
  }
  .curtain-stage-status {
    bottom: 8px;
    height: 28px;
  }
  .curtain-control-dock {
    right: 22px;
    bottom: 11px;
    left: 22px;
    min-height: 82px;
    grid-template-columns: minmax(220px, 1fr) auto;
    gap: 8px;
  }
  .curtain-position-control {
    border-radius: 16px;
  }
  .curtain-control-dock .curtain-actions {
    border-radius: 16px;
  }
  .curtain-control-dock .curtain-actions button {
    min-width: 56px;
    min-height: 44px;
    padding-inline: 10px;
  }
}
@media (max-height: 540px) {
  .secondary-workspace {
    grid-template-rows: 48px 68px minmax(0, 1fr);
    gap: 7px;
    padding-block: 9px;
  }
  .device-switcher {
    padding-block: 10px;
  }
  .device-switcher button {
    min-height: 54px;
  }
  .focus-control {
    padding-top: 18px;
  }
  .focus-control > input {
    margin-top: 34px;
  }
  .focus-device {
    right: 62px;
    bottom: 34px;
    transform: scale(1.08);
  }
  .preset-row,
  .curtain-actions,
  .transport-row {
    margin-top: 11px;
  }
  .brief-primary {
    min-height: 60px;
  }
  .brief-row {
    min-height: 46px;
  }
}
@media (max-height: 360px) {
  .secondary-shell {
    min-height: 0;
  }
  .secondary-workspace {
    height: calc(100vh - 42px);
    grid-template-columns: 292px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    gap: 7px;
    padding: 7px 8px 8px;
  }
  .secondary-overview {
    display: none;
  }
  .scene-rail {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 30px 1fr 1fr;
    gap: 1px;
  }
  .rail-label {
    width: auto;
    grid-column: 1 / 3;
    display: flex;
    justify-content: flex-start;
    padding-left: 12px;
  }
  .scene-action {
    grid-template-columns: 22px 1fr;
    padding: 0 10px;
  }
  .scene-action > svg:last-child,
  .scene-action small {
    display: none;
  }
  .scene-action strong {
    font-size: 9px;
  }
  .control-deck {
    grid-template-columns: 146px minmax(0, 1fr);
  }
  .home-brief {
    display: none;
  }
  .device-switcher {
    padding: 8px;
  }
  .switcher-label {
    padding-bottom: 3px;
  }
  .device-switcher button {
    min-height: 50px;
  }
  .focus-control {
    padding: 14px 20px;
  }
  .focus-copy h1 {
    margin-top: 6px;
    font-size: 17px;
  }
  .focus-copy p {
    display: none;
  }
  .focus-value {
    top: 12px;
    right: 20px;
  }
  .focus-value strong {
    font-size: 25px;
  }
  .focus-control > input {
    margin-top: 24px;
  }
  .preset-row,
  .curtain-actions,
  .transport-row {
    min-height: 32px;
    margin-top: 7px;
  }
  .preset-row button,
  .curtain-actions button,
  .transport-row button {
    min-height: 32px;
  }
  .master-action {
    right: 18px;
    bottom: 14px;
    width: 42px;
    height: 42px;
  }
  .focus-device {
    display: none;
  }
  .curtain-stage {
    display: none;
  }
  .curtain-control-dock {
    top: 64px;
    right: 20px;
    bottom: 8px;
    left: 20px;
    min-height: 0;
    grid-template-columns: minmax(180px, 1fr) auto;
    align-items: end;
    gap: 7px;
  }
  .curtain-position-control {
    height: 74px;
    border-radius: 14px;
  }
  .curtain-control-dock .curtain-actions {
    height: 74px;
    padding: 4px;
    border-radius: 14px;
  }
  .curtain-control-dock .curtain-actions button {
    min-width: 52px;
    min-height: 44px;
    padding-inline: 8px;
  }
  .offline-lock {
    top: 44px;
  }
}
@keyframes secondary-scene-progress {
  0% {
    transform: scaleX(0.08);
    opacity: 0.45;
  }
  65% {
    transform: scaleX(0.86);
    opacity: 1;
  }
  100% {
    transform: scaleX(1);
    opacity: 0;
  }
}
@keyframes secondary-scene-pulse {
  50% {
    transform: scale(1.16);
    filter: drop-shadow(0 0 5px currentColor);
  }
}
</style>

<style scoped>
/* 家庭屏模式：米家浅色层级与大触控目标 */
.secondary-shell {
  background: var(--canvas);
}
.secondary-workspace {
  background: var(--canvas);
}
.secondary-overview {
  padding: 0 20px;
  background: transparent;
  border-bottom: 0;
}
.home-title strong,
.ambient-status strong {
  color: var(--text);
}
.home-title small,
.ambient-status span,
.all-off small {
  color: var(--muted);
}
.ambient-status {
  color: var(--text-soft);
}
.ambient-status i {
  background: var(--line);
}
.all-off {
  color: var(--text-soft);
  background: var(--card);
  border: 0;
  box-shadow: var(--shadow-control);
}
.all-off:hover {
  color: var(--cyan);
  background: var(--selected);
  border-color: transparent;
}
.scene-rail {
  gap: 10px;
  padding: 0;
  background: transparent;
  border-radius: 0;
  overflow: visible;
}
.rail-label {
  color: var(--text-soft);
  background: transparent;
  font-weight: 600;
}
.scene-action {
  color: var(--muted);
  background: var(--card);
  border-radius: 16px;
  box-shadow: var(--shadow-control);
}
.scene-action:hover {
  color: var(--cyan);
  background: var(--selected);
}
.scene-action strong {
  color: var(--text);
}
.scene-action small {
  color: var(--muted);
}
.scene-action.running,
.scene-action.completed {
  color: var(--scene-state);
  background: color-mix(in srgb, var(--scene-state) 10%, var(--card));
}
.scene-action.partial {
  color: var(--gold);
  background: color-mix(in srgb, var(--gold) 9%, var(--card));
}
.scene-action.failed {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 9%, var(--card));
}
.control-deck {
  gap: 12px;
  padding: 0;
  background: transparent;
  border-radius: 0;
  overflow: visible;
}
.device-switcher,
.focus-control,
.home-brief {
  background: var(--card);
  border-radius: 20px;
  box-shadow: var(--shadow-control);
}
.switcher-label {
  color: var(--muted);
}
.device-switcher button {
  color: var(--muted);
  border-radius: 14px;
}
.device-switcher button:hover {
  color: var(--text);
  background: var(--control);
}
.device-switcher button.active {
  color: var(--cyan);
  background: var(--selected);
}
.device-switcher strong {
  color: var(--text);
}
.device-switcher small {
  color: var(--muted);
}
.focus-control::before {
  right: -40px;
  top: -90px;
  background: radial-gradient(circle, rgba(50, 170, 255, 0.09), transparent 67%);
}
.light-focus::before {
  background: radial-gradient(circle, rgba(255, 203, 118, 0.18), transparent 67%);
}
.music-focus::before {
  background: radial-gradient(circle, rgba(129, 120, 245, 0.13), transparent 67%);
}
.focus-copy > span {
  color: var(--muted);
}
.focus-copy h1,
.focus-value strong {
  color: var(--text);
}
.focus-copy p,
.focus-value small,
.preset-row > span {
  color: var(--muted);
}
.focus-device {
  opacity: 0.64;
  filter: saturate(0.8) drop-shadow(0 12px 20px rgba(40, 47, 58, 0.08));
}
.preset-row button,
.curtain-actions button,
.transport-row button {
  color: var(--text-soft);
  background: var(--control);
}
.preset-row button:hover,
.preset-row button.selected,
.curtain-actions button.selected {
  color: var(--cyan);
  background: var(--selected);
}
.master-action {
  color: var(--muted);
  background: var(--control);
  border: 0;
}
.master-action.active,
.play-action.active {
  color: #fff;
  background: var(--cyan);
  border-color: transparent;
}
.transport-row > span {
  color: var(--muted);
}
.home-brief > header {
  color: var(--text);
  border-bottom: 1px solid var(--line);
}
.brief-primary,
.brief-row {
  border-bottom-color: var(--line);
}
.brief-primary strong,
.brief-row strong {
  color: var(--text);
}
.brief-primary small,
.brief-row small {
  color: var(--muted);
}
.brief-row {
  color: var(--muted);
}
.alert-summary {
  color: var(--danger);
  background: var(--danger-card);
  border-radius: 12px;
}
.offline-lock {
  color: var(--warning-text);
  background: color-mix(in srgb, var(--warning-card) 97%, transparent);
  border-radius: 14px;
}
.offline-lock small {
  color: var(--warning-text);
}
@media (max-height: 360px) {
  .scene-rail {
    gap: 7px;
  }
}

/* 终稿细节层：副屏只保留与控制有关的轨道，不以横线切割状态 */
.home-brief {
  padding: 16px 14px;
}
.home-brief > header {
  padding: 0 4px 10px;
  border-bottom: 0;
}
.brief-primary,
.brief-row {
  min-height: 62px;
  margin-top: 7px;
  padding: 10px 12px;
  background: var(--card-soft);
  border-bottom: 0;
  border-radius: 14px;
}
.brief-primary {
  min-height: 74px;
}
.alert-summary {
  margin-top: 8px;
  padding: 10px 12px;
}
.scene-action {
  border: 0;
}
.scene-action:hover {
  transform: translateY(-1px);
}
.device-switcher button,
.preset-row button,
.curtain-actions button,
.transport-row button {
  border: 0;
}
.device-switcher button.active,
.preset-row button.selected,
.curtain-actions button.selected {
  box-shadow: 0 5px 16px rgba(50, 170, 255, 0.08);
}

@media (max-height: 360px) {
  .brief-primary,
  .brief-row {
    margin-top: 4px;
  }
}

/* 工控触摸屏可读性：状态文案至少 11px，直接控制面至少 44px。 */
.home-title small,
.ambient-status span,
.all-off small,
.all-off strong,
.rail-label,
.scene-action small,
.switcher-label,
.device-switcher strong,
.device-switcher small,
.focus-copy > span,
.focus-copy p,
.focus-value small,
.preset-row > span,
.preset-row button,
.curtain-actions button,
.transport-row button,
.transport-row > span,
.home-brief > header,
.home-brief > header small,
.brief-primary strong,
.brief-row strong,
.brief-primary small,
.brief-row small,
.alert-summary {
  font-size: 11px;
}
.alert-summary small,
.offline-lock strong,
.offline-lock small,
.offline-lock > button {
  font-size: 11px;
}
.offline-lock > button {
  min-height: 44px;
}
.all-off {
  min-height: 44px;
  height: 44px;
}

@media (max-height: 360px) {
  .scene-action strong,
  .device-switcher strong,
  .focus-copy > span,
  .focus-value small,
  .preset-row > span,
  .preset-row button,
  .curtain-actions button,
  .transport-row button {
    font-size: 11px;
  }
  .preset-row,
  .curtain-actions,
  .transport-row,
  .preset-row button,
  .curtain-actions button,
  .transport-row button {
    min-height: 44px;
  }
  .master-action {
    width: 44px;
    height: 44px;
  }
}
</style>
