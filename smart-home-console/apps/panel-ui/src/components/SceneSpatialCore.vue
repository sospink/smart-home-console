<script setup lang="ts">
import { computed } from "vue";
import { Blinds, CircleAlert, Clapperboard, Lightbulb, LogIn, LogOut, MoonStar, Music2, Power, Radio, WifiOff } from "lucide-vue-next";

export type SpatialRunState = "idle" | "running" | "completed" | "partial" | "failed";
export type SpatialNodeStatus = "idle" | "pending" | "confirmed" | "failed" | "timeout";
export type SceneSpatialKind = "home" | "away" | "movie" | "sleep";

export interface SpatialActionNode {
  id: string;
  deviceId: string;
  label: string;
  property: string;
  status: SpatialNodeStatus;
  offline?: boolean;
}

interface DeviceSpatialNode extends SpatialActionNode {
  x: number;
  y: number;
  index: number;
  actionCount: number;
}

const props = defineProps<{
  sceneId: string;
  sceneName: string;
  state: SpatialRunState;
  progress: number;
  completed: number;
  total: number;
  source?: "primary" | "secondary" | "admin" | "automation";
  nodes: SpatialActionNode[];
}>();

const sceneKind = computed<SceneSpatialKind>(() => {
  if (props.sceneId === "scene-away") return "away";
  if (props.sceneId === "scene-movie") return "movie";
  if (props.sceneId === "scene-sleep") return "sleep";
  return "home";
});

const sceneMeta: Record<SceneSpatialKind, { eyebrow: string; description: string }> = {
  home: { eyebrow: "ARRIVAL", description: "光线由玄关向生活区展开" },
  away: { eyebrow: "SECURE", description: "设备依次收束，空间进入布防" },
  movie: { eyebrow: "CINEMA", description: "窗帘闭合，灯带与音乐切入观影氛围" },
  sleep: { eyebrow: "NIGHT", description: "主光沉降，卧室保留低亮暖光" }
};

const sourceLabel: Record<NonNullable<(typeof props)["source"]>, string> = {
  primary: "主屏发起",
  secondary: "副屏发起",
  admin: "后台试运行",
  automation: "自动联动"
};

const devicePositions: Record<string, { x: number; y: number }> = {
  "living-main-light": { x: 39, y: 37 },
  "curtain-c3": { x: 22, y: 57 },
  "downlight-a": { x: 59, y: 31 },
  "ambient-strip": { x: 77, y: 48 },
  "music-r11": { x: 64, y: 69 },
  "bedroom-light": { x: 66, y: 30 }
};

const fallbackPositions = [
  { x: 39, y: 73 },
  { x: 80, y: 66 },
  { x: 28, y: 35 },
  { x: 52, y: 58 }
];

function combineStatus(statuses: SpatialNodeStatus[]): SpatialNodeStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("timeout")) return "timeout";
  if (statuses.includes("pending")) return "pending";
  if (statuses.length && statuses.every((status) => status === "confirmed")) return "confirmed";
  if (statuses.includes("confirmed")) return "pending";
  return "idle";
}

const visibleNodes = computed<DeviceSpatialNode[]>(() => {
  const grouped = new Map<string, SpatialActionNode[]>();
  for (const node of props.nodes) grouped.set(node.deviceId, [...(grouped.get(node.deviceId) ?? []), node]);
  return [...grouped.entries()].slice(0, 6).map(([deviceId, actions], index) => {
    const position = devicePositions[deviceId] ?? fallbackPositions[index % fallbackPositions.length];
    const representative = actions.find((action) => action.property !== "power") ?? actions[0];
    return {
      ...representative,
      id: deviceId,
      deviceId,
      status: combineStatus(actions.map((action) => action.status)),
      offline: actions.some((action) => action.offline),
      actionCount: actions.length,
      index,
      ...position
    };
  });
});

