export type DeviceKind = "gateway" | "light" | "cover" | "sensor" | "lock" | "media" | "switch" | "panel";

export type DeviceHealth = "online" | "offline" | "degraded" | "unknown";
export type VerificationStatus = "test-fixture" | "hardware-pending" | "hardware-verified" | "blocked";

export interface DeviceCapability {
  property: string;
  label: string;
  type: "boolean" | "number" | "enum" | "action" | "readonly";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: Array<{ label: string; value: string | number }>;
  writable: boolean;
}

export type CapabilityValueError = "TYPE" | "MIN" | "MAX" | "STEP" | "OPTION";

export function capabilityValueError(
  capability: DeviceCapability,
  value: string | number | boolean | null
): CapabilityValueError | undefined {
  if (capability.type === "boolean") return typeof value === "boolean" ? undefined : "TYPE";
  if (capability.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "TYPE";
    if (capability.min != null && value < capability.min) return "MIN";
    if (capability.max != null && value > capability.max) return "MAX";
    if (capability.step != null && capability.step > 0) {
      const steps = (value - (capability.min ?? 0)) / capability.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) return "STEP";
    }
    return undefined;
  }
  if (capability.type === "enum" || capability.type === "action") {
    return capability.options?.some((option) => option.value === value) ? undefined : "OPTION";
  }
  return capability.type === "readonly" ? undefined : capability.writable ? undefined : "TYPE";
}

export function automationOperatorSupported(
  capability: DeviceCapability,
  operator: AutomationCondition["operator"],
  currentValue?: string | number | boolean | null
) {
  return capability.type === "number" || typeof currentValue === "number" || operator === "eq" || operator === "neq";
}

export interface DeviceIntegration {
  adapter: "mock" | "dmwg03lm" | "miot-local" | "home-assistant" | "vendor";
  externalId?: string;
  marketModel?: string;
  internalModel?: string;
  protocol: "zigbee" | "ble-mesh" | "ble" | "wifi" | "virtual";
  gatewayId?: string;
  verificationStatus: VerificationStatus;
  note?: string;
}

export interface Device {
  id: string;
  name: string;
  room: string;
  kind: DeviceKind;
  health: DeviceHealth;
  updatedAt: string;
  state: Record<string, string | number | boolean | null>;
  capabilities: DeviceCapability[];
  integration: DeviceIntegration;
  display?: {
    icon?: string;
    order?: number;
    hidden?: boolean;
    favorite?: boolean;
    secondarySlot?: "light" | "curtain" | "music";
  };
}

export interface SceneAction {
  id: string;
  deviceId: string;
  property: string;
  value: string | number | boolean;
  label: string;
}

export interface Scene {
  id: string;
  name: string;
  description: string;
  tone: "cyan" | "gold" | "violet" | "green";
  actions: SceneAction[];
  lastExecutedAt?: string;
  enabled?: boolean;
  strategy?: "serial" | "parallel";
}

export interface AlertRecord {
  id: string;
  deviceId: string;
  level: "info" | "warning" | "critical";
  title: string;
  message: string;
  occurredAt: string;
  acknowledgedAt?: string;
  recoveredAt?: string;
  recoveryProperty?: string;
  recoveryValue?: string | number | boolean | null;
}

export type CommandStatus = "pending" | "confirmed" | "failed" | "timeout";

export interface CommandRequest {
  requestId: string;
  property: string;
  value: string | number | boolean;
  source: "primary" | "secondary" | "admin" | "automation";
}

export interface CommandRecord extends CommandRequest {
  id: string;
  deviceId: string;
  status: CommandStatus;
  createdAt: string;
  confirmedAt?: string;
  error?: string;
}

export interface SceneExecution {
  id: string;
  sceneId: string;
  source: CommandRequest["source"];
  status: "running" | "completed" | "partial" | "failed";
  completedActions: number;
  totalActions: number;
  startedAt: string;
  finishedAt?: string;
}

export interface GatewayHealth {
  id: string;
  name: string;
  model: string;
  firmware: string;
  status: DeviceHealth;
  latencyMs: number;
  lastHeartbeatAt: string;
  mode: "test-fixture" | "local" | "ha-cloud";
}

export interface SystemHealth {
  /** 一台实训台安装实例的稳定身份；地址变化时用于防止副屏凭据串到另一台主屏。 */
  controlDomainId: string;
  mode: "test-fixture" | "hardware";
  version: string;
  serverTime: string;
  uptimeSeconds: number;
  gateways: GatewayHealth[];
}

export interface AuditRecord {
  id: string;
  category: "command" | "scene" | "alert" | "system" | "security";
  action: string;
  detail: string;
  source: string;
  result: "success" | "failed" | "pending" | "ignored";
  occurredAt: string;
}

export interface SystemSnapshot {
  sequence: number;
  devices: Device[];
  scenes: Scene[];
  alerts: AlertRecord[];
  commands: CommandRecord[];
  executions: SceneExecution[];
  health: SystemHealth;
}

export interface RoomConfig {
  id: string;
  name: string;
  order: number;
  enabled: boolean;
}

