<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import type { Device, DeviceCapability, Scene, SceneAction } from "@smart-lab/contracts";
import {
  Activity,
  BellRing,
  Blinds,
  CircleAlert,
  Gauge,
  Music2,
  Play,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  SunMedium,
  TriangleAlert
} from "lucide-vue-next";
import SystemHeader from "../components/SystemHeader.vue";
import SideNav from "../components/SideNav.vue";
import DeviceGlyph from "../components/DeviceGlyph.vue";
import DeviceVisual from "../components/DeviceVisual.vue";
import ToastStack from "../components/ToastStack.vue";
import HomeOverview from "../components/HomeOverview.vue";
import type { SpatialActionNode } from "../components/SceneSpatialCore.vue";
import homeArt from "../assets/scenes/home.svg";
import awayArt from "../assets/scenes/away.svg";
import nightArt from "../assets/scenes/night.svg";
import movieArt from "../assets/scenes/movie.svg";
import { useEdgeStore } from "../stores/edge";
import { cachedSnapshotAgeLabel } from "../lib/snapshot-cache";

const MotionPreferenceControl = defineAsyncComponent(() => import("../components/MotionPreferenceControl.vue"));
const ScreenSaver = defineAsyncComponent(() => import("../components/ScreenSaver.vue"));
const SceneSpatialCore = defineAsyncComponent(() => import("../components/SceneSpatialCore.vue"));
const LightCapabilityPanel = defineAsyncComponent(() => import("../components/LightCapabilityPanel.vue"));
const ContinuousCapabilityControl = defineAsyncComponent(() => import("../components/ContinuousCapabilityControl.vue"));

const edge = useEdgeStore();
const activeSection = ref("home");
const selectedSceneId = ref("scene-home");
const selectedDeviceId = ref("");
const selectedRoom = ref("全部");
const deviceQuery = ref("");
const devicePage = ref(1);
const environmentFilter = ref<"all" | "attention">("all");
const alertAction = ref<Record<string, "pending" | "failed">>({});
const alertActionError = ref<Record<string, string>>({});
const snapshotRefreshing = ref(false);
const snapshotMessage = ref("");
const cacheAge = computed(() => (edge.cachedSnapshotAt ? cachedSnapshotAgeLabel(edge.cachedSnapshotAt) : undefined));
const DEVICE_PAGE_SIZE = 15;

const operationalDevices = computed(() =>
  edge.devices
    .filter((item) => item.kind !== "gateway" && item.display?.hidden !== true)
    .sort((left, right) => (left.display?.order ?? 0) - (right.display?.order ?? 0))
);
const favoriteDevices = computed(() => {
  const favorites = operationalDevices.value.filter((item) => item.display?.favorite === true);
  const remaining = operationalDevices.value.filter((item) => item.display?.favorite !== true);
  return [...favorites, ...remaining].slice(0, 6);
});
const visibleScenes = computed(() => edge.scenes);
const selectedScene = computed(() => visibleScenes.value.find((item) => item.id === selectedSceneId.value) ?? visibleScenes.value[0]);
const selectedDevice = computed(
  () => operationalDevices.value.find((item) => item.id === selectedDeviceId.value) ?? operationalDevices.value[0]
);
const rooms = computed(() => [...new Set(operationalDevices.value.map((item) => item.room))]);
const roomDevices = computed(() => {
  const roomFiltered =
    selectedRoom.value === "全部" ? operationalDevices.value : operationalDevices.value.filter((item) => item.room === selectedRoom.value);
  const query = deviceQuery.value.trim().toLowerCase();
  if (!query) return roomFiltered;
  return roomFiltered.filter((item) => `${item.name} ${item.room} ${item.integration.marketModel ?? ""}`.toLowerCase().includes(query));
});
const devicePageCount = computed(() => Math.ceil(roomDevices.value.length / DEVICE_PAGE_SIZE));
const pagedDevices = computed(() =>
  roomDevices.value.slice((devicePage.value - 1) * DEVICE_PAGE_SIZE, devicePage.value * DEVICE_PAGE_SIZE)
);

const sceneArt: Record<string, string> = {
  "scene-home": homeArt,
  "scene-away": awayArt,
  "scene-sleep": nightArt,
  "scene-movie": movieArt
};

function sceneArtwork(scene: Scene) {
  const identity = `${scene.id} ${scene.name}`.toLowerCase();
  if (sceneArt[scene.id]) return sceneArt[scene.id];
  if (identity.includes("away") || identity.includes("离家") || identity.includes("关闭")) return awayArt;
  if (identity.includes("movie") || identity.includes("观影") || identity.includes("影院")) return movieArt;
  if (identity.includes("sleep") || identity.includes("night") || identity.includes("夜间") || identity.includes("睡眠")) return nightArt;
  return homeArt;
}
const securityDevices = computed(() => operationalDevices.value.filter((item) => item.kind === "lock" || item.kind === "sensor"));
const offlineDevices = computed(() => edge.devices.filter((item) => item.health !== "online"));
const sensorDevices = computed(() => operationalDevices.value.filter((item) => item.kind === "sensor"));
const environmentDevices = computed(() =>
  sensorDevices.value.filter(
    (item) =>
      environmentFilter.value === "all" ||
      item.health !== "online" ||
      item.state.waterLeak === true ||
      item.state.contact === "open" ||
      item.state.motion === true
  )
);
const telemetryProperties = new Set(["powerConsumption", "energy", "electricPower", "voltage", "current"]);
const energyTelemetryDevices = computed(() =>
  operationalDevices.value.filter((device) => device.capabilities.some((capability) => telemetryProperties.has(capability.property)))
);
const poweredDevices = computed(() => operationalDevices.value.filter((device) => device.state.power === true));
const controllableLoadCount = computed(
  () =>
    operationalDevices.value.filter((device) =>
      device.capabilities.some((capability) => capability.property === "power" && capability.writable)
    ).length
);
const acknowledgedActiveAlertCount = computed(() => edge.activeAlerts.length - edge.unacknowledgedAlerts.length);
const criticalActiveAlert = computed(() => edge.activeAlerts.find((item) => item.level === "critical"));
const alertLifecycleSummary = computed(() => {
  const parts = [];
  if (edge.unacknowledgedAlerts.length) parts.push(`${edge.unacknowledgedAlerts.length} 待确认`);
  if (acknowledgedActiveAlertCount.value) parts.push(`${acknowledgedActiveAlertCount.value} 处理中`);
  return parts.length ? parts.join(" · ") : "无活动告警";
});

const linkedDevices = computed(() => {
  const ids = selectedScene.value?.actions.map((action) => action.deviceId) ?? [];
  return [...new Set(ids)].map((id) => edge.devices.find((item) => item.id === id)).filter(Boolean) as Device[];
});

const moduleTitle: Record<string, [string, string]> = {
  home: ["首页", "设备、场景与安防状态概览"],
  security: ["安防监控", "门锁、门窗与水浸安防节点"],
  environment: ["环境监测", "实训环境感知数据"],
  energy: ["能耗分析", "设备运行状态与遥测能力审计"],
  settings: ["系统设置", "网关、终端和本地服务状态"]
};

type SceneRunState = "running" | "completed" | "partial" | "failed" | "idle";

function latestExecution(sceneId: string) {
  return edge.snapshot?.executions.find((item) => item.sceneId === sceneId);
}

function sceneRunState(scene: Scene): SceneRunState {
  if (edge.requestingSceneIds[scene.id]) return "running";
  const execution = latestExecution(scene.id);
  if (!execution) return "idle";
  return execution.status === "running" ? "running" : execution.status;
}

const selectedRunState = computed(() => (selectedScene.value ? sceneRunState(selectedScene.value) : "idle"));
const selectedExecution = computed(() => (selectedScene.value ? latestExecution(selectedScene.value.id) : undefined));
const currentSceneExecution = computed(() => edge.snapshot?.executions[0]);
const selectedProgress = computed(() => {
  const execution = selectedExecution.value;
  if (!execution?.totalActions) return selectedRunState.value === "completed" ? 100 : 0;
  return Math.round((execution.completedActions / execution.totalActions) * 100);
});

function sceneCardState(scene: Scene): SceneRunState {
  return currentSceneExecution.value?.sceneId === scene.id ? sceneRunState(scene) : "idle";
}

function sceneCardText(scene: Scene) {
  if (edge.requestingSceneIds[scene.id]) return "正在发送请求";
  const active = edge.activeExecution;
  if (active && active.sceneId !== scene.id) {
    const source =
      active.source === "primary" ? "主屏" : active.source === "secondary" ? "副屏" : active.source === "admin" ? "后台" : "自动联动";
    const name = edge.scenes.find((item) => item.id === active.sceneId)?.name ?? "其他";
    return `${source}正在执行${name}`;
  }
  const execution = latestExecution(scene.id);
  if (!execution) return "点击查看详情";
  if (currentSceneExecution.value?.sceneId !== scene.id) return "上次已执行";
  if (execution.status === "running") return "执行中…";
  if (execution.status === "completed") return "当前生效";
  if (execution.status === "partial") return "部分完成";
  return "执行失败";
}

watch(
  () => edge.activeExecution?.sceneId,
  (sceneId) => {
    if (sceneId) {
      selectedSceneId.value = sceneId;
      // 任一终端启动场景时，主屏自动进入可观测的执行页，避免首页遮蔽进度或失败节点。
      activeSection.value = "scenes";
    }
  }
);

function selectSceneTab(scene: Scene) {
  selectedSceneId.value = scene.id;
}
function runScene(scene: Scene) {
  if (edge.connected && scene.enabled !== false && !edge.activeExecution && !Object.keys(edge.requestingSceneIds).length)
    void edge.executeScene(scene.id, "primary");
}

function runHomeScene(scene: Scene) {
  selectedSceneId.value = scene.id;
  runScene(scene);
}

function openHomeSection(section: "devices" | "security" | "scenes") {
  activeSection.value = section;
}

function selectRoom(room: string) {
  selectedRoom.value = room;
  devicePage.value = 1;
}
function clearDeviceFilters() {
  selectedRoom.value = "全部";
  deviceQuery.value = "";
  devicePage.value = 1;
}