const routeNodes = computed(() => (sceneKind.value === "away" ? [...visibleNodes.value].reverse() : visibleNodes.value));
const routeSegments = computed(() =>
  routeNodes.value.slice(1).map((node, index) => {
    const previous = routeNodes.value[index];
    const x1 = previous.x * 4.2;
    const y1 = previous.y * 2.5;
    const x2 = node.x * 4.2;
    const y2 = node.y * 2.5;
    const bend = Math.max(7, Math.abs(x2 - x1) * 0.12);
    return {
      id: `${previous.id}-${node.id}`,
      path: `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 - bend} ${x2} ${y2}`,
      active: ["confirmed", "pending"].includes(node.status),
      failed: ["failed", "timeout"].includes(node.status)
    };
  })
);

const statusLabel = computed(() => {
  if (props.state === "running") return `${props.sceneName}场景执行中`;
  if (props.state === "completed") {
    if (sceneKind.value === "away") return "离家布防已完成";
    if (sceneKind.value === "movie") return "观影氛围已就绪";
    if (sceneKind.value === "sleep") return "夜间氛围已就绪";
    return "回家环境已就绪";
  }
  if (props.state === "partial") return "部分设备未完成";
  if (props.state === "failed") return "场景执行失败";
  return `${props.sceneName}场景待命`;
});

const sceneIcon = computed(() => ({ home: LogIn, away: LogOut, movie: Clapperboard, sleep: MoonStar })[sceneKind.value]);

function nodeIcon(node: SpatialActionNode) {
  if (node.offline) return WifiOff;
  if (node.property === "position" || node.property === "motor") return Blinds;
  if (node.deviceId === "music-r11" || node.property === "volume") return Music2;
  if (node.property === "brightness" || node.property === "colorTemperature") return Lightbulb;
  if (node.property === "power") return Power;
  return Radio;
}
</script>

