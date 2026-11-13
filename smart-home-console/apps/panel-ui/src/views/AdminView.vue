<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useDebounceFn } from "@vueuse/core";
import { automationOperatorSupported, capabilityValueError } from "@smart-lab/contracts";
import type {
  AlertRecord,
  AdminConfiguration,
  AdminResourceItem,
  AdminResourceName,
  AuditRecord,
  AutomationConfig,
  BenchResetPreview,
  BenchResetResult,
  HandoverChecklist,
  HandoverCompletion,
  Device,
  GatewayConfig,
  RoomConfig,
  Scene,
  SceneAction,
  TerminalConfig,
  UiUpdateInstallRequest,
  UiUpdateStatus
} from "@smart-lab/contracts";
import SystemHeader from "../components/SystemHeader.vue";
import AdminListPager from "../components/AdminListPager.vue";
import {
  configureNativeHomeAssistant,
  edgeApi,
  nativeHomeAssistantConfigurationAvailable,
  requestNativeDatabaseBackupDownload,
  setAdminAuthExpiredHandler,
  setAdminToken
} from "../lib/api";
import { adminIdleState, idleRemainingLabel } from "../lib/admin-idle";
import { runtimeId } from "../lib/runtime-id";
import { useEdgeStore } from "../stores/edge";
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NEmpty,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSwitch,
  NTag,
  NConfigProvider,
  darkTheme,
  zhCN,
  dateZhCN
} from "naive-ui";

const HandoverModal = defineAsyncComponent(() => import("../components/HandoverModal.vue"));
import { zhijingDarkThemeOverrides, zhijingThemeOverrides } from "../theme/zhijing";
import { useTheme } from "../composables/theme";
import { alertRecoveryAvailability } from "../lib/alerts";
import { KeyRound, RotateCcw } from "lucide-vue-next";
import { nativeAppVersion } from "../lib/terminal-runtime";