function openDevice(device: Device) {
  selectedDeviceId.value = device.id;
  selectedRoom.value = "全部";
  devicePage.value = Math.max(1, Math.floor(operationalDevices.value.findIndex((item) => item.id === device.id) / DEVICE_PAGE_SIZE) + 1);
  activeSection.value = "devices";
}

async function acknowledgeAlert(alertId: string) {
  if (alertAction.value[alertId] === "pending") return;
  alertAction.value[alertId] = "pending";
  delete alertActionError.value[alertId];
  try {
    await edge.acknowledgeAlert(alertId);
  } catch (error) {
    alertAction.value[alertId] = "failed";
    alertActionError.value[alertId] = error instanceof Error ? error.message : "确认失败";
    return;
  }
  delete alertAction.value[alertId];
}

async function refreshAuthoritativeSnapshot() {
  if (snapshotRefreshing.value) return;
  snapshotRefreshing.value = true;
  snapshotMessage.value = "";
  try {
    const snapshot = await edge.refreshSnapshot();
    snapshotMessage.value = `已同步权威快照 · sequence ${snapshot.sequence}`;
  } catch (error) {
    snapshotMessage.value = `同步失败：${error instanceof Error ? error.message : "本地服务不可用"}`;
  } finally {
    snapshotRefreshing.value = false;
  }
}