<template>
  <section
    class="spatial-core"
    :class="[state, `scene-${sceneKind}`]"
    :data-scene="sceneKind"
    :data-source="source"
    :aria-label="`${sceneName}场景空间状态`"
  >
    <div class="scene-signature">
      <span><component :is="sceneIcon" :size="12" /></span>
      <p>
        <b>{{ sceneMeta[sceneKind].eyebrow }}</b
        ><small>{{ sceneMeta[sceneKind].description }}</small>
      </p>
    </div>
    <div class="atmosphere" aria-hidden="true"><i /><i /><i /><i /></div>

    <svg class="home-world" viewBox="0 0 420 250" role="img" :aria-label="`${sceneName}场景的微缩住宅联动模型`">
      <defs>
        <linearGradient id="spatial-platform" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--platform-light)" />
          <stop offset="1" stop-color="var(--platform-shadow)" />
        </linearGradient>
        <linearGradient id="spatial-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--glass-light)" />
          <stop offset="1" stop-color="var(--glass-shadow)" />
        </linearGradient>
        <linearGradient id="spatial-room-left" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--room-left-a)" />
          <stop offset="1" stop-color="var(--room-left-b)" />
        </linearGradient>
        <linearGradient id="spatial-room-right" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--room-right-a)" />
          <stop offset="1" stop-color="var(--room-right-b)" />
        </linearGradient>
        <filter id="spatial-shadow" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="9" /></filter>
        <filter id="spatial-room-glow" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="12" /></filter>
      </defs>

      <ellipse class="cast-shadow" cx="210" cy="213" rx="153" ry="24" filter="url(#spatial-shadow)" />
      <g class="scene-lighting" aria-hidden="true">
        <ellipse class="light-zone living-light" cx="138" cy="147" rx="65" ry="35" filter="url(#spatial-room-glow)" />
        <ellipse class="light-zone bedroom-light" cx="263" cy="86" rx="52" ry="29" filter="url(#spatial-room-glow)" />
        <path class="arrival-beam" d="M362 142 291 146 182 204 210 227Z" />
        <path class="secure-beam" d="M60 141 179 205 288 146 361 106" />
      </g>

      <g class="platform">
        <path d="M42 141 207 52l170 90-166 94Z" fill="url(#spatial-platform)" />
        <path d="m42 141 169 95v10L42 151Z" class="platform-side left" />
        <path d="m211 236 166-94v10l-166 94Z" class="platform-side right" />
        <path d="M57 142 207 62l154 81-151 85Z" class="platform-inset" />
      </g>

      <g class="rooms">
        <path d="M58 142 169 82l88 46-113 63Z" fill="url(#spatial-room-left)" class="room living-room" />
        <path d="m169 82 74-40 87 46-73 40Z" fill="url(#spatial-room-right)" class="room bedroom" />
        <path d="m257 128 73-40 32 17-73 41Z" class="room foyer" />
        <path d="m144 191 113-63 32 18-113 63Z" class="room passage" />
        <path d="M58 142V98l111-60v44Z" fill="url(#spatial-glass)" class="wall living-wall" />
        <path d="M169 82V38l74-40v44Z" class="wall bedroom-wall-left" />
        <path d="m243 42 87 46v42l-87-46Z" fill="url(#spatial-glass)" class="wall bedroom-wall-right" />
        <path d="m330 88 32 17v41l-32-17Z" class="wall foyer-wall" />
        <path d="m169 82 88 46v8l-88-46Z" class="partition" />
        <path d="m257 128 32 18v8l-32-18Z" class="partition low" />
      </g>

      <g class="windows">
        <path d="m75 119 39-21v-26L75 93Z" />
        <path d="m79 113 14-8V83l-14 8Zm18-10 14-8V73l-14 8Z" class="window-glow" />
        <path d="m266 55 47 25v24l-47-25Z" />
        <path d="m271 62 17 9v17l-17-9Zm20 11 17 9v17l-17-9Z" class="window-glow" />
      </g>

      <g class="furniture living-furniture">
        <ellipse cx="141" cy="151" rx="36" ry="15" class="rug" />
        <path d="m87 135 48 25 28-16-48-25Z" class="sofa-seat" />
        <path d="m87 135 28-16v-16l-28 16Z" class="sofa-back" />
        <path d="m115 119 48 25v-16l-48-25Z" class="sofa-back right" />
        <path d="m130 154 25 13 22-12-25-13Z" class="table-top" />
        <path d="m151 167 3 1v10l-3-2Zm12-7 3 2v9l-3-1Z" class="table-leg" />
        <path d="m72 132 2 1v-30l-2-1Z" class="lamp-stem" />
        <path d="m63 106 10-9 11 6-10 9Z" class="lamp-shade" />
      </g>

      <g class="furniture bedroom-furniture">
        <path d="m213 74 50 26 37-20-50-27Z" class="bed-base" />
        <path d="m213 74 50 26v17l-50-27Z" class="bed-side" />
        <path d="m263 100 37-20v17l-37 20Z" class="bed-side right" />
        <path d="m229 68 20 11 13-7-20-11Zm23 12 19 10 13-7-19-10Z" class="pillow" />
        <path d="m307 102 14 7 12-7-14-7Z" class="nightstand" />
        <path d="m318 103 2 1V89l-2-1Z" class="lamp-stem" />
        <path d="m311 91 8-7 9 5-8 7Z" class="lamp-shade small" />
      </g>

      <g class="furniture foyer-furniture">
        <path d="m329 115 20 10 10-5-20-11Z" class="console-top" />
        <path d="m339 125 20-11v14l-20 11Z" class="console-side" />
        <path d="m339 125-20-10v14l20 10Z" class="console-front" />
        <circle cx="344" cy="118" r="3" class="console-light" />
      </g>

      <g class="architectural-lines">
        <path d="M58 142 207 62l154 81-151 85Z" />
        <path d="m58 98 111-60 74-40 87 46" />
        <path d="m243-2 87 46 32 17" />
      </g>

      <g class="route-layer" aria-hidden="true">
        <path v-for="segment in routeSegments" :key="`${segment.id}-base`" :d="segment.path" class="route-base" />
        <path
          v-for="segment in routeSegments"
          :key="segment.id"
          :d="segment.path"
          class="route-energy"
          :class="{ active: segment.active, failed: segment.failed }"
        />
      </g>
    </svg>

    <div class="node-layer">
      <div
        v-for="node in visibleNodes"
        :key="node.id"
        class="device-node"
        :class="[node.status, { offline: node.offline }]"
        :style="{ left: `${node.x}%`, top: `${node.y}%`, '--node-order': node.index }"
        :title="node.label"
      >
        <span><component :is="nodeIcon(node)" :size="12" /></span>
        <em v-if="node.actionCount > 1">{{ node.actionCount }}</em>
        <i />
      </div>
    </div>

    <div class="spatial-caption">
      <div>
        <span class="state-dot"><CircleAlert v-if="state === 'failed' || state === 'partial'" :size="12" /></span>
        <p>
          <strong>{{ statusLabel }}</strong>
          <small
            >{{ source ? sourceLabel[source] : sceneMeta[sceneKind].description }} · {{ visibleNodes.length }} 台设备 /
            {{ total }} 个动作</small
          >
        </p>
      </div>
      <b>{{ total ? `${completed}/${total}` : "READY" }}</b>
    </div>
    <div class="progress-track" aria-hidden="true"><i :style="{ width: `${state === 'idle' ? 0 : Math.max(2, progress)}%` }" /></div>
  </section>