type AdminTab = "overview" | "rooms" | "scenes" | "automations" | "alerts" | "gateways" | "terminals" | "backup" | "audit";
type SecondarySlot = "light" | "curtain" | "music";
type DatabaseBackupArtifact = {
  filename: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  integrityStatus: "ok" | "failed";
  schemaVersion?: number;
  verifiedAt: string;
};
type DatabaseBackupStorage = {
  totalBytes: number;
  usableBytes: number;
  reserveBytes: number;
  estimatedNextBackupBytes: number;
  canCreate: boolean;
  level: "healthy" | "warning" | "critical";
  message: string;
};
type DataLifecycleReport = {
  generatedAt: string;
  databaseBytes: number;
  usableBytes: number;
  reserveBytes: number;
  growthBytesPerDay?: number;
  estimatedDaysToReserve?: number;
  trendSamples: number;
  level: "healthy" | "warning" | "critical" | "unknown";
  message: string;
  domains: Array<{
    id: string;
    label: string;
    records: number;
    oldestAt?: string;
    protection: "authoritative" | "safety" | "operational";
    automaticDeletion: boolean;
    guidance: string;
  }>;
};
const edge = useEdgeStore();
const { isDark } = useTheme();
const authenticated = ref(false);
const sessionExpiresAt = ref("");
const sessionNow = ref(Date.now());
const sessionExpired = ref(false);
const pin = ref("");
const authError = ref("");
const authBusy = ref(false);
const authLocked = ref(false);
const authNotice = ref("");
const sessionLockReason = ref<"expired" | "idle" | "manual">("expired");
const lastAdminActivityAt = ref(Date.now());
const active = ref<AdminTab>("overview");
const config = ref<AdminConfiguration>();
const busy = ref(false);
const benchResetOpen = ref(false);
const benchResetBusy = ref(false);
const benchResetPreview = ref<BenchResetPreview>();
const benchResetResult = ref<BenchResetResult>();
const benchResetError = ref("");
const handoverOpen = ref(false);
const handoverBusy = ref(false);
const handoverChecklist = ref<HandoverChecklist>();
const handoverCompletion = ref<HandoverCompletion>();
const handoverAcknowledgements = reactive<Record<string, boolean>>({});
const handoverCompletionId = ref("");
const handoverCompletedBy = ref("");
const handoverNote = ref("");
const handoverError = ref("");
const saved = ref(false);
const savedConfigSnapshot = ref("");
let draftPersistence: { flush(): void; stop(): void } | undefined;
const saveError = ref("");
const haNativeAvailable = nativeHomeAssistantConfigurationAvailable();
const appVersion = nativeAppVersion();
const haSetup = reactive({
  baseUrl: "http://192.168.0.110:8123",
  token: "",
  gatewayEntityId: "sensor.lumi_cn_599968967_mcn001_ip_address_p_2_2",
  lightEntityId: "light.xiaomi_cn_2142280092_btlm2_s_2_light"
});
const haSetupBusy = ref(false);
const reauthenticationConflict = ref(false);
const configurationConflictOpen = ref(false);
const configurationConflictServer = ref<AdminConfiguration>();
const configurationConflictChoices = reactive<Record<string, "local" | "server">>({});
const leaveTarget = ref<AdminTab | "logout">();
const dangerDialog = ref<{ title: string; detail: string; confirmLabel: string; action: () => void | Promise<void> }>();
const dangerBusy = ref(false);
const backupText = ref("");
const backupCandidate = ref<AdminConfiguration>();
const backupPreviewOpen = ref(false);
const operationFeedback = ref<{ type: "success" | "info" | "warning" | "error"; message: string }>();
const uiUpdateText = ref("");
const uiUpdateStatus = ref<UiUpdateStatus>();
const uiUpdateBusy = ref(false);
const databaseBackups = ref<DatabaseBackupArtifact[]>([]);
const databaseBackupStorage = ref<DatabaseBackupStorage>();
const dataLifecycle = ref<DataLifecycleReport>();
const databaseBackupBusy = ref(false);
const pinChangeOpen = ref(false);
const pinChangeBusy = ref(false);
const currentAdminPin = ref("");
const newAdminPin = ref("");
const confirmAdminPin = ref("");
const pinChangeError = ref("");
const pairingCode = ref("");
const newAutomationName = ref("门开联动");
const alertQuery = ref("");
const alertFilter = ref<"all" | "open" | "acknowledged" | "recovered">("all");
const alertActions = ref<Record<string, "recovering" | "failed">>({});
const alertActionErrors = ref<Record<string, string>>({});
const activePageError = computed(
  () => (tabResources[active.value] ?? []).map((resource) => pageStates[resource].error).find(Boolean) ?? ""
);
const configSnapshot = computed(() => (config.value ? JSON.stringify(config.value) : ""));
const hasUnsavedChanges = computed(
  () => authenticated.value && Boolean(savedConfigSnapshot.value) && configSnapshot.value !== savedConfigSnapshot.value
);
function clearPersistedAdminDraft() {
  void import("../lib/admin-draft").then((module) => module.clearAdminConfigurationDraft());
}
watch(
  () => edge.alerts.map((alert) => `${alert.id}:${alert.acknowledgedAt ?? ""}:${alert.recoveredAt ?? ""}`).join("|"),
  () => {
    const items = pageStates.alerts.items;
    for (const latest of edge.alerts) {
      const index = items.findIndex((item) => item.id === latest.id);
      if (index >= 0) items.splice(index, 1, latest);
    }
  }
);
watch(
  () => edge.terminalRevision,
  () => {
    const latest = edge.latestTerminalUpdate;
    if (latest && config.value) {
      const terminal = config.value.terminals.find((item) => item.id === latest.id);
      if (terminal) {
        terminal.online = latest.online;
        terminal.version = latest.version;
        terminal.address = latest.address;
        terminal.lastSeenAt = latest.lastSeenAt;
      }
      // 在线租约是服务端运行态，不应让后台误报“有未保存修改”；同步更新保存基线，
      // 同时保留用户正在编辑的其他配置字段。
      if (savedConfigSnapshot.value) {
        const baseline = JSON.parse(savedConfigSnapshot.value) as AdminConfiguration;
        const savedTerminal = baseline.terminals.find((item) => item.id === latest.id);
        if (savedTerminal) {
          savedTerminal.online = latest.online;
          savedTerminal.version = latest.version;
          savedTerminal.address = latest.address;
          savedTerminal.lastSeenAt = latest.lastSeenAt;
          savedConfigSnapshot.value = JSON.stringify(baseline);
        }
      }
    }
    // 状态筛选可能让该行进入或退出当前结果集，仍需刷新分页元数据。
    if (active.value === "terminals" && authenticated.value) void loadPage("terminals");
  }
);
const configValidationErrors = computed(() => {
  if (!config.value) return [];
  const errors: string[] = [];
  if (!config.value.rooms.length) errors.push("至少需要保留 1 个房间");
  if (config.value.rooms.some((item) => !item.name.trim())) errors.push("房间名称不能为空");
  const roomNames = config.value.rooms.map((item) => item.name.trim());
  if (new Set(roomNames).size !== roomNames.length) errors.push("房间名称不能重复");
  if (config.value.devices.some((item) => item.kind !== "gateway" && !roomNames.includes(item.room.trim())))
    errors.push("设备必须归属于现有房间");
  if (config.value.scenes.some((item) => !item.name.trim())) errors.push("场景名称不能为空");
  if (config.value.automations.some((item) => !item.name.trim())) errors.push("联动名称不能为空");
  const emptyEnabledScenes = config.value.scenes.filter((item) => item.enabled !== false && !item.actions.length);
  if (emptyEnabledScenes.length)
    errors.push(`启用场景至少需要 1 个动作：${emptyEnabledScenes.map((item) => item.name || "未命名").join("、")}`);
  const emptyEnabledAutomations = config.value.automations.filter((item) => item.enabled && !item.actions.length);
  if (emptyEnabledAutomations.length)
    errors.push(`启用联动至少需要 1 个动作：${emptyEnabledAutomations.map((item) => item.name || "未命名").join("、")}`);
  const duplicateDeviceIds = [
    ...new Set(config.value.devices.map((item) => item.id).filter((id, index, ids) => ids.indexOf(id) !== index))
  ];
  if (duplicateDeviceIds.length) errors.push(`设备 ID 不能重复：${duplicateDeviceIds.join("、")}`);
  const hiddenSafetyDevices = config.value.devices.filter(
    (item) => (item.kind === "sensor" || item.kind === "lock") && item.display?.hidden
  );
  if (hiddenSafetyDevices.length) errors.push(`安防设备不能从主屏隐藏：${hiddenSafetyDevices.map((item) => item.name).join("、")}`);
  const benchPolicy = config.value.benchResetPolicy;
  if (!benchPolicy || !["off", "unchanged"].includes(benchPolicy.power)) errors.push("复位照明策略无效");
  if (!benchPolicy || !["closed", "open", "unchanged"].includes(benchPolicy.cover)) errors.push("复位窗帘策略无效");
  if (
    !benchPolicy ||
    !Number.isInteger(benchPolicy.automationSuppressionSeconds) ||
    benchPolicy.automationSuppressionSeconds < 3 ||
    benchPolicy.automationSuppressionSeconds > 30
  )
    errors.push("复位联动抑制必须为 3–30 秒的整数");
  if (
    config.value.automations.some(
      (item) => !Number.isInteger(item.cooldownSeconds) || item.cooldownSeconds < 1 || item.cooldownSeconds > 86_400
    )
  )
    errors.push("联动冷却时间必须为 1–86400 秒的整数");
  if (config.value.gateways.some((item) => !item.name.trim() || !item.host.trim())) errors.push("网关名称和主机地址不能为空");
  if (!config.value.gateways.length) errors.push("每台实训台至少需要配置 1 个本地网关");
  if (new Set(config.value.gateways.map((item) => item.id)).size !== config.value.gateways.length) errors.push("网关 ID 不能重复");
  if (config.value.gateways.some((item) => !Number.isInteger(item.port) || item.port < 1 || item.port > 65_535))
    errors.push("网关端口必须为 1–65535 的整数");
  if (config.value.gateways.some((item) => !item.credentialRef.startsWith("keystore://")))
    errors.push("网关凭据引用已失效，请在本机 Keystore 重新写入凭据后恢复配置");
  const gatewayIds = new Set(config.value.gateways.map((item) => item.id));
  if (config.value.devices.some((item) => item.integration.gatewayId && !gatewayIds.has(item.integration.gatewayId)))
    errors.push("存在设备引用了未配置的网关，请先修正设备归属");
  for (const definition of secondarySlotDefinitions) {
    const devices = config.value.devices.filter((device) => device.display?.secondarySlot === definition.id);
    if (devices.length > 1) errors.push(`${definition.label}只能选择 1 个设备`);
    if (devices.some((device) => !supportsSecondarySlot(device, definition.id))) errors.push(`${definition.label}设备缺少所需可写能力`);
  }
  const knownSecondarySlots = new Set(secondarySlotDefinitions.map((item) => item.id as string));
  const unknownSecondaryDevices = config.value.devices.filter(
    (device) => device.display?.secondarySlot && !knownSecondarySlots.has(device.display.secondarySlot)
  );
  if (unknownSecondaryDevices.length)
    errors.push(`副屏快捷槽位版本不兼容：${unknownSecondaryDevices.map((device) => device.name).join("、")}`);
  const devicesById = new Map(config.value.devices.map((device) => [device.id, device]));
  for (const scene of config.value.scenes) {
    for (const action of scene.actions) {
      const device = devicesById.get(action.deviceId);
      if (!device) errors.push(`场景“${scene.name || "未命名"}”引用了不存在的设备 ${action.deviceId}`);
      else {
        const capability = device.capabilities.find((item) => item.property === action.property && item.writable);
        if (!capability) errors.push(`场景“${scene.name || "未命名"}”不能写入 ${device.name}.${action.property}`);
        else if (capabilityValueError(capability, action.value))
          errors.push(`场景“${scene.name || "未命名"}”的 ${device.name}.${capability.label} 值不符合能力范围或类型`);
      }
    }
  }
  for (const automation of config.value.automations) {
    const source = devicesById.get(automation.condition.deviceId);
    if (!source) errors.push(`联动“${automation.name || "未命名"}”的条件设备不存在`);
    else {
      const capability = source.capabilities.find((item) => item.property === automation.condition.property);
      if (!capability) errors.push(`联动“${automation.name || "未命名"}”的条件属性 ${source.name}.${automation.condition.property} 不存在`);
      else {
        if (!automationOperatorSupported(capability, automation.condition.operator, source.state[automation.condition.property]))
          errors.push(`联动“${automation.name || "未命名"}”的 ${capability.label} 只能使用等于或不等于`);
        if (capabilityValueError(capability, automation.condition.value))
          errors.push(`联动“${automation.name || "未命名"}”的条件值不符合 ${source.name}.${capability.label} 能力`);
      }
    }
    for (const action of automation.actions) {
      const target = devicesById.get(action.deviceId);
      if (!target) errors.push(`联动“${automation.name || "未命名"}”的动作设备 ${action.deviceId} 不存在`);
      else {
        const capability = target.capabilities.find((item) => item.property === action.property && item.writable);
        if (!capability) errors.push(`联动“${automation.name || "未命名"}”不能写入 ${target.name}.${action.property}`);
        else if (capabilityValueError(capability, action.value))
          errors.push(`联动“${automation.name || "未命名"}”的 ${target.name}.${capability.label} 值不符合能力范围或类型`);
      }
    }
  }
  return errors;
});
const safeCompatibilityRepairCount = computed(() => {
  if (!config.value) return 0;
  const slotOwners = new Map<string, number>();
  config.value.devices.forEach((device) => {
    if (device.display?.secondarySlot)
      slotOwners.set(device.display.secondarySlot, (slotOwners.get(device.display.secondarySlot) ?? 0) + 1);
  });
  return (
    config.value.devices.filter((device) => (device.kind === "sensor" || device.kind === "lock") && device.display?.hidden).length +
    config.value.devices.filter((device) => {
      const slot = device.display?.secondarySlot;
      if (!slot) return false;
      const definition = secondarySlotDefinitions.find((item) => item.id === slot);
      return !definition || (slotOwners.get(slot) ?? 0) > 1 || !supportsSecondarySlot(device, definition.id);
    }).length +
    config.value.scenes.filter((scene) => scene.enabled !== false && !scene.actions.length).length +
    config.value.automations.filter((automation) => automation.enabled && !automation.actions.length).length
  );
});
function createSafeCompatibilityRepairDraft() {
  if (!config.value) return;
  const slotOwners = new Map<string, number>();
  config.value.devices.forEach((device) => {
    if (device.display?.secondarySlot)
      slotOwners.set(device.display.secondarySlot, (slotOwners.get(device.display.secondarySlot) ?? 0) + 1);
  });
  let repaired = 0;
  config.value.devices.forEach((device) => {
    device.display ??= {};
    if ((device.kind === "sensor" || device.kind === "lock") && device.display.hidden) {
      device.display.hidden = false;
      repaired += 1;
    }
    const slot = device.display.secondarySlot;
    if (!slot) return;
    const definition = secondarySlotDefinitions.find((item) => item.id === slot);
    if (!definition || (slotOwners.get(slot) ?? 0) > 1 || !supportsSecondarySlot(device, definition.id)) {
      device.display.secondarySlot = undefined;
      repaired += 1;
    }
  });
  config.value.scenes.forEach((scene) => {
    if (scene.enabled !== false && !scene.actions.length) {
      scene.enabled = false;
      repaired += 1;
    }
  });
  config.value.automations.forEach((automation) => {
    if (automation.enabled && !automation.actions.length) {
      automation.enabled = false;
      repaired += 1;
    }
  });
  feedback("warning", `已生成安全修复草稿：修复 ${repaired} 项显示/启用状态；请继续处理剩余问题并检查后保存`);
}
const sessionRemainingMs = computed(() => (sessionExpiresAt.value ? new Date(sessionExpiresAt.value).getTime() - sessionNow.value : 0));
const sessionStatus = computed(() => {
  if (!sessionExpiresAt.value) return "";
  const minutes = Math.max(0, Math.ceil(sessionRemainingMs.value / 60_000));
  if (minutes > 60) return `会话剩余 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  return `会话剩余 ${minutes} 分`;
});
const sessionExpiringSoon = computed(() => authenticated.value && sessionRemainingMs.value > 0 && sessionRemainingMs.value <= 15 * 60_000);
const idleState = computed(() => adminIdleState(lastAdminActivityAt.value, sessionNow.value));
const idleWarning = computed(() => authenticated.value && !sessionExpired.value && idleState.value.warning);
const idleStatus = computed(() => idleRemainingLabel(idleState.value.remainingMs));
const backupSummary = computed(() => {
  if (!backupCandidate.value || !config.value) return undefined;
  const candidate = backupCandidate.value;
  const changedItems = <T extends { id: string }>(current: T[], next: T[]) => {
    const byId = new Map(current.map((item) => [item.id, JSON.stringify(item)]));
    return next.filter((item) => byId.has(item.id) && byId.get(item.id) !== JSON.stringify(item)).length;
  };
  const delta = (current: { id: string }[], next: { id: string }[]) => ({
    added: next.filter((item) => !current.some((source) => source.id === item.id)).length,
    removed: current.filter((item) => !next.some((target) => target.id === item.id)).length
  });
  return {
    sourceVersion: candidate.version,
    exportedAt: candidate.exportedAt,
    rooms: {
      ...delta(config.value.rooms, candidate.rooms),
      changed: changedItems(config.value.rooms, candidate.rooms),
      total: candidate.rooms.length
    },
    devices: {
      ...delta(config.value.devices, candidate.devices),
      changed: changedItems(config.value.devices, candidate.devices),
      total: candidate.devices.length
    },
    scenes: {
      ...delta(config.value.scenes, candidate.scenes),
      changed: changedItems(config.value.scenes, candidate.scenes),
      total: candidate.scenes.length
    },
    automations: {
      ...delta(config.value.automations, candidate.automations),
      changed: changedItems(config.value.automations, candidate.automations),
      total: candidate.automations.length
    },
    gateways: {
      ...delta(config.value.gateways, candidate.gateways),
      changed: changedItems(config.value.gateways, candidate.gateways),
      total: candidate.gateways.length
    },
    terminals: {
      ...delta(config.value.terminals, candidate.terminals),
      changed: changedItems(config.value.terminals, candidate.terminals),
      total: candidate.terminals.length
    }
  };
});
const backupRestoreBlockReason = computed(() => "");
type MergeResource = "rooms" | "devices" | "scenes" | "automations" | "gateways" | "terminals";
type MergeItem = { id: string; name?: string };
const mergeResources: Array<{ key: MergeResource; label: string }> = [
  { key: "rooms", label: "房间" },
  { key: "devices", label: "设备" },
  { key: "scenes", label: "场景" },
  { key: "automations", label: "联动" },
  { key: "gateways", label: "网关" },
  { key: "terminals", label: "终端" }
];
const configurationMergePlan = computed(() => {
  if (!config.value || !savedConfigSnapshot.value || !configurationConflictServer.value) return undefined;
  let baseline: AdminConfiguration;
  try {
    baseline = JSON.parse(savedConfigSnapshot.value) as AdminConfiguration;
  } catch {
    return undefined;
  }
  const local = config.value;
  const server = configurationConflictServer.value;
  const conflicts: Array<{
    key: string;
    resource: MergeResource | "benchResetPolicy";
    resourceLabel: string;
    id: string;
    label: string;
    localAction: string;
    serverAction: string;
  }> = [];
  let localOnly = 0;
  let serverOnly = 0;
  const action = (before: MergeItem | undefined, after: MergeItem | undefined) => (!before ? "新增" : !after ? "删除" : "修改");
  for (const resource of mergeResources) {
    const baseItems = baseline[resource.key] as MergeItem[];
    const localItems = local[resource.key] as MergeItem[];
    const serverItems = server[resource.key] as MergeItem[];
    const ids = new Set([...baseItems, ...localItems, ...serverItems].map((item) => item.id));
    for (const id of ids) {
      const baseItem = baseItems.find((item) => item.id === id);
      const localItem = localItems.find((item) => item.id === id);
      const serverItem = serverItems.find((item) => item.id === id);
      const localChanged = JSON.stringify(localItem) !== JSON.stringify(baseItem);
      const serverChanged = JSON.stringify(serverItem) !== JSON.stringify(baseItem);
      if (localChanged && serverChanged && JSON.stringify(localItem) !== JSON.stringify(serverItem)) {
        conflicts.push({
          key: `${resource.key}:${id}`,
          resource: resource.key,
          resourceLabel: resource.label,
          id,
          label: localItem?.name ?? serverItem?.name ?? baseItem?.name ?? id,
          localAction: action(baseItem, localItem),
          serverAction: action(baseItem, serverItem)
        });
      } else if (localChanged) localOnly += 1;
      else if (serverChanged) serverOnly += 1;
    }
  }
  const basePolicy = baseline.benchResetPolicy;
  const localPolicy = local.benchResetPolicy;
  const serverPolicy = server.benchResetPolicy;
  const localPolicyChanged = JSON.stringify(localPolicy) !== JSON.stringify(basePolicy);
  const serverPolicyChanged = JSON.stringify(serverPolicy) !== JSON.stringify(basePolicy);
  if (localPolicyChanged && serverPolicyChanged && JSON.stringify(localPolicy) !== JSON.stringify(serverPolicy)) {
    conflicts.push({
      key: "benchResetPolicy:policy",
      resource: "benchResetPolicy",
      resourceLabel: "交接策略",
      id: "policy",
      label: "设备安全复位策略",
      localAction: "修改",
      serverAction: "修改"
    });
  } else if (localPolicyChanged) localOnly += 1;
  else if (serverPolicyChanged) serverOnly += 1;
  return { baseline, local, server, conflicts, localOnly, serverOnly };
});
const unresolvedConfigurationConflicts = computed(
  () => configurationMergePlan.value?.conflicts.filter((item) => !configurationConflictChoices[item.key]).length ?? 0
);
let sessionTimer: number | undefined;

function feedback(type: "success" | "info" | "warning" | "error", message: string) {
  operationFeedback.value = { type, message };
}

function formatDateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

interface PageState<T extends AdminResourceItem> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  q: string;
  status: string;
  loading: boolean;
  error: string;
}

function createPageState<T extends AdminResourceItem>(pageSize = 6): PageState<T> {
  return { items: [], page: 1, pageSize, total: 0, totalPages: 1, q: "", status: "all", loading: false, error: "" };
}

const pageStates = reactive({
  rooms: createPageState<RoomConfig>(4),
  devices: createPageState<Device>(8),
  scenes: createPageState<Scene>(4),
  automations: createPageState<AutomationConfig>(6),
  alerts: createPageState<AlertRecord>(8),
  gateways: createPageState<GatewayConfig>(6),
  terminals: createPageState<TerminalConfig>(8),
  audits: createPageState<AuditRecord>(10)
});
const pageRequestIds: Record<keyof typeof pageStates, number> = {
  rooms: 0,
  devices: 0,
  scenes: 0,
  automations: 0,
  alerts: 0,
  gateways: 0,
  terminals: 0,
  audits: 0
};

type PageResource = keyof typeof pageStates;
const tabResources: Partial<Record<AdminTab, PageResource[]>> = {
  rooms: ["rooms", "devices"],
  scenes: ["scenes"],
  automations: ["automations"],
  alerts: ["alerts"],
  gateways: ["gateways"],
  terminals: ["terminals"],
  audit: ["audits"]
};

const tabs = [
  { id: "overview", label: "运行总览" },
  { id: "rooms", label: "房间与设备" },
  { id: "scenes", label: "场景编排" },
  { id: "automations", label: "自动联动" },
  { id: "alerts", label: "告警中心" },
  { id: "gateways", label: "网关配置" },
  { id: "terminals", label: "终端管理" },
  { id: "backup", label: "配置备份" },
  { id: "audit", label: "审计日志" }
] as const;

const tabKickers: Record<AdminTab, string> = {
  overview: "系统状态",
  rooms: "空间配置",
  scenes: "场景配置",
  automations: "联动规则",
  alerts: "事件管理",
  gateways: "本地接入",
  terminals: "双屏终端",
  backup: "配置安全",
  audit: "操作记录"
};

const deviceOptions = computed(() =>
  (config.value?.devices ?? edge.devices).map((item) => ({ label: `${item.name} · ${item.room}`, value: item.id }))
);
const writableDeviceOptions = computed(() => writableDevices().map((item) => ({ label: item.name, value: item.id })));
const roomOptions = computed(() => config.value?.rooms.map((item) => ({ label: item.name, value: item.name })) ?? []);
const secondarySlotDefinitions: Array<{ id: SecondarySlot; label: string; properties: string[] }> = [
  { id: "light", label: "副屏灯光", properties: ["power", "brightness"] },
  { id: "curtain", label: "副屏窗帘", properties: ["position", "motor"] },
  { id: "music", label: "副屏音乐", properties: ["power", "volume"] }
];
function supportsSecondarySlot(device: Device, slot: SecondarySlot) {
  const definition = secondarySlotDefinitions.find((item) => item.id === slot)!;
  return definition.properties.every((property) =>
    device.capabilities.some((capability) => capability.property === property && capability.writable)
  );
}
function secondarySlotOptions(slot: SecondarySlot) {
  return (config.value?.devices ?? [])
    .filter((device) => supportsSecondarySlot(device, slot))
    .map((device) => ({ label: `${device.name} · ${device.room}`, value: device.id }));
}
function secondarySlotValue(slot: SecondarySlot) {
  return config.value?.devices.find((device) => device.display?.secondarySlot === slot)?.id ?? null;
}
function setSecondarySlot(slot: SecondarySlot, deviceId: string | number | null) {
  if (!config.value) return;
  config.value.devices.forEach((device) => {
    device.display ??= {};
    if (device.display.secondarySlot === slot) device.display.secondarySlot = undefined;
  });
  if (!deviceId) return;
  const device = config.value.devices.find((item) => item.id === String(deviceId));
  if (device && supportsSecondarySlot(device, slot)) device.display!.secondarySlot = slot;
}
const strategyOptions = [
  { label: "串行执行", value: "serial" },
  { label: "并行执行", value: "parallel" }
];
const operatorOptions = [
  { label: "等于", value: "eq" },
  { label: "不等于", value: "neq" },
  { label: "大于", value: "gt" },
  { label: "大于等于", value: "gte" },
  { label: "小于", value: "lt" },
  { label: "小于等于", value: "lte" }
];
const alertFilterOptions = [
  { label: "全部状态", value: "all" },
  { label: "待处理", value: "open" },
  { label: "已确认", value: "acknowledged" },
  { label: "已恢复", value: "recovered" }
];
const enabledFilterOptions = [
  { label: "全部状态", value: "all" },
  { label: "已启用", value: "enabled" },
  { label: "已停用", value: "disabled" }
];
const deviceFilterOptions = [
  { label: "全部状态", value: "all" },
  { label: "在线", value: "online" },
  { label: "离线", value: "offline" },
  { label: "异常", value: "degraded" },
  { label: "待实机验证", value: "hardware-pending" },
  { label: "受阻", value: "blocked" }
];
const gatewayFilterOptions = [
  { label: "全部模式", value: "all" },
  { label: "本地", value: "local" },
  { label: "HA 云链路", value: "ha-cloud" },
  { label: "已测试", value: "tested" }
];
const terminalFilterOptions = [
  { label: "全部状态", value: "all" },
  { label: "在线", value: "online" },
  { label: "离线", value: "offline" },
  { label: "已配对", value: "paired" },
  { label: "未配对", value: "unpaired" }
];
function isBrowserTerminal(terminal: TerminalConfig) {
  return /(?:web|browser|debug|浏览器|调试)/i.test(`${terminal.id} ${terminal.name}`);
}
const physicalTerminalCount = computed(() => config.value?.terminals.filter((terminal) => !isBrowserTerminal(terminal)).length ?? 0);
const onlinePhysicalTerminalCount = computed(
  () => config.value?.terminals.filter((terminal) => !isBrowserTerminal(terminal) && terminal.online).length ?? 0
);
const browserTerminalCount = computed(() => config.value?.terminals.filter(isBrowserTerminal).length ?? 0);
function terminalRoleLabel(terminal: TerminalConfig) {
  if (isBrowserTerminal(terminal)) return "Web 调试";
  return terminal.role === "primary" ? "主屏" : "副屏";
}
function terminalStatusDetail(terminal: TerminalConfig) {
  if (!terminal.paired) return "授权已撤销，需要重新配对后才能控制设备";
  if (terminal.online) {
    return isBrowserTerminal(terminal) ? "当前浏览器调试会话已连接" : `${terminalRoleLabel(terminal)}心跳正常，可接收实时状态`;
  }
  return isBrowserTerminal(terminal)
    ? "浏览器会话已关闭或网络已变化，不影响物理屏运行"
    : `${terminalRoleLabel(terminal)}最近心跳中断，请检查屏幕供电、网络和应用运行状态`;
}
const auditFilterOptions = [
  { label: "全部结果", value: "all" },
  { label: "成功", value: "success" },
  { label: "失败", value: "failed" },
  { label: "处理中", value: "pending" }
];
function capabilityOptions(action: SceneAction) {
  return writableCapabilities(action).map((item) => ({ label: item.label, value: item.property }));
}

async function loadPage<R extends PageResource>(resource: R) {
  const state = pageStates[resource] as PageState<AdminResourceItem>;
  const requestId = ++pageRequestIds[resource];
  state.loading = true;
  state.error = "";
  try {
    const result = await edgeApi.adminResource<AdminResourceItem>(resource as AdminResourceName, {
      page: state.page,
      pageSize: state.pageSize,
      q: state.q,
      status: state.status
    });
    if (requestId === pageRequestIds[resource]) Object.assign(state, result.data);
  } catch (error) {
    if (requestId === pageRequestIds[resource]) state.error = error instanceof Error ? error.message : "查询失败";
  } finally {
    if (requestId === pageRequestIds[resource]) state.loading = false;
  }
}

async function loadActivePages() {
  await Promise.all((tabResources[active.value] ?? []).map((resource) => loadPage(resource)));
  if (active.value === "terminals" && edge.health?.mode === "hardware") {
    pairingCode.value = (await edgeApi.pairingCode()).data.code;
  }
  if (active.value === "backup" && edge.health?.mode === "hardware") {
    await Promise.all([
      edgeApi
        .uiUpdateStatus()
        .then((result) => (uiUpdateStatus.value = result.data))
        .catch(() => (uiUpdateStatus.value = undefined)),
      loadDatabaseBackups()
    ]);
  }
  if (active.value === "overview" && edge.health?.mode === "hardware") {
    await edgeApi
      .dataLifecycle()
      .then((result) => (dataLifecycle.value = result.data))
      .catch(() => (dataLifecycle.value = undefined));
  }
}

async function loadDatabaseBackups() {
  try {
    const [backups, storage, lifecycle] = await Promise.all([
      edgeApi.databaseBackups(),
      edgeApi.databaseBackupStorage(),
      edgeApi.dataLifecycle()
    ]);
    databaseBackups.value = backups.data;
    databaseBackupStorage.value = storage.data;
    dataLifecycle.value = lifecycle.data;
  } catch {
    databaseBackups.value = [];
    databaseBackupStorage.value = undefined;
    dataLifecycle.value = undefined;
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function createDatabaseBackup() {
  if (databaseBackupBusy.value) return;
  databaseBackupBusy.value = true;
  try {
    const artifact = (await edgeApi.createDatabaseBackup()).data;
    await loadDatabaseBackups();
    feedback("success", `数据库快照已创建：${artifact.filename}`);
  } catch (error) {
    feedback("error", `数据库快照创建失败：${error instanceof Error ? error.message : "服务不可用"}`);
  } finally {
    databaseBackupBusy.value = false;
  }
}

async function downloadDatabaseBackup(artifact: DatabaseBackupArtifact) {
  if (databaseBackupBusy.value) return;
  if (requestNativeDatabaseBackupDownload(artifact.filename)) {
    feedback("info", `正在导出到 Download/SmartLab；完成后请核对 SHA-256：${artifact.sha256}`);
    return;
  }
  databaseBackupBusy.value = true;
  try {
    const result = await edgeApi.downloadDatabaseBackup(artifact.filename);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(result.blob);
    link.download = result.filename ?? artifact.filename;
    link.click();
    URL.revokeObjectURL(link.href);
    feedback("success", `已导出数据库快照；请同时保存 SHA-256：${artifact.sha256}`);
  } catch (error) {
    feedback("error", `数据库快照导出失败：${error instanceof Error ? error.message : "服务不可用"}`);
  } finally {
    databaseBackupBusy.value = false;
  }
}

async function setPage(resource: PageResource, page: number) {
  pageStates[resource].page = page;
  await loadPage(resource);
}

async function setPageSize(resource: PageResource, pageSize: number) {
  pageStates[resource].pageSize = pageSize;
  pageStates[resource].page = 1;
  await loadPage(resource);
}

function resetPage(resource: PageResource) {
  pageStates[resource].page = 1;
  void loadPage(resource);
}

const schedulePageReset = useDebounceFn((resource: PageResource) => resetPage(resource), 260);

function configItems<T extends AdminResourceItem>(resource: Exclude<PageResource, "alerts" | "audits">): T[] {
  const ids = new Set((pageStates[resource].items as AdminResourceItem[]).map((item) => item.id));
  const key = resource as keyof Pick<AdminConfiguration, "rooms" | "devices" | "scenes" | "automations" | "gateways" | "terminals">;
  return ((config.value?.[key] ?? []) as T[]).filter((item) => ids.has(item.id));
}

async function login() {
  if (authBusy.value || authLocked.value || !pin.value) return;
  authBusy.value = true;
  let sessionIssued = false;
  try {
    const session = await edgeApi.adminLogin(pin.value);
    sessionIssued = true;
    // PIN 通过不等于后台可用；必须先取得本次会话下的权威配置，才原子解锁管理工作区。
    await loadAdmin();
    authenticated.value = true;
    const draftModule = await import("../lib/admin-draft");
    const recovery = config.value
      ? await draftModule.recoverAdminConfigurationDraft(
          config.value,
          tabs.map((tab) => tab.id),
          formatDateTime
        )
      : undefined;
    if (recovery?.choice === "discard") feedback("info", recovery.message);
    else if (recovery?.choice === "restore") {
      const latest = config.value!;
      config.value = recovery.local;
      savedConfigSnapshot.value = JSON.stringify(recovery.savedSnapshot);
      active.value = recovery.activeTab as AdminTab;
      reauthenticationConflict.value = recovery.serverChanged;
      saveError.value = recovery.serverChanged ? "CONFIG_VERSION_CONFLICT" : "";
      configurationConflictServer.value = recovery.serverChanged ? latest : undefined;
      feedback(recovery.feedbackType, recovery.feedbackMessage);
    }
    draftPersistence?.stop();
    draftPersistence = draftModule.startAdminDraftPersistence(
      () => ({ authenticated: authenticated.value, baseline: savedConfigSnapshot.value, local: config.value, activeTab: active.value }),
      (type, message) => feedback(type, message)
    );
    sessionExpired.value = false;
    sessionExpiresAt.value = session.data.expiresAt;
    sessionNow.value = Date.now();
    authError.value = "";
    authNotice.value = "";
    authLocked.value = false;
    lastAdminActivityAt.value = Date.now();
    pin.value = "";
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (sessionIssued) {
      // 刚签发的会话没有完成管理端启动，不得在服务端留下无人持有的长效 Bearer。
      await edgeApi.adminLogout().catch(() => setAdminToken(""));
      authenticated.value = false;
      sessionExpired.value = false;
      sessionExpiresAt.value = "";
      config.value = undefined;
      savedConfigSnapshot.value = "";
    }
    authError.value =
      code === "INVALID_ADMIN_PIN"
        ? "PIN 不正确"
        : code === "TOO_MANY_AUTH_ATTEMPTS"
          ? "PIN 尝试次数过多，管理入口已锁定 15 分钟；请停止重试并联系现场管理员核对 PIN"
          : sessionIssued
            ? "PIN 已通过，但权威管理配置未能加载；本次会话已安全退出，请检查 EdgeCore 后重试"
            : "管理服务暂不可用，请检查 EdgeCore 连接";
    authLocked.value = code === "TOO_MANY_AUTH_ATTEMPTS";
    pin.value = "";
  } finally {
    authBusy.value = false;
  }
}

function normalizeAdminConfiguration(value: AdminConfiguration) {
  value.benchResetPolicy ??= { power: "off", cover: "closed", automationSuppressionSeconds: 8 };
  value.devices.forEach((device, order) => {
    device.display ??= { order };
    device.display.order ??= order;
    device.display.hidden ??= false;
    device.display.favorite ??= false;
  });
  return value;
}

function savedConfigurationVersion() {
  if (!savedConfigSnapshot.value) return undefined;
  try {
    return (JSON.parse(savedConfigSnapshot.value) as AdminConfiguration).version;
  } catch {
    return undefined;
  }
}

async function reauthenticate() {
  if (authBusy.value || authLocked.value || !pin.value) return;
  authBusy.value = true;
  const preserveLocalChanges = hasUnsavedChanges.value;
  let sessionIssued = false;
  try {
    const session = await edgeApi.adminLogin(pin.value);
    sessionIssued = true;
    // 恢复前必须读取权威版本：无本地修改时直接同步；有修改时只探测版本，绝不覆盖编辑内容。
    const latest = normalizeAdminConfiguration((await edgeApi.adminConfig()).data);
    const serverChangedWhileLocked = preserveLocalChanges && latest.version !== savedConfigurationVersion();
    if (!preserveLocalChanges) {
      config.value = latest;
      savedConfigSnapshot.value = JSON.stringify(latest);
      saveError.value = "";
    } else if (serverChangedWhileLocked) {
      saveError.value = "CONFIG_VERSION_CONFLICT";
      configurationConflictServer.value = latest;
    }
    reauthenticationConflict.value = Boolean(serverChangedWhileLocked);
    await loadActivePages();
    sessionExpiresAt.value = session.data.expiresAt;
    sessionNow.value = Date.now();
    sessionExpired.value = false;
    sessionLockReason.value = "expired";
    lastAdminActivityAt.value = Date.now();
    authError.value = "";
    authLocked.value = false;
    pin.value = "";
    feedback(
      serverChangedWhileLocked ? "warning" : "success",
      serverChangedWhileLocked
        ? "会话已恢复；锁屏期间服务端配置已更新，本地修改仍保留，请先核对冲突"
        : preserveLocalChanges
          ? "会话已恢复，未保存修改仍保留"
          : "管理会话已恢复，并已同步服务端最新配置"
    );
    authNotice.value = "";
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (sessionIssued) await edgeApi.adminLogout().catch(() => setAdminToken(""));
    authError.value =
      code === "INVALID_ADMIN_PIN"
        ? "PIN 不正确"
        : code === "TOO_MANY_AUTH_ATTEMPTS"
          ? "PIN 尝试次数过多，管理入口已锁定 15 分钟；未保存修改仍保留，请停止重试"
          : sessionIssued
            ? "PIN 已通过，但权威配置同步失败；本次会话已安全退出，本地修改仍保留"
            : "重新验证失败，请检查 EdgeCore 连接";
    authLocked.value = code === "TOO_MANY_AUTH_ATTEMPTS";
    pin.value = "";
  } finally {
    authBusy.value = false;
  }
}
async function loadAdmin() {
  const c = await edgeApi.adminConfig();
  const latest = normalizeAdminConfiguration(c.data);
  config.value = latest;
  savedConfigSnapshot.value = JSON.stringify(latest);
  saveError.value = "";
  reauthenticationConflict.value = false;
  await loadActivePages();
}
async function saveConfig() {
  if (!config.value) return false;
  if (configValidationErrors.value.length) {
    saveError.value = "CONFIG_VALIDATION_FAILED";
    feedback("warning", `配置未保存：${configValidationErrors.value.join("；")}`);
    return false;
  }
  busy.value = true;
  saveError.value = "";
  try {
    config.value = (await edgeApi.saveAdminConfig(config.value)).data;
    savedConfigSnapshot.value = JSON.stringify(config.value);
    clearPersistedAdminDraft();
    reauthenticationConflict.value = false;
    configurationConflictServer.value = undefined;
    saved.value = true;
    feedback("success", "配置已保存并同步至两屏");
    await loadActivePages();
    setTimeout(() => (saved.value = false), 1200);
    return true;
  } catch (error) {
    const code = error instanceof Error ? error.message : "SAVE_REQUEST_FAILED";
    saveError.value = code;
    feedback(
      "error",
      code === "CONFIG_VERSION_CONFLICT"
        ? "保存冲突：服务端配置已更新。当前修改仍保留，请核对后重新载入。"
        : `保存失败：${code}；当前修改仍保留在页面中`
    );
    return false;
  } finally {
    busy.value = false;
  }
}

function requestTerminalRevocation(terminal: TerminalConfig) {
  confirmDanger(
    `撤销 ${terminal.name} 的配对？`,
    `${terminal.online ? "在线事件流将立即断开。" : ""}服务端将清除旧令牌与事件票据；保存配置不能复活旧令牌。重新使用须在副屏输入新配对码。`,
    "撤销并断开终端",
    async () => {
      try {
        await edgeApi.revokeTerminal(terminal.id);
        await loadAdmin();
        feedback("success", `${terminal.name} 已撤销；旧令牌和在线连接已失效`);
      } catch (error) {
        const code = error instanceof Error ? error.message : "TERMINAL_REVOCATION_FAILED";
        feedback(
          "error",
          code === "PRIMARY_TERMINAL_CANNOT_BE_REVOKED"
            ? "本机主屏是 EdgeCore 信任根，不能在此撤销"
            : `终端撤销失败：${code}；原配对状态保持不变`
        );
        throw error;
      }
    }
  );
}

function selectTab(tab: AdminTab) {
  if (tab === active.value) return;
  if (hasUnsavedChanges.value) {
    leaveTarget.value = tab;
    return;
  }
  active.value = tab;
}

async function discardChanges() {
  const latest = await edgeApi.adminConfig();
  const normalized = normalizeAdminConfiguration(latest.data);
  config.value = normalized;
  savedConfigSnapshot.value = JSON.stringify(normalized);
  saveError.value = "";
  reauthenticationConflict.value = false;
  configurationConflictServer.value = undefined;
  clearPersistedAdminDraft();
}

async function openConfigurationConflict() {
  try {
    configurationConflictServer.value = normalizeAdminConfiguration((await edgeApi.adminConfig()).data);
    for (const key of Object.keys(configurationConflictChoices)) delete configurationConflictChoices[key];
    configurationConflictOpen.value = true;
  } catch (error) {
    feedback("error", `无法读取服务端最新配置：${error instanceof Error ? error.message : "服务不可用"}；本地修改仍保留`);
  }
}

function closeConfigurationConflict() {
  configurationConflictOpen.value = false;
  configurationConflictServer.value = undefined;
  for (const key of Object.keys(configurationConflictChoices)) delete configurationConflictChoices[key];
}

function applyConfigurationMerge() {
  const plan = configurationMergePlan.value;
  if (!plan || unresolvedConfigurationConflicts.value) return;
  // Vue ref 内的数据是响应式 Proxy，不能直接交给 structuredClone；配置契约本身是纯 JSON。
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const merged = clone(plan.server);
  for (const resource of mergeResources) {
    const baseItems = plan.baseline[resource.key] as MergeItem[];
    const localItems = plan.local[resource.key] as MergeItem[];
    const serverItems = plan.server[resource.key] as MergeItem[];
    const mergedItems = merged[resource.key] as MergeItem[];
    const ids = new Set([...baseItems, ...localItems].map((item) => item.id));
    for (const id of ids) {
      const baseItem = baseItems.find((item) => item.id === id);
      const localItem = localItems.find((item) => item.id === id);
      const serverItem = serverItems.find((item) => item.id === id);
      const localChanged = JSON.stringify(localItem) !== JSON.stringify(baseItem);
      if (!localChanged) continue;
      const serverChanged = JSON.stringify(serverItem) !== JSON.stringify(baseItem);
      const divergent = serverChanged && JSON.stringify(localItem) !== JSON.stringify(serverItem);
      if (divergent && configurationConflictChoices[`${resource.key}:${id}`] !== "local") continue;
      const targetIndex = mergedItems.findIndex((item) => item.id === id);
      if (!localItem && targetIndex >= 0) mergedItems.splice(targetIndex, 1);
      else if (localItem && targetIndex >= 0) mergedItems.splice(targetIndex, 1, clone(localItem));
      else if (localItem) mergedItems.push(clone(localItem));
    }
  }
  const localPolicyChanged = JSON.stringify(plan.local.benchResetPolicy) !== JSON.stringify(plan.baseline.benchResetPolicy);
  const serverPolicyChanged = JSON.stringify(plan.server.benchResetPolicy) !== JSON.stringify(plan.baseline.benchResetPolicy);
  const policyDivergent =
    localPolicyChanged &&
    serverPolicyChanged &&
    JSON.stringify(plan.local.benchResetPolicy) !== JSON.stringify(plan.server.benchResetPolicy);
  if (localPolicyChanged && (!policyDivergent || configurationConflictChoices["benchResetPolicy:policy"] === "local")) {
    merged.benchResetPolicy = clone(plan.local.benchResetPolicy);
  }
  config.value = merged;
  savedConfigSnapshot.value = JSON.stringify(plan.server);
  saveError.value = "";
  reauthenticationConflict.value = false;
  configurationConflictOpen.value = false;
  configurationConflictServer.value = undefined;
  for (const key of Object.keys(configurationConflictChoices)) delete configurationConflictChoices[key];
  feedback(
    "success",
    configSnapshot.value === savedConfigSnapshot.value
      ? "已采用服务端最新配置，无需再次保存"
      : "冲突已合并为本地草稿；请检查后点击保存配置，服务端尚未被改写"
  );
}

async function resolveLeave(choice: "save" | "discard" | "keep" | "cancel") {
  const target = leaveTarget.value;
  if (!target || choice === "cancel") {
    leaveTarget.value = undefined;
    return;
  }
  if (choice === "save" && !(await saveConfig())) return;
  if (choice === "discard") await discardChanges();
  leaveTarget.value = undefined;
  if (target === "logout") await performLogout();
  else active.value = target;
}

function confirmDanger(title: string, detail: string, confirmLabel: string, action: () => void | Promise<void>) {
  dangerDialog.value = { title, detail, confirmLabel, action };
}

async function acceptDanger() {
  if (!dangerDialog.value || dangerBusy.value) return;
  dangerBusy.value = true;
  try {
    await dangerDialog.value.action();
    dangerDialog.value = undefined;
  } finally {
    dangerBusy.value = false;
  }
}

function closeDanger() {
  if (!dangerBusy.value) dangerDialog.value = undefined;
}

function reloadServerConfiguration() {
  confirmDanger("放弃当前修改并重新载入？", "未保存修改会被服务端最新版替换，请先记录待合并内容。", "重新载入", async () => {
    await discardChanges();
    feedback("success", "已重新载入服务端最新配置");
  });
}
function benchResetBlockerLabel(blocker: string) {
  return (
    {
      ACTIVE_CRITICAL_ALERT: "仍有未恢复的严重告警，请先完成现场处置",
      ACTIVE_OPERATION: "仍有命令或场景正在执行，请等待其收口",
      BENCH_RESET_IN_PROGRESS: "另一轮设备复位正在执行"
    }[blocker] ?? blocker
  );
}

async function openBenchReset() {
  if (benchResetBusy.value) return;
  benchResetOpen.value = true;
  benchResetBusy.value = true;
  benchResetError.value = "";
  benchResetResult.value = undefined;
  try {
    benchResetPreview.value = (await edgeApi.benchResetPreview()).data;
  } catch (error) {
    benchResetError.value = error instanceof Error ? benchResetBlockerLabel(error.message) : "无法读取设备复位影响清单";
  } finally {
    benchResetBusy.value = false;
  }
}

async function confirmBenchReset() {
  if (benchResetBusy.value || !benchResetPreview.value?.canExecute) return;
  benchResetBusy.value = true;
  benchResetError.value = "";
  try {
    benchResetResult.value = (await edgeApi.benchReset()).data;
    await loadAdmin();
    const summary = benchResetResult.value.summary;
    feedback(
      benchResetResult.value.status === "completed" ? "success" : "warning",
      `设备复位已收口：确认 ${summary.confirmed}，已在基线 ${summary.unchanged}，失败 ${summary.failed + summary.timeout}，人工核对 ${summary.manualCheck}`
    );
  } catch (error) {
    benchResetError.value = error instanceof Error ? benchResetBlockerLabel(error.message) : "设备复位失败";
    try {
      benchResetPreview.value = (await edgeApi.benchResetPreview()).data;
    } catch {
      /* 保留原始失败原因 */
    }
  } finally {
    benchResetBusy.value = false;
  }
}

function closeBenchReset() {
  if (benchResetBusy.value) return;
  benchResetOpen.value = false;
  benchResetPreview.value = undefined;
  benchResetResult.value = undefined;
  benchResetError.value = "";
}
function handoverLabel(code: string) {
  return (
    {
      ACTIVE_CRITICAL_ALERT: "仍有未恢复的严重告警",
      ACTIVE_OPERATION: "仍有命令或场景执行中",
      OFFLINE_GATEWAY: "网关离线，不能证明设备可控",
      BENCH_NOT_RESET: "设备尚未回到交接基线",
      ACTIVE_NONCRITICAL_ALERTS: "仍有未恢复的一般告警",
      OFFLINE_DEVICES: "存在离线设备，当前值可能是最后已知状态",
      MANUAL_BASELINE_CHECK: "存在无法远程证明基线的设备，需现场核对",
      PAIRED_TERMINALS_OFFLINE: "已配对的主副屏未全部在线",
      INVALID_HANDOVER_OPERATOR: "请填写 2–40 字检查人或值班人",
      INVALID_HANDOVER_COMPLETION_ID: "交接请求标识无效，请关闭后重新打开检查单",
      INVALID_HANDOVER_NOTE: "交接备注不能超过 200 字",
      HANDOVER_STATE_CHANGED: "打开检查单后设备状态已变化，请按刷新后的清单重新核对",
      HANDOVER_WARNINGS_UNACKNOWLEDGED: "请逐项确认全部交接风险"
    }[code] ?? code
  );
}
async function openHandover() {
  if (handoverBusy.value) return;
  handoverOpen.value = true;
  handoverBusy.value = true;
  handoverError.value = "";
  handoverCompletion.value = undefined;
  handoverCompletionId.value = runtimeId();
  handoverCompletedBy.value = "";
  handoverNote.value = "";
  Object.keys(handoverAcknowledgements).forEach((key) => delete handoverAcknowledgements[key]);
  try {
    handoverChecklist.value = (await edgeApi.handoverChecklist()).data;
  } catch (error) {
    handoverError.value = error instanceof Error ? handoverLabel(error.message) : "无法读取交接检查单";
  } finally {
    handoverBusy.value = false;
  }
}
async function completeHandover() {
  const checklist = handoverChecklist.value;
  if (!checklist || handoverBusy.value || !checklist.canComplete) return;
  handoverBusy.value = true;
  handoverError.value = "";
  try {
    const acknowledged = checklist.warnings.filter((warning) => handoverAcknowledgements[warning]);
    handoverCompletion.value = (
      await edgeApi.completeHandover(
        handoverCompletionId.value,
        handoverCompletedBy.value.trim(),
        checklist.stateToken,
        acknowledged,
        handoverNote.value.trim()
      )
    ).data;
    feedback("success", "运行检查已由 EdgeCore 留档");
  } catch (error) {
    handoverError.value = error instanceof Error ? handoverLabel(error.message) : "交接留档失败";
    try {
      handoverChecklist.value = (await edgeApi.handoverChecklist()).data;
    } catch {
      /* 保留原始失败 */
    }
  } finally {
    handoverBusy.value = false;
  }
}
function closeHandover() {
  if (!handoverBusy.value) handoverOpen.value = false;
}
async function exportBackup() {
  const backup = (await edgeApi.exportBackup()).data;
  backupText.value = JSON.stringify(backup, null, 2);
  backupCandidate.value = backup;
  feedback("success", `已生成配置版本 ${backup.version} 的脱敏备份`);
}
function previewBackup() {
  try {
    const parsed = JSON.parse(backupText.value) as AdminConfiguration;
    if (
      !parsed.version ||
      !Array.isArray(parsed.rooms) ||
      !Array.isArray(parsed.devices) ||
      !Array.isArray(parsed.scenes) ||
      !Array.isArray(parsed.automations) ||
      !Array.isArray(parsed.gateways) ||
      !Array.isArray(parsed.terminals)
    )
      throw new Error("INVALID_BACKUP");
    backupCandidate.value = parsed;
    backupPreviewOpen.value = true;
  } catch {
    backupCandidate.value = undefined;
    feedback("error", "备份校验失败：JSON 或备份结构不兼容");
  }
}
async function confirmRestoreBackup() {
  if (!backupCandidate.value) return;
  if (backupRestoreBlockReason.value) {
    feedback("error", backupRestoreBlockReason.value);
    return;
  }
  busy.value = true;
  try {
    config.value = (await edgeApi.restoreBackup(backupCandidate.value)).data;
    savedConfigSnapshot.value = JSON.stringify(config.value);
    saveError.value = "";
    await loadActivePages();
    backupPreviewOpen.value = false;
    feedback("success", `已恢复配置版本 ${config.value.version}`);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    feedback("error", `恢复失败：${code || "备份不兼容"}`);
  } finally {
    busy.value = false;
  }
}
async function installUiUpdate() {
  uiUpdateBusy.value = true;
  try {
    const parsed = JSON.parse(uiUpdateText.value) as UiUpdateInstallRequest;
    if (!parsed.manifestJson || !parsed.signature || !parsed.files || typeof parsed.files !== "object") {
      throw new Error("INVALID_UI_UPDATE_PACKAGE");
    }
    uiUpdateStatus.value = (await edgeApi.installUiUpdate(parsed)).data;
    feedback("success", `${uiUpdateStatus.value.message}；界面已重新加载`);
    uiUpdateText.value = "";
  } catch (error) {
    feedback("error", `界面更新失败：${error instanceof Error ? error.message : "包格式无效"}`);
  } finally {
    uiUpdateBusy.value = false;
  }
}
async function rollbackUiUpdate() {
  uiUpdateBusy.value = true;
  try {
    uiUpdateStatus.value = (await edgeApi.rollbackUiUpdate()).data;
    feedback("success", `${uiUpdateStatus.value.message}；界面已回滚`);
  } catch (error) {
    feedback("error", `界面回滚失败：${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    uiUpdateBusy.value = false;
  }
}
async function testGateway(id: string) {
  if (!(await saveConfig())) return;
  await edgeApi.testGateway(id);
  await loadAdmin();
}
async function activateHomeAssistant() {
  if (!haSetup.baseUrl.trim() || !haSetup.token.trim() || !haSetup.gatewayEntityId.trim() || !haSetup.lightEntityId.trim()) {
    feedback("error", "请完整填写 HA 地址、长期令牌和两个实体 ID");
    return;
  }
  haSetupBusy.value = true;
  try {
    const ok = configureNativeHomeAssistant({
      baseUrl: haSetup.baseUrl.trim(),
      token: haSetup.token.trim(),
      gatewayEntityId: haSetup.gatewayEntityId.trim(),
      lightEntityId: haSetup.lightEntityId.trim()
    });
    haSetup.token = "";
    if (!ok) throw new Error("原生 Keystore 写入或管理员会话核验失败");
    feedback("success", "HA 凭据已写入 Android Keystore，正在重启 EdgeCore 并加载真机状态");
    window.setTimeout(() => window.location.reload(), 2_000);
  } catch (error) {
    feedback("error", error instanceof Error ? error.message : "HA 配置失败");
  } finally {
    haSetupBusy.value = false;
  }
}
async function recoverAlert(id: string) {
  alertActions.value[id] = "recovering";
  delete alertActionErrors.value[id];
  try {
    await edgeApi.recoverAlert(id);
    await loadPage("alerts");
    feedback("success", "设备已上报异常解除，告警已恢复");
    delete alertActions.value[id];
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const message =
      code === "ALERT_CONDITION_STILL_ACTIVE"
        ? "异常条件仍存在，请先排除现场故障"
        : code === "ALERT_RECOVERY_STATE_UNAVAILABLE"
          ? "恢复状态不可用，请先检查设备在线与属性上报"
          : `恢复失败：${code}`;
    alertActions.value[id] = "failed";
    alertActionErrors.value[id] = message;
    feedback("error", message);
  }
}
function alertRecovery(alert: AlertRecord) {
  return alertRecoveryAvailability(alert, edge.devices);
}
async function acknowledgeAlert(id: string) {
  await edge.acknowledgeAlert(id);
  await loadPage("alerts");
}
async function downloadAlerts() {
  const items = await edgeApi.allAdminResources<AlertRecord>("alerts", {
    q: alertQuery.value,
    status: alertFilter.value
  });
  const rows = [
    ["标题", "级别", "消息", "发生时间", "确认时间", "恢复时间"],
    ...items.map((item) => [item.title, item.level, item.message, item.occurredAt, item.acknowledgedAt ?? "", item.recoveredAt ?? ""])
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  link.download = `alerts-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  // Spreadsheet applications may execute cells beginning with formula markers.
  // Prefix untrusted values with an apostrophe while preserving the visible text.
  const safe = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

async function downloadAudits() {
  try {
    const items = await edgeApi.allAdminResources<AuditRecord>("audits", {
      q: pageStates.audits.q,
      status: pageStates.audits.status
    });
    const rows = [
      ["时间", "类别", "动作", "详情", "来源", "结果"],
      ...items.map((item) => [item.occurredAt, item.category, item.action, item.detail, item.source, item.result])
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    link.download = `audits-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    feedback("success", `已按当前筛选导出 ${items.length} 条完整审计记录`);
  } catch (error) {
    feedback("error", `审计导出失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

async function performLogout() {
  try {
    await edgeApi.adminLogout();
  } catch {
    // 会话已失效时，本地仍必须完成安全退出。
  }
  authenticated.value = false;
  pin.value = "";
  savedConfigSnapshot.value = "";
  sessionExpiresAt.value = "";
  sessionExpired.value = false;
  sessionLockReason.value = "expired";
  clearPersistedAdminDraft();
  draftPersistence?.stop();
  draftPersistence = undefined;
}
function openPinChange() {
  currentAdminPin.value = "";
  newAdminPin.value = "";
  confirmAdminPin.value = "";
  pinChangeError.value = "";
  pinChangeOpen.value = true;
}
function closePinChange() {
  if (pinChangeBusy.value) return;
  pinChangeOpen.value = false;
  currentAdminPin.value = "";
  newAdminPin.value = "";
  confirmAdminPin.value = "";
  pinChangeError.value = "";
}
async function changeAdminPin() {
  if (pinChangeBusy.value) return;
  if (!/^\d{6,12}$/.test(newAdminPin.value)) {
    pinChangeError.value = "新 PIN 必须为 6–12 位数字";
    return;
  }
  if (newAdminPin.value !== confirmAdminPin.value) {
    pinChangeError.value = "两次输入的新 PIN 不一致";
    return;
  }
  pinChangeBusy.value = true;
  pinChangeError.value = "";
  try {
    await edgeApi.changeAdminPin(currentAdminPin.value, newAdminPin.value, confirmAdminPin.value);
    pinChangeOpen.value = false;
    currentAdminPin.value = "";
    newAdminPin.value = "";
    confirmAdminPin.value = "";
    authenticated.value = false;
    sessionExpiresAt.value = "";
    savedConfigSnapshot.value = "";
    clearPersistedAdminDraft();
    draftPersistence?.stop();
    draftPersistence = undefined;
    authNotice.value = "管理员 PIN 已轮换；所有旧会话已吊销，请使用新 PIN 重新登录";
  } catch (error) {
    const code = error instanceof Error ? error.message : "ADMIN_PIN_CHANGE_FAILED";
    pinChangeError.value =
      code === "INVALID_CURRENT_ADMIN_PIN"
        ? "当前 PIN 不正确"
        : code === "ADMIN_PIN_CONFIRMATION_MISMATCH"
          ? "两次输入的新 PIN 不一致"
          : code === "INVALID_NEW_ADMIN_PIN"
            ? "新 PIN 必须为 6–12 位数字"
            : code === "ADMIN_PIN_UNCHANGED"
              ? "新 PIN 不能与当前 PIN 相同"
              : code === "TOO_MANY_AUTH_ATTEMPTS"
                ? "错误尝试过多，PIN 轮换已锁定 15 分钟；当前会话仍可继续使用"
                : `PIN 轮换失败：${code}；当前 PIN 与会话保持不变`;
  } finally {
    pinChangeBusy.value = false;
  }
}
async function logout() {
  if (hasUnsavedChanges.value) {
    leaveTarget.value = "logout";
    return;
  }
  await performLogout();
}

async function addRoom() {
  if (!config.value) return;
  config.value.rooms.push({
    id: runtimeId(),
    name: `新房间 ${config.value.rooms.length + 1}`,
    order: config.value.rooms.length,
    enabled: true
  });
  pageStates.rooms.q = "";
  pageStates.rooms.status = "all";
  pageStates.rooms.page = Math.ceil((pageStates.rooms.total + 1) / pageStates.rooms.pageSize);
  await saveConfig();
}
function renameRoom(room: RoomConfig, name: string) {
  if (!config.value || !name || name === room.name) return;
  const previous = room.name;
  room.name = name;
  config.value.devices.filter((item) => item.room === previous).forEach((item) => (item.room = name));
}
function removeRoom(id: string) {
  if (!config.value) return;
  const removed = config.value.rooms.find((item) => item.id === id);
  const fallback = config.value.rooms.find((item) => item.id !== id);
  if (!removed || !fallback) {
    feedback("warning", "至少保留一个房间");
    return;
  }
  const affected = config.value.devices.filter((item) => item.room === removed.name).length;
  confirmDanger(
    `删除房间“${removed.name}”？`,
    affected
      ? `${affected} 个设备将自动迁移到“${fallback.name}”。保存配置后才会正式生效。`
      : "该房间没有归属设备，保存配置后才会正式删除。",
    "删除房间",
    () => {
      config.value?.devices.filter((item) => item.room === removed.name).forEach((item) => (item.room = fallback.name));
      if (config.value) config.value.rooms = config.value.rooms.filter((item) => item.id !== id);
    }
  );
}
function consolidateGateway(targetId: string) {
  if (!config.value || config.value.gateways.length <= 1) return;
  const target = config.value.gateways.find((item) => item.id === targetId);
  if (!target) return;
  const removed = config.value.gateways.filter((item) => item.id !== targetId);
  const reassigned = config.value.devices.filter(
    (device) => device.kind !== "gateway" && device.integration.gatewayId && device.integration.gatewayId !== targetId
  ).length;
  confirmDanger(
    `将“${target.name}”设为本台唯一网关？`,
    `将移除 ${removed.length} 个其他网关，并把 ${reassigned} 个设备的归属迁移到“${target.name}”。这只会形成未保存修改，检查后仍需保存配置。`,
    "归并为单网关",
    () => {
      if (!config.value) return;
      config.value.gateways = [target];
      config.value.devices = config.value.devices
        .filter((device) => device.kind !== "gateway" || device.id === targetId)
        .map((device) => ({
          ...device,
          name: device.kind === "gateway" && device.id === targetId ? target.name : device.name,
          integration:
            device.integration.gatewayId && device.integration.gatewayId !== targetId
              ? { ...device.integration, gatewayId: targetId }
              : device.integration
        }));
      feedback("warning", "拓扑归并已预览，请检查设备归属后保存配置");
    }
  );
}
async function addScene() {
  if (!config.value) return;
  config.value.scenes.push({
    id: runtimeId(),
    name: "新场景",
    description: "待编排",
    tone: "cyan",
    enabled: false,
    strategy: "serial",
    actions: []
  });
  pageStates.scenes.q = "";
  pageStates.scenes.status = "all";
  pageStates.scenes.page = Math.ceil((pageStates.scenes.total + 1) / pageStates.scenes.pageSize);
  await saveConfig();
}
function removeScene(id: string) {
  const scene = config.value?.scenes.find((item) => item.id === id);
  if (!scene) return;
  confirmDanger(`删除场景“${scene.name}”？`, `其中 ${scene.actions.length} 个动作将一并删除。保存配置后才会正式生效。`, "删除场景", () => {
    if (config.value) config.value.scenes = config.value.scenes.filter((item) => item.id !== id);
  });
}
function writableDevices() {
  return config.value?.devices.filter((item) => item.capabilities.some((capability) => capability.writable)) ?? [];
}
function actionDevice(action: SceneAction) {
  return config.value?.devices.find((item) => item.id === action.deviceId);
}
function actionCapability(action: SceneAction) {
  return actionDevice(action)?.capabilities.find((item) => item.property === action.property);
}
function writableCapabilities(action: SceneAction) {
  return actionDevice(action)?.capabilities.filter((item) => item.writable) ?? [];
}
function defaultValue(device: Device, property: string) {
  const cap = device.capabilities.find((item) => item.property === property);
  if (cap?.type === "boolean") return true;
  if (cap?.type === "number") return cap.min ?? 0;
  return cap?.options?.[0]?.value ?? "stop";
}
function addAction(target: Scene | AutomationConfig) {
  const device = writableDevices()[0];
  const cap = device?.capabilities.find((item) => item.writable);
  if (!device || !cap) return;
  target.actions.push({
    id: runtimeId(),
    deviceId: device.id,
    property: cap.property,
    value: defaultValue(device, cap.property),
    label: `${device.name}·${cap.label}`
  });
}
function removeAction(target: Scene | AutomationConfig, id: string) {
  target.actions = target.actions.filter((item) => item.id !== id);
}
function moveAction(target: Scene | AutomationConfig, index: number, delta: -1 | 1) {
  const next = index + delta;
  if (next < 0 || next >= target.actions.length) return;
  [target.actions[index], target.actions[next]] = [target.actions[next], target.actions[index]];
}
function changeActionDevice(action: SceneAction) {
  const device = actionDevice(action);
  const cap = device?.capabilities.find((item) => item.writable);
  if (!device || !cap) return;
  action.property = cap.property;
  action.value = defaultValue(device, cap.property);
  action.label = `${device.name}·${cap.label}`;
}
function changeActionProperty(action: SceneAction) {
  const device = actionDevice(action);
  if (!device) return;
  const cap = device.capabilities.find((item) => item.property === action.property);
  action.value = defaultValue(device, action.property);
  action.label = `${device.name}·${cap?.label ?? action.property}`;
}
function setActionValue(action: SceneAction, raw: string) {
  const capability = actionCapability(action);
  if (capability?.type === "boolean") action.value = raw === "true";
  else if (capability?.type === "number") action.value = Number(raw);
  else {
    const option = capability?.options?.find((item) => String(item.value) === raw);
    action.value = option?.value ?? raw;
  }
}
function actionValueOptions(action: SceneAction) {
  const capability = actionCapability(action);
  if (capability?.type === "boolean")
    return [
      { label: "开启 / 是", value: "true" },
      { label: "关闭 / 否", value: "false" }
    ];
  return capability?.options?.map((option) => ({ label: option.label, value: String(option.value) })) ?? [];
}
function setActionNumber(action: SceneAction, value: number | null) {
  if (value != null) action.value = value;
}
function setConditionValue(item: AutomationConfig, raw: string) {
  const current = config.value?.devices.find((device) => device.id === item.condition.deviceId)?.state[item.condition.property];
  item.condition.value = typeof current === "boolean" ? raw === "true" : typeof current === "number" ? Number(raw) : raw;
}
function conditionDevice(item: AutomationConfig) {
  return config.value?.devices.find((device) => device.id === item.condition.deviceId);
}
function conditionCapability(item: AutomationConfig) {
  return conditionDevice(item)?.capabilities.find((capability) => capability.property === item.condition.property);
}
function conditionValueType(item: AutomationConfig) {
  const capability = conditionCapability(item);
  if (capability?.type !== "readonly") return capability?.type;
  const current = conditionDevice(item)?.state[item.condition.property];
  return typeof current === "boolean" ? "boolean" : typeof current === "number" ? "number" : "readonly";
}
function conditionValueOptions(item: AutomationConfig) {
  const capability = conditionCapability(item);
  if (conditionValueType(item) === "boolean")
    return [
      { label: "是 / 开启", value: "true" },
      { label: "否 / 关闭", value: "false" }
    ];
  return capability?.options?.map((option) => ({ label: option.label, value: String(option.value) })) ?? [];
}
function setConditionNumber(item: AutomationConfig, value: number | null) {
  if (value != null) item.condition.value = value;
}
function conditionCapabilityOptions(item: AutomationConfig) {
  const device = config.value?.devices.find((candidate) => candidate.id === item.condition.deviceId);
  return device?.capabilities.map((capability) => ({ label: capability.label, value: capability.property })) ?? [];
}
function conditionOperatorOptions(item: AutomationConfig) {
  const device = config.value?.devices.find((candidate) => candidate.id === item.condition.deviceId);
  const capability = device?.capabilities.find((candidate) => candidate.property === item.condition.property);
  return capability && automationOperatorSupported(capability, "gt", device?.state[capability.property])
    ? operatorOptions
    : operatorOptions.slice(0, 2);
}
function normalizeCondition(item: AutomationConfig) {
  const device = config.value?.devices.find((candidate) => candidate.id === item.condition.deviceId);
  const capability = device?.capabilities.find((candidate) => candidate.property === item.condition.property);
  if (!device || !capability) return;
  if (!automationOperatorSupported(capability, item.condition.operator, device.state[capability.property])) item.condition.operator = "eq";
  item.condition.value = device.state[capability.property] ?? defaultValue(device, capability.property);
}
function changeConditionDevice(item: AutomationConfig) {
  const device = config.value?.devices.find((candidate) => candidate.id === item.condition.deviceId);
  const capability = device?.capabilities[0];
  if (!device || !capability) return;
  item.condition.property = capability.property;
  normalizeCondition(item);
}
async function testScene(scene: Scene) {
  if (!(await saveConfig())) return;
  const result = await edge.executeScene(scene.id, "admin");
  if (!result) {
    feedback("error", edge.operationNotice?.detail ?? "场景试运行失败，请稍后重试");
    return;
  }
  feedback(
    result.data.status === "completed" ? "success" : result.data.status === "partial" ? "warning" : "error",
    `场景试运行：${result.data.status} (${result.data.completedActions}/${result.data.totalActions})`
  );
}
async function addAutomation() {
  const first = edge.devices.find((item) => item.kind !== "gateway");
  if (!config.value || !first) return;
  config.value.automations.push({
    id: runtimeId(),
    name: newAutomationName.value,
    enabled: false,
    condition: { deviceId: first.id, property: Object.keys(first.state)[0] ?? "power", operator: "eq", value: true },
    actions: [],
    cooldownSeconds: 30
  });
  pageStates.automations.q = "";
  pageStates.automations.status = "all";
  pageStates.automations.page = Math.ceil((pageStates.automations.total + 1) / pageStates.automations.pageSize);
  await saveConfig();
}
function removeAutomation(id: string) {
  const automation = config.value?.automations.find((item) => item.id === id);
  if (!automation) return;
  confirmDanger(
    `删除联动“${automation.name}”？`,
    `触发条件和 ${automation.actions.length} 个动作将一并删除。保存配置后才会正式生效。`,
    "删除联动",
    () => {
      if (config.value) config.value.automations = config.value.automations.filter((item) => item.id !== id);
    }
  );
}
async function testAutomation(item: AutomationConfig) {
  if (!(await saveConfig())) return;
  const results = await Promise.all(
    item.actions.map((action) => edge.sendCommand(action.deviceId, action.property, action.value, "admin"))
  );
  const confirmed = results.filter((result) => result?.data.status === "confirmed").length;
  feedback(
    confirmed === results.length ? "success" : confirmed ? "warning" : "error",
    `联动试运行：${confirmed}/${results.length} 个动作已确认`
  );
}
async function downloadDiagnostics() {
  if (!config.value) return;
  if (edge.health?.mode === "hardware") {
    const bundle = (await edgeApi.diagnostics()).data;
    downloadJson(bundle, `diagnostics-${new Date().toISOString().slice(0, 10)}.json`);
    return;
  }
  const audits = await edgeApi.allAdminResources<AuditRecord>("audits");
  const payload = {
    generatedAt: new Date().toISOString(),
    health: edge.health,
    sequence: edge.snapshot?.sequence,
    devices: edge.devices.map(({ id, name, health, updatedAt, integration }) => ({
      id,
      name,
      health,
      updatedAt,
      integration: { ...integration, note: integration.note ? "[REDACTED]" : undefined }
    })),
    gateways: config.value.gateways.map(({ credentialRef, ...gateway }) => ({
      ...gateway,
      credentialRef: credentialRef.replace(/:.+$/, "://[REDACTED]")
    })),
    audits
  };
  downloadJson(payload, `diagnostics-${new Date().toISOString().slice(0, 10)}.json`);
}
function downloadJson(payload: unknown, filename: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
watch(active, () => {
  void loadActivePages();
});
watch(alertQuery, (value) => {
  pageStates.alerts.q = value;
  schedulePageReset("alerts");
});
watch(alertFilter, (value) => {
  pageStates.alerts.status = value;
  resetPage("alerts");
});

function protectUnsavedChanges(event: BeforeUnloadEvent) {
  if (!hasUnsavedChanges.value) return;
  event.preventDefault();
  event.returnValue = "";
}

function clearSensitiveOverlays() {
  pinChangeOpen.value = false;
  currentAdminPin.value = "";
  newAdminPin.value = "";
  confirmAdminPin.value = "";
  pinChangeError.value = "";
  dangerDialog.value = undefined;
  backupPreviewOpen.value = false;
  leaveTarget.value = undefined;
  configurationConflictOpen.value = false;
  configurationConflictServer.value = undefined;
  for (const key of Object.keys(configurationConflictChoices)) delete configurationConflictChoices[key];
}

function handleAdminSessionExpired(reason: "expired" | "idle" | "manual" = "expired") {
  if (!authenticated.value || sessionExpired.value) return;
  sessionLockReason.value = reason;
  sessionExpired.value = true;
  sessionExpiresAt.value = "";
  pin.value = "";
  authError.value = "";
  authLocked.value = false;
  clearSensitiveOverlays();
}

function lockAdminWorkspace(reason: "idle" | "manual") {
  if (!authenticated.value || sessionExpired.value) return;
  // 先发起服务端吊销，request 会同步捕获当前 Bearer；随后立即清理本地副本。
  const revocation = edgeApi.adminLogout().catch(() => undefined);
  setAdminToken("");
  void revocation;
  handleAdminSessionExpired(reason);
}

function recordAdminActivity() {
  if (!authenticated.value || sessionExpired.value) return;
  lastAdminActivityAt.value = Date.now();
}

function handleVisibilityActivity() {
  sessionNow.value = Date.now();
  if (document.visibilityState !== "visible") draftPersistence?.flush();
  if (document.visibilityState !== "visible" || !authenticated.value || sessionExpired.value) return;
  if (adminIdleState(lastAdminActivityAt.value, sessionNow.value).expired) lockAdminWorkspace("idle");
  else recordAdminActivity();
}

onMounted(() => {
  window.addEventListener("beforeunload", protectUnsavedChanges);
  window.addEventListener("pointerdown", recordAdminActivity, { passive: true });
  window.addEventListener("keydown", recordAdminActivity);
  window.addEventListener("wheel", recordAdminActivity, { passive: true });
  document.addEventListener("visibilitychange", handleVisibilityActivity);
  setAdminAuthExpiredHandler(handleAdminSessionExpired);
  sessionTimer = window.setInterval(() => {
    sessionNow.value = Date.now();
    if (authenticated.value && sessionExpiresAt.value && sessionRemainingMs.value <= 0) handleAdminSessionExpired();
    else if (authenticated.value && !sessionExpired.value && idleState.value.expired) lockAdminWorkspace("idle");
  }, 1000);
});
onBeforeUnmount(() => {
  if (authenticated.value) void edgeApi.adminLogout().catch(() => {});
  setAdminToken("");
  window.removeEventListener("beforeunload", protectUnsavedChanges);
  window.removeEventListener("pointerdown", recordAdminActivity);
  window.removeEventListener("keydown", recordAdminActivity);
  window.removeEventListener("wheel", recordAdminActivity);
  document.removeEventListener("visibilitychange", handleVisibilityActivity);
  setAdminAuthExpiredHandler();
  window.clearInterval(sessionTimer);
  draftPersistence?.flush();
  draftPersistence?.stop();
});
</script>

<template>
  <NConfigProvider
    :theme="isDark ? darkTheme : null"
    :theme-overrides="isDark ? zhijingDarkThemeOverrides : zhijingThemeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <main class="admin-shell">
      <SystemHeader title="知境 · 工程管理" />
      <section v-if="!authenticated" class="login-stage">
        <form class="login-panel panel" @submit.prevent="login">
          <span class="login-icon"><KeyRound :size="30" /></span><span class="eyebrow">身份验证</span>
          <h1>管理员验证</h1>
          <p>操作受保护。</p>
          <NInput
            v-model:value="pin"
            type="password"
            show-password-on="mousedown"
            :input-props="{ inputmode: 'numeric' }"
            maxlength="12"
            placeholder="输入管理员 PIN"
            autofocus
            size="large"
          />
          <small v-if="authError" class="bad">{{ authError }}</small
          ><small v-if="authNotice" class="good">{{ authNotice }}</small
          ><NButton type="primary" attr-type="submit" block size="large" :loading="authBusy" :disabled="authBusy || authLocked || !pin"
            >进入工程管理</NButton
          >
          <small>请使用主屏首次配置时设置的管理员 PIN</small>
        </form>
      </section>
      <section
        v-else
        class="admin-workspace"
        :class="{ 'session-locked': sessionExpired }"
        :aria-hidden="sessionExpired"
        :inert="sessionExpired"
      >
        <aside>
          <span class="eyebrow">工程管理</span>
          <h1>工程管理</h1>
          <p>
            服务端配置版本 {{ config?.version ?? 0 }}<span v-if="appVersion" class="app-version"> · APK {{ appVersion }}</span>
          </p>
          <span v-if="sessionStatus" class="session-status" :class="{ warning: sessionExpiringSoon }">{{ sessionStatus }}</span>
          <span v-if="idleWarning" class="session-status warning">闲置 {{ idleStatus }} 后自动锁定</span>
          <nav>
            <button v-for="tab in tabs" :key="tab.id" :class="{ active: active === tab.id }" @click="selectTab(tab.id)">
              {{ tab.label }}
            </button>
          </nav>
          <button class="lock-admin" @click="lockAdminWorkspace('manual')">立即锁定</button>
          <button class="lock-admin" @click="openPinChange">轮换管理员 PIN</button>
          <button class="logout" @click="logout">退出管理</button>
        </aside>
        <div class="admin-content">
          <header class="workspace-head">
            <div>
              <span class="eyebrow">{{ tabKickers[active] }}</span>
              <h2>{{ tabs.find((t) => t.id === active)?.label }}</h2>
              <span v-if="appVersion" class="workspace-app-version" data-testid="admin-app-version">APK {{ appVersion }}</span>
            </div>
            <div class="workspace-actions">
              <span v-if="hasUnsavedChanges" class="save-state unsaved"><i />有未保存修改</span>
              <span v-else-if="configValidationErrors.length" class="save-state invalid">服务端配置需修复</span>
              <span v-else-if="authenticated && config" class="save-state saved">已与服务端同步</span>
              <NButton
                v-if="!['overview', 'audit', 'alerts', 'backup'].includes(active)"
                type="primary"
                :loading="busy"
                :disabled="!hasUnsavedChanges && !saveError"
                @click="saveConfig"
              >
                {{ saved ? "已保存" : saveError ? "重试保存" : "保存配置" }}
              </NButton>
            </div>
          </header>
          <NAlert v-if="activePageError" type="error" :bordered="false" class="page-error">分页查询失败：{{ activePageError }}</NAlert>
          <NAlert
            v-if="configValidationErrors.length"
            :type="hasUnsavedChanges ? 'warning' : 'error'"
            :bordered="false"
            class="config-validation"
            :title="hasUnsavedChanges ? '保存前需要修正' : '服务端配置存在兼容性问题'"
          >
            <span v-if="!hasUnsavedChanges">当前权威配置可能来自旧备份或其他版本。控制端仍可运行，但再次保存前必须修复：</span>
            {{ configValidationErrors.join("；") }}
            <div v-if="safeCompatibilityRepairCount" class="config-repair-actions">
              <NButton size="small" secondary type="warning" @click="createSafeCompatibilityRepairDraft">
                生成安全修复草稿（{{ safeCompatibilityRepairCount }} 项）
              </NButton>
              <small>只恢复安防可见性、清除异常副屏槽位并停用零动作项；不会改写 ID、凭据或业务动作，也不会自动保存。</small>
            </div>
          </NAlert>
          <NAlert
            v-if="saveError === 'CONFIG_VERSION_CONFLICT'"
            type="error"
            :bordered="false"
            class="config-conflict"
            title="配置保存冲突"
          >
            <div class="conflict-content">
              <span v-if="reauthenticationConflict"
                >锁屏期间另一个管理会话已保存新版本。本页修改仍在，继续保存会被版本保护阻止；请先核对后决定是否重新载入。</span
              >
              <span v-else>另一个管理会话已先保存新版本。本页修改仍在，服务端内容未被覆盖。</span>
              <div class="conflict-actions">
                <NButton size="small" type="warning" secondary @click="openConfigurationConflict">查看差异并合并</NButton>
                <NButton size="small" type="error" secondary @click="reloadServerConfiguration">放弃本地修改并重新载入</NButton>
              </div>
            </div>
          </NAlert>
          <NAlert v-if="sessionExpiringSoon" type="warning" :bordered="false" class="session-warning" title="管理会话即将过期">
            {{ sessionStatus }}。请先保存当前修改，过期后需重新输入 PIN。
          </NAlert>
          <NAlert v-if="idleWarning" type="warning" :bordered="false" class="session-warning" title="管理台即将自动锁定">
            已长时间无操作，{{ idleStatus }} 后隐藏管理数据并吊销当前会话。点击或按键可继续本次工作。
          </NAlert>
          <Transition name="operation-feedback">
            <NAlert
              v-if="operationFeedback"
              :type="operationFeedback.type"
              :bordered="false"
              class="global-operation-message"
              closable
              @close="operationFeedback = undefined"
            >
              {{ operationFeedback.message }}
            </NAlert>
          </Transition>

          <template v-if="active === 'overview'">
            <NAlert
              v-if="dataLifecycle && dataLifecycle.level !== 'healthy'"
              :type="dataLifecycle.level === 'critical' ? 'error' : dataLifecycle.level === 'warning' ? 'warning' : 'info'"
              :bordered="false"
              class="data-health-banner"
              :title="
                dataLifecycle.level === 'critical'
                  ? '长期数据容量高风险'
                  : dataLifecycle.level === 'warning'
                    ? '长期数据容量需关注'
                    : '正在建立容量趋势'
              "
            >
              <div class="data-health-banner-content">
                <span
                  >{{ dataLifecycle.message }}；数据库 {{ formatBytes(dataLifecycle.databaseBytes) }}，可用空间
                  {{ formatBytes(dataLifecycle.usableBytes) }}。</span
                >
                <NButton size="small" secondary @click="selectTab('backup')">查看长期数据健康</NButton>
              </div>
            </NAlert>
            <section class="summary-line">
              <div><small>运行模式</small><strong>正式</strong><span class="good">真实设备链路</span></div>
              <div>
                <small>事件序号</small><strong>{{ edge.snapshot?.sequence ?? 0 }}</strong
                ><span>双屏权威状态源</span>
              </div>
            </section>
            <section class="admin-grid">
              <article class="panel handover-panel">
                <header>
                  <div>
                    <span class="eyebrow">系统维护</span>
                    <h3>设备安全复位</h3>
                  </div>
                  <div class="handover-actions">
                    <NButton secondary @click="openHandover">运行检查</NButton>
                    <NButton secondary type="primary" @click="openBenchReset">复位检查</NButton>
                  </div>
                </header>
                <p>将灯光、音乐与窗帘恢复到预设安全状态；告警、配置、配对和凭据全部保留。</p>
                <small>离线设备转为人工核对；门锁与只读安防设备不会被操作。</small>
                <div v-if="config?.benchResetPolicy" class="handover-policy" aria-label="设备复位策略">
                  <label>
                    <span>照明 / 音乐 / 开关</span>
                    <NSelect
                      v-model:value="config.benchResetPolicy.power"
                      :options="[
                        { label: '关闭', value: 'off' },
                        { label: '保持现状', value: 'unchanged' }
                      ]"
                    />
                  </label>
                  <label>
                    <span>窗帘位置</span>
                    <NSelect
                      v-model:value="config.benchResetPolicy.cover"
                      :options="[
                        { label: '关闭', value: 'closed' },
                        { label: '完全打开', value: 'open' },
                        { label: '保持现状', value: 'unchanged' }
                      ]"
                    />
                  </label>
                  <label>
                    <span>联动抑制</span>
                    <NInputNumber v-model:value="config.benchResetPolicy.automationSuppressionSeconds" :min="3" :max="30" :step="1">
                      <template #suffix>秒</template>
                    </NInputNumber>
                  </label>
                  <NButton secondary :loading="busy" :disabled="!hasUnsavedChanges" @click="saveConfig">保存复位策略</NButton>
                </div>
                <small class="handover-policy-note">复位命令及随后到达的设备回报在此窗口内不会触发自动联动。</small>
              </article>
            </section>
          </template>

          <section v-else-if="active === 'rooms' && config" class="panel list-panel">
            <header>
              <h3>房间与设备归属</h3>
              <div>
                <NInput
                  v-model:value="pageStates.rooms.q"
                  clearable
                  placeholder="搜索房间"
                  @update:value="schedulePageReset('rooms')"
                /><NSelect
                  v-model:value="pageStates.rooms.status"
                  :options="enabledFilterOptions"
                  @update:value="resetPage('rooms')"
                /><NButton tertiary size="small" @click="addRoom">新增房间</NButton>
              </div>
            </header>
            <NAlert v-if="pageStates.rooms.error" type="error" :bordered="false">{{ pageStates.rooms.error }}</NAlert>
            <div v-for="room in configItems<RoomConfig>('rooms')" :key="room.id" class="edit-row">
              <label><span>房间名称</span><NInput :value="room.name" @update:value="renameRoom(room, $event)" /></label
              ><label><span>显示顺序</span><NInputNumber v-model:value="room.order" :min="0" /></label
              ><label class="device-flag"><NSwitch v-model:value="room.enabled" :aria-label="`${room.name} 启用状态`" />启用</label
              ><NButton text type="error" @click="removeRoom(room.id)">删除</NButton>
            </div>
            <NEmpty v-if="!pageStates.rooms.loading && !configItems<RoomConfig>('rooms').length" description="没有符合条件的房间" />
            <AdminListPager
              resource="rooms"
              :page="pageStates.rooms.page"
              :page-size="pageStates.rooms.pageSize"
              :total="pageStates.rooms.total"
              :loading="pageStates.rooms.loading"
              @update:page="setPage('rooms', $event)"
              @update:page-size="setPageSize('rooms', $event)"
            />
            <div class="mapping-table">
              <div class="mapping-head">
                <strong>设备归房</strong
                ><NInput
                  v-model:value="pageStates.devices.q"
                  clearable
                  placeholder="搜索设备 / 房间 / 型号"
                  @update:value="schedulePageReset('devices')"
                /><NSelect v-model:value="pageStates.devices.status" :options="deviceFilterOptions" @update:value="resetPage('devices')" />
              </div>
              <section class="secondary-slot-editor" aria-label="副屏快捷控制映射">
                <header>
                  <div><strong>副屏快捷控制</strong><small>按 capability 选择，不依赖设备型号或固定 ID</small></div>
                  <NTag size="small" :type="secondarySlotDefinitions.every((slot) => secondarySlotValue(slot.id)) ? 'success' : 'warning'">
                    {{ secondarySlotDefinitions.filter((slot) => secondarySlotValue(slot.id)).length }}/3 已配置
                  </NTag>
                </header>
                <label v-for="slot in secondarySlotDefinitions" :key="slot.id">
                  <span>{{ slot.label }}</span>
                  <NSelect
                    :value="secondarySlotValue(slot.id)"
                    :options="secondarySlotOptions(slot.id)"
                    clearable
                    :aria-label="slot.label"
                    :data-testid="`secondary-slot-${slot.id}`"
                    :placeholder="`${slot.label}待配置`"
                    @update:value="setSecondarySlot(slot.id, $event)"
                  />
                  <small>要求：{{ slot.properties.join(" + ") }}</small>
                </label>
              </section>
              <NAlert v-if="pageStates.devices.error" type="error" :bordered="false">{{ pageStates.devices.error }}</NAlert>
              <div v-for="device in configItems<Device>('devices')" :key="device.id" class="device-edit">
                <label><span>设备名称</span><NInput v-model:value="device.name" /></label
                ><label><span>归属房间</span><NSelect v-model:value="device.room" :options="roomOptions" /></label
                ><label><span>显示顺序</span><NInputNumber v-model:value="device.display!.order" :min="0" placeholder="排序" /></label
                ><label class="device-flag"
                  ><NSwitch v-model:value="device.display!.favorite" :aria-label="`${device.name} 首页收藏`" />首页</label
                ><label class="device-flag"
                  ><NSwitch
                    v-model:value="device.display!.hidden"
                    :aria-label="`${device.name} 主屏隐藏`"
                    :disabled="device.kind === 'sensor' || device.kind === 'lock'"
                    :aria-disabled="device.kind === 'sensor' || device.kind === 'lock'"
                  />主屏隐藏</label
                >
                <small v-if="device.kind === 'sensor' || device.kind === 'lock'" class="safety-visibility-note">安防设备保持可见</small>
              </div>
              <NEmpty v-if="!pageStates.devices.loading && !configItems<Device>('devices').length" description="没有符合条件的设备" />
              <AdminListPager
                resource="devices"
                :page="pageStates.devices.page"
                :page-size="pageStates.devices.pageSize"
                :total="pageStates.devices.total"
                :loading="pageStates.devices.loading"
                @update:page="setPage('devices', $event)"
                @update:page-size="setPageSize('devices', $event)"
              />
            </div>
          </section>

          <section v-else-if="active === 'scenes' && config" class="panel list-panel">
            <header>
              <h3>场景 CRUD 与动作编排</h3>
              <div>
                <NInput
                  v-model:value="pageStates.scenes.q"
                  clearable
                  placeholder="搜索场景"
                  @update:value="schedulePageReset('scenes')"
                /><NSelect
                  v-model:value="pageStates.scenes.status"
                  :options="enabledFilterOptions"
                  @update:value="resetPage('scenes')"
                /><NButton tertiary size="small" @click="addScene">新增场景</NButton>
              </div>
            </header>
            <NAlert v-if="pageStates.scenes.error" type="error" :bordered="false">{{ pageStates.scenes.error }}</NAlert>
            <NCollapse accordion arrow-placement="right">
              <NCollapseItem v-for="scene in configItems<Scene>('scenes')" :key="scene.id" :title="scene.name" :name="scene.id">
                <template #header-extra
                  ><NTag size="small" :type="scene.enabled !== false ? 'success' : 'default'">{{
                    scene.enabled !== false ? "已启用" : "已停用"
                  }}</NTag></template
                >
                <article class="scene-editor">
                  <label class="scene-name-field"><span>场景名称</span><NInput v-model:value="scene.name" placeholder="场景名称" /></label>
                  <label class="scene-description-field"
                    ><span>场景说明</span><NInput v-model:value="scene.description" placeholder="场景说明"
                  /></label>
                  <label class="scene-strategy-field"
                    ><span>执行策略</span><NSelect v-model:value="scene.strategy" :options="strategyOptions"
                  /></label>
                  <label class="device-flag scene-enabled-field"
                    ><NSwitch v-model:value="scene.enabled" :aria-label="`${scene.name} 启用状态`" />启用</label
                  >
                  <NButton class="scene-remove" text type="error" @click="removeScene(scene.id)">删除</NButton>
                  <div class="scene-actions action-editor scene-action-list">
                    <div v-for="(action, index) in scene.actions" :key="action.id">
                      <b>{{ index + 1 }}</b
                      ><NSelect
                        v-model:value="action.deviceId"
                        :options="writableDeviceOptions"
                        @update:value="changeActionDevice(action)"
                      />
                      <NSelect
                        v-model:value="action.property"
                        :options="capabilityOptions(action)"
                        @update:value="changeActionProperty(action)"
                      />
                      <NInputNumber
                        v-if="actionCapability(action)?.type === 'number'"
                        :value="typeof action.value === 'number' ? action.value : null"
                        :min="actionCapability(action)?.min"
                        :max="actionCapability(action)?.max"
                        :step="actionCapability(action)?.step ?? 1"
                        :input-props="{
                          'aria-label': `${actionDevice(action)?.name ?? action.deviceId} ${actionCapability(action)?.label ?? action.property} 动作值`
                        }"
                        @update:value="setActionNumber(action, $event)"
                      />
                      <NSelect
                        v-else-if="['boolean', 'enum', 'action'].includes(actionCapability(action)?.type ?? '')"
                        :value="String(action.value)"
                        :options="actionValueOptions(action)"
                        :aria-label="`${actionDevice(action)?.name ?? action.deviceId} ${actionCapability(action)?.label ?? action.property} 动作值`"
                        @update:value="setActionValue(action, String($event))"
                      />
                      <NInput
                        v-else
                        :value="String(action.value)"
                        :aria-label="`${actionDevice(action)?.name ?? action.deviceId} ${action.property} 动作值`"
                        @update:value="setActionValue(action, $event)"
                      />
                      <NButton quaternary size="small" :aria-label="`上移动作 ${index + 1}`" @click="moveAction(scene, index, -1)"
                        >↑</NButton
                      >
                      <NButton quaternary size="small" :aria-label="`下移动作 ${index + 1}`" @click="moveAction(scene, index, 1)"
                        >↓</NButton
                      >
                      <NButton text type="error" :aria-label="`删除动作 ${index + 1}`" @click="removeAction(scene, action.id)">×</NButton>
                    </div>
                    <NEmpty v-if="!scene.actions.length" description="尚未添加场景动作" size="small" />
                    <footer>
                      <NButton secondary @click="addAction(scene)">添加动作</NButton>
                      <NButton type="primary" @click="testScene(scene)">保存并试运行</NButton>
                    </footer>
                  </div>
                </article></NCollapseItem
              ></NCollapse
            >
            <NEmpty v-if="!pageStates.scenes.loading && !configItems<Scene>('scenes').length" description="没有符合条件的场景">
              <template #extra><NButton type="primary" @click="addScene">新增场景</NButton></template>
            </NEmpty>
            <AdminListPager
              resource="scenes"
              :page="pageStates.scenes.page"
              :page-size="pageStates.scenes.pageSize"
              :total="pageStates.scenes.total"
              :loading="pageStates.scenes.loading"
              @update:page="setPage('scenes', $event)"
              @update:page-size="setPageSize('scenes', $event)"
            />
          </section>

          <section v-else-if="active === 'automations' && config" class="panel list-panel">
            <header>
              <h3>条件、冷却与启停</h3>
              <div>
                <NInput
                  v-model:value="pageStates.automations.q"
                  clearable
                  placeholder="搜索联动"
                  @update:value="schedulePageReset('automations')"
                /><NSelect
                  v-model:value="pageStates.automations.status"
                  :options="enabledFilterOptions"
                  @update:value="resetPage('automations')"
                /><NInput v-model:value="newAutomationName" /><NButton tertiary @click="addAutomation">新增联动</NButton>
              </div>
            </header>
            <NEmpty
              v-if="!pageStates.automations.loading && !configItems<AutomationConfig>('automations').length"
              class="workspace-empty"
              description="没有符合条件的自动联动"
            >
              <template #extra><NButton type="primary" @click="addAutomation">创建第一条联动</NButton></template>
            </NEmpty>
            <article v-for="auto in configItems<AutomationConfig>('automations')" :key="auto.id" class="automation-editor">
              <label class="automation-name-field"><span>联动名称</span><NInput v-model:value="auto.name" /></label>
              <label class="device-flag automation-enabled-field"
                ><NSwitch v-model:value="auto.enabled" :aria-label="`${auto.name} 启用状态`" />启用</label
              >
              <label class="automation-device-field"
                ><span>触发设备</span
                ><NSelect v-model:value="auto.condition.deviceId" :options="deviceOptions" @update:value="changeConditionDevice(auto)"
              /></label>
              <label class="automation-property-field"
                ><span>触发属性</span
                ><NSelect
                  v-model:value="auto.condition.property"
                  :options="conditionCapabilityOptions(auto)"
                  @update:value="normalizeCondition(auto)"
              /></label>
              <label class="automation-operator-field"
                ><span>比较方式</span><NSelect v-model:value="auto.condition.operator" :options="conditionOperatorOptions(auto)"
              /></label>
              <label class="automation-value-field"
                ><span>触发值</span>
                <NInputNumber
                  v-if="conditionValueType(auto) === 'number'"
                  :value="typeof auto.condition.value === 'number' ? auto.condition.value : null"
                  :min="conditionCapability(auto)?.min"
                  :max="conditionCapability(auto)?.max"
                  :step="conditionCapability(auto)?.step ?? 1"
                  :input-props="{ 'aria-label': `${auto.name} 触发值` }"
                  @update:value="setConditionNumber(auto, $event)"
                />
                <NSelect
                  v-else-if="['boolean', 'enum', 'action'].includes(conditionValueType(auto) ?? '')"
                  :value="String(auto.condition.value)"
                  :options="conditionValueOptions(auto)"
                  :aria-label="`${auto.name} 触发值`"
                  @update:value="setConditionValue(auto, String($event))"
                />
                <NInput
                  v-else
                  :value="String(auto.condition.value)"
                  placeholder="值"
                  :aria-label="`${auto.name} 触发值`"
                  @update:value="setConditionValue(auto, $event)"
                />
              </label>
              <label class="automation-cooldown-field"
                ><span>冷却时间（秒）</span><NInputNumber v-model:value="auto.cooldownSeconds" :min="1" :max="86400"
              /></label>
              <NButton class="automation-remove" text type="error" @click="removeAutomation(auto.id)">删除</NButton>
              <div class="scene-actions action-editor automation-action-list">
                <div v-for="(action, index) in auto.actions" :key="action.id">
                  <b>{{ index + 1 }}</b
                  ><NSelect v-model:value="action.deviceId" :options="writableDeviceOptions" @update:value="changeActionDevice(action)" />
                  <NSelect
                    v-model:value="action.property"
                    :options="capabilityOptions(action)"
                    @update:value="changeActionProperty(action)"
                  />
                  <NInputNumber
                    v-if="actionCapability(action)?.type === 'number'"
                    :value="typeof action.value === 'number' ? action.value : null"
                    :min="actionCapability(action)?.min"
                    :max="actionCapability(action)?.max"
                    :step="actionCapability(action)?.step ?? 1"
                    :input-props="{
                      'aria-label': `${actionDevice(action)?.name ?? action.deviceId} ${actionCapability(action)?.label ?? action.property} 动作值`
                    }"
                    @update:value="setActionNumber(action, $event)"
                  />
                  <NSelect
                    v-else-if="['boolean', 'enum', 'action'].includes(actionCapability(action)?.type ?? '')"
                    :value="String(action.value)"
                    :options="actionValueOptions(action)"
                    :aria-label="`${actionDevice(action)?.name ?? action.deviceId} ${actionCapability(action)?.label ?? action.property} 动作值`"
                    @update:value="setActionValue(action, String($event))"
                  />
                  <NInput
                    v-else
                    :value="String(action.value)"
                    :aria-label="`${actionDevice(action)?.name ?? action.deviceId} ${action.property} 动作值`"
                    @update:value="setActionValue(action, $event)"
                  />
                  <NButton quaternary size="small" :aria-label="`上移动作 ${index + 1}`" @click="moveAction(auto, index, -1)">↑</NButton>
                  <NButton quaternary size="small" :aria-label="`下移动作 ${index + 1}`" @click="moveAction(auto, index, 1)">↓</NButton>
                  <NButton text type="error" :aria-label="`删除动作 ${index + 1}`" @click="removeAction(auto, action.id)">×</NButton>
                </div>
                <footer>
                  <NButton secondary @click="addAction(auto)">添加动作</NButton>
                  <NButton type="primary" @click="testAutomation(auto)">保存并试运行</NButton>
                </footer>
              </div>
            </article>
            <AdminListPager
              resource="automations"
              :page="pageStates.automations.page"
              :page-size="pageStates.automations.pageSize"
              :total="pageStates.automations.total"
              :loading="pageStates.automations.loading"
              @update:page="setPage('automations', $event)"
              @update:page-size="setPageSize('automations', $event)"
            />
          </section>

          <section v-else-if="active === 'alerts'" class="panel list-panel">
            <header>
              <h3>告警确认、恢复与历史</h3>
              <div>
                <NInput v-model:value="alertQuery" clearable placeholder="搜索标题 / 消息" />
                <NSelect v-model:value="alertFilter" :options="alertFilterOptions" />
                <NButton tertiary @click="downloadAlerts">导出 CSV</NButton>
              </div>
            </header>
            <NAlert v-if="pageStates.alerts.error" type="error" :bordered="false">{{ pageStates.alerts.error }}</NAlert>
            <article v-for="alert in pageStates.alerts.items" :key="alert.id" class="alert-row">
              <span :class="alert.level" aria-hidden="true">•</span>
              <div>
                <strong>{{ alert.title }}</strong
                ><small>{{ alert.message }} · {{ formatDateTime(alert.occurredAt) }}</small>
                <small v-if="!alert.recoveredAt" class="alert-recovery-note" :class="{ blocked: !alertRecovery(alert).allowed }">{{
                  alertActionErrors[alert.id] || alertRecovery(alert).reason
                }}</small>
              </div>
              <span>{{ alert.recoveredAt ? "已恢复" : alert.acknowledgedAt ? "处理中" : "待处理" }}</span>
              <div class="alert-actions">
                <NButton v-if="!alert.acknowledgedAt" text type="warning" @click="acknowledgeAlert(alert.id)">确认</NButton>
                <NButton
                  v-if="!alert.recoveredAt"
                  text
                  type="success"
                  :loading="alertActions[alert.id] === 'recovering'"
                  :disabled="!alertRecovery(alert).allowed"
                  @click="recoverAlert(alert.id)"
                  >{{ alertActions[alert.id] === "failed" ? "重试恢复" : "恢复" }}</NButton
                >
              </div>
            </article>
            <NEmpty v-if="!pageStates.alerts.loading && !pageStates.alerts.items.length" description="没有符合条件的告警" />
            <AdminListPager
              resource="alerts"
              :page="pageStates.alerts.page"
              :page-size="pageStates.alerts.pageSize"
              :total="pageStates.alerts.total"
              :loading="pageStates.alerts.loading"
              @update:page="setPage('alerts', $event)"
              @update:page-size="setPageSize('alerts', $event)"
            />
          </section>

          <section v-else-if="active === 'gateways' && config" class="panel list-panel">
            <header>
              <div>
                <h3>本台网关、凭据引用与诊断</h3>
                <small>每台 EdgeCore 只管理所在实训台；当前配置 {{ config.gateways.length }} 个网关。</small>
              </div>
              <div>
                <NInput
                  v-model:value="pageStates.gateways.q"
                  clearable
                  placeholder="搜索网关 / 地址"
                  @update:value="schedulePageReset('gateways')"
                /><NSelect
                  v-model:value="pageStates.gateways.status"
                  :options="gatewayFilterOptions"
                  @update:value="resetPage('gateways')"
                /><NButton tertiary @click="downloadDiagnostics">导出脱敏诊断包</NButton>
              </div>
            </header>
            <NAlert v-if="!haNativeAvailable" type="info" :bordered="false">浏览器不保存 HA 凭据；请在主屏 APK 配置。</NAlert>
            <article v-else class="gateway-editor ha-setup-editor">
              <div class="ha-setup-heading">
                <strong>Home Assistant · Xiaomi Home 云链路</strong>
                <small>令牌仅存于 Android Keystore，不进入数据库、备份或日志。</small>
              </div>
              <label><span>HA 地址</span><NInput v-model:value="haSetup.baseUrl" placeholder="http://192.168.0.110:8123" /></label>
              <label
                ><span>长期访问令牌</span
                ><NInput v-model:value="haSetup.token" type="password" show-password-on="mousedown" autocomplete="off"
              /></label>
              <label><span>网关状态实体</span><NInput v-model:value="haSetup.gatewayEntityId" /></label>
              <label><span>灯实体</span><NInput v-model:value="haSetup.lightEntityId" /></label>
              <div class="gateway-actions">
                <NButton type="primary" :loading="haSetupBusy" @click="activateHomeAssistant">安全写入并启用</NButton>
                <small>依赖 HA 与小米云；断网不可控。</small>
              </div>
            </article>
            <NAlert v-if="config.gateways.length > 1" type="warning" :bordered="false" class="topology-warning">
              检测到旧版多网关控制域。两台实训台各一只网关时，请在保留项上执行“设为本台唯一网关”。
            </NAlert>
            <article v-for="gw in configItems<GatewayConfig>('gateways')" :key="gw.id" class="gateway-editor">
              <label><span>网关名称</span><NInput v-model:value="gw.name" /></label
              ><label><span>主机地址</span><NInput v-model:value="gw.host" placeholder="192.168.31.30" /></label
              ><label><span>端口</span><NInputNumber v-model:value="gw.port" :min="1" :max="65535" /></label
              ><label><span>凭据引用</span><NInput v-model:value="gw.credentialRef" readonly /></label>
              <div class="gateway-actions">
                <NButton secondary @click="testGateway(gw.id)">网关与灯联检</NButton>
                <NButton v-if="config.gateways.length > 1" secondary type="warning" @click="consolidateGateway(gw.id)"
                  >设为本台唯一网关</NButton
                ><small class="gateway-test-result" :class="gw.lastTest ? (gw.lastTest.ok ? 'success' : 'failed') : 'untested'">
                  <i />{{ gw.lastTest?.message ?? "尚未验证网关与灯实体" }}
                </small>
              </div>
            </article>
            <NEmpty
              v-if="!pageStates.gateways.loading && !configItems<GatewayConfig>('gateways').length"
              description="没有符合条件的网关"
            />
            <AdminListPager
              resource="gateways"
              :page="pageStates.gateways.page"
              :page-size="pageStates.gateways.pageSize"
              :total="pageStates.gateways.total"
              :loading="pageStates.gateways.loading"
              @update:page="setPage('gateways', $event)"
              @update:page-size="setPageSize('gateways', $event)"
            />
          </section>

          <section v-else-if="active === 'terminals' && config" class="panel list-panel">
            <header>
              <div class="terminal-heading">
                <h3>主副屏配对与在线状态</h3>
                <small>物理终端与 Web 调试会话分别按心跳判断</small>
              </div>
              <div>
                <NInput
                  v-model:value="pageStates.terminals.q"
                  clearable
                  placeholder="搜索终端"
                  @update:value="schedulePageReset('terminals')"
                /><NSelect
                  v-model:value="pageStates.terminals.status"
                  :options="terminalFilterOptions"
                  @update:value="resetPage('terminals')"
                />
              </div>
            </header>
            <NAlert type="info" :bordered="false" class="terminal-help">
              “主屏 / 副屏”代表采购的物理安卓终端；“Web 调试”只是当前浏览器会话。物理屏离线而 Web 在线并不矛盾，状态分别按各自心跳判断。
            </NAlert>
            <div class="terminal-summary" aria-label="终端状态摘要">
              <div>
                <small>物理终端</small><strong>{{ onlinePhysicalTerminalCount }}/{{ physicalTerminalCount }}</strong
                ><span>当前在线 · 共 {{ physicalTerminalCount }} 台</span>
              </div>
              <div>
                <small>Web 调试</small><strong>{{ browserTerminalCount }}</strong
                ><span>已登记会话</span>
              </div>
              <div class="pairing-summary">
                <small>一次性配对码</small><strong>{{ pairingCode || "待生成" }}</strong
                ><span>{{ pairingCode ? "配对成功后自动换新" : "仅用于新增副屏" }}</span>
              </div>
            </div>
            <div class="terminal-card-grid">
              <article
                v-for="terminal in configItems<TerminalConfig>('terminals')"
                :key="terminal.id"
                class="terminal-row"
                :class="{ 'browser-terminal': isBrowserTerminal(terminal) }"
              >
                <header class="terminal-card-head">
                  <span class="terminal-presence" :class="{ online: terminal.online }" role="status">
                    <i />{{ terminal.online ? "在线" : "离线" }}
                  </span>
                  <NTag size="small" :type="terminal.paired ? 'success' : 'default'">{{ terminal.paired ? "已配对" : "已撤销" }}</NTag>
                </header>
                <div class="terminal-identity">
                  <strong>{{ terminal.name }}</strong
                  ><small>{{ terminalRoleLabel(terminal) }} · {{ terminal.address }} · v{{ terminal.version }}</small>
                  <small class="terminal-detail">{{ terminalStatusDetail(terminal) }}</small>
                </div>
                <footer class="terminal-card-foot">
                  <time :title="terminal.lastSeenAt">最后心跳 {{ formatDateTime(terminal.lastSeenAt) }}</time>
                  <NButton
                    v-if="terminal.role !== 'primary' && terminal.paired"
                    size="small"
                    tertiary
                    type="error"
                    :disabled="busy"
                    @click="requestTerminalRevocation(terminal)"
                    >撤销配对</NButton
                  >
                </footer>
              </article>
            </div>
            <NEmpty
              v-if="!pageStates.terminals.loading && !configItems<TerminalConfig>('terminals').length"
              description="没有符合条件的终端"
            />
            <AdminListPager
              resource="terminals"
              :page="pageStates.terminals.page"
              :page-size="pageStates.terminals.pageSize"
              :total="pageStates.terminals.total"
              :loading="pageStates.terminals.loading"
              @update:page="setPage('terminals', $event)"
              @update:page-size="setPageSize('terminals', $event)"
            />
          </section>

          <section v-else-if="active === 'backup'" class="panel backup-panel">
            <header>
              <h3>脱敏配置备份与恢复</h3>
              <div>
                <NButton tertiary @click="exportBackup">生成备份</NButton>
                <NButton type="primary" :disabled="!backupText.trim()" @click="previewBackup">校验并预览</NButton>
              </div>
            </header>
            <NInput
              v-model:value="backupText"
              type="textarea"
              :autosize="{ minRows: 18, maxRows: 28 }"
              placeholder="备份 JSON；仅包含 Keystore 引用，不包含 Token/Key 明文。"
            />
            <section v-if="edge.health?.mode === 'hardware'" class="database-backup-panel">
              <header>
                <div>
                  <span class="eyebrow">本机数据灾备</span>
                  <h3>权威数据库快照</h3>
                  <small>系统每日自动创建一次并保留最近 7 份；应定期导出到实训台之外。</small>
                </div>
                <NButton
                  type="primary"
                  :loading="databaseBackupBusy"
                  :disabled="databaseBackupStorage?.canCreate === false"
                  @click="createDatabaseBackup"
                >
                  立即创建快照
                </NButton>
              </header>
              <NAlert
                v-if="databaseBackupStorage"
                :type="
                  databaseBackupStorage.level === 'critical' ? 'error' : databaseBackupStorage.level === 'warning' ? 'warning' : 'success'
                "
                :bordered="false"
              >
                {{ databaseBackupStorage.message }}。可用 {{ formatBytes(databaseBackupStorage.usableBytes) }} / 总计
                {{ formatBytes(databaseBackupStorage.totalBytes) }}；下一份预计需
                {{ formatBytes(databaseBackupStorage.estimatedNextBackupBytes) }}，并强制保留
                {{ formatBytes(databaseBackupStorage.reserveBytes) }} 运行余量。
              </NAlert>
              <NAlert type="warning" :bordered="false"> 快照含敏感记录。请保存到受控介质并留存 SHA-256；恢复前须停机校验完整性。 </NAlert>
              <section v-if="dataLifecycle" class="data-lifecycle-panel" aria-label="长期数据健康">
                <header>
                  <div>
                    <span class="eyebrow">长期数据健康</span>
                    <h3>{{ dataLifecycle.message }}</h3>
                  </div>
                  <small>{{ formatDateTime(dataLifecycle.generatedAt) }}</small>
                </header>
                <div class="lifecycle-metrics">
                  <div>
                    <span>数据库占用</span><strong>{{ formatBytes(dataLifecycle.databaseBytes) }}</strong>
                  </div>
                  <div>
                    <span>日增长趋势</span>
                    <strong>{{
                      dataLifecycle.growthBytesPerDay == null ? "样本不足" : `${formatBytes(dataLifecycle.growthBytesPerDay)}/天`
                    }}</strong>
                  </div>
                  <div>
                    <span>预计安全余量</span>
                    <strong>{{
                      dataLifecycle.estimatedDaysToReserve == null ? "待积累快照" : `${dataLifecycle.estimatedDaysToReserve} 天`
                    }}</strong>
                  </div>
                  <div>
                    <span>趋势样本</span><strong>{{ dataLifecycle.trendSamples }} 份快照</strong>
                  </div>
                </div>
                <div class="lifecycle-domains">
                  <article v-for="domain in dataLifecycle.domains" :key="domain.id">
                    <div>
                      <strong>{{ domain.label }}</strong>
                      <small>{{ domain.records }} 条 · 最早 {{ domain.oldestAt ? formatDateTime(domain.oldestAt) : "暂无记录" }}</small>
                    </div>
                    <span :class="domain.protection">{{
                      domain.protection === "authoritative" ? "权威证据" : domain.protection === "safety" ? "安全档案" : "运行记录"
                    }}</span>
                    <p>{{ domain.guidance }}</p>
                  </article>
                </div>
                <NAlert
                  :type="dataLifecycle.level === 'critical' ? 'error' : dataLifecycle.level === 'warning' ? 'warning' : 'info'"
                  :bordered="false"
                >
                  系统不自动删除记录。请先完成快照与 SHA-256 核验，再按学校制度只读归档；禁止清空告警、审计或运行交接记录。
                </NAlert>
              </section>
              <div v-if="databaseBackups.length" class="database-backup-list" aria-label="数据库快照列表">
                <article v-for="artifact in databaseBackups" :key="artifact.filename">
                  <div>
                    <strong>{{ artifact.filename }}</strong>
                    <small>{{ formatDateTime(artifact.createdAt) }} · {{ formatBytes(artifact.sizeBytes) }}</small>
                    <small :class="['backup-integrity', artifact.integrityStatus]">
                      {{ artifact.integrityStatus === "ok" ? "SQLite quick_check 通过" : "完整性校验失败" }}
                      <template v-if="artifact.schemaVersion"> · schema v{{ artifact.schemaVersion }}</template>
                      · 验证于 {{ formatDateTime(artifact.verifiedAt) }}
                    </small>
                    <code :title="artifact.sha256">SHA-256 {{ artifact.sha256 }}</code>
                  </div>
                  <NButton
                    secondary
                    :disabled="artifact.integrityStatus !== 'ok'"
                    :loading="databaseBackupBusy"
                    @click="downloadDatabaseBackup(artifact)"
                  >
                    导出
                  </NButton>
                </article>
              </div>
              <NEmpty v-else description="尚无数据库快照；请立即创建第一份离机灾备" />
            </section>
            <section v-if="edge.health?.mode === 'hardware'" class="ui-update-panel">
              <header>
                <div>
                  <span class="eyebrow">签名资源更新</span>
                  <h3>屏端 UI 离线更新与回滚</h3>
                </div>
                <NButton
                  secondary
                  type="warning"
                  :disabled="!uiUpdateStatus?.activeVersion"
                  :loading="uiUpdateBusy"
                  @click="rollbackUiUpdate"
                  ><RotateCcw :size="14" />回滚至{{ uiUpdateStatus?.previousVersion ?? "内置版本" }}</NButton
                >
              </header>
              <NAlert :type="uiUpdateStatus?.enabled ? 'info' : 'warning'" :bordered="false">
                {{ uiUpdateStatus?.message ?? "正在读取更新策略…" }}；APK 内置版本
                {{ uiUpdateStatus?.bundledVersion ?? edge.health.version }}。仅接受交付方 Ed25519
                签名包，拒绝未知签名、摘要不符、路径穿越及降级覆盖。
              </NAlert>
              <NInput
                v-model:value="uiUpdateText"
                type="textarea"
                :autosize="{ minRows: 8, maxRows: 14 }"
                :disabled="!uiUpdateStatus?.enabled"
                placeholder="粘贴 build-ui-update.mjs 生成的签名更新包 JSON"
              />
              <NButton
                type="primary"
                :disabled="!uiUpdateStatus?.enabled || !uiUpdateText.trim()"
                :loading="uiUpdateBusy"
                @click="installUiUpdate"
                >验签、安装并激活</NButton
              >
            </section>
          </section>

          <section v-else-if="active === 'audit'" class="panel list-panel">
            <header>
              <h3>服务端审计流</h3>
              <div>
                <NInput
                  v-model:value="pageStates.audits.q"
                  clearable
                  placeholder="搜索动作 / 来源 / 详情"
                  @update:value="schedulePageReset('audits')"
                /><NSelect
                  v-model:value="pageStates.audits.status"
                  :options="auditFilterOptions"
                  @update:value="resetPage('audits')"
                /><NButton tertiary size="small" @click="loadPage('audits')">刷新</NButton
                ><NButton tertiary size="small" @click="downloadAudits">导出当前筛选</NButton>
              </div>
            </header>
            <article v-for="audit in pageStates.audits.items" :key="audit.id" class="audit-row">
              <i :class="audit.result" />
              <div>
                <strong>{{ audit.action }}</strong
                ><small>{{ audit.detail }} · {{ audit.source }}</small>
              </div>
              <time :title="audit.occurredAt">{{ formatDateTime(audit.occurredAt) }}</time>
            </article>
            <NEmpty v-if="!pageStates.audits.loading && !pageStates.audits.items.length" description="暂无审计记录" />
            <AdminListPager
              resource="audits"
              :page="pageStates.audits.page"
              :page-size="pageStates.audits.pageSize"
              :total="pageStates.audits.total"
              :loading="pageStates.audits.loading"
              @update:page="setPage('audits', $event)"
              @update:page-size="setPageSize('audits', $event)"
            />
          </section>
        </div>
      </section>

      <NModal :show="Boolean(leaveTarget)" :mask-closable="false" preset="card" class="decision-modal" title="存在未保存修改">
        <p>修改未写入 EdgeCore；请保存或放弃。</p>
        <template #footer>
          <div class="decision-actions">
            <NButton @click="resolveLeave('cancel')">留在当前页</NButton>
            <NButton v-if="leaveTarget !== 'logout'" secondary @click="resolveLeave('keep')">保留草稿并前往</NButton>
            <NButton secondary type="warning" @click="resolveLeave('discard')">放弃修改</NButton>
            <NButton type="primary" :loading="busy" @click="resolveLeave('save')">保存并继续</NButton>
          </div>
        </template>
      </NModal>

      <NModal
        :show="benchResetOpen"
        :mask-closable="false"
        preset="card"
        class="decision-modal bench-reset-modal"
        title="设备安全复位"
        aria-label="设备安全复位"
        @esc="closeBenchReset"
      >
        <NAlert v-if="benchResetError" type="error" :bordered="false">{{ benchResetError }}</NAlert>
        <template v-if="benchResetResult">
          <p>复位已完成，每台设备均保留独立回执。请继续处理失败或需要人工核对的项目。</p>
          <div class="bench-reset-summary">
            <span
              >设备确认 <strong>{{ benchResetResult.summary.confirmed }}</strong></span
            >
            <span
              >已在基线 <strong>{{ benchResetResult.summary.unchanged }}</strong></span
            >
            <span
              >失败/超时 <strong>{{ benchResetResult.summary.failed + benchResetResult.summary.timeout }}</strong></span
            >
            <span
              >人工核对 <strong>{{ benchResetResult.summary.manualCheck }}</strong></span
            >
          </div>
          <div class="bench-reset-list">
            <div
              v-for="item in benchResetResult.items.filter((entry) => ['failed', 'timeout', 'manual-check'].includes(entry.outcome))"
              :key="`${item.deviceId}-${item.property}`"
            >
              <strong>{{ item.deviceName }}</strong
              ><span>{{ item.room }} · {{ item.reason }}</span>
            </div>
          </div>
        </template>
        <template v-else-if="benchResetPreview">
          <p>系统按当前权威状态生成影响清单。确认后仍通过正常命令状态机逐台执行，不会把“已下发”冒充“已复位”。</p>
          <NAlert v-if="benchResetPreview.blockers.length" type="warning" :bordered="false">
            <div v-for="blocker in benchResetPreview.blockers" :key="blocker">{{ benchResetBlockerLabel(blocker) }}</div>
          </NAlert>
          <div class="bench-reset-list">
            <div v-for="item in benchResetPreview.items" :key="`${item.deviceId}-${item.property ?? 'excluded'}`" :class="item.disposition">
              <strong>{{ item.deviceName }}</strong>
              <span>{{ item.room }} · {{ item.reason }}</span>
              <small v-if="item.property">{{ item.property }} → {{ String(item.targetValue) }}</small>
            </div>
          </div>
          <div class="bench-reset-retained">
            <strong>始终保留</strong><span>{{ benchResetPreview.retained.join("、") }}</span>
          </div>
        </template>
        <template #footer>
          <div class="decision-actions">
            <NButton :disabled="benchResetBusy" @click="closeBenchReset">{{ benchResetResult ? "完成" : "取消" }}</NButton>
            <NButton
              v-if="!benchResetResult"
              type="primary"
              :loading="benchResetBusy"
              :disabled="benchResetBusy || !benchResetPreview?.canExecute"
              @click="confirmBenchReset"
              >确认并逐台复位</NButton
            >
          </div>
        </template>
      </NModal>

      <HandoverModal
        v-if="handoverOpen"
        :busy="handoverBusy"
        :error="handoverError"
        :checklist="handoverChecklist"
        :completion="handoverCompletion"
        :acknowledgements="handoverAcknowledgements"
        :completed-by="handoverCompletedBy"
        :note="handoverNote"
        @update:completed-by="handoverCompletedBy = $event"
        @update:note="handoverNote = $event"
        @acknowledge="(warning, checked) => (handoverAcknowledgements[warning] = checked)"
        @close="closeHandover"
        @complete="completeHandover"
      />

      <NModal
        :show="Boolean(dangerDialog)"
        :mask-closable="false"
        preset="card"
        class="decision-modal danger-modal"
        :title="dangerDialog?.title"
      >
        <p>{{ dangerDialog?.detail }}</p>
        <template #footer>
          <div class="decision-actions">
            <NButton :disabled="dangerBusy" @click="closeDanger">取消</NButton>
            <NButton type="error" :loading="dangerBusy" :disabled="dangerBusy" @click="acceptDanger">{{
              dangerDialog?.confirmLabel
            }}</NButton>
          </div>
        </template>
      </NModal>

      <NModal
        :show="configurationConflictOpen"
        :mask-closable="false"
        preset="card"
        class="decision-modal configuration-conflict-preview"
        title="核对多人配置冲突"
      >
        <template v-if="configurationMergePlan">
          <p>
            系统以你开始编辑时的版本为基线，比对当前草稿和服务端版本
            {{ configurationMergePlan.server.version }}。不同记录上的修改会自动合并；同一记录被双方改动时必须逐项决定。
          </p>
          <NAlert type="info" :bordered="false">
            配置冲突只比较房间、设备、场景、联动、网关、终端与复位策略；运行记录不参与配置合并。
          </NAlert>
          <div class="merge-summary" aria-label="配置合并摘要">
            <span
              >仅本机修改 <strong>{{ configurationMergePlan.localOnly }}</strong></span
            >
            <span
              >仅服务端修改 <strong>{{ configurationMergePlan.serverOnly }}</strong></span
            >
            <span :class="{ warning: configurationMergePlan.conflicts.length }"
              >同项冲突 <strong>{{ configurationMergePlan.conflicts.length }}</strong></span
            >
          </div>
          <div v-if="configurationMergePlan.conflicts.length" class="merge-conflicts">
            <article v-for="item in configurationMergePlan.conflicts" :key="item.key">
              <div>
                <small>{{ item.resourceLabel }}</small>
                <strong>{{ item.label }}</strong>
                <span>本机{{ item.localAction }}；服务端{{ item.serverAction }}</span>
              </div>
              <div class="merge-choice" :aria-label="`${item.resourceLabel} ${item.label} 冲突选择`">
                <NButton
                  size="small"
                  :type="configurationConflictChoices[item.key] === 'local' ? 'primary' : 'default'"
                  @click="configurationConflictChoices[item.key] = 'local'"
                  >保留我的</NButton
                >
                <NButton
                  size="small"
                  :type="configurationConflictChoices[item.key] === 'server' ? 'primary' : 'default'"
                  @click="configurationConflictChoices[item.key] = 'server'"
                  >采用服务端</NButton
                >
              </div>
            </article>
          </div>
          <NAlert type="info" :bordered="false">合并只生成新的本地草稿，不会立即写入设备或覆盖服务端。</NAlert>
          <NAlert v-if="unresolvedConfigurationConflicts" type="warning" :bordered="false">
            还有 {{ unresolvedConfigurationConflicts }} 项冲突未选择，暂不能生成合并草稿。
          </NAlert>
        </template>
        <template #footer>
          <div class="decision-actions">
            <NButton @click="closeConfigurationConflict">取消</NButton>
            <NButton type="primary" :disabled="Boolean(unresolvedConfigurationConflicts)" @click="applyConfigurationMerge"
              >生成合并草稿</NButton
            >
          </div>
        </template>
      </NModal>

      <NModal
        :show="backupPreviewOpen"
        :mask-closable="false"
        preset="card"
        class="decision-modal backup-preview"
        title="确认恢复备份"
        aria-label="确认恢复备份"
      >
        <template v-if="backupSummary">
          <p>将用备份版本 {{ backupSummary.sourceVersion }} 替换六类配置资源。备份时间：{{ formatDateTime(backupSummary.exportedAt) }}。</p>
          <div class="backup-diff">
            <div
              v-for="(value, label) in {
                房间: backupSummary.rooms,
                设备: backupSummary.devices,
                场景: backupSummary.scenes,
                联动: backupSummary.automations,
                网关: backupSummary.gateways,
                终端: backupSummary.terminals
              }"
              :key="label"
            >
              <strong>{{ label }}</strong
              ><span>{{ value.total }} 项</span
              ><small :class="{ changed: value.added || value.removed || value.changed }"
                >+{{ value.added }} / −{{ value.removed }} / 内容变化 {{ value.changed }}</small
              >
            </div>
          </div>
          <NAlert v-if="backupRestoreBlockReason" type="error" :bordered="false">{{ backupRestoreBlockReason }}</NAlert>
          <NAlert type="warning" :bordered="false">恢复会生成新配置版本，不可通过“撤销”恢复。如需回滚，请先导出当前备份。</NAlert>
        </template>
        <template #footer>
          <div class="decision-actions">
            <NButton @click="backupPreviewOpen = false">取消</NButton>
            <NButton type="warning" :loading="busy" :disabled="Boolean(backupRestoreBlockReason)" @click="confirmRestoreBackup"
              >确认恢复配置</NButton
            >
          </div>
        </template>
      </NModal>

      <NModal
        :show="sessionExpired"
        :mask-closable="false"
        preset="card"
        class="decision-modal"
        :title="sessionLockReason === 'expired' ? '管理会话已过期' : '管理台已锁定'"
      >
        <p v-if="sessionLockReason === 'idle'">因 10 分钟无操作，管理数据已隐藏，当前服务端会话已吊销。</p>
        <p v-else-if="sessionLockReason === 'manual'">管理员已主动锁定本台设备，当前服务端会话已吊销。</p>
        <p v-if="hasUnsavedChanges">
          页面中未保存的配置仍保留在本机内存中。重新验证时只检查服务端版本，不会自动覆盖；若锁屏期间发生更新，系统会提示冲突。
        </p>
        <p v-else>重新验证时会先同步服务端最新配置；同步失败将保持锁屏并吊销新会话。</p>
        <NInput
          v-model:value="pin"
          type="password"
          show-password-on="mousedown"
          :input-props="{ inputmode: 'numeric' }"
          placeholder="输入管理员 PIN"
          @keyup.enter="reauthenticate"
        />
        <small v-if="authError" class="bad">{{ authError }}</small>
        <template #footer>
          <div class="decision-actions">
            <NButton type="primary" :loading="authBusy" :disabled="authBusy || authLocked || !pin" @click="reauthenticate"
              >恢复管理会话</NButton
            >
          </div>
        </template>
      </NModal>
      <NModal :show="pinChangeOpen" :mask-closable="false" preset="card" class="decision-modal pin-change-modal" title="轮换管理员 PIN">
        <p>用于管理员离岗、PIN 疑似泄露或定期轮换。成功后本台所有管理会话立即失效，主副屏控制令牌不受影响。</p>
        <div class="pin-change-fields">
          <label
            ><span>当前 PIN</span
            ><NInput v-model:value="currentAdminPin" type="password" :input-props="{ inputmode: 'numeric' }" maxlength="12"
          /></label>
          <label
            ><span>新 PIN</span
            ><NInput
              v-model:value="newAdminPin"
              type="password"
              :input-props="{ inputmode: 'numeric' }"
              maxlength="12"
              placeholder="6–12 位数字"
          /></label>
          <label
            ><span>再次输入新 PIN</span
            ><NInput
              v-model:value="confirmAdminPin"
              type="password"
              :input-props="{ inputmode: 'numeric' }"
              maxlength="12"
              @keyup.enter="changeAdminPin"
          /></label>
        </div>
        <NAlert type="warning" :bordered="false"
          >PIN 不会进入数据库快照、日志或审计详情。请使用学校批准的离线保管方式记录，不要截图或写入设备名称。</NAlert
        >
        <small v-if="pinChangeError" class="bad">{{ pinChangeError }}</small>
        <template #footer>
          <div class="decision-actions">
            <NButton :disabled="pinChangeBusy" @click="closePinChange">取消</NButton>
            <NButton
              type="warning"
              :loading="pinChangeBusy"
              :disabled="pinChangeBusy || !currentAdminPin || !newAdminPin || !confirmAdminPin"
              @click="changeAdminPin"
              >确认轮换并吊销旧会话</NButton
            >
          </div>
        </template>
      </NModal>
    </main>
  </NConfigProvider>
</template>

<style scoped>
.admin-shell {
  width: 100%;
  max-width: 100%;
  height: 100vh;
  min-width: 0;
  overflow: hidden;
}
.pin-change-fields {
  display: grid;
  gap: 12px;
  margin: 16px 0;
}
.pin-change-fields label {
  display: grid;
  gap: 6px;
}
.pin-change-fields label > span {
  color: var(--muted);
  font-size: 11px;
}
.login-stage {
  height: calc(100vh - 64px);
  display: grid;
  place-items: center;
}
.login-panel {
  width: 390px;
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: 34px;
}
.login-icon {
  width: 66px;
  height: 66px;
  display: grid;
  place-items: center;
  color: var(--cyan);
  background: var(--cyan-soft);
  border-radius: 50%;
  box-shadow: 0 0 36px rgba(24, 201, 255, 0.16);
}
h1,
h2,
h3 {
  margin: 0;
  font-weight: 500;
}
.login-panel h1 {
  font-size: 27px;
}
.login-panel p {
  color: var(--muted);
  font-size: 12px;
}
.login-panel input {
  width: 100%;
  height: 46px;
  text-align: center;
}
.login-panel small {
  color: var(--muted);
  font-size: 11px;
}
.bad {
  color: var(--danger) !important;
}
.admin-workspace {
  height: calc(100vh - 72px);
  min-height: 0;
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
}
.admin-workspace > aside {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 14px;
  background: rgba(3, 18, 40, 0.7);
  box-shadow: 14px 0 34px rgba(0, 4, 18, 0.18);
  overflow: hidden;
}
aside h1 {
  margin: 8px 0 4px;
  font-size: 25px;
}
aside p {
  margin: 0 0 19px;
  color: var(--muted);
  font-size: 11px;
}
.session-status {
  display: block;
  margin: -12px 0 16px;
  color: var(--green);
  font-size: 11px;
}
.session-status.warning {
  color: var(--warning);
}
nav {
  min-height: 0;
  flex: 1 1 auto;
  display: grid;
  align-content: start;
  gap: 3px;
  overflow: auto;
  scrollbar-width: thin;
}
nav button,
.lock-admin,
.logout {
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 11px;
  color: var(--muted);
  background: transparent;
  border-radius: 9px;
  text-align: left;
  font-size: 12px;
}
nav button.active {
  color: #fff;
  background: var(--blue-soft);
}
.lock-admin {
  margin-top: auto;
}
.logout {
  color: var(--danger);
}
.admin-workspace.session-locked {
  pointer-events: none;
  user-select: none;
}
.admin-workspace.session-locked > aside,
.admin-workspace.session-locked > .admin-content {
  filter: blur(10px);
  opacity: 0.22;
}
.admin-content {
  min-width: 0;
  padding: 18px;
  overflow: auto;
}
.workspace-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.workspace-head h2 {
  margin-top: 5px;
  font-size: 21px;
}
.workspace-app-version {
  display: none;
}
.workspace-actions,
.decision-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
.conflict-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.merge-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin: 16px 0;
}
.merge-summary span {
  display: grid;
  gap: 4px;
  padding: 12px;
  background: var(--card-soft);
  border-radius: 12px;
  color: var(--muted);
}
.merge-summary strong {
  color: var(--text);
  font-size: 18px;
}
.merge-summary .warning strong {
  color: var(--warning);
}
.merge-conflicts {
  display: grid;
  gap: 8px;
  max-height: 280px;
  margin-bottom: 12px;
  overflow: auto;
}
.merge-conflicts article {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px;
  background: var(--card-soft);
  border-radius: 12px;
}
.merge-conflicts article > div:first-child {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.merge-conflicts small,
.merge-conflicts span {
  color: var(--muted);
}
.merge-choice {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}
:deep(.configuration-conflict-preview) {
  width: min(680px, calc(100vw - 40px));
}
.save-state {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 4px;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.save-state.unsaved {
  color: var(--warning-text);
}
.save-state.unsaved i {
  width: 7px;
  height: 7px;
  background: var(--gold);
  border-radius: 50%;
  box-shadow: 0 0 0 4px var(--gold-soft);
}
.save-state.saved {
  color: var(--green);
}
.save-state.invalid {
  color: var(--danger);
}
.config-conflict {
  margin-bottom: 12px;
}
.conflict-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
:deep(.decision-modal) {
  width: min(480px, calc(100vw - 40px));
  border-radius: 20px;
}
:deep(.decision-modal .n-card__content) {
  color: var(--text-soft);
  line-height: 1.7;
}
:deep(.decision-modal .n-card__footer) {
  padding-top: 8px;
}
.save,
.minor {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 12px;
  color: var(--text);
  background: rgba(15, 78, 137, 0.5);
  border-radius: 9px;
  font-size: 12px;
}
.save {
  background: var(--blue);
}
.summary-line {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 14px;
}
.summary-line > div {
  min-height: 86px;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 5px 10px;
  padding: 15px 17px;
  background: var(--surface-strong);
  border-radius: 13px;
  box-shadow: var(--shadow-control);
}
.summary-line small {
  color: var(--muted);
  font-size: 11px;
}
.summary-line strong {
  grid-row: 1/3;
  grid-column: 2;
  font-size: 25px;
}
.summary-line span {
  display: flex;
  gap: 5px;
  color: var(--muted);
  font-size: 11px;
}
.good {
  color: var(--green) !important;
}
.admin-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.admin-grid article,
.list-panel,
.backup-panel {
  padding: 20px;
}
.admin-grid header,
.list-panel > header,
.backup-panel > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 15px;
}
.admin-grid h3,
.list-panel h3,
.backup-panel h3 {
  font-size: 16px;
}
.handover-panel {
  grid-column: 1 / -1;
  display: grid;
  gap: 8px;
  background: var(--surface-soft);
}
.handover-actions {
  display: flex;
  gap: 8px;
}
.handover-panel p,
.handover-panel small {
  margin: 0;
  color: var(--muted);
}
.handover-panel small {
  font-size: 11px;
}
.handover-policy {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) minmax(150px, 1fr) minmax(120px, 0.8fr) auto;
  align-items: end;
  gap: 10px;
  margin-top: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.handover-policy label {
  min-width: 0;
  display: grid;
  gap: 5px;
}
.handover-policy label > span {
  color: var(--muted);
  font-size: 11px;
}
.handover-policy-note {
  color: var(--warning-text) !important;
}
:deep(.bench-reset-modal) {
  width: min(680px, calc(100vw - 40px));
}
.bench-reset-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin: 16px 0;
}
.bench-reset-summary span,
.bench-reset-retained {
  display: grid;
  gap: 4px;
  padding: 11px 12px;
  border-radius: 12px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 11px;
}
.bench-reset-summary strong {
  color: var(--text);
  font-size: 18px;
}
.bench-reset-list {
  max-height: 300px;
  overflow: auto;
  display: grid;
  gap: 2px;
  margin: 14px 0;
}
.bench-reset-list > div {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(220px, 1.5fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 6px 2px;
  border-bottom: 1px solid var(--line);
}
.bench-reset-list span,
.bench-reset-list small,
.bench-reset-retained span {
  color: var(--muted);
  font-size: 11px;
}
.bench-reset-list .manual-check span,
.bench-reset-list .ready small {
  color: var(--warning-text);
}
.bench-reset-list .excluded {
  opacity: 0.72;
}
.bench-reset-retained {
  margin-top: 14px;
}
.primary {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: #032338;
  background: var(--cyan);
  border-radius: 9px;
  font-weight: 700;
}
label {
  display: grid;
  gap: 5px;
  color: var(--muted);
  font-size: 12px;
}
input,
select,
textarea {
  color: var(--text);
  background: rgba(2, 17, 36, 0.75);
  border: 1px solid var(--line);
  border-radius: 8px;
}
input,
select {
  min-height: 44px;
  padding: 0 9px;
}
.readiness ul {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.9;
}
.list-panel {
  min-height: 500px;
}
.edit-row,
.device-edit,
.scene-editor,
.automation-editor,
.gateway-editor,
.terminal-row,
.alert-row,
.audit-row {
  display: grid;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}
.edit-row {
  grid-template-columns: minmax(220px, 1fr) minmax(160px, 176px) minmax(96px, max-content) minmax(64px, max-content);
}
.device-edit {
  grid-template-columns:
    minmax(180px, 1fr) minmax(150px, 0.8fr) minmax(160px, 176px) minmax(88px, max-content)
    minmax(110px, max-content);
}
.device-flag {
  min-width: max-content;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding-inline: 4px;
  color: var(--muted);
  white-space: nowrap;
}
.safety-visibility-note {
  grid-column: 1 / -1;
  color: var(--warning);
  font-size: 11px;
}
.scene-editor {
  grid-template-columns: 160px 1fr 120px minmax(88px, max-content) minmax(64px, max-content);
}
.scene-actions {
  grid-column: 1/-1;
  display: grid;
  gap: 7px;
  color: var(--muted);
}
.action-editor > div {
  display: grid;
  grid-template-columns: 24px minmax(160px, 1fr) minmax(130px, 0.8fr) minmax(160px, 0.7fr) repeat(3, 44px);
  align-items: center;
  gap: 6px;
  padding: 6px;
  background: rgba(4, 31, 63, 0.42);
  border-radius: 7px;
}
.action-editor footer {
  display: flex;
  gap: 7px;
}
.operation-message {
  padding: 9px 12px;
  color: var(--cyan);
  background: var(--cyan-soft);
  border-radius: 8px;
  font-size: 11px;
}
.automation-editor {
  grid-template-columns: 150px 90px 150px 100px 85px 160px 160px 64px;
}
.gateway-editor {
  grid-template-columns: minmax(150px, 0.75fr) minmax(220px, 1.15fr) minmax(160px, 0.55fr) minmax(220px, 1fr);
}
.gateway-actions {
  grid-column: 1/-1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.ha-setup-editor {
  grid-template-columns: minmax(190px, 0.9fr) minmax(220px, 1fr) minmax(180px, 0.9fr) minmax(260px, 1.25fr);
  align-items: end;
  gap: 12px;
  padding: 16px;
}
.ha-setup-heading {
  grid-column: 1 / -1;
  min-width: 0;
  display: grid;
  gap: 4px;
}
.ha-setup-heading strong,
.ha-setup-heading small {
  overflow-wrap: normal;
  word-break: normal;
}
.ha-setup-editor > label {
  min-width: 0;
}
.gateway-editor small {
  color: var(--muted);
}
.gateway-test-result {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 11px;
  border-radius: 12px;
  background: var(--control);
}
.gateway-test-result i {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--faint);
}
.gateway-test-result.success {
  color: var(--green);
  background: var(--green-soft);
}
.gateway-test-result.success i {
  background: var(--green);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--green) 13%, transparent);
}
.gateway-test-result.failed {
  color: var(--danger);
  background: var(--danger-soft);
}
.gateway-test-result.failed i {
  background: var(--danger);
}
.topology-warning {
  margin-bottom: 12px;
}
.edit-row > label:not(.device-flag),
.device-edit > label:not(.device-flag),
.scene-editor > label:not(.device-flag),
.automation-editor > label:not(.device-flag),
.gateway-editor > label {
  min-width: 0;
  display: grid;
  gap: 5px;
}
.edit-row > label > span,
.device-edit > label > span,
.scene-editor > label > span,
.automation-editor > label > span,
.gateway-editor > label > span {
  color: var(--muted);
  font-size: 11px;
  line-height: 1;
}
.config-validation {
  margin-bottom: 12px;
}
.config-repair-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.config-repair-actions small {
  color: var(--muted);
}
.session-warning {
  margin-bottom: 12px;
}
.backup-diff {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin: 16px 0;
}
.backup-diff > div {
  display: grid;
  gap: 4px;
  padding: 12px;
  background: var(--card-soft);
  border-radius: 12px;
}
.backup-diff span {
  color: var(--text);
  font-size: 15px;
}
.backup-diff small {
  color: var(--muted);
  font-size: 11px;
}
.backup-diff small.changed {
  color: var(--warning);
}
:deep(.backup-preview) {
  width: min(620px, calc(100vw - 40px));
}
.terminal-help {
  margin-bottom: 12px;
}
.terminal-heading {
  display: grid !important;
  gap: 5px !important;
}
.terminal-heading small {
  color: var(--muted);
}
.terminal-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.terminal-summary > div {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 12px;
  padding: 14px 16px;
  background: var(--card-soft);
  border-radius: 14px;
}
.terminal-summary small,
.terminal-summary span {
  color: var(--muted);
  font-size: 11px;
}
.terminal-summary strong {
  grid-row: 1 / 3;
  grid-column: 2;
  align-self: center;
  color: var(--text);
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.terminal-summary .pairing-summary {
  background: var(--selected);
}
.terminal-summary .pairing-summary strong {
  color: var(--cyan);
  letter-spacing: 0.16em;
}
.terminal-card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.terminal-row {
  min-width: 0;
  min-height: 152px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  gap: 12px;
  padding: 16px;
}
.terminal-card-head,
.terminal-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.terminal-card-head {
  min-height: 24px;
}
.terminal-card-foot {
  min-height: 44px;
  margin-top: auto;
}
.terminal-card-foot time {
  min-width: 0;
  color: var(--muted);
  font-size: 11px;
}
.terminal-identity {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.terminal-identity strong,
.terminal-identity small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-row.browser-terminal {
  background: color-mix(in srgb, var(--selected) 45%, var(--card-soft));
}
.terminal-detail {
  max-width: 100%;
  line-height: 1.45;
}
.terminal-presence {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--danger);
  font-size: 11px;
  font-weight: 650;
}
.terminal-presence > i {
  width: 7px;
  height: 7px;
  background: var(--danger);
  border-radius: 50%;
}
.terminal-presence.online {
  color: var(--green);
}
.terminal-presence.online > i {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
}
.terminal-row div,
.alert-row div,
.audit-row div {
  display: grid;
  gap: 3px;
}
.terminal-row small,
.alert-row small,
.audit-row small {
  color: var(--muted);
}
.alert-row {
  grid-template-columns: 24px minmax(240px, 1fr) 72px minmax(90px, auto);
}
.alert-actions {
  display: flex !important;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
.alert-recovery-note {
  margin-top: 3px;
  color: var(--green) !important;
  font-weight: 600;
}
.alert-recovery-note.blocked {
  color: var(--warning-text) !important;
}
.audit-row {
  grid-template-columns: 12px 1fr 190px;
}
.audit-row i {
  width: 7px;
  height: 7px;
  background: var(--gold);
  border-radius: 50%;
}
.audit-row i.success {
  background: var(--green);
}
.audit-row i.failed {
  background: var(--danger);
}
.audit-row strong em {
  margin-left: 7px;
  padding: 2px 6px;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 999px;
  font-size: 10px;
  font-style: normal;
  font-weight: 650;
}
.backup-panel textarea {
  width: 100%;
  height: 510px;
  padding: 14px;
  resize: none;
  font:
    12px/1.5 ui-monospace,
    monospace;
}
.ui-update-panel,
.database-backup-panel {
  display: grid;
  gap: 12px;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}
.ui-update-panel > header,
.database-backup-panel > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.ui-update-panel > header div,
.database-backup-panel > header div {
  display: grid;
  gap: 5px;
}
.database-backup-panel > header small {
  color: var(--muted);
  font-size: 11px;
}
.database-backup-list {
  display: grid;
  gap: 8px;
}
.data-lifecycle-panel {
  display: grid;
  gap: 12px;
  padding: 14px;
  border-radius: 16px;
  background: var(--surface-soft);
}
.data-health-banner {
  margin-bottom: 14px;
}
.data-health-banner-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.data-lifecycle-panel > header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}
.data-lifecycle-panel > header div {
  display: grid;
  gap: 4px;
}
.data-lifecycle-panel h3 {
  margin: 0;
  font-size: 14px;
}
.data-lifecycle-panel small {
  color: var(--muted);
  font-size: 11px;
}
.lifecycle-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.lifecycle-metrics > div {
  display: grid;
  gap: 3px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--surface);
}
.lifecycle-metrics span,
.lifecycle-domains small {
  color: var(--muted);
  font-size: 11px;
}
.lifecycle-domains {
  display: grid;
  gap: 6px;
}
.lifecycle-domains article {
  display: grid;
  grid-template-columns: minmax(150px, 0.8fr) auto minmax(220px, 1.4fr);
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: 11px;
  background: var(--surface);
}
.lifecycle-domains article > div {
  display: grid;
  gap: 2px;
}
.lifecycle-domains article > span {
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--muted);
  background: var(--surface-soft);
  font-size: 11px;
}
.lifecycle-domains article > span.authoritative {
  color: var(--danger);
}
.lifecycle-domains article > span.safety {
  color: var(--warning);
}
.lifecycle-domains p {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
}
@media (max-width: 1100px) {
  .lifecycle-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .lifecycle-domains article {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .lifecycle-domains p {
    grid-column: 1 / -1;
  }
}
@media (max-width: 900px) {
  .admin-workspace {
    height: calc(100vh - 64px);
    grid-template-columns: 176px minmax(0, 1fr);
  }
  .admin-content {
    padding: 14px 16px 22px;
  }
  .workspace-head {
    align-items: flex-start;
    gap: 10px;
  }
  .workspace-actions {
    flex-wrap: wrap;
  }
  .summary-line {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .admin-grid {
    grid-template-columns: 1fr;
  }
  .mapping-head {
    flex-wrap: wrap;
  }
  .mapping-head :deep(.n-input),
  .mapping-head :deep(.n-select) {
    width: min(100%, 220px);
  }
}
.database-backup-list article {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface-soft);
  border-radius: 14px;
}
.database-backup-list article > div {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.database-backup-list small,
.database-backup-list code {
  color: var(--muted);
  font-size: 11px;
}
.database-backup-list .backup-integrity.ok {
  color: var(--success);
}
.database-backup-list .backup-integrity.failed {
  color: var(--danger);
}
.database-backup-list code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.backup-panel header > div,
.list-panel header > div {
  display: flex;
  gap: 8px;
}
.mapping-table {
  margin-top: 16px;
}
.mapping-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 10px;
  border-bottom: 1px solid var(--line);
}
.mapping-head strong {
  flex: 1 1 auto;
  white-space: nowrap;
}
.mapping-head :deep(.n-input) {
  width: 280px;
}
.mapping-head :deep(.n-select) {
  width: 160px;
}
</style>

<style scoped>
/* 管理端沿用同一米家浅色系统，但保留工程信息密度 */
.admin-shell {
  background: var(--canvas);
}
.admin-workspace small {
  font-size: 11px;
  line-height: 1.45;
}
.login-stage {
  height: calc(100vh - 72px);
  background: var(--canvas);
}
.login-panel {
  background: var(--card);
  border: 0;
  border-radius: 24px;
  box-shadow: 0 18px 54px rgba(43, 50, 60, 0.1);
}
.login-icon {
  color: var(--cyan);
  background: var(--cyan-soft);
  box-shadow: none;
}
.login-panel h1,
aside h1,
.workspace-head h2,
.admin-grid h3,
.list-panel h3,
.backup-panel h3 {
  color: var(--text);
}
.admin-workspace > aside {
  background: var(--nav-surface);
  border-right: 0;
  box-shadow: 12px 0 32px rgba(40, 47, 58, 0.025);
}
nav button,
.lock-admin,
.logout {
  color: var(--muted);
  border-radius: 13px;
}
nav button:hover,
.lock-admin:hover,
.logout:hover {
  color: var(--text);
  background: var(--control);
}
nav button.active {
  color: var(--text);
  background: var(--selected);
}
.admin-content {
  background: var(--canvas);
  container-name: admin-content;
  container-type: inline-size;
}
.workspace-head {
  border-bottom-color: var(--line);
}
.summary-line {
  gap: 12px;
  border: 0;
}
.summary-line > div {
  min-height: 102px;
  padding: 20px 22px;
  background: var(--card);
  border: 0;
  border-radius: 18px;
  box-shadow: var(--shadow-control);
}
.summary-line strong {
  color: var(--text);
}
.admin-grid {
  gap: 14px;
  border: 0;
}
.admin-grid article,
.list-panel,
.backup-panel {
  background: var(--card);
  border: 0;
  border-radius: 20px;
  box-shadow: var(--shadow-control);
}
.admin-grid article:first-child {
  border-right: 0;
}
.list-panel > header,
.backup-panel > header,
.edit-row,
.device-edit,
.scene-editor,
.automation-editor,
.gateway-editor,
.terminal-row,
.alert-row,
.audit-row,
.mapping-table,
.action-editor > div {
  border-color: var(--line);
}
.action-editor > div {
  background: var(--card-soft);
  border-radius: 12px;
}
.operation-message {
  color: var(--cyan);
  background: var(--selected);
}
.gateway-editor small {
  color: var(--muted);
}
input,
select,
textarea {
  color: var(--text);
  background: var(--card-soft);
  border-color: var(--line);
}
.pairing-code {
  display: block;
  margin-top: 6px;
  color: var(--muted);
}
.pairing-code strong {
  margin: 0 5px;
  color: var(--text);
  font-size: 17px;
  letter-spacing: 0.18em;
  font-variant-numeric: tabular-nums;
}
.formal-boundary {
  align-content: start;
}

/* 终稿细节层：工程页用连续工作区与分组底色代替表格式横线 */
.admin-content {
  padding: 24px 26px 30px;
}
.workspace-head {
  min-height: 62px;
  margin-bottom: 18px;
  border-bottom: 0;
}
.workspace-head h2 {
  margin: 7px 0 0;
  font-size: 25px;
  font-weight: 650;
  letter-spacing: -0.025em;
}
.list-panel,
.backup-panel,
.admin-grid article {
  padding: 22px 24px;
}
.list-panel > header,
.backup-panel > header {
  min-height: 48px;
  margin-bottom: 18px;
  border-bottom: 0;
}
.list-panel h3,
.backup-panel h3,
.admin-grid h3 {
  font-size: 17px;
  font-weight: 650;
}
.edit-row,
.device-edit,
.scene-editor,
.automation-editor,
.gateway-editor,
.terminal-row,
.alert-row,
.audit-row {
  min-height: 58px;
  margin-top: 8px;
  padding: 9px 12px;
  background: var(--card-soft);
  border-bottom: 0;
  border-radius: 14px;
  font-size: 11px;
}
.scene-editor,
.automation-editor,
.gateway-editor {
  min-height: 64px;
}
.mapping-table {
  padding: 10px;
  background: var(--card-soft);
  border: 0;
  border-radius: 16px;
}
.secondary-slot-editor {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
  padding: 14px;
  background: color-mix(in srgb, var(--selected) 52%, var(--card));
  border-radius: 14px;
}
.secondary-slot-editor > header {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.secondary-slot-editor > header div {
  display: grid;
  gap: 3px;
}
.secondary-slot-editor > header small,
.secondary-slot-editor label > small {
  color: var(--muted);
  font-size: 11px;
}
.secondary-slot-editor label {
  min-width: 0;
  display: grid;
  gap: 6px;
}
.mapping-head,
.mapping-row {
  border-bottom: 0;
}
.action-editor > div {
  border: 0;
}
.summary-line > div {
  min-height: 112px;
}
.admin-grid article,
.list-panel,
.backup-panel {
  box-shadow: var(--shadow-panel);
}

/*
 * 管理端控件层级：工作区 > 分组行 > 可编辑控件。
 * Naive UI 默认在同色背景上再绘制 1px 内框，视觉上会像圆角边缘溢出；
 * 默认态改用表面反差表达边界，只在 hover / focus 时显示状态轮廓。
 */
.admin-shell :deep(.n-input),
.admin-shell :deep(.n-base-selection-label) {
  min-height: 44px;
  border-radius: 12px;
  transition:
    background-color 0.16s ease,
    box-shadow 0.16s ease;
}
.admin-workspace :deep(.n-button),
.decision-modal :deep(.n-button),
.pin-change-modal :deep(.n-button) {
  min-width: 44px;
  min-height: 44px;
}
.admin-workspace :deep(.n-button__content),
.decision-modal :deep(.n-button__content),
.pin-change-modal :deep(.n-button__content) {
  font-size: 12px;
}
.admin-workspace :deep(.n-input__input-el),
.admin-workspace :deep(.n-base-selection-label__render-label) {
  font-size: 12px;
}
.edit-row :deep(.n-input-number),
.device-edit :deep(.n-input-number),
.scene-editor :deep(.n-input-number),
.automation-editor :deep(.n-input-number),
.gateway-editor :deep(.n-input-number),
.action-editor :deep(.n-input-number),
.handover-policy :deep(.n-input-number) {
  width: 100%;
  min-width: 160px;
}
.admin-shell :deep(.n-input__border),
.admin-shell :deep(.n-base-selection__border) {
  border-color: transparent !important;
}
.admin-shell :deep(.n-input__state-border),
.admin-shell :deep(.n-base-selection__state-border) {
  border-radius: 12px;
}
.list-panel > header :deep(.n-input),
.list-panel > header :deep(.n-base-selection-label),
.backup-panel :deep(.n-input),
.mapping-head :deep(.n-input),
.mapping-head :deep(.n-base-selection-label) {
  background: var(--control) !important;
}
.edit-row :deep(.n-input),
.device-edit :deep(.n-input),
.device-edit :deep(.n-base-selection-label),
.scene-editor :deep(.n-input),
.scene-editor :deep(.n-base-selection-label),
.automation-editor :deep(.n-input),
.automation-editor :deep(.n-base-selection-label),
.gateway-editor :deep(.n-input),
.action-editor :deep(.n-input),
.action-editor :deep(.n-base-selection-label) {
  background: var(--card) !important;
}
.admin-shell :deep(.n-input:hover),
.admin-shell :deep(.n-base-selection:not(.n-base-selection--disabled):hover .n-base-selection-label) {
  background: var(--control-hover) !important;
}
.admin-shell :deep(.n-input.n-input--focus),
.admin-shell :deep(.n-base-selection.n-base-selection--active .n-base-selection-label) {
  background: var(--card) !important;
}
.mapping-table {
  overflow: visible;
}
.mapping-table .device-edit {
  background: color-mix(in srgb, var(--card) 72%, transparent);
}
@media (max-width: 1200px) {
  .gateway-editor,
  .ha-setup-editor {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 1400px) {
  .device-edit {
    grid-template-columns:
      minmax(180px, 1.25fr) minmax(150px, 0.9fr) minmax(160px, 0.7fr) minmax(88px, max-content)
      minmax(110px, max-content);
  }
  .device-edit > .device-flag,
  .device-edit > .safety-visibility-note {
    grid-column: auto;
  }
  .scene-editor {
    grid-template-columns: minmax(180px, 0.8fr) minmax(260px, 1.4fr) 120px auto auto;
  }
  .automation-editor {
    grid-template-columns: minmax(180px, 1fr) auto minmax(160px, 1fr) 105px 100px;
  }
  .automation-editor > :nth-child(n + 6) {
    grid-row: 2;
  }
  .action-editor > div {
    grid-template-columns: 24px minmax(170px, 1fr) minmax(130px, 0.8fr) minmax(160px, 0.7fr) repeat(3, 44px);
  }
}

@media (max-width: 1100px) {
  .admin-workspace {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 72px);
  }
  .admin-workspace > aside {
    min-height: auto;
    flex: none;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    overflow: visible;
  }
  .admin-workspace > aside > .eyebrow,
  .admin-workspace > aside > p,
  .admin-workspace > aside > .session-status {
    display: none;
  }
  .admin-workspace > aside h1 {
    margin: 0;
    font-size: 18px;
    white-space: nowrap;
  }
  .admin-workspace > aside nav {
    min-width: 0;
    display: flex;
    gap: 5px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .admin-workspace > aside nav::-webkit-scrollbar {
    display: none;
  }
  .admin-workspace > aside nav button {
    flex: none;
    padding-inline: 13px;
  }
  .admin-workspace > aside .lock-admin,
  .admin-workspace > aside .logout {
    display: none;
  }
  .admin-content {
    flex: 1 1 auto;
    min-height: 0;
  }
  .workspace-head {
    align-items: flex-start;
  }
  .workspace-app-version {
    width: fit-content;
    display: inline-flex;
    margin-top: 6px;
    padding: 4px 8px;
    color: var(--muted);
    background: var(--control);
    border-radius: 999px;
    font-size: 10px;
    line-height: 1;
  }
  .workspace-actions {
    flex-wrap: wrap;
  }
  .list-panel > header,
  .backup-panel > header,
  .mapping-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .list-panel > header > div,
  .backup-panel > header > div,
  .mapping-head {
    width: 100%;
    flex-wrap: wrap;
  }
  .list-panel > header :deep(.n-input),
  .list-panel > header :deep(.n-select),
  .mapping-head :deep(.n-input),
  .mapping-head :deep(.n-select) {
    width: min(100%, 260px);
    flex: 1 1 180px;
  }
  .edit-row {
    grid-template-columns: minmax(220px, 1fr) minmax(160px, 176px) minmax(96px, max-content) minmax(64px, max-content);
  }
  .device-edit,
  .scene-editor,
  .automation-editor {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: end;
  }
  .device-edit > .device-flag,
  .scene-editor > .device-flag,
  .automation-editor > .device-flag {
    min-height: 44px;
  }
  .scene-actions,
  .automation-actions,
  .safety-visibility-note {
    grid-column: 1 / -1 !important;
  }
  .automation-editor > :nth-child(n + 6) {
    grid-row: auto;
  }
  .action-editor > div {
    grid-template-columns: 24px minmax(0, 1fr) minmax(0, 1fr);
  }
  .action-editor > div > :nth-child(n + 4) {
    grid-row: 2;
  }
  .secondary-slot-editor,
  .terminal-summary {
    grid-template-columns: 1fr;
  }
  .terminal-card-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .handover-policy {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .login-stage,
  .admin-workspace {
    height: calc(100vh - 64px);
  }
}

@media (max-width: 720px) {
  .gateway-editor,
  .ha-setup-editor {
    grid-template-columns: minmax(0, 1fr);
  }
  .admin-content {
    padding: 12px;
  }
  .workspace-head {
    flex-direction: column;
  }
  .workspace-actions,
  .workspace-actions :deep(.n-button) {
    width: 100%;
  }
  .workspace-actions {
    justify-content: stretch;
  }
  .edit-row,
  .device-edit,
  .scene-editor,
  .automation-editor,
  .handover-policy,
  .backup-diff,
  .summary-line {
    grid-template-columns: minmax(0, 1fr);
  }
  .edit-row > *,
  .device-edit > *,
  .scene-editor > *,
  .automation-editor > * {
    grid-column: 1 !important;
    grid-row: auto !important;
  }
  .action-editor > div {
    grid-template-columns: 24px minmax(0, 1fr);
  }
  .action-editor > div > * {
    grid-column: 2;
    grid-row: auto !important;
  }
  .action-editor > div > b {
    grid-column: 1;
    grid-row: 1 / span 3 !important;
  }
  .terminal-card-head,
  .terminal-card-foot {
    flex-wrap: wrap;
  }
}

/*
 * 管理页也可能显示在 Android WebView、调试侧栏或其他窄容器中。
 * 此时浏览器媒体查询报告的是外层视口宽度，不能代表实际工作区宽度；
 * 由内容容器自身决定表单是否折叠，避免桌面网格被横向裁掉。
 */
@container admin-content (max-width: 700px) {
  .workspace-head {
    flex-direction: column;
    align-items: stretch;
  }
  .workspace-actions {
    width: 100%;
    flex-wrap: wrap;
    justify-content: space-between;
  }
  .workspace-actions :deep(.n-button) {
    flex: 1 1 180px;
  }
  .list-panel,
  .backup-panel,
  .admin-grid article {
    padding: 16px;
  }
  .list-panel > header,
  .backup-panel > header,
  .mapping-head {
    align-items: stretch;
    flex-direction: column;
  }
  .list-panel > header > div,
  .backup-panel > header > div,
  .mapping-head {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .list-panel > header :deep(.n-input),
  .list-panel > header :deep(.n-select),
  .mapping-head :deep(.n-input),
  .mapping-head :deep(.n-select) {
    width: 100%;
    min-width: 0;
  }
  .list-panel > header :deep(.n-button) {
    width: 100%;
  }
  .edit-row,
  .device-edit,
  .scene-editor,
  .automation-editor,
  .gateway-editor,
  .ha-setup-editor,
  .terminal-row,
  .alert-row,
  .audit-row,
  .handover-policy,
  .backup-diff,
  .summary-line {
    grid-template-columns: minmax(0, 1fr);
    align-items: stretch;
  }
  .edit-row > *,
  .device-edit > *,
  .scene-editor > *,
  .automation-editor > *,
  .gateway-editor > *,
  .alert-row > *,
  .audit-row > * {
    grid-column: 1 !important;
    grid-row: auto !important;
  }
  .device-flag,
  .terminal-presence {
    min-height: 44px;
  }
  .gateway-actions,
  .alert-actions,
  .action-editor footer {
    justify-content: flex-start;
  }
  .terminal-summary,
  .terminal-card-grid,
  .secondary-slot-editor,
  .lifecycle-metrics {
    grid-template-columns: minmax(0, 1fr);
  }
  .action-editor > div {
    grid-template-columns: 24px minmax(0, 1fr);
  }
  .action-editor > div > * {
    grid-column: 2;
    grid-row: auto !important;
  }
  .action-editor > div > b {
    grid-column: 1;
    grid-row: 1 / span 3 !important;
  }
}

/* 中等工作区：复杂编排器按业务分组换行，不把末尾字段和危险操作挤在同一行。 */
@container admin-content (min-width: 701px) and (max-width: 1120px) {
  .scene-editor {
    grid-template-columns: minmax(180px, 0.8fr) minmax(280px, 1.3fr) minmax(130px, 0.55fr) auto auto;
  }
  .automation-editor {
    grid-template-columns: minmax(190px, 1fr) minmax(210px, 1.2fr) minmax(150px, 0.8fr) minmax(120px, 0.65fr);
    align-items: end;
  }
  .automation-editor > .automation-name-field {
    grid-column: 1 / 3;
    grid-row: 1;
  }
  .automation-editor > .automation-enabled-field {
    grid-column: 3;
    grid-row: 1;
    min-height: 44px;
  }
  .automation-editor > .automation-remove {
    grid-column: 4;
    grid-row: 1;
    justify-self: end;
  }
  .automation-editor > .automation-device-field {
    grid-column: 1 / 3;
    grid-row: 2;
  }
  .automation-editor > .automation-property-field {
    grid-column: 3;
    grid-row: 2;
  }
  .automation-editor > .automation-operator-field {
    grid-column: 4;
    grid-row: 2;
  }
  .automation-editor > .automation-value-field {
    grid-column: 1 / 3;
    grid-row: 3;
  }
  .automation-editor > .automation-cooldown-field {
    grid-column: 3 / 5;
    grid-row: 3;
  }
  .automation-editor > .automation-action-list {
    grid-column: 1 / -1;
    grid-row: 4;
  }
  .action-editor > div {
    grid-template-columns: 24px minmax(180px, 1.2fr) minmax(140px, 0.8fr) minmax(120px, 0.65fr) repeat(3, 44px);
  }
}

@container admin-content (max-width: 470px) {
  .list-panel > header > div,
  .backup-panel > header > div,
  .mapping-head {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-height: 780px) {
  .admin-workspace > aside {
    padding-block: 10px;
  }
  aside h1 {
    margin-top: 4px;
    font-size: 21px;
  }
  aside p {
    margin-bottom: 13px;
  }
  .session-status {
    margin: -7px 0 10px;
  }
  .admin-content {
    padding: 16px 18px 22px;
  }
  .workspace-head {
    min-height: 50px;
    margin-bottom: 12px;
  }
  .edit-row,
  .device-edit,
  .scene-editor,
  .automation-editor,
  .gateway-editor,
  .terminal-row,
  .alert-row,
  .audit-row {
    min-height: 52px;
    margin-top: 6px;
  }
}
</style>