function freshnessLabel(updatedAt: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(updatedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前更新`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前更新`;
  return new Date(updatedAt).toLocaleString("zh-CN");
}

function toggleDevice(device: Device) {
  if (canControl(device) && typeof device.state.power === "boolean") edge.sendCommand(device.id, "power", !device.state.power, "primary");
}

function canControl(device?: Device) {
  // degraded 表示能力/链路受限，服务端仍会按具体 capability 判定；只有明确离线才整体禁用。
  return Boolean(edge.connected && device && device.health !== "offline");
}

function setDeviceValue(device: Device, property: string, value: string | number | boolean) {
  if (canControl(device)) edge.sendCommand(device.id, property, value, "primary");
}

function hasPower(device: Device) {
  return device.capabilities.some((item) => item.property === "power" && item.type === "boolean" && item.writable);
}

function powerCap(device: Device) {
  return device.capabilities.find((item) => item.property === "power" && item.type === "boolean" && item.writable);
}

function mainNumberCap(device: Device) {
  return device.capabilities.find((item) => item.type === "number" && item.writable);
}

function extraNumberCaps(device: Device) {
  const main = mainNumberCap(device);
  return device.capabilities.filter((item) => item.type === "number" && item.writable && item !== main);
}

function enumCaps(device: Device) {
  return device.capabilities.filter((item) => item.type === "enum" && item.writable);
}

function readonlyCaps(device: Device) {
  return device.capabilities.filter((item) => item.type === "readonly");
}

function primaryState(device: Device) {
  if (device.kind === "light") return device.state.power ? `${device.state.brightness ?? 100}%` : "已关闭";
  if (device.kind === "cover") return `开合 ${device.state.position}%`;
  if (device.kind === "lock") return device.state.locked ? "已上锁" : "已解锁";
  if (device.kind === "media") return device.state.power ? `音量 ${device.state.volume}%` : "已关闭";
  if (device.kind === "switch") return device.state.power ? `${device.state.channels ?? 1} 路已开启` : "已关闭";
  if (device.kind === "panel") return device.state.voice === "ready" ? "语音服务就绪" : "屏幕在线";
  if ("waterLeak" in device.state) return device.state.waterLeak ? "检测到水浸" : "正常";
  if ("contact" in device.state) return device.state.contact === "closed" ? "已关闭" : "已打开";
  if ("motion" in device.state) return device.state.motion ? "有人移动" : "无人移动";
  return device.health === "online" ? "在线" : "离线";
}

function visibleDeviceState(device: Device) {
  const state = primaryState(device);
  return device.health === "offline" || edge.cachedSnapshotAt ? `上次 ${state}` : state;
}

function visibleHealth(health: Device["health"]) {
  const label = health === "online" ? "在线" : health === "degraded" ? "受限" : "离线";
  return edge.cachedSnapshotAt ? `上次${label}` : label;
}

function actionLiveState(action: SceneAction) {
  const device = edge.devices.find((item) => item.id === action.deviceId);
  if (!device) return "设备离线";
  const value = device.state[action.property];
  if (action.property === "power") return value ? "已开启" : "已关闭";
  if (action.property === "brightness" || action.property === "volume") return `${value}%`;
  if (action.property === "position") return `开合 ${value}%`;
  if (action.property === "colorTemperature") return `${value}K`;
  if (action.property === "motor") return value === "open" ? "打开中" : value === "close" ? "关闭中" : "已停止";
  return primaryState(device);
}

function actionAchieved(action: SceneAction) {
  const device = edge.devices.find((item) => item.id === action.deviceId);
  if (!device) return false;
  return String(device.state[action.property]) === String(action.value);
}

function actionCommandStatus(action: SceneAction) {
  const execution = selectedExecution.value;
  if (!execution) return actionAchieved(action) ? "confirmed" : "idle";
  const command = edge.snapshot?.commands.find((item) => item.requestId === `${execution.id}:${action.id}`);
  return command?.status ?? (actionAchieved(action) ? "confirmed" : "idle");
}

function actionCommandError(action: SceneAction) {
  const execution = selectedExecution.value;
  if (!execution) return "";
  return edge.snapshot?.commands.find((item) => item.requestId === `${execution.id}:${action.id}`)?.error ?? "";
}

const spatialActionNodes = computed<SpatialActionNode[]>(() =>
  (selectedScene.value?.actions ?? []).map((action) => {
    const device = edge.devices.find((item) => item.id === action.deviceId);
    return {
      id: action.id,
      deviceId: action.deviceId,
      label: action.label,
      property: action.property,
      status: selectedExecution.value ? actionCommandStatus(action) : "idle",
      offline: !device || device.health === "offline"
    };
  })
);

function deviceFeedback(device: Device) {
  if (edge.isDeviceRequesting(device.id)) return "pending";
  return edge.feedbackByDevice[device.id]?.status;
}

function propertyFeedback(device: Device, property: string) {
  if (edge.isPropertyRequesting(device.id, property)) return "pending";
  return edge.propertyFeedback(device.id, property)?.status;
}

function canControlProperty(device: Device | undefined, property: string) {
  return Boolean(canControl(device) && device && !edge.isPropertyPending(device.id, property));
}

function formatReadonly(device: Device, capability: DeviceCapability) {
  const value = device.state[capability.property];
  if (capability.property === "contact") return value === "closed" ? "已关闭" : "已打开";
  if (capability.property === "motion") return value ? "有人移动" : "无人移动";
  if (capability.property === "waterLeak") return value ? "检测到水浸" : "正常";
  if (capability.property === "locked") return value ? "已上锁" : "已解锁";
  if (typeof value === "boolean") return value ? "是" : "否";
  return `${value ?? "—"}${capability.unit ?? ""}`;
}

function actionIcon(property: string) {
  if (property === "position" || property === "motor") return Blinds;
  if (property === "volume") return Music2;
  if (property === "brightness" || property === "colorTemperature") return SunMedium;
  return Power;
}
</script>

<template>
  <main class="primary-shell">
    <SystemHeader />
    <div class="app-body">
      <SideNav
        :active="activeSection"
        :alert-count="edge.activeAlerts.length"
        :connected="edge.connected"
        @select="activeSection = $event"
      />

      <section v-if="activeSection === 'scenes'" key="scenes" class="dashboard scene-dashboard">
        <div class="dashboard-center">
          <article class="panel scene-library">
            <header class="scene-tabs">
              <button class="tab-main active">常用场景</button>
              <button
                v-for="scene in visibleScenes"
                :key="scene.id"
                class="tab-scene"
                :class="{ active: selectedScene?.id === scene.id }"
                @click="selectSceneTab(scene)"
              >
                {{ scene.name }}
              </button>
            </header>
            <div class="scene-grid">
              <button
                v-for="scene in visibleScenes"
                :key="scene.id"
                v-ripple
                class="scene-card pressable"
                :class="[
                  { selected: selectedScene?.id === scene.id, current: currentSceneExecution?.sceneId === scene.id },
                  sceneCardState(scene)
                ]"
                :disabled="
                  !edge.connected ||
                  scene.enabled === false ||
                  Boolean(edge.activeExecution) ||
                  Object.keys(edge.requestingSceneIds).length > 0
                "
                :aria-label="`查看${scene.name}模式详情，${sceneCardText(scene)}`"
                @click="selectSceneTab(scene)"
              >
                <img :src="sceneArtwork(scene)" alt="" />
                <span class="scene-shade" />
                <strong class="scene-name">{{ scene.name }}模式</strong>
                <span class="scene-state" :class="sceneCardState(scene)">{{ sceneCardText(scene) }}</span>
              </button>
            </div>
          </article>

          <article class="linkage-panel">
            <div class="linkage-heading">
              <div><span class="head-mark" /> <strong>场景联动</strong></div>
              <span class="head-note">当前场景将依次执行 {{ selectedScene?.actions.length ?? 0 }} 个动作</span>
            </div>
            <div class="linkage-grid">
              <article
                v-for="device in linkedDevices"
                :key="device.id"
                class="linkage-card command-surface"
                :class="deviceFeedback(device)"
              >
                <div class="link-icon">
                  <DeviceGlyph :kind="device.kind" :sensor-type="'waterLeak' in device.state ? 'waterLeak' : undefined" :size="24" />
                </div>
                <div class="link-copy">
                  <strong>{{ device.name }}</strong
                  ><small>{{ device.room }} · {{ primaryState(device) }}</small>
                </div>
                <button
                  v-if="hasPower(device)"
                  v-ripple
                  class="mini-switch"
                  :class="{ on: device.state.power }"
                  :aria-label="`${device.name} 电源`"
                  :disabled="!canControl(device)"
                  @click="toggleDevice(device)"
                >
                  <i />
                </button>
              </article>
            </div>
          </article>
        </div>

        <aside class="panel detail-panel scene-detail">
          <header class="detail-title">
            <span>场景详情：{{ selectedScene?.name }}模式</span>
            <button
              class="scene-run-button"
              :aria-label="`执行${selectedScene?.name}场景（${selectedScene?.actions.length ?? 0} 项动作）`"
              :disabled="
                !edge.connected ||
                selectedScene?.enabled === false ||
                Boolean(edge.activeExecution) ||
                Boolean(Object.keys(edge.requestingSceneIds).length)
              "
              @click="selectedScene && runScene(selectedScene)"
            >
              <Play :size="15" />执行 {{ selectedScene?.actions.length ?? 0 }} 项动作
            </button>
          </header>
          <div class="scene-hero">
            <SceneSpatialCore
              :scene-id="selectedScene?.id ?? 'scene-home'"
              :scene-name="selectedScene?.name ?? '全屋'"
              :state="selectedRunState"
              :progress="selectedProgress"
              :completed="selectedExecution?.completedActions ?? 0"
              :total="selectedExecution?.totalActions ?? selectedScene?.actions.length ?? 0"
              :source="selectedExecution?.source"
              :nodes="spatialActionNodes"
            />
          </div>
          <div class="action-area">
            <header>
              <strong>执行动作（{{ selectedScene?.actions.length ?? 0 }}）</strong>
            </header>
            <div class="action-grid">
              <article
                v-for="action in selectedScene?.actions"
                :key="action.id"
                class="scene-action-node"
                :class="actionCommandStatus(action)"
              >
                <component :is="actionIcon(action.property)" :size="21" />
                <div>
                  <strong>{{ action.label }}</strong
                  ><small :class="{ achieved: actionAchieved(action), error: actionCommandError(action) }">{{
                    actionCommandError(action) || actionLiveState(action)
                  }}</small>
                </div>
              </article>
            </div>
          </div>
        </aside>
      </section>

      <section v-else-if="activeSection === 'devices'" key="devices" class="dashboard device-dashboard">
        <div class="panel device-library">
          <header class="scene-tabs device-tabs">
            <button class="tab-main" :class="{ active: selectedRoom === '全部' }" @click="selectRoom('全部')">全部设备</button>
            <button
              v-for="room in rooms"
              :key="room"
              class="tab-scene"
              :class="{ active: selectedRoom === room }"
              @click="selectRoom(room)"
            >
              {{ room }}
            </button>
            <span class="device-count">{{ roomDevices.length }} 个设备</span>
            <label class="device-search"
              ><Search :size="14" /><input v-model="deviceQuery" type="search" placeholder="搜索设备 / 型号" @input="devicePage = 1"
            /></label>
          </header>
          <div class="device-grid">
            <article
              v-for="device in pagedDevices"
              :key="device.id"
              v-memo="[
                device.updatedAt,
                device.health,
                selectedDevice?.id === device.id,
                edge.feedbackByDevice[device.id]?.id,
                edge.feedbackByDevice[device.id]?.status,
                edge.isDeviceRequesting(device.id),
                edge.cachedSnapshotAt
              ]"
              v-ripple
              class="device-card pressable command-surface"
              :class="[{ selected: selectedDevice?.id === device.id, offline: device.health === 'offline' }, deviceFeedback(device)]"
              role="button"
              tabindex="0"
              @click="selectedDeviceId = device.id"
              @keydown.enter="selectedDeviceId = device.id"
              @keydown.space.prevent="selectedDeviceId = device.id"
            >
              <span class="device-product"><DeviceVisual :device="device" compact /></span>
              <span class="device-copy">
                <strong>{{ device.name }}</strong>
                <small>{{ device.room }}</small>
                <small class="state" :class="{ on: device.state.power === true && device.health !== 'offline' }">{{
                  visibleDeviceState(device)
                }}</small>
              </span>
              <button
                v-if="hasPower(device)"
                v-ripple
                class="power-dot"
                :aria-label="`${device.name} 电源`"
                :disabled="!canControlProperty(device, 'power')"
                :class="[propertyFeedback(device, 'power'), { on: device.state.power }]"
                @click.stop="toggleDevice(device)"
              >
                <Power :size="14" />
              </button>
            </article>
            <div v-if="!pagedDevices.length" class="device-empty">
              <Search :size="24" />
              <strong>没有找到匹配设备</strong>
              <small>当前房间或搜索词过滤了全部结果</small>
              <button @click="clearDeviceFilters">清除筛选</button>
            </div>
          </div>
          <footer v-if="devicePageCount > 1" class="pager">
            <button v-for="page in devicePageCount" :key="page" :class="{ active: devicePage === page }" @click="devicePage = page">
              {{ page }}
            </button>
          </footer>
        </div>

        <aside v-if="selectedDevice" class="panel detail-panel device-detail">
          <header class="device-detail-head">
            <strong>{{ selectedDevice.name }}</strong>
            <span class="online" :class="{ off: selectedDevice.health !== 'online' }"><i />{{ visibleHealth(selectedDevice.health) }}</span>
          </header>
          <p v-if="edge.cachedSnapshotAt" class="last-known-note">离线缓存，数值为上次同步状态，控制已锁定</p>
          <p v-else-if="selectedDevice.health === 'offline'" class="last-known-note">设备离线，数值为最后已知状态</p>
          <LightCapabilityPanel v-if="selectedDevice.kind === 'light'" :device="selectedDevice" source="primary" compact />
          <template v-else>
            <div class="device-hero">
              <div class="device-orbit command-surface" :class="deviceFeedback(selectedDevice)">
                <DeviceVisual :device="selectedDevice" />
              </div>
              <div class="device-model">
                <span>{{ selectedDevice.integration.marketModel ?? "型号待读取" }}</span
                ><small>{{ selectedDevice.integration.protocol.toUpperCase() }} · {{ selectedDevice.room }}</small>
              </div>
            </div>

            <ContinuousCapabilityControl
              v-if="mainNumberCap(selectedDevice)"
              :key="`${selectedDevice.id}.${mainNumberCap(selectedDevice)!.property}`"
              :device="selectedDevice"
              :capability="mainNumberCap(selectedDevice)!"
              source="primary"
              prominent
            />
            <div v-else class="value-static">
              <strong>{{ primaryState(selectedDevice) }}</strong>
            </div>

            <div class="mode-area">
              <div
                v-for="capability in enumCaps(selectedDevice)"
                :key="capability.property"
                class="mode-group command-surface"
                :class="propertyFeedback(selectedDevice, capability.property)"
              >
                <span class="mode-label">{{ capability.label }}</span>
                <div class="mode-options">
                  <button
                    v-for="option in capability.options"
                    :key="String(option.value)"
                    :class="{ active: selectedDevice.state[capability.property] === option.value }"
                    :disabled="!canControlProperty(selectedDevice, capability.property)"
                    @click="setDeviceValue(selectedDevice, capability.property, option.value)"
                  >
                    <component :is="actionIcon(capability.property)" :size="16" />{{ option.label }}
                  </button>
                </div>
              </div>
              <ContinuousCapabilityControl
                v-for="capability in extraNumberCaps(selectedDevice)"
                :key="`${selectedDevice.id}.${capability.property}`"
                :device="selectedDevice"
                :capability="capability"
                source="primary"
              />
              <div v-for="capability in readonlyCaps(selectedDevice)" :key="capability.property" class="mode-readonly">
                <span class="mode-label">{{ capability.label }}</span>
                <strong>{{ formatReadonly(selectedDevice, capability) }}</strong>
              </div>
            </div>

            <button
              v-if="powerCap(selectedDevice)"
              v-ripple
              class="power-button command-surface"
              :class="[{ on: selectedDevice.state.power }, propertyFeedback(selectedDevice, 'power')]"
              :disabled="!canControlProperty(selectedDevice, 'power')"
              @click="toggleDevice(selectedDevice)"
            >
              <Power :size="17" /> 开关
            </button>
          </template>
        </aside>
      </section>

      <section v-else-if="activeSection === 'security'" key="security" class="dashboard module-dashboard">
        <article class="panel module-panel security-module">
          <header>
            <div>
              <span class="eyebrow">安防状态</span>
              <h1>安防监控</h1>
              <p>门锁、人体、门磁与水浸节点实时状态</p>
            </div>
            <ShieldCheck :size="34" />
          </header>
          <div class="security-layout">
            <div class="security-devices">
              <article
                v-for="device in securityDevices"
                :key="device.id"
                :class="{ alarm: device.state.waterLeak === true || device.health === 'offline' }"
                role="button"
                tabindex="0"
                :aria-label="`查看${device.name}设备详情`"
                @click="openDevice(device)"
                @keydown.enter="openDevice(device)"
                @keydown.space.prevent="openDevice(device)"
              >
                <DeviceGlyph :kind="device.kind" :sensor-type="'waterLeak' in device.state ? 'waterLeak' : undefined" :size="26" />
                <div>
                  <strong>{{ device.name }}</strong
                  ><small>{{ device.room }} · {{ primaryState(device) }}</small>
                </div>
                <span>{{ visibleHealth(device.health) }}</span>
              </article>
            </div>
            <div class="alert-history">
              <header>
                <strong>告警记录</strong><span>{{ alertLifecycleSummary }}</span>
              </header>
              <article v-for="alert in edge.alerts" :key="alert.id">
                <CircleAlert :size="18" />
                <div>
                  <strong>{{ alert.title }}</strong
                  ><small>{{ alert.message }} · {{ new Date(alert.occurredAt).toLocaleString("zh-CN") }}</small>
                </div>
                <button v-if="!alert.acknowledgedAt" :disabled="alertAction[alert.id] === 'pending'" @click="acknowledgeAlert(alert.id)">
                  {{ alertAction[alert.id] === "pending" ? "确认中…" : alertAction[alert.id] === "failed" ? "重试" : "确认" }}</button
                ><span v-else>{{ alert.recoveredAt ? "已恢复" : "处理中" }}</span>
                <small v-if="alertActionError[alert.id]" class="alert-action-error">{{ alertActionError[alert.id] }}</small>
              </article>
              <p v-if="!edge.alerts.length">当前无告警记录</p>
            </div>
          </div>
        </article>
      </section>

      <section v-else-if="activeSection === 'settings'" key="settings" class="dashboard module-dashboard">
        <article class="panel module-panel status-module">
          <header>
            <div>
              <span class="eyebrow">本地服务</span>
              <h1>网关与终端状态</h1>
              <p>状态过期、离线节点与事件流恢复</p>
            </div>
            <button class="module-header-action" :disabled="snapshotRefreshing" @click="refreshAuthoritativeSnapshot">
              <RefreshCw :size="18" :class="{ spinning: snapshotRefreshing }" />{{ snapshotRefreshing ? "同步中" : "同步快照" }}
            </button>
          </header>
          <div v-if="snapshotMessage" class="snapshot-message" :class="{ bad: snapshotMessage.startsWith('同步失败') }">
            {{ snapshotMessage }}
          </div>
          <div v-if="edge.recoveringSequence || edge.staleSince" class="stale-banner">
            <TriangleAlert :size="17" />{{
              edge.cachedSnapshotAt ? `离线缓存 · ${cacheAge}的状态，仅供查看，控制已锁定` : "状态已过期，正在从权威快照恢复…"
            }}
          </div>
          <div class="status-grid">
            <article>
              <small>实时事件流</small
              ><strong :class="edge.connected ? 'good' : 'bad'">{{
                edge.connected ? "已连接" : edge.retryInSeconds ? `${edge.retryInSeconds} 秒后重试` : "正在连接"
              }}</strong
              ><span>{{ edge.cachedSnapshotAt ? `只读缓存 · ${cacheAge}` : `sequence ${edge.snapshot?.sequence ?? 0}` }}</span>
              <small v-if="!edge.connected" class="connection-detail">{{ edge.connectionIssue?.detail ?? "正在恢复实时状态" }}</small>
              <button v-if="!edge.connected" class="status-retry" :disabled="!edge.networkOnline" @click="edge.reconnectNow">
                {{ edge.networkOnline ? "立即重连" : "等待网络恢复" }}
              </button>
            </article>
            <article v-for="gateway in edge.health?.gateways" :key="gateway.id">
              <small>{{ gateway.model }}</small
              ><strong :class="gateway.status === 'online' ? 'good' : 'bad'">{{ gateway.status === "online" ? "在线" : "离线" }}</strong
              ><span>{{ gateway.name }} · {{ gateway.latencyMs }}ms</span>
            </article>
          </div>
          <section class="display-preferences">
            <div class="preference-heading"><span class="eyebrow">显示偏好</span><strong>触控与动效</strong></div>
            <MotionPreferenceControl />
          </section>
          <div class="offline-list">
            <header>
              <strong>异常节点</strong><span>{{ offlineDevices.length }} 个</span>
            </header>
            <article
              v-for="device in offlineDevices"
              :key="device.id"
              role="button"
              tabindex="0"
              @click="openDevice(device)"
              @keydown.enter="openDevice(device)"
              @keydown.space.prevent="openDevice(device)"
            >
              <DeviceGlyph :kind="device.kind" />
              <div>
                <strong>{{ device.name }}</strong
                ><small>{{ device.room }} · 更新于 {{ new Date(device.updatedAt).toLocaleString("zh-CN") }}</small>
              </div>
              <span>{{ device.health }}</span>
            </article>
            <p v-if="!offlineDevices.length">全部节点在线</p>
          </div>
        </article>
      </section>

      <section v-else-if="activeSection === 'environment'" key="environment" class="dashboard module-dashboard">
        <article class="panel module-panel capability-module">
          <header>
            <div>
              <span class="eyebrow">实时环境</span>
              <h1>{{ moduleTitle.environment?.[0] }}</h1>
              <p>采购能力范围内的人体、门磁与水浸瞬时状态</p>
            </div>
            <SunMedium :size="34" />
          </header>
          <div class="module-toolbar" role="group" aria-label="环境状态筛选">
            <button :class="{ active: environmentFilter === 'all' }" @click="environmentFilter = 'all'">
              全部 {{ sensorDevices.length }}
            </button>
            <button :class="{ active: environmentFilter === 'attention' }" @click="environmentFilter = 'attention'">需关注</button>
          </div>
          <div class="live-readings">
            <article
              v-for="device in environmentDevices"
              :key="device.id"
              role="button"
              tabindex="0"
              @click="openDevice(device)"
              @keydown.enter="openDevice(device)"
              @keydown.space.prevent="openDevice(device)"
            >
              <DeviceGlyph :kind="device.kind" :sensor-type="'waterLeak' in device.state ? 'waterLeak' : undefined" />
              <div>
                <strong>{{ device.name }}</strong
                ><small>{{ primaryState(device) }} · {{ freshnessLabel(device.updatedAt) }}</small>
              </div>
              <span>{{ device.health === "online" ? "在线" : "异常" }}</span>
            </article>
            <p v-if="!environmentDevices.length" class="module-empty">当前没有需要关注的环境节点</p>
          </div>
          <div class="capability-gate">
            <TriangleAlert :size="22" />
            <div>
              <strong>温湿度与历史趋势尚无可信数据源</strong>
              <p>采购清单没有温湿度传感器；接入真实采样并由 EdgeCore 持久化之前，不生成温度读数或趋势曲线。</p>
            </div>
          </div>
        </article>
      </section>

      <section v-else-if="activeSection === 'energy'" key="energy" class="dashboard module-dashboard">
        <article class="panel module-panel capability-module energy-module">
          <header>
            <div>
              <span class="eyebrow">能力审计</span>
              <h1>能耗分析</h1>
              <p>区分真实开关状态与功率、电量遥测能力</p>
            </div>
            <Gauge :size="34" />
          </header>
          <div class="energy-summary">
            <article>
              <Activity :size="21" /><small>当前开启负载</small><strong>{{ poweredDevices.length }}</strong
              ><span>来自设备 power 状态</span>
            </article>
            <article>
              <Power :size="21" /><small>可控负载</small><strong>{{ controllableLoadCount }}</strong
              ><span>支持真实开关命令</span>
            </article>
            <article :class="{ unavailable: !energyTelemetryDevices.length }">
              <Gauge :size="21" /><small>能耗遥测设备</small><strong>{{ energyTelemetryDevices.length }}</strong
              ><span>功率 / 电量 capability</span>
            </article>
          </div>
          <div class="energy-live-list">
            <header><strong>当前运行负载</strong><span>不等同于耗电量</span></header>
            <button v-for="device in poweredDevices" :key="device.id" @click="openDevice(device)">
              <DeviceGlyph :kind="device.kind" :size="22" /><span
                ><strong>{{ device.name }}</strong
                ><small>{{ device.room }} · {{ primaryState(device) }}</small></span
              ><b>查看设备</b>
            </button>
            <p v-if="!poweredDevices.length">当前没有开启的可观测负载</p>
          </div>
          <div class="capability-gate">
            <TriangleAlert :size="22" />
            <div>
              <strong>{{ energyTelemetryDevices.length ? "仅统计已声明遥测能力的设备" : "当前采购设备未声明功率或电量遥测能力" }}</strong>
              <p>因此不能计算 W、kWh、费用或节能趋势；补充具备遥测能力的硬件并完成实机验证后，才能形成可信统计。</p>
            </div>
          </div>
        </article>
      </section>

      <section v-else :key="activeSection" class="dashboard overview-dashboard">
        <HomeOverview
          :devices="favoriteDevices"
          :scenes="visibleScenes"
          :online-count="edge.onlineCount"
          :total-device-count="operationalDevices.length"
          :powered-count="poweredDevices.length"
          :alert-count="edge.activeAlerts.length"
          :alert-summary="alertLifecycleSummary"
          :connected="edge.connected"
          :cached="Boolean(edge.cachedSnapshotAt)"
          :active-scene-id="edge.activeExecution?.sceneId"
          :scene-busy="Boolean(edge.activeExecution) || Boolean(Object.keys(edge.requestingSceneIds).length)"
          @open-device="openDevice"
          @run-scene="runHomeScene"
          @open-section="openHomeSection"
        />
      </section>
    </div>

    <div v-if="criticalActiveAlert" class="critical-strip">
      <BellRing :size="17" />{{
        criticalActiveAlert.acknowledgedAt ? "紧急告警已确认，等待设备恢复" : "检测到紧急告警，请进入安防监控确认"
      }}
    </div>
    <ToastStack />
    <ScreenSaver />
  </main>