</template>

<style scoped>
.spatial-core {
  --spatial-tone: #36cfa2;
  --scene-halo: rgba(54, 207, 162, 0.13);
  --platform-light: #f6f2ec;
  --platform-shadow: #e6e0d8;
  --platform-edge-left: #d8d1c8;
  --platform-edge-right: #c9c1b7;
  --room-left-a: #f7f2ea;
  --room-left-b: #e9e1d6;
  --room-right-a: #f3efe9;
  --room-right-b: #ded8cf;
  --glass-light: rgba(248, 252, 255, 0.86);
  --glass-shadow: rgba(212, 225, 235, 0.58);
  position: relative;
  width: 100%;
  height: 258px;
  isolation: isolate;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 38%, var(--scene-halo), transparent 44%),
    linear-gradient(180deg, color-mix(in srgb, var(--card) 86%, var(--canvas)), var(--card));
  transition: background 500ms ease;
}
.scene-home {
  --spatial-tone: #36cfa2;
  --scene-halo: rgba(54, 207, 162, 0.15);
}
.scene-away {
  --spatial-tone: #f1a83b;
  --scene-halo: rgba(241, 168, 59, 0.12);
}
.scene-movie {
  --spatial-tone: #8f79ff;
  --scene-halo: rgba(143, 121, 255, 0.14);
}
.scene-sleep {
  --spatial-tone: #687bdc;
  --scene-halo: rgba(104, 123, 220, 0.17);
}
.spatial-core.partial {
  --spatial-tone: var(--gold);
}
.spatial-core.failed {
  --spatial-tone: var(--danger);
}
.scene-signature {
  position: absolute;
  z-index: 3;
  top: 10px;
  left: 13px;
  display: flex;
  align-items: center;
  gap: 7px;
  opacity: 0.76;
}
.scene-signature > span {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  color: var(--spatial-tone);
  background: color-mix(in srgb, var(--spatial-tone) 8%, var(--card));
  border: 1px solid color-mix(in srgb, var(--spatial-tone) 22%, transparent);
  border-radius: 8px;
}
.scene-signature p {
  display: grid;
  gap: 1px;
  margin: 0;
}
.scene-signature b {
  color: var(--spatial-tone);
  font:
    650 7px/1.1 ui-monospace,
    SFMono-Regular,
    monospace;
  letter-spacing: 0.18em;
}
.scene-signature small {
  color: var(--muted);
  font-size: 6px;
}
.home-world {
  position: absolute;
  width: 109%;
  height: 232px;
  left: 50%;
  top: -6px;
  overflow: visible;
  transform: translateX(-50%);
  animation: spatial-enter 720ms var(--ease-out) both;
}
.cast-shadow {
  fill: rgba(53, 60, 69, 0.2);
}
.scene-lighting {
  pointer-events: none;
}
.light-zone,
.arrival-beam,
.secure-beam {
  opacity: 0;
  transition: opacity 520ms ease;
}
.light-zone {
  fill: var(--spatial-tone);
}
.arrival-beam {
  fill: url(#spatial-glass);
}
.secure-beam {
  fill: none;
  stroke: var(--spatial-tone);
  stroke-width: 1;
  stroke-dasharray: 3 7;
}
.scene-home.running .arrival-beam,
.scene-home.completed .living-light {
  opacity: 0.22;
}
.scene-home.completed .bedroom-light {
  opacity: 0.09;
}
.scene-away.running .secure-beam,
.scene-away.completed .secure-beam {
  opacity: 0.48;
}
.scene-sleep.running .bedroom-light,
.scene-sleep.completed .bedroom-light {
  fill: #f3ad58;
  opacity: 0.28;
}
.scene-sleep.completed .living-light {
  fill: #5565bc;
  opacity: 0.07;
}
.platform-side.left {
  fill: var(--platform-edge-left);
}
.platform-side.right {
  fill: var(--platform-edge-right);
}
.platform-inset {
  fill: rgba(255, 255, 255, 0.16);
  stroke: rgba(91, 104, 116, 0.12);
  stroke-width: 1;
}
.room {
  stroke: rgba(70, 78, 86, 0.08);
  stroke-width: 0.8;
  transition:
    filter 500ms ease,
    opacity 500ms ease;
}
.foyer {
  fill: #e8e3dc;
}
.passage {
  fill: #f1ece5;
}
.wall {
  stroke: rgba(95, 110, 121, 0.12);
  stroke-width: 0.8;
}
.bedroom-wall-left {
  fill: rgba(239, 235, 229, 0.88);
}
.foyer-wall {
  fill: rgba(226, 232, 234, 0.72);
}
.partition {
  fill: rgba(216, 213, 207, 0.88);
}
.partition.low {
  fill: rgba(200, 206, 208, 0.72);
}
.windows > path:first-child,
.windows > path:nth-child(3) {
  fill: rgba(128, 158, 177, 0.16);
  stroke: rgba(98, 127, 146, 0.18);
}
.window-glow {
  fill: color-mix(in srgb, var(--spatial-tone) 18%, #e9f6ff);
  opacity: 0.8;
  transition:
    fill 500ms ease,
    opacity 500ms ease;
}
.scene-away.completed .window-glow {
  opacity: 0.2;
}
.scene-sleep.completed .window-glow {
  fill: #5d6bb8;
  opacity: 0.35;
}
.scene-sleep.completed .living-room {
  filter: brightness(0.9) saturate(0.7);
}
.rug {
  fill: rgba(176, 160, 141, 0.16);
}
.sofa-seat,
.sofa-back {
  fill: #d9d3cb;
  stroke: rgba(88, 86, 82, 0.13);
  stroke-width: 0.6;
}
.sofa-back {
  fill: #e5e0da;
}
.sofa-back.right {
  fill: #cbc5bd;
}
.table-top {
  fill: rgba(157, 130, 101, 0.52);
}
.table-leg,
.lamp-stem {
  fill: #797d81;
}
.lamp-shade {
  fill: #f1c373;
  filter: drop-shadow(0 0 5px rgba(241, 195, 115, 0.38));
}
.lamp-shade.small {
  fill: #f3d197;
}
.scene-away.completed .lamp-shade {
  fill: #aaa7a1;
  filter: none;
}
.scene-sleep.completed .lamp-shade:not(.small) {
  fill: #8f8a87;
  filter: none;
}
.scene-sleep.completed .lamp-shade.small {
  filter: drop-shadow(0 0 8px rgba(243, 173, 88, 0.64));
}
.bed-base {
  fill: #ece7e0;
}
.bed-side {
  fill: #d5cfc7;
}
.bed-side.right {
  fill: #c6c0b8;
}
.pillow {
  fill: #fbfaf7;
  stroke: rgba(100, 102, 102, 0.1);
}
.nightstand,
.console-top {
  fill: #b19d86;
}
.console-side {
  fill: #8f7d68;
}
.console-front {
  fill: #a9957e;
}
.console-light {
  fill: var(--spatial-tone);
  filter: drop-shadow(0 0 4px var(--spatial-tone));
}
.architectural-lines {
  fill: none;
  stroke: rgba(89, 108, 120, 0.1);
  stroke-width: 0.7;
}
.route-base,
.route-energy {
  fill: none;
  stroke-linecap: round;
  stroke-width: 1.4;
}
.route-base {
  stroke: rgba(102, 126, 143, 0.14);
  stroke-dasharray: 2 5;
}
.route-energy {
  stroke: var(--spatial-tone);
  stroke-dasharray: 2 7;
  opacity: 0;
  filter: drop-shadow(0 0 3px var(--spatial-tone));
  transition: opacity 280ms ease;
}
.route-energy.active {
  opacity: 0.82;
}
.route-energy.failed {
  stroke: var(--danger);
  opacity: 0.9;
}
.running .route-energy.active {
  animation: energy-flow 900ms linear infinite;
}
.scene-away.running .route-energy.active {
  animation-direction: reverse;
}
.node-layer {
  position: absolute;
  inset: 0 0 31px;
  pointer-events: none;
}
.device-node {
  --node-order: 0;
  position: absolute;
  width: 27px;
  height: 27px;
  transform: translate(-50%, -50%);
  display: grid;
  place-items: center;
  color: #87939c;
  background: color-mix(in srgb, var(--card) 93%, transparent);
  border: 1px solid rgba(92, 111, 124, 0.18);
  border-radius: 9px;
  box-shadow:
    0 8px 20px rgba(54, 62, 71, 0.14),
    inset 0 1px 0 rgba(255, 255, 255, 0.7);
  transition:
    color 320ms ease,
    background 320ms ease,
    border-color 320ms ease,
    transform 320ms var(--ease-out),
    opacity 400ms ease;
}
.device-node::after {
  content: "";
  position: absolute;
  width: 9px;
  height: 4px;
  top: calc(100% + 5px);
  background: rgba(32, 38, 43, 0.2);
  border-radius: 50%;
  filter: blur(2px);
}
.device-node > i {
  position: absolute;
  inset: -5px;
  border: 1px solid currentColor;
  border-radius: 12px;
  opacity: 0;
}
.device-node > b {
  position: absolute;
  top: -8px;
  left: -7px;
  width: 13px;
  height: 13px;
  display: grid;
  place-items: center;
  color: #fff;
  background: var(--spatial-tone);
  border: 2px solid var(--card);
  border-radius: 50%;
  font:
    700 6px/1 ui-monospace,
    monospace;
}
.device-node > em {
  position: absolute;
  right: -5px;
  bottom: -5px;
  min-width: 11px;
  height: 11px;
  display: grid;
  place-items: center;
  color: #fff;
  background: var(--spatial-tone);
  border: 1px solid var(--card);
  border-radius: 6px;
  font:
    normal 700 6px/1 ui-monospace,
    monospace;
}
.device-node.confirmed,
.device-node.pending {
  color: var(--spatial-tone);
  background: color-mix(in srgb, var(--spatial-tone) 10%, var(--card));
  border-color: color-mix(in srgb, var(--spatial-tone) 46%, transparent);
  transform: translate(-50%, -54%);
}
.device-node.failed,
.device-node.timeout,
.device-node.offline {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 9%, var(--card));
  border-color: color-mix(in srgb, var(--danger) 50%, transparent);
}
.running .device-node.pending > i,
.failed .device-node.failed > i,
.partial .device-node.failed > i {
  opacity: 0.5;
  animation: node-signal 1.3s ease-out infinite;
}
.scene-away.completed .device-node.confirmed {
  opacity: 0.64;
  transform: translate(-50%, -50%) scale(0.92);
}
.completed .home-world {
  animation: spatial-confirm 900ms var(--ease-out) both;
}
.scene-away.completed .home-world {
  animation: spatial-secure 720ms var(--ease-out) both;
}
.scene-movie.completed .home-world {
  animation: spatial-night 900ms var(--ease-out) both;
}
.scene-sleep.completed .home-world {
  animation: spatial-night 900ms var(--ease-out) both;
}
.failed .home-world {
  animation: spatial-error 520ms ease-out both;
}
.atmosphere {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.atmosphere i {
  position: absolute;
  width: 3px;
  height: 3px;
  background: var(--spatial-tone);
  border-radius: 50%;
  opacity: 0.14;
}
.atmosphere i:nth-child(1) {
  left: 12%;
  top: 31%;
}
.atmosphere i:nth-child(2) {
  right: 15%;
  top: 28%;
}
.atmosphere i:nth-child(3) {
  right: 24%;
  top: 63%;
}
.atmosphere i:nth-child(4) {
  left: 31%;
  top: 72%;
}
.scene-home.running .atmosphere i {
  animation: particle-arrive 2.1s ease-in-out infinite;
}
.scene-away.running .atmosphere i {
  animation: particle-depart 1.8s ease-in-out infinite;
}
.scene-movie.running .atmosphere i {
  animation: particle-arrive 2.1s ease-in-out infinite;
}
.scene-sleep.running .atmosphere i {
  animation: particle-settle 2.5s ease-in-out infinite;
}
.running .atmosphere i:nth-child(2) {
  animation-delay: -0.6s;
}
.running .atmosphere i:nth-child(3) {
  animation-delay: -1.2s;
}
.running .atmosphere i:nth-child(4) {
  animation-delay: -1.8s;
}
.spatial-caption {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 9px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  z-index: 4;
}
.spatial-caption > div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.spatial-caption p {
  display: grid;
  gap: 2px;
  margin: 0;
}
.spatial-caption strong {
  color: var(--text);
  font-size: 10px;
  font-weight: 650;
}
.spatial-caption small {
  color: var(--muted);
  font-size: 7px;
}
.spatial-caption > b {
  color: var(--spatial-tone);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.state-dot {
  width: 7px;
  height: 7px;
  display: grid;
  place-items: center;
  color: var(--spatial-tone);
  background: currentColor;
  border-radius: 50%;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--spatial-tone) 12%, transparent);
}
.state-dot :deep(svg) {
  width: 10px;
  color: currentColor;
}
.partial .state-dot,
.failed .state-dot {
  width: 14px;
  height: 14px;
  background: transparent;
  box-shadow: none;
}
.progress-track {
  position: absolute;
  z-index: 4;
  inset: auto 0 0;
  height: 2px;
  background: color-mix(in srgb, var(--spatial-tone) 8%, transparent);
}
.progress-track i {
  display: block;
  height: 100%;
  background: var(--spatial-tone);
  box-shadow: 0 0 8px color-mix(in srgb, var(--spatial-tone) 50%, transparent);
  transition: width 420ms var(--ease-out);
}

:global(:root[data-theme="dark"] .spatial-core) {
  --platform-light: #333437;
  --platform-shadow: #242528;
  --platform-edge-left: #1c1d20;
  --platform-edge-right: #151619;
  --room-left-a: #323236;
  --room-left-b: #27282b;
  --room-right-a: #353538;
  --room-right-b: #252629;
  --glass-light: rgba(83, 100, 111, 0.34);
  --glass-shadow: rgba(36, 45, 51, 0.55);
}
:global(:root[data-theme="dark"] .spatial-core .foyer) {
  fill: #292a2d;
}
:global(:root[data-theme="dark"] .spatial-core .passage) {
  fill: #2d2e31;
}
:global(:root[data-theme="dark"] .spatial-core .bedroom-wall-left),
:global(:root[data-theme="dark"] .spatial-core .foyer-wall),
:global(:root[data-theme="dark"] .spatial-core .partition) {
  fill: rgba(53, 55, 59, 0.86);
}
:global(:root[data-theme="dark"] .spatial-core .sofa-seat),
:global(:root[data-theme="dark"] .spatial-core .sofa-back) {
  fill: #4b4b4f;
}
:global(:root[data-theme="dark"] .spatial-core .sofa-back.right),
:global(:root[data-theme="dark"] .spatial-core .bed-side) {
  fill: #3e3f42;
}
:global(:root[data-theme="dark"] .spatial-core .bed-base),
:global(:root[data-theme="dark"] .spatial-core .pillow) {
  fill: #57575a;
}

@keyframes spatial-enter {
  from {
    opacity: 0;
    transform: translate(-50%, 12px) scale(0.96);
  }
}
@keyframes spatial-confirm {
  0% {
    filter: saturate(0.88);
  }
  52% {
    filter: drop-shadow(0 5px 16px color-mix(in srgb, var(--spatial-tone) 36%, transparent)) saturate(1.12);
    transform: translate(-50%, -3px) scale(1.012);
  }
}
@keyframes spatial-secure {
  50% {
    filter: saturate(0.75) brightness(0.93);
    transform: translate(-50%, 1px) scale(0.99);
  }
}
@keyframes spatial-night {
  55% {
    filter: brightness(0.9) saturate(0.82);
    transform: translate(-50%, 2px) scale(0.995);
  }
}
@keyframes spatial-error {
  35% {
    transform: translateX(calc(-50% - 3px));
  }
  65% {
    transform: translateX(calc(-50% + 3px));
  }
}
@keyframes energy-flow {
  to {
    stroke-dashoffset: -18;
  }
}
@keyframes node-signal {
  to {
    inset: -13px;
    opacity: 0;
  }
}
@keyframes particle-arrive {
  0%,
  100% {
    opacity: 0;
    transform: translate(12px, 8px) scale(0.7);
  }
  45% {
    opacity: 0.28;
  }
  80% {
    opacity: 0;
    transform: translate(-10px, -12px) scale(1.1);
  }
}
@keyframes particle-depart {
  0%,
  100% {
    opacity: 0;
    transform: translate(-8px, -8px) scale(1);
  }
  35% {
    opacity: 0.26;
  }
  80% {
    opacity: 0;
    transform: translate(15px, 9px) scale(0.55);
  }
}
@keyframes particle-settle {
  0% {
    opacity: 0;
    transform: translateY(-14px) scale(0.7);
  }
  45% {
    opacity: 0.22;
  }
  100% {
    opacity: 0;
    transform: translateY(16px) scale(0.45);
  }
}
@media (max-height: 650px) {
  .spatial-core {
    height: 190px;
  }
  .home-world {
    top: -13px;
    height: 175px;
  }
  .node-layer {
    bottom: 27px;
  }
  .scene-signature {
    top: 7px;
  }
  .scene-signature small {
    display: none;
  }
  .spatial-caption {
    bottom: 7px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .home-world,
  .route-energy,
  .device-node,
  .device-node > i,
  .atmosphere i {
    animation: none !important;
  }
}
</style>