export interface AutomationCondition {
  deviceId: string;
  property: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  value: string | number | boolean;
}

export interface AutomationConfig {
  id: string;
  name: string;
  enabled: boolean;
  condition: AutomationCondition;
  actions: SceneAction[];
  cooldownSeconds: number;
  lastTriggeredAt?: string;
}

export interface GatewayConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  credentialRef: string;
  mode: "test-fixture" | "local" | "ha-cloud";
  lastTest?: { ok: boolean; message: string; testedAt: string };
}

export interface TerminalConfig {
  id: string;
  name: string;
  role: "primary" | "secondary";
  paired: boolean;
  online: boolean;
  version: string;
  address: string;
  lastSeenAt: string;
}

export interface AdminConfiguration {
  version: number;
  exportedAt?: string;
  rooms: RoomConfig[];
  devices: Device[];
  scenes: Scene[];
  automations: AutomationConfig[];
  gateways: GatewayConfig[];
  terminals: TerminalConfig[];
  benchResetPolicy?: BenchResetPolicy;
}

export interface BenchResetPolicy {
  power: "off" | "unchanged";
  cover: "closed" | "open" | "unchanged";
  automationSuppressionSeconds: number;
}

export interface AdminSession {
  token: string;
  expiresAt: string;
}

export type BenchResetDisposition = "ready" | "already-safe" | "manual-check" | "excluded";
export type BenchResetOutcome = "confirmed" | "failed" | "timeout" | "unchanged" | "manual-check" | "excluded";

export interface BenchResetItem {
  deviceId: string;
  deviceName: string;
  room: string;
  property?: string;
  targetValue?: string | number | boolean;
  disposition: BenchResetDisposition;
  reason: string;
}

/** 管理员确认前的权威设备安全复位影响清单；由 EdgeCore 根据当前状态生成。 */
export interface BenchResetPreview {
  generatedAt: string;
  canExecute: boolean;
  blockers: string[];
  items: BenchResetItem[];
  retained: string[];
}

export interface BenchResetResultItem extends BenchResetItem {
  outcome: BenchResetOutcome;
  command?: CommandRecord;
}

export interface BenchResetResult {
  id: string;
  status: "completed" | "partial" | "manual-check";
  startedAt: string;
  finishedAt: string;
  items: BenchResetResultItem[];
  summary: {
    confirmed: number;
    unchanged: number;
    failed: number;
    timeout: number;
    manualCheck: number;
    excluded: number;
  };
  retained: string[];
}

/** 下一位值班人员接手前由 EdgeCore 按当前权威状态生成的运行检查单。 */
export interface HandoverChecklist {
  generatedAt: string;
  stateToken: string;
  canComplete: boolean;
  blockers: string[];
  warnings: string[];
  summary: {
    activeCriticalAlerts: number;
    activeWarnings: number;
    offlineGateways: number;
    offlineDevices: number;
    pendingOperations: number;
    pairedTerminals: number;
    onlineTerminals: number;
    baselineReady: number;
    baselineManualCheck: number;
    baselineNotReady: number;
  };
  /** 最近一次由 EdgeCore 持久化的交接；为空表示尚无交接记录。 */
  lastCompletion: HandoverCompletion | null;
}

export interface HandoverCompletion {
  id: string;
  completedAt: string;
  completedBy: string;
  stateToken: string;
  acknowledgedWarnings: string[];
  note: string;
  summary: HandoverChecklist["summary"];
}

export type AdminResourceName = "rooms" | "devices" | "scenes" | "automations" | "alerts" | "gateways" | "terminals" | "audits";

export type AdminResourceItem = RoomConfig | Device | Scene | AutomationConfig | AlertRecord | GatewayConfig | TerminalConfig | AuditRecord;

export interface PageQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type EdgeEvent =
  | { type: "snapshot"; sequence: number; payload: SystemSnapshot }
  | { type: "heartbeat"; sequence: number; payload: { serverTime: string } }
  | { type: "device.updated"; sequence: number; payload: Device }
  | { type: "command.updated"; sequence: number; payload: CommandRecord }
  | { type: "scene.updated"; sequence: number; payload: Scene }
  | { type: "scene.execution"; sequence: number; payload: SceneExecution }
  | { type: "alert.created"; sequence: number; payload: AlertRecord }
  | { type: "alert.updated"; sequence: number; payload: AlertRecord }
  | { type: "health.updated"; sequence: number; payload: SystemHealth }
  | { type: "terminal.updated"; sequence: number; payload: TerminalConfig }
  | { type: "audit.created"; sequence: number; payload: AuditRecord };

export interface ApiEnvelope<T> {
  data: T;
  sequence: number;
}

export interface UiUpdateStatus {
  enabled: boolean;
  bundledVersion: string;
  activeVersion?: string;
  previousVersion?: string;
  installedVersions: string[];
  message: string;
}

export interface UiUpdateInstallRequest {
  manifestJson: string;
  signature: string;
  files: Record<string, string>;
}

export interface UiUpdateSync {
  targetVersion?: string;
  update?: UiUpdateInstallRequest;
}