</template>

<style scoped>
.primary-shell {
  width: 100vw;
  height: 100vh;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.app-body {
  height: calc(100vh - 64px);
  display: flex;
  min-width: 0;
  min-height: 0;
}
.device-card:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--cyan) 65%, #fff);
  outline-offset: -2px;
}
button:disabled {
  cursor: not-allowed;
  filter: saturate(0.5);
  opacity: 0.5;
}
.dashboard {
  min-width: 0;
  flex: 1;
  padding: 13px;
}
.scene-dashboard {
  display: grid;
  grid-template-columns: minmax(650px, 1fr) 400px;
  gap: 13px;
}
.dashboard-center {
  min-width: 0;
  display: grid;
  grid-template-rows: minmax(320px, 1.08fr) minmax(240px, 0.92fr);
  gap: 13px;
}

/* 顶部 tab 行（参考图：首个粗白大字，其余细字，选中蓝色下划线） */
.scene-tabs {
  height: 54px;
  display: flex;
  align-items: center;
  gap: 26px;
  padding: 0 18px;
  background: linear-gradient(180deg, rgba(12, 56, 100, 0.16), transparent);
  box-shadow: 0 16px 28px rgba(0, 8, 26, 0.12);
}
.scene-tabs button {
  position: relative;
  height: 100%;
  padding: 0 2px;
  background: transparent;
}
.tab-main {
  color: #fff;
  font-size: 15px;
  font-weight: 600;
}
.tab-main:not(.active) {
  color: #9dc3e8;
  font-weight: 500;
}
.tab-scene {
  color: #7ea6cc;
  font-size: 13px;
}
.tab-scene.active {
  color: #fff;
}
.tab-scene.active::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 9px;
  height: 2px;
  background: var(--cyan);
  border-radius: 2px;
  box-shadow: 0 0 8px var(--cyan);
}

.panel-head {
  min-height: 50px;
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 18px;
  background: linear-gradient(180deg, rgba(12, 56, 100, 0.17), transparent);
  box-shadow: 0 14px 25px rgba(0, 7, 24, 0.13);
}
.panel-head > div {
  display: flex;
  align-items: center;
  gap: 9px;
}
.panel-head strong {
  font-size: 14px;
  font-weight: 500;
}
.head-mark {
  width: 3px;
  height: 15px;
  background: var(--cyan);
  border-radius: 2px;
  box-shadow: 0 0 10px var(--cyan);
}
.head-note {
  margin-left: auto;
  color: #5e87ad;
  font-size: 9px;
}

/* 场景影像卡 */
.scene-library {
  overflow: hidden;
}
.scene-grid {
  height: calc(100% - 54px);
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  padding: 15px 18px;
}
.scene-card {
  position: relative;
  min-width: 0;
  overflow: hidden;
  padding: 0;
  color: #fff;
  background: #071c37;
  border: 1px solid transparent;
  border-radius: 9px;
  box-shadow:
    0 16px 30px rgba(0, 3, 15, 0.32),
    inset 0 1px rgba(255, 255, 255, 0.035);
  text-align: left;
}
.scene-card img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  transition: transform 300ms var(--ease-out);
}
.scene-card:hover img {
  transform: scale(1.035);
}
.scene-shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(1, 11, 27, 0.42), rgba(1, 10, 26, 0.06) 38%, rgba(1, 9, 23, 0.94));
}
.scene-card.selected {
  border-color: rgba(24, 201, 255, 0.62);
  box-shadow:
    0 20px 38px rgba(0, 4, 18, 0.42),
    0 0 22px rgba(24, 201, 255, 0.13),
    inset 0 0 0 1px rgba(24, 201, 255, 0.12);
}
.scene-card.running::after {
  content: "";
  position: absolute;
  z-index: 3;
  left: -40%;
  right: 60%;
  bottom: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--cyan), #fff, transparent);
  box-shadow: 0 0 12px var(--cyan);
  animation: scene-scan 1.1s ease-in-out infinite;
}
.scene-name {
  position: absolute;
  z-index: 2;
  top: 13px;
  left: 14px;
  font-size: 15px;
  font-weight: 600;
  text-shadow: 0 1px 8px rgba(0, 5, 15, 0.85);
}
.scene-state {
  position: absolute;
  z-index: 2;
  left: 14px;
  bottom: 12px;
  font-size: 11px;
  color: #b8d2ea;
  text-shadow: 0 1px 6px rgba(0, 5, 15, 0.85);
}
.scene-state.completed {
  color: var(--green);
}
.scene-state.running,
.scene-state.partial {
  color: var(--gold);
}
.scene-state.failed {
  color: var(--danger);
}

/* 场景联动 */
.linkage-panel {
  overflow: hidden;
}
.linkage-grid {
  height: calc(100% - 50px);
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  grid-auto-rows: 108px;
  align-content: start;
  gap: 12px;
  padding: 20px 18px 14px;
}
.linkage-card {
  position: relative;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 14px;
  background: linear-gradient(145deg, rgba(15, 64, 113, 0.72), rgba(5, 29, 58, 0.94));
  border: 0;
  border-radius: 10px;
  box-shadow: var(--shadow-control);
  animation: none;
}
.link-icon {
  flex: none;
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  color: var(--cyan);
  background: radial-gradient(circle at 35% 25%, rgba(31, 145, 234, 0.23), rgba(8, 64, 116, 0.28));
  border: 0;
  border-radius: 50%;
  box-shadow:
    inset 0 1px rgba(179, 224, 255, 0.08),
    0 8px 18px rgba(0, 6, 21, 0.28);
}
.link-copy {
  min-width: 0;
  display: grid;
  gap: 5px;
  padding-right: 40px;
}
.link-copy strong {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.link-copy small {
  color: #6c95bb;
  font-size: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mini-switch {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 44px;
  height: 44px;
  padding: 14px 7px;
  background: transparent;
  border-radius: 9px;
}
.mini-switch i {
  display: block;
  position: relative;
  width: 30px;
  height: 15px;
  background: #173a5d;
  border-radius: 9px;
  transition: background 160ms ease;
}
.mini-switch i::after {
  content: "";
  position: absolute;
  left: 2px;
  top: 2px;
  width: 11px;
  height: 11px;
  background: #6b8ead;
  border-radius: 50%;
  transition:
    transform 160ms ease,
    background 160ms ease;
}
.mini-switch.on i {
  background: var(--blue);
  box-shadow: 0 0 8px rgba(22, 136, 255, 0.4);
}
.mini-switch.on i::after {
  transform: translateX(15px);
  background: #fff;
}

/* 右侧详情面板 */
.detail-panel {
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.detail-title {
  padding: 17px 20px 0;
  font-size: 15px;
  font-weight: 600;
}
.scene-hero {
  position: relative;
  display: grid;
  justify-items: center;
  padding: 0;
  overflow: hidden;
  box-shadow: 0 18px 32px rgba(0, 7, 24, 0.12);
}
.action-area {
  padding: 16px 20px;
}
.action-area > header {
  margin-bottom: 12px;
}
.action-area > header strong {
  font-size: 13px;
  font-weight: 600;
}
.action-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 9px;
}
.action-grid article {
  min-width: 0;
  display: grid;
  grid-template-columns: 34px 1fr;
  align-items: center;
  gap: 8px;
  padding: 11px 10px;
  color: var(--cyan);
  background: linear-gradient(145deg, rgba(20, 83, 145, 0.34), rgba(6, 38, 75, 0.42));
  border: 0;
  border-radius: 9px;
  box-shadow:
    0 10px 22px rgba(0, 4, 18, 0.24),
    inset 0 1px rgba(179, 224, 255, 0.025);
}
.scene-action-node {
  position: relative;
  overflow: hidden;
  transition:
    transform 220ms var(--ease-out),
    color 220ms ease,
    background 220ms ease;
}
.scene-action-node.pending {
  color: var(--cyan);
  background: linear-gradient(145deg, rgba(20, 98, 170, 0.48), rgba(6, 42, 82, 0.45));
}
.scene-action-node.pending::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 30%, rgba(62, 204, 255, 0.16), transparent 70%);
  transform: translateX(-100%);
  animation: energy-pass 0.8s ease-in-out infinite;
}
.scene-action-node.confirmed {
  color: var(--green);
}
.scene-action-node.failed,
.scene-action-node.timeout {
  color: var(--danger);
  animation: command-shake 320ms ease-out;
}
.action-grid article > div {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.action-grid strong {
  color: #dcefff;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.action-grid small {
  color: #557fa5;
  font-size: 9px;
}
.action-grid small.achieved {
  color: var(--green);
}
.action-grid small.error {
  color: var(--danger);
}

/* 设备矩阵 */
.device-dashboard {
  display: grid;
  grid-template-columns: minmax(650px, 1fr) 400px;
  gap: 13px;
}
.device-library {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.device-tabs {
  gap: 24px;
}
.device-count {
  margin-left: auto;
  color: #668fb5;
  font-size: 9px;
}
.device-search {
  width: 190px;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 9px;
  color: #668fb5;
  background: rgba(2, 20, 42, 0.48);
  border-radius: 7px;
}
.device-search input {
  width: 100%;
  height: 100%;
  padding: 0;
  color: #cfe7f8;
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 9px;
}
.device-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  grid-auto-rows: minmax(132px, 1fr);
  align-content: stretch;
  align-content: start;
  gap: 12px;
  padding: 15px 18px;
  scrollbar-width: thin;
  scrollbar-color: var(--line-strong) transparent;
}
.device-empty {
  grid-column: 1 / -1;
  min-height: 220px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: #668fb5;
  text-align: center;
}
.device-empty strong {
  color: #cfe7f8;
  font-size: 13px;
}
.device-empty small {
  font-size: 9px;
}
.device-empty button {
  min-height: 38px;
  margin-top: 4px;
  padding: 0 16px;
  color: #9ee8ff;
  background: rgba(24, 201, 255, 0.12);
  border-radius: 10px;
}
.device-card {
  position: relative;
  min-width: 0;
  display: grid;
  grid-template-columns: 78px 1fr;
  align-items: center;
  gap: 8px;
  padding: 12px 38px 12px 8px;
  color: #fff;
  background: linear-gradient(145deg, rgba(15, 65, 115, 0.88), rgba(4, 27, 56, 0.98));
  border: 0;
  border-radius: 11px;
  box-shadow: var(--shadow-control);
  cursor: pointer;
  overflow: hidden;
}
.device-card.selected {
  border-color: rgba(24, 201, 255, 0.58);
  box-shadow:
    0 17px 34px rgba(0, 4, 18, 0.4),
    0 0 20px rgba(24, 201, 255, 0.12),
    inset 0 0 24px rgba(18, 126, 233, 0.08);
}
.device-card.confirmed .device-product {
  animation: device-confirm 620ms var(--ease-out);
}
.device-card.offline {
  opacity: 0.55;
}
.device-product {
  width: 78px;
  height: 78px;
  display: grid;
  place-items: center;
  background: radial-gradient(circle, rgba(32, 154, 243, 0.13), transparent 68%);
}
.device-copy {
  min-width: 0;
  display: grid;
  gap: 4px;
  text-align: left;
}
.device-copy strong {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.device-copy small {
  color: #719ac0;
  font-size: 8px;
}
.device-copy .state.on {
  color: var(--green);
}
.power-dot {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 44px;
  height: 44px;
  padding: 10px;
  display: grid;
  place-items: center;
  color: #577fa4;
  background: transparent;
  border-radius: 50%;
}
.power-dot :deep(svg) {
  width: 26px;
  height: 26px;
  padding: 5px;
  color: #577fa4;
  background: rgba(16, 74, 126, 0.42);
  border: 0;
  border-radius: 50%;
  box-shadow:
    inset 0 1px rgba(184, 224, 255, 0.06),
    0 5px 12px rgba(0, 4, 16, 0.3);
}
.power-dot.on :deep(svg) {
  color: var(--green);
  box-shadow:
    0 0 12px rgba(32, 229, 155, 0.3),
    inset 0 1px rgba(255, 255, 255, 0.08);
}
.pager {
  display: flex;
  justify-content: center;
  gap: 8px;
  padding: 10px 0 14px;
}
.pager button {
  min-width: 30px;
  height: 30px;
  color: #7ea6cc;
  background: rgba(16, 74, 126, 0.25);
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 11px;
}
.pager button.active {
  color: #fff;
  background: var(--blue);
  border-color: #4daeff;
}

/* 设备详情（参考图空调面板布局） */
.device-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 62px;
  padding: 0 20px;
}
.device-detail-head strong {
  font-size: 15px;
  font-weight: 600;
}
.online {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--green);
  font-size: 10px;
}
.online.off {
  color: var(--danger);
}
.online i {
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
  box-shadow: 0 0 7px currentColor;
}
.last-known-note {
  margin: 0 14px 10px;
  padding: 8px 10px;
  color: #8aa5bb;
  font-size: 9px;
  text-align: center;
  background: var(--card-soft);
  border-radius: 12px;
}
.device-hero {
  display: grid;
  justify-items: center;
  gap: 7px;
  padding: 10px 20px 12px;
}
.device-orbit {
  position: relative;
  width: 188px;
  height: 138px;
  display: grid;
  place-items: center;
  color: #c8e8ff;
  background: radial-gradient(ellipse, var(--selected), transparent 68%);
  box-shadow: none;
  filter: none;
}
.device-orbit::before {
  content: none;
}
.device-orbit :deep(.device-visual) {
  transform: scale(1.42);
}
.device-model {
  display: grid;
  justify-items: center;
  gap: 3px;
}
.device-model span {
  color: var(--text-soft);
  font-size: 11px;
}
.device-model small {
  color: var(--muted);
  font-size: 9px;
  letter-spacing: 0.08em;
}
.value-static {
  display: grid;
  justify-items: center;
  padding: 12px 20px 8px;
}
.value-static strong {
  font-size: 28px;
  font-weight: 500;
}
.mode-area {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  align-content: start;
  gap: 14px;
  padding: 16px 14px;
}
.mode-group,
.mode-readonly {
  padding: 3px 0 0;
  background: transparent;
  border: 0;
  border-radius: 16px;
  box-shadow: none;
  overflow: hidden;
}
.mode-label {
  color: var(--muted);
  font-size: 11px;
}
.mode-options {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 10px;
}
.mode-options button {
  min-height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-soft);
  background: var(--control);
  border: 0;
  border-radius: 14px;
  box-shadow: var(--shadow-control);
  font-size: 11px;
  transition:
    transform 0.16s var(--ease-out),
    color 0.16s ease,
    background 0.16s ease;
}
.mode-options button.active {
  color: #fff;
  background: var(--cyan);
  box-shadow: 0 6px 16px var(--cyan-soft);
}
.mode-options button:active {
  transform: scale(0.96);
}
.mode-readonly {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 50px;
  padding: 0 4px;
}
.mode-readonly strong {
  color: #eef8ff;
  font-size: 11px;
  font-weight: 500;
}
.power-button {
  min-height: 48px;
  margin: 2px 14px 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #fff;
  background: linear-gradient(180deg, #1a98ff, #096be0);
  border: 1px solid #39a8ff;
  border-radius: 16px;
  box-shadow: 0 7px 18px var(--cyan-soft);
  font-size: 13px;
}
.power-button:not(.on) {
  background: rgba(16, 74, 126, 0.4);
  border-color: var(--line);
  box-shadow: none;
}

@keyframes control-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes scene-scan {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(350%);
  }
}
@keyframes energy-pass {
  to {
    transform: translateX(100%);
  }
}
@keyframes device-confirm {
  0% {
    transform: scale(0.92);
    filter: brightness(1);
  }
  45% {
    transform: scale(1.08);
    filter: brightness(1.6) drop-shadow(0 0 14px var(--green));
  }
  100% {
    transform: scale(1);
    filter: brightness(1);
  }
}

/* 其他模块概览页 */
.overview-dashboard {
  padding: 18px;
}
.overview-panel {
  height: 100%;
  padding: 26px;
}
.overview-panel > header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  color: var(--cyan);
}
.overview-panel h1 {
  margin: 8px 0 5px;
  color: #fff;
  font-size: 28px;
  font-weight: 500;
}
.overview-panel p {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
}
.overview-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin-top: 30px;
}
.overview-metrics article {
  display: grid;
  gap: 7px;
  padding: 20px;
  background: rgba(7, 49, 94, 0.42);
  border: 1px solid var(--line);
  border-radius: 9px;
}
.overview-metrics small {
  color: var(--muted);
}
.overview-metrics strong {
  font-size: 34px;
  font-weight: 400;
}
.overview-metrics span {
  color: #5b85aa;
  font-size: 9px;
}
.overview-metrics i {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  background: var(--green);
  border-radius: 50%;
}
.overview-devices {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-top: 16px;
}
.overview-devices article {
  display: grid;
  grid-template-columns: 42px 1fr 8px;
  align-items: center;
  gap: 10px;
  padding: 15px;
  color: var(--cyan);
  background: rgba(7, 49, 94, 0.28);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.overview-devices article div {
  display: grid;
  gap: 4px;
}
.overview-devices strong {
  color: #fff;
  font-size: 11px;
  font-weight: 500;
}
.overview-devices small {
  color: var(--muted);
  font-size: 9px;
}
.overview-devices article > i {
  width: 6px;
  height: 6px;
  background: var(--green);
  border-radius: 50%;
  box-shadow: 0 0 6px var(--green);
}
.overview-devices article > i.offline {
  background: var(--danger);
  box-shadow: 0 0 6px color-mix(in srgb, var(--danger) 55%, transparent);
}
.overview-devices article > i.degraded {
  background: var(--warning-text);
  box-shadow: 0 0 6px color-mix(in srgb, var(--warning-text) 50%, transparent);
}

/* 安防、设置和能力门禁页面 */
.module-dashboard {
  padding: 18px;
}
.module-panel {
  height: 100%;
  padding: 25px;
  overflow: auto;
}
.module-panel > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  color: var(--cyan);
  margin-bottom: 22px;
}
.module-panel h1 {
  margin: 7px 0 5px;
  color: #fff;
  font-size: 27px;
  font-weight: 500;
}
.module-panel p {
  margin: 0;
  color: var(--muted);
  font-size: 10px;
}
.security-layout {
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 16px;
}
.security-devices,
.alert-history,
.offline-list {
  display: grid;
  align-content: start;
  gap: 8px;
}
.security-devices article,
.alert-history article,
.offline-list article,
.live-readings article {
  display: grid;
  grid-template-columns: 42px 1fr auto;
  align-items: center;
  gap: 10px;
  min-height: 66px;
  padding: 11px 14px;
  color: var(--cyan);
  background: rgba(8, 49, 91, 0.43);
  border-radius: 10px;
  box-shadow: var(--shadow-control);
}
.security-devices article.alarm {
  color: var(--danger);
  background: rgba(112, 22, 48, 0.24);
}
.security-devices div,
.alert-history div,
.offline-list div,
.live-readings div {
  display: grid;
  gap: 4px;
}
.security-devices strong,
.alert-history strong,
.offline-list strong,
.live-readings strong {
  color: #fff;
  font-size: 11px;
}
.security-devices small,
.alert-history small,
.offline-list small,
.live-readings small {
  color: var(--muted);
  font-size: 8px;
}
.security-devices span,
.alert-history span,
.offline-list span,
.live-readings span {
  color: #6f9abe;
  font-size: 8px;
}
.alert-history > header,
.offline-list > header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
}
.alert-history article {
  grid-template-columns: 26px 1fr auto;
  color: var(--danger);
}
.alert-history button {
  padding: 8px 11px;
  color: #fff;
  background: var(--blue);
  border-radius: 7px;
  font-size: 8px;
}
.alert-action-error {
  grid-column: 2 / -1;
  color: var(--danger) !important;
}
.module-header-action {
  min-width: 116px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 14px;
  color: var(--cyan);
  background: var(--selected);
  border-radius: 14px;
  font-size: 10px;
  font-weight: 650;
}
.module-header-action:disabled {
  opacity: 0.65;
}
.spinning {
  animation: refresh-spin 0.85s linear infinite;
}
.snapshot-message {
  margin: -8px 0 16px;
  padding: 10px 13px;
  color: var(--green);
  background: var(--green-soft);
  border-radius: 12px;
  font-size: 10px;
}
.module-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.module-toolbar button {
  min-height: 44px;
  padding: 0 17px;
  color: var(--text-soft);
  background: var(--control);
  border-radius: 13px;
  font-size: 10px;
}
.module-toolbar button.active {
  color: var(--cyan);
  background: var(--selected);
}
.security-devices article[role="button"],
.offline-list article[role="button"],
.live-readings article[role="button"] {
  cursor: pointer;
}
.security-devices article[role="button"]:focus-visible,
.offline-list article[role="button"]:focus-visible,
.live-readings article[role="button"]:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--cyan) 60%, #fff);
  outline-offset: -2px;
}
.module-empty {
  min-height: 96px;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--card-soft);
  border-radius: 15px;
}
.energy-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.energy-summary article {
  min-height: 112px;
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  gap: 5px 8px;
  padding: 18px 20px;
  color: var(--cyan);
  background: var(--card-soft);
  border-radius: 17px;
}
.energy-summary small,
.energy-summary span {
  color: var(--muted);
}
.energy-summary strong {
  grid-row: 1 / 3;
  grid-column: 3;
  color: var(--text);
  font-size: 28px;
}
.energy-summary span {
  grid-column: 2;
  font-size: 9px;
}
.energy-summary article.unavailable {
  color: var(--gold);
  background: var(--warning-card);
}
.energy-live-list {
  display: grid;
  gap: 8px;
  margin-bottom: 18px;
}
.energy-live-list > header {
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
}
.energy-live-list > header span,
.energy-live-list > p {
  color: var(--muted);
  font-size: 9px;
}
.energy-live-list > button {
  min-height: 60px;
  display: grid;
  grid-template-columns: 34px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 10px 15px;
  color: var(--cyan);
  background: var(--card-soft);
  border-radius: 14px;
  text-align: left;
}
.energy-live-list > button > span {
  display: grid;
  gap: 3px;
}
.energy-live-list > button strong {
  color: var(--text);
  font-size: 11px;
}
.energy-live-list > button small {
  color: var(--muted);
  font-size: 9px;
}
.energy-live-list > button b {
  color: var(--cyan);
  font-size: 9px;
}
.stale-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  margin-bottom: 13px;
  color: var(--gold);
  background: rgba(101, 62, 13, 0.28);
  border-radius: 9px;
}
.status-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 11px;
  margin-bottom: 18px;
}

@keyframes refresh-spin {
  to {
    transform: rotate(360deg);
  }
}
.display-preferences {
  display: grid;
  grid-template-columns: 130px minmax(0, 760px);
  align-items: center;
  gap: 18px;
  margin-bottom: 18px;
  padding: 16px 18px;
  background: var(--card-soft);
  border-radius: 18px;
}
.preference-heading {
  display: grid;
  gap: 6px;
}
.preference-heading strong {
  color: var(--text);
  font-size: 14px;
}
.status-grid article {
  display: grid;
  gap: 8px;
  padding: 17px;
  background: var(--surface-strong);
  border-radius: 11px;
}
.status-grid small,
.status-grid span {
  color: var(--muted);
  font-size: 8px;
}
.status-grid strong {
  font-size: 18px;
}
.good {
  color: var(--green) !important;
}
.bad {
  color: var(--danger) !important;
}
.live-readings {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.capability-gate {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 12px;
  max-width: 780px;
  margin: 24px auto;
  padding: 20px;
  color: var(--gold);
  background: rgba(74, 48, 14, 0.28);
  border-radius: 12px;
}
.capability-gate strong {
  color: #ffe3ad;
}
.capability-gate p {
  margin-top: 7px;
  line-height: 1.8;
}

.critical-strip {
  position: fixed;
  z-index: 50;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 17px;
  color: #fff;
  background: rgba(126, 20, 38, 0.95);
  border: 1px solid rgba(255, 94, 114, 0.45);
  border-radius: 7px;
  font-size: 10px;
  box-shadow: var(--shadow-float);
}

@media (max-width: 1380px) {
  .scene-dashboard,
  .device-dashboard {
    grid-template-columns: minmax(600px, 1fr) 350px;
  }
  .scene-grid {
    gap: 10px;
    padding: 12px;
  }
  .linkage-grid {
    gap: 8px;
    padding: 12px;
  }
  .device-grid {
    grid-template-columns: repeat(4, 1fr);
  }
  .scene-tabs {
    gap: 18px;
  }
}
@media (max-height: 780px) {
  .dashboard-center {
    grid-template-rows: 1fr 0.72fr;
  }
  .scene-hero {
    min-height: 210px;
  }
  .device-hero {
    padding-block: 12px 8px;
  }
  .device-orbit {
    width: 120px;
    height: 120px;
  }
  .action-area {
    padding-block: 10px;
  }
  .device-grid {
    grid-auto-rows: 116px;
  }
}
</style>

<style scoped>
/* 米家化视觉层：浅色家庭空间、房间优先、设备卡片即操作 */
.primary-shell {
  background: var(--canvas);
}
.app-body {
  height: calc(100vh - 72px);
}
.dashboard {
  padding: 22px 24px 24px;
}
.scene-dashboard,
.device-dashboard {
  grid-template-columns: minmax(720px, 1fr) 366px;
  gap: 18px;
}
.dashboard-center {
  grid-template-rows: minmax(390px, 1.42fr) minmax(188px, 0.58fr);
  gap: 18px;
}
.scene-library,
.detail-panel,
.device-library,
.module-panel,
.overview-panel {
  background: var(--card);
  border: 0;
  border-radius: 22px;
  box-shadow: var(--shadow-panel);
  backdrop-filter: none;
}
.scene-tabs {
  height: 64px;
  gap: 26px;
  padding: 0 22px;
  background: var(--card);
  border-bottom: 0;
}
.scene-tabs button {
  color: var(--muted);
}
.tab-main,
.tab-main:not(.active),
.tab-scene.active {
  color: var(--text);
}
.tab-main {
  font-size: 15px;
  font-weight: 650;
}
.tab-scene {
  font-size: 12px;
}
.tab-scene.active::after {
  bottom: 9px;
  width: 18px;
  height: 3px;
  margin: auto;
  background: var(--cyan);
  border-radius: 4px;
  box-shadow: none;
}
.scene-grid {
  height: calc(100% - 64px);
  gap: 10px;
  padding: 0 14px 14px;
  background: var(--card);
}
.scene-card,
.scene-card.selected,
.scene-card:not(.selected) {
  border: 0;
  border-radius: 17px;
  box-shadow: none;
}
.scene-card:not(.selected) {
  filter: saturate(0.62) brightness(0.82);
}
.scene-card.selected {
  box-shadow: inset 0 0 0 2px rgba(50, 170, 255, 0.72);
}
.scene-card.current:not(.selected) {
  filter: saturate(0.78) brightness(0.88);
}
.scene-card.current::before {
  content: "";
  position: absolute;
  z-index: 3;
  top: 13px;
  right: 13px;
  width: 7px;
  height: 7px;
  background: var(--green);
  border: 2px solid rgba(255, 255, 255, 0.82);
  border-radius: 50%;
  box-shadow: 0 0 0 4px rgba(48, 208, 151, 0.14);
}
.scene-card:hover {
  filter: saturate(0.86) brightness(0.94);
}
.scene-shade {
  background: linear-gradient(180deg, rgba(12, 16, 20, 0.03), rgba(12, 16, 20, 0.1) 45%, rgba(10, 14, 18, 0.74));
}
.scene-card.selected .scene-name {
  font-size: 27px;
}
.scene-state {
  color: rgba(255, 255, 255, 0.78);
}
.panel-head {
  min-height: 54px;
  padding: 0 20px;
  background: var(--card);
  border-bottom: 1px solid var(--line);
}
.linkage-panel {
  min-height: 0;
  overflow: hidden;
  background: var(--card);
  border: 0;
  border-radius: 22px;
  box-shadow: var(--shadow-panel);
  backdrop-filter: none;
}
.linkage-heading {
  display: flex;
  align-items: center;
  gap: 20px;
  min-height: 54px;
  padding: 0 22px;
}
.linkage-heading > div {
  display: flex;
  align-items: center;
  gap: 9px;
}
.linkage-heading strong {
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
}
.panel-head strong {
  color: var(--text);
  font-size: 13px;
}
.head-mark {
  display: none;
}
.head-note {
  color: var(--muted);
}
.linkage-grid {
  height: calc(100% - 54px);
  grid-template-columns: repeat(5, 1fr);
  grid-auto-rows: 104px;
  gap: 10px;
  padding: 0 14px 14px;
}
.linkage-card {
  padding: 12px;
  background: var(--card-soft);
  border: 0;
  border-radius: 16px;
}
.linkage-card:last-child {
  border-right: 0;
}
.link-icon {
  color: var(--cyan);
  background: var(--control);
  border-radius: 13px;
}
.link-copy strong {
  color: var(--text);
}
.link-copy small {
  color: var(--muted);
}
.mini-switch i {
  background: var(--faint);
}
.mini-switch i::after {
  background: var(--surface-strong);
  box-shadow: 0 1px 4px rgba(33, 38, 45, 0.2);
}
.mini-switch.on i {
  background: var(--cyan);
  box-shadow: none;
}
.detail-title,
.device-detail-head {
  min-height: 64px;
  color: var(--text);
  border-bottom: 1px solid var(--line);
}
.detail-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.scene-run-button {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 14px;
  color: #fff;
  background: var(--cyan);
  border-radius: 22px;
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}
.scene-run-button:disabled {
  color: var(--muted);
  background: var(--control);
}
.scene-hero {
  min-height: 242px;
  background: linear-gradient(180deg, var(--canvas-raised), var(--card));
  border-bottom: 1px solid var(--line);
}
.action-area > header strong,
.action-grid strong {
  color: var(--text);
}
.action-grid article {
  color: var(--cyan);
  background: transparent;
  border-bottom: 1px solid var(--line);
}
.action-grid small {
  color: var(--muted);
}
.device-tabs {
  gap: 22px;
}
.device-count {
  color: var(--muted);
}
.device-search {
  width: 218px;
  height: 36px;
  color: var(--muted);
  background: var(--control);
  border: 0;
  border-radius: 18px;
}
.device-search input {
  color: var(--text);
}
.device-search input::placeholder {
  color: var(--faint);
}
.status-retry {
  justify-self: start;
  padding: 5px 9px;
  color: var(--warning-text);
  background: var(--warning-card);
  border: 0;
  border-radius: 8px;
  font-size: 9px;
}
.device-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-auto-rows: 148px;
  align-content: start;
  gap: 12px;
  padding: 4px 16px 16px;
  background: var(--card);
}
.device-card {
  min-height: 0;
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  grid-template-rows: 1fr;
  gap: 8px;
  padding: 14px 38px 14px 10px;
  color: var(--text);
  background: var(--card-soft);
  border: 1px solid transparent;
  border-radius: 18px;
  box-shadow: none;
}
.device-card:hover {
  background: var(--control-hover);
  transform: translateY(-1px);
}
.device-card.selected {
  background: var(--selected);
  border-color: rgba(50, 170, 255, 0.3);
  box-shadow: none;
}
.device-product {
  width: 78px;
  height: 80px;
  align-self: center;
  background: transparent;
}
.device-copy {
  display: grid;
  grid-template-columns: 1fr;
  align-content: center;
  gap: 6px;
}
.device-copy strong {
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}
.device-copy small {
  color: var(--muted);
  font-size: 9px;
}
.device-copy .state {
  color: var(--text-soft);
  text-align: left;
}
.device-copy .state.on {
  color: var(--cyan);
}
.power-dot {
  right: 8px;
  top: 8px;
  bottom: auto;
  color: var(--muted);
}
.power-dot :deep(svg) {
  color: var(--muted);
  background: var(--control);
  box-shadow: 0 2px 8px rgba(38, 44, 52, 0.07);
}
.power-dot.on :deep(svg) {
  color: #fff;
  background: var(--cyan);
  box-shadow: none;
}
.pager button {
  color: var(--muted);
  background: var(--control);
  border: 0;
}
.pager button.active {
  color: #fff;
  background: var(--cyan);
}
.online {
  color: var(--green);
}
.device-hero {
  background: linear-gradient(180deg, var(--canvas-raised), var(--card));
}
.device-orbit {
  color: var(--text);
  background: radial-gradient(ellipse, var(--selected), transparent 68%);
  box-shadow: none;
  filter: none;
}
.device-model span,
.value-static strong,
.mode-readonly strong {
  color: var(--text);
}
.device-model small,
.mode-label {
  color: var(--muted);
}
.mode-group,
.mode-readonly {
  background: transparent;
  border-radius: 14px;
}
.mode-options button {
  color: var(--text-soft);
  background: var(--control);
}
.mode-options button.active {
  color: #fff;
  background: var(--cyan);
  box-shadow: none;
}
.power-button {
  color: #fff;
  background: var(--cyan);
  border: 0;
  box-shadow: none;
}
.power-button:not(.on) {
  color: var(--text-soft);
  background: var(--control);
}
.module-panel > header {
  border-bottom: 1px solid var(--line);
}
.module-panel h1,
.overview-panel h1 {
  color: var(--text);
}
.module-panel p {
  color: var(--muted);
}
.security-devices article,
.alert-history article,
.offline-list article,
.live-readings article,
.status-grid article,
.overview-metrics article,
.overview-devices article {
  background: var(--card-soft);
  border-color: var(--line);
}
.security-devices article strong,
.alert-history article strong,
.offline-list article strong,
.live-readings strong,
.status-grid strong {
  color: var(--text);
}
.security-devices article.alarm {
  background: var(--danger-card);
}
.capability-gate {
  background: var(--warning-card);
  border-radius: 16px;
}
.capability-gate strong {
  color: var(--warning-text);
}
.overview-panel {
  background:
    linear-gradient(90deg, var(--image-overlay-start) 0%, var(--image-overlay-middle) 34%, var(--image-overlay-end) 70%),
    linear-gradient(
      0deg,
      var(--image-overlay-bottom) 0%,
      color-mix(in srgb, var(--image-overlay-bottom) 18%, transparent) 58%,
      transparent 78%
    ),
    url("../assets/illustrations/home-overview.svg") center 46% / cover no-repeat;
}
.overview-panel p {
  color: var(--text-soft);
}
.overview-metrics {
  background: color-mix(in srgb, var(--card) 92%, transparent);
  border: 0;
  border-radius: 18px;
  box-shadow: 0 12px 34px rgba(43, 50, 60, 0.08);
}
.overview-metrics article {
  background: transparent;
  border-right: 1px solid var(--line);
}
.overview-metrics strong,
.overview-metrics small {
  color: var(--text);
}
.overview-metrics span {
  color: var(--muted);
}
.overview-device-block {
  margin-top: 18px;
  background: color-mix(in srgb, var(--card) 94%, transparent);
  border: 0;
  border-radius: 18px;
  box-shadow: 0 10px 30px rgba(43, 50, 60, 0.06);
  overflow: hidden;
}
.overview-section-head {
  min-height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px 0 20px;
  border-bottom: 1px solid var(--line);
}
.overview-section-head > div {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.overview-section-head span {
  color: var(--text);
  font-size: 12px;
  font-weight: 650;
}
.overview-section-head small {
  color: var(--muted);
  font-size: 8px;
}
.overview-section-head button {
  min-height: 32px;
  padding: 0 11px;
  color: var(--text-soft);
  background: var(--control);
  border-radius: 16px;
  font-size: 9px;
}
.overview-section-head button:hover {
  color: var(--cyan);
  background: var(--selected);
}
.overview-devices {
  gap: 10px;
  padding: 10px;
  background: transparent;
}
.overview-devices article {
  background: var(--card-soft);
  border-radius: 14px;
}
.overview-devices article:hover {
  background: var(--selected-hover);
}
.overview-devices article {
  cursor: pointer;
}
.overview-devices article:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--cyan) 60%, #fff);
  outline-offset: -2px;
}
.overview-devices strong {
  color: var(--text);
}
.overview-devices small {
  color: var(--muted);
}
@media (max-width: 1380px) {
  .scene-dashboard,
  .device-dashboard {
    grid-template-columns: minmax(650px, 1fr) 340px;
  }
  .device-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 1180px) {
  .primary-shell {
    min-width: 0;
    min-height: 0;
  }
  .dashboard {
    padding: 12px;
  }
  .scene-dashboard,
  .device-dashboard {
    grid-template-columns: minmax(540px, 1fr) 260px;
    gap: 12px;
  }
  .dashboard-center {
    gap: 12px;
  }
  .scene-tabs {
    gap: 18px;
    padding-inline: 16px;
  }
  .scene-grid {
    padding-inline: 10px;
  }
  .scene-card.selected .scene-name {
    font-size: 21px;
  }
  .detail-title,
  .device-detail-head {
    min-height: 54px;
    padding-inline: 14px;
    font-size: 13px;
  }
  .scene-run-button {
    padding-inline: 10px;
  }
  .action-area {
    padding-inline: 12px;
  }
  .action-grid {
    gap: 6px;
  }
  .action-grid article {
    grid-template-columns: 27px minmax(0, 1fr);
    gap: 5px;
    padding-inline: 6px;
  }
  .device-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .device-hero {
    gap: 5px;
    padding: 10px 10px 6px;
  }
  .device-orbit {
    width: 168px;
    height: 118px;
  }
  .mode-area {
    padding: 10px 12px;
  }
  .power-button {
    margin: 0 12px 12px;
  }
}

@media (max-width: 900px) {
  .app-body {
    height: calc(100vh - 64px);
  }
  .dashboard {
    padding: 10px;
  }
  .scene-dashboard,
  .device-dashboard {
    grid-template-columns: minmax(0, 1fr) 236px;
    gap: 10px;
  }
  .scene-tabs {
    gap: 11px;
    padding-inline: 12px;
  }
  .scene-tabs button,
  .device-count {
    white-space: nowrap;
  }
  .device-search {
    width: 132px;
  }
  .device-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    padding: 10px;
  }
  .device-card {
    min-width: 0;
  }
  .device-copy strong,
  .device-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    word-break: keep-all;
  }
  .module-panel {
    padding: 18px;
    overflow: auto;
  }
  .security-layout {
    grid-template-columns: 1fr;
  }
  .overview-dashboard {
    overflow: auto;
  }
}

/* 工控触摸屏可读性：业务状态不依赖微缩文字，入口保持 44px 热区。 */
.overview-metrics span,
.overview-section-head small,
.overview-devices small {
  font-size: 11px;
}
.overview-section-head button {
  min-height: 44px;
  padding-inline: 14px;
  border-radius: 22px;
  font-size: 11px;
}
@media (max-height: 650px) {
  .dashboard-center {
    grid-template-rows: minmax(0, 1fr) 145px;
  }
  .scene-hero {
    min-height: 190px;
  }
  .linkage-grid {
    grid-auto-rows: 76px;
    padding-block: 8px;
  }
  .linkage-card {
    min-height: 76px;
  }
  .action-area {
    padding-block: 9px;
  }
  .action-grid article {
    padding-block: 8px;
  }
}

/* 终稿细节层：用留白、灰阶表面和状态填充替代重复描边 */
.scene-card.selected {
  box-shadow: 0 10px 28px rgba(34, 40, 48, 0.12);
  transform: translateY(-2px);
}
.panel-head,
.detail-title,
.device-detail-head,
.module-panel > header,
.overview-section-head {
  border-bottom: 0;
}
.panel-head,
.detail-title,
.device-detail-head {
  padding-inline: 22px;
}
.linkage-grid {
  padding-top: 4px;
}
.action-grid {
  gap: 7px;
}
.action-grid article {
  min-height: 54px;
  padding: 9px 10px;
  background: var(--card-soft);
  border-bottom: 0;
  border-radius: 13px;
}
.scene-hero,
.device-hero {
  border-bottom: 0;
}
.device-card,
.device-card.selected {
  border: 0;
}
.device-card.selected {
  background: var(--selected);
  box-shadow: 0 8px 22px rgba(50, 170, 255, 0.09);
}
.module-panel {
  padding: 30px 32px;
}
.module-panel > header {
  margin-bottom: 24px;
}
.module-panel h1 {
  margin-top: 9px;
  font-size: 30px;
  font-weight: 620;
  letter-spacing: -0.035em;
}
.module-panel > header > svg {
  padding: 11px;
  box-sizing: content-box;
  background: var(--selected);
  border-radius: 16px;
}
.security-layout {
  grid-template-columns: minmax(0, 1fr) minmax(430px, 1.12fr);
  gap: 26px;
}
.security-devices,
.alert-history,
.offline-list {
  gap: 10px;
}
.security-devices article,
.alert-history article,
.offline-list article,
.live-readings article {
  min-height: 68px;
  padding: 13px 16px;
  border: 0;
  border-radius: 15px;
  box-shadow: none;
}
.security-devices article strong,
.alert-history article strong,
.offline-list article strong,
.live-readings strong {
  font-size: 12px;
}
.security-devices small,
.alert-history small,
.offline-list small,
.live-readings small {
  font-size: 9px;
}
.alert-history > header,
.offline-list > header {
  min-height: 42px;
  align-items: center;
  margin: 0 4px 2px;
}
.status-grid {
  gap: 12px;
}
.status-grid article {
  min-height: 108px;
  padding: 20px;
  border: 0;
  border-radius: 17px;
}
.display-preferences {
  margin: 18px 0 26px;
  padding: 18px;
  background: var(--card-soft);
  border: 0;
  border-radius: 18px;
}
.live-readings {
  gap: 12px;
}
.capability-gate {
  margin-top: 24px;
  padding: 20px 22px;
  max-width: 880px;
}
.overview-metrics {
  gap: 8px;
  padding: 8px;
}
.overview-metrics article {
  border-right: 0;
  border-radius: 14px;
}
.overview-device-block {
  padding: 8px;
}
.overview-section-head {
  min-height: 48px;
  padding-inline: 12px;
}
.overview-devices {
  margin-top: 0;
  padding: 0;
}
.overview-devices article {
  border: 0;
}
@media (max-width: 1180px) {
  .module-panel {
    padding: 22px;
  }
  .security-layout {
    gap: 14px;
  }
}
</style>
