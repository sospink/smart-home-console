import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { automationOperatorSupported, capabilityValueError } from "@smart-lab/contracts";
import type {
  AlertRecord,
  AdminResourceItem,
  AdminResourceName,
  AdminConfiguration,
  BenchResetPreview,
  BenchResetResult,
  BenchResetResultItem,
  HandoverChecklist,
  HandoverCompletion,
  AuditRecord,
  AutomationConfig,
  CommandRecord,
  CommandRequest,
  Device,
  EdgeEvent,
  PageQuery,
  PaginatedResult,
  Scene,
  SceneExecution,
  SystemHealth,
  SystemSnapshot
} from "@smart-lab/contracts";
import { createSeedAlerts, createSeedDevices, createSeedScenes } from "./seed.js";
import { applyHaSnapshot, type HaSnapshot, HomeAssistantClient } from "./home-assistant.js";

const clone = <T>(value: T): T => structuredClone(value);
type SecondarySlot = "light" | "curtain" | "music";
const commandSources = new Set(["primary", "secondary", "admin", "automation"]);
const defaultBenchResetPolicy = { power: "off", cover: "closed", automationSuppressionSeconds: 8 } as const;
export type TestFaultRequest = {
  targetId: string;
  kind: "offline" | "online" | "fail-next-command" | "timeout-next-command" | "water-leak" | "clear-water-leak";
};

const secondarySlotRequirements: Record<SecondarySlot, string[]> = {
  light: ["power", "brightness"],
  curtain: ["position", "motor"],
  music: ["power", "volume"]
};

function validateSecondarySlots(devices: Device[]) {
  const slots = devices.flatMap((device) => (device.display?.secondarySlot ? [[device.display.secondarySlot, device] as const] : []));
  if (slots.some(([slot]) => !(slot in secondarySlotRequirements))) throw new Error("INVALID_SECONDARY_SLOT");
  if (new Set(slots.map(([slot]) => slot)).size !== slots.length) throw new Error("DUPLICATE_SECONDARY_SLOT");
  for (const [slot, device] of slots) {
    const required = secondarySlotRequirements[slot as SecondarySlot];
    if (required.some((property) => !device.capabilities.some((capability) => capability.property === property && capability.writable))) {
      throw new Error(`SECONDARY_SLOT_CAPABILITY_MISMATCH:${slot}:${device.id}`);
    }
  }
}

export class SimulationEngine extends EventEmitter {
  readonly controlDomainId: string;
  private sequence = 0;
  private runtimeGeneration = 0;
  private readonly startedAt = Date.now();
  private devices: Device[] = createSeedDevices();
  private scenes: Scene[] = createSeedScenes();
  private alerts: AlertRecord[] = createSeedAlerts();
  private commands: CommandRecord[] = [];
  private executions: SceneExecution[] = [];
  private audits: AuditRecord[] = [];
  private handovers: HandoverCompletion[] = [];
  private failNextCommandFor = new Set<string>();
  private timeoutNextCommandFor = new Set<string>();
  private commandByRequestId = new Map<string, CommandRecord>();
  private propertyOwners = new Map<string, string>();
  private activeScene?: { owner: string; name: string; source: CommandRequest["source"] };
  private configuration: AdminConfiguration;

  constructor(
    controlDomainId: string = randomUUID(),
    private readonly homeAssistant?: HomeAssistantClient
  ) {
    super();
    this.controlDomainId = controlDomainId;
    this.configuration = this.createConfiguration();
  }

  get hardwareMode() {
    return Boolean(this.homeAssistant);
  }

  async syncHomeAssistant(publish = true) {
    if (!this.homeAssistant) return;
    const before = new Map(this.devices.map((device) => [device.id, JSON.stringify({ health: device.health, state: device.state })]));
    const snapshot = await this.homeAssistant.snapshot();
    applyHaSnapshot(this.devices, snapshot);
    if (!publish) return;
    for (const device of this.devices) {
      if (before.get(device.id) !== JSON.stringify({ health: device.health, state: device.state })) {
        this.publish<EdgeEvent>({ type: "device.updated", payload: device } as Omit<EdgeEvent, "sequence">);
      }
    }
  }

  private createConfiguration(): AdminConfiguration {
    const rooms = [...new Set(this.devices.filter((item) => item.kind !== "gateway").map((item) => item.room))].map((name, order) => ({
      id: `room-${order + 1}`,
      name,
      order,
      enabled: true
    }));
    return {
      version: 1,
      rooms,
      devices: this.devices,
      scenes: this.scenes.map((scene) => ({ ...scene, enabled: true, strategy: "serial" })),
      automations: [],
      gateways: this.devices
        .filter((item) => item.kind === "gateway")
        .map((item, index) => ({
          id: item.id,
          name: item.name,
          host: this.homeAssistant ? this.homeAssistant.config.baseUrl : `192.168.31.${30 + index}`,
          port: this.homeAssistant ? Number(new URL(this.homeAssistant.config.baseUrl).port || 80) : 23,
          credentialRef: `keystore://${item.id}`,
          mode: this.homeAssistant ? "ha-cloud" : "test-fixture"
        })),
      terminals: [
        {
          id: "terminal-primary",
          name: "实训台主屏",
          role: "primary",
          paired: true,
          online: false,
          version: "0.1.0",
          address: "本机",
          lastSeenAt: new Date().toISOString()
        },
        {
          id: "terminal-secondary",
          name: "实训台副屏",
          role: "secondary",
          paired: true,
          online: false,
          version: "0.1.0",
          address: "局域网",
          lastSeenAt: new Date().toISOString()
        }
      ],
      benchResetPolicy: { ...defaultBenchResetPolicy }
    };
  }

  getSequence() {
    return this.sequence;
  }

  getHealth(): SystemHealth {
    const gateways = this.devices.filter((item) => item.kind === "gateway");
    return {
      controlDomainId: this.controlDomainId,
      mode: this.hardwareMode ? "hardware" : "test-fixture",
      version: this.hardwareMode ? "0.1.0-ha" : "0.1.0-sim",
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      gateways: gateways.map((gateway, index) => ({
        id: gateway.id,
        name: gateway.name,
        model: gateway.integration.marketModel ?? "DMWG03LM",
        firmware: String(gateway.state.firmware ?? "待实机读取"),
        status: gateway.health,
        latencyMs: gateway.health === "offline" ? 0 : 18 + index * 3,
        lastHeartbeatAt: gateway.updatedAt,
        mode: this.hardwareMode ? "ha-cloud" : "test-fixture"
      }))
    };
  }

  snapshot(): SystemSnapshot {
    return clone({
      sequence: this.sequence,
      devices: this.devices,
      scenes: this.scenes,
      alerts: this.alerts,
      commands: this.commands.slice(0, 30),
      executions: this.executions.slice(0, 20),
      health: this.getHealth()
    });
  }

  getDevices() {
    return clone(this.devices);
  }

  getScenes() {
    return clone(this.scenes);
  }

  getAlerts() {
    return clone(this.alerts);
  }

  getAudits() {
    return clone(this.audits.slice(0, 100));
  }

  recordAdminPinRotation() {
    this.writeAudit({
      category: "security",
      action: "轮换管理员 PIN",
      detail: "旧管理会话已全部吊销",
      source: "admin",
      result: "success"
    });
  }

  queryAdminResource(resource: AdminResourceName, query: PageQuery = {}): PaginatedResult<AdminResourceItem> {
    const q = query.q?.trim().toLowerCase() ?? "";
    const status = query.status?.trim().toLowerCase() ?? "";
    let items: AdminResourceItem[];

    switch (resource) {
      case "rooms":
        items = [...this.configuration.rooms]
          .sort((a, b) => a.order - b.order)
          .filter((item) => this.matchesText(q, item.name) && (!status || status === "all" || (status === "enabled") === item.enabled));
        break;
      case "devices":
        items = this.configuration.devices
          .filter((item) => item.kind !== "gateway")
          .sort((a, b) => (a.display?.order ?? 0) - (b.display?.order ?? 0))
          .filter(
            (item) =>
              this.matchesText(
                q,
                item.name,
                item.room,
                item.kind,
                item.health,
                item.integration.marketModel,
                item.integration.internalModel
              ) &&
              (!status || status === "all" || item.health === status || item.integration.verificationStatus === status)
          );
        break;
      case "scenes":
        items = this.configuration.scenes.filter(
          (item) =>
            this.matchesText(q, item.name, item.description, item.strategy) &&
            (!status || status === "all" || (status === "enabled") === (item.enabled !== false))
        );
        break;
      case "automations":
        items = this.configuration.automations.filter(
          (item) =>
            this.matchesText(q, item.name, item.condition.deviceId, item.condition.property, item.condition.operator) &&
            (!status || status === "all" || (status === "enabled") === item.enabled)
        );
        break;
      case "alerts":
        items = this.alerts.filter(
          (item) =>
            this.matchesText(q, item.title, item.message, item.level, item.deviceId) &&
            (!status || status === "all" || this.alertStatus(item) === status)
        );
        break;
      case "gateways":
        items = this.configuration.gateways.filter(
          (item) =>
            this.matchesText(q, item.name, item.host, item.mode, item.lastTest?.message) &&
            (!status || status === "all" || item.mode === status || (status === "tested" && !!item.lastTest))
        );
        break;
      case "terminals":
        items = this.configuration.terminals.filter(
          (item) =>
            this.matchesText(q, item.name, item.role, item.address, item.version) &&
            (!status ||
              status === "all" ||
              (status === "online" && item.online) ||
              (status === "offline" && !item.online) ||
              (status === "paired" && item.paired) ||
              (status === "unpaired" && !item.paired))
        );
        break;
      case "audits":
        items = this.audits.filter(
          (item) =>
            this.matchesText(q, item.action, item.detail, item.source, item.category, item.result) &&
            (!status || status === "all" || item.result === status || item.category === status)
        );
        break;
    }

    const requestedPageSize = Number.isFinite(query.pageSize) ? Math.trunc(query.pageSize!) : 10;
    const pageSize = Math.min(100, Math.max(1, requestedPageSize));
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const requestedPage = Number.isFinite(query.page) ? Math.trunc(query.page!) : 1;
    const page = Math.min(totalPages, Math.max(1, requestedPage));
    return clone({ items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, totalPages });
  }

  private matchesText(query: string, ...values: unknown[]) {
    return (
      !query ||
      values.some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(query)
      )
    );
  }

  private alertStatus(alert: AlertRecord) {
    return alert.recoveredAt ? "recovered" : alert.acknowledgedAt ? "acknowledged" : "open";
  }

  private benchResetTarget(device: Device): { property: string; value: string | number | boolean } | undefined {
    const policy = this.configuration.benchResetPolicy ?? defaultBenchResetPolicy;
    if (["light", "media", "switch", "panel"].includes(device.kind)) {
      if (policy.power === "unchanged") return undefined;
      const power = device.capabilities.find((item) => item.property === "power" && item.writable);
      if (power) return { property: "power", value: false };
    }
    if (device.kind === "cover") {
      if (policy.cover === "unchanged") return undefined;
      const position = device.capabilities.find((item) => item.property === "position" && item.writable);
      if (position) return { property: "position", value: policy.cover === "open" ? 100 : 0 };
    }
    return undefined;
  }

  benchResetPreview(): BenchResetPreview {
    const blockers: string[] = [];
    if (this.alerts.some((item) => item.level === "critical" && !item.recoveredAt)) blockers.push("ACTIVE_CRITICAL_ALERT");
    if (this.propertyOwners.size || this.activeScene) blockers.push("ACTIVE_OPERATION");
    const items = this.devices
      .filter((device) => device.kind !== "gateway")
      .map((device) => {
        const target = this.benchResetTarget(device);
        const common = { deviceId: device.id, deviceName: device.name, room: device.room };
        if (!target) {
          const policy = this.configuration.benchResetPolicy ?? defaultBenchResetPolicy;
          const keptByPolicy =
            (policy.power === "unchanged" && ["light", "media", "switch", "panel"].includes(device.kind)) ||
            (policy.cover === "unchanged" && device.kind === "cover");
          return {
            ...common,
            disposition: "excluded" as const,
            reason:
              device.kind === "lock"
                ? "门锁只读，设备复位禁止主动开锁或改锁态"
                : keptByPolicy
                  ? "交接策略设为保持现状"
                  : "只读或不属于安全基线"
          };
        }
        if (device.health !== "online") {
          return { ...common, ...target, targetValue: target.value, disposition: "manual-check" as const, reason: "设备离线，需现场核对" };
        }
        if (device.state[target.property] === target.value) {
          return { ...common, ...target, targetValue: target.value, disposition: "already-safe" as const, reason: "已处于安全状态" };
        }
        return {
          ...common,
          property: target.property,
          targetValue: target.value,
          disposition: "ready" as const,
          reason: "将通过正常命令链路复位"
        };
      });
    return {
      generatedAt: new Date().toISOString(),
      canExecute: blockers.length === 0,
      blockers,
      items,
      retained: ["审计记录", "告警历史与当前告警", "设备、场景与网关配置", "终端配对与管理员凭据"]
    };
  }

  async benchReset(): Promise<BenchResetResult> {
    const preview = this.benchResetPreview();
    if (preview.blockers.length) throw new Error(preview.blockers[0]);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const results: BenchResetResultItem[] = [];
    for (const item of preview.items) {
      if (item.disposition === "excluded") {
        results.push({ ...item, outcome: "excluded" });
        continue;
      }
      if (item.disposition === "manual-check") {
        results.push({ ...item, outcome: "manual-check" });
        continue;
      }
      if (item.disposition === "already-safe") {
        results.push({ ...item, outcome: "unchanged" });
        continue;
      }
      try {
        const command = await this.command(
          item.deviceId,
          {
            requestId: `bench-reset:${id}:${item.deviceId}:${item.property}`,
            property: item.property!,
            value: item.targetValue!,
            source: "admin"
          },
          undefined,
          true
        );
        results.push({
          ...item,
          command,
          outcome: command.status === "confirmed" ? "confirmed" : command.status === "timeout" ? "timeout" : "failed"
        });
      } catch (error) {
        results.push({ ...item, outcome: "failed", reason: error instanceof Error ? error.message : "复位命令失败" });
      }
    }
    const summary = {
      confirmed: results.filter((item) => item.outcome === "confirmed").length,
      unchanged: results.filter((item) => item.outcome === "unchanged").length,
      failed: results.filter((item) => item.outcome === "failed").length,
      timeout: results.filter((item) => item.outcome === "timeout").length,
      manualCheck: results.filter((item) => item.outcome === "manual-check").length,
      excluded: results.filter((item) => item.outcome === "excluded").length
    };
    const status = summary.failed || summary.timeout ? "partial" : summary.manualCheck ? "manual-check" : "completed";
    const result: BenchResetResult = {
      id,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      items: results,
      summary,
      retained: preview.retained
    };
    this.writeAudit({
      category: "system",
      action: "设备安全复位",
      detail: `确认 ${summary.confirmed}，已在安全状态 ${summary.unchanged}，失败 ${summary.failed + summary.timeout}，人工核对 ${summary.manualCheck}；告警与审计记录保留`,
      source: "admin",
      result: status === "completed" ? "success" : "failed"
    });
    return clone(result);
  }

  handoverChecklist(): HandoverChecklist {
    const preview = this.benchResetPreview();
    const activeCriticalAlerts = this.alerts.filter((item) => item.level === "critical" && !item.recoveredAt).length;
    const activeWarnings = this.alerts.filter((item) => item.level !== "critical" && !item.recoveredAt).length;
    const offlineGateways = this.devices.filter((item) => item.kind === "gateway" && item.health !== "online").length;
    const offlineDevices = this.devices.filter((item) => item.kind !== "gateway" && item.health !== "online").length;
    const pendingOperations =
      this.commands.filter((item) => item.status === "pending").length + this.executions.filter((item) => item.status === "running").length;
    const paired = this.configuration.terminals.filter((item) => item.paired);
    const baselineReady = preview.items.filter((item) => item.disposition === "already-safe" || item.disposition === "excluded").length;
    const baselineManualCheck = preview.items.filter((item) => item.disposition === "manual-check").length;
    const baselineNotReady = preview.items.filter((item) => item.disposition === "ready").length;
    const blockers = [
      ...(activeCriticalAlerts ? ["ACTIVE_CRITICAL_ALERT"] : []),
      ...(pendingOperations ? ["ACTIVE_OPERATION"] : []),
      ...(offlineGateways ? ["OFFLINE_GATEWAY"] : []),
      ...(baselineNotReady ? ["BENCH_NOT_RESET"] : [])
    ];
    const warnings = [
      ...(activeWarnings ? ["ACTIVE_NONCRITICAL_ALERTS"] : []),
      ...(offlineDevices ? ["OFFLINE_DEVICES"] : []),
      ...(baselineManualCheck ? ["MANUAL_BASELINE_CHECK"] : []),
      ...(paired.some((item) => !item.online) ? ["PAIRED_TERMINALS_OFFLINE"] : [])
    ];
    const summary = {
      activeCriticalAlerts,
      activeWarnings,
      offlineGateways,
      offlineDevices,
      pendingOperations,
      pairedTerminals: paired.length,
      onlineTerminals: paired.filter((item) => item.online).length,
      baselineReady,
      baselineManualCheck,
      baselineNotReady
    };
    const stateToken = createHash("sha256").update(JSON.stringify({ blockers, warnings, summary })).digest("hex");
    return {
      generatedAt: new Date().toISOString(),
      stateToken,
      canComplete: blockers.length === 0,
      blockers,
      warnings,
      summary,
      lastCompletion: this.handovers[0] ? clone(this.handovers[0]) : null
    };
  }

  completeHandover(request: {
    completionId: string;
    completedBy: string;
    stateToken: string;
    acknowledgedWarnings: string[];
    note: string;
  }): HandoverCompletion {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(request.completionId)) throw new Error("INVALID_HANDOVER_COMPLETION_ID");
    const existing = this.handovers.find((item) => item.id === request.completionId);
    if (existing) return clone(existing);
    const current = this.handoverChecklist();
    if (request.stateToken !== current.stateToken) throw new Error("HANDOVER_STATE_CHANGED");
    if (current.blockers.length) throw new Error(current.blockers[0]);
    const acknowledged = [...new Set(request.acknowledgedWarnings)];
    if (current.warnings.some((warning) => !acknowledged.includes(warning))) throw new Error("HANDOVER_WARNINGS_UNACKNOWLEDGED");
    if (acknowledged.some((warning) => !current.warnings.includes(warning))) throw new Error("INVALID_HANDOVER_WARNING");
    const note = request.note.trim();
    if (note.length > 200) throw new Error("INVALID_HANDOVER_NOTE");
    const completedBy = request.completedBy.trim();
    if (completedBy.length < 2 || completedBy.length > 40) throw new Error("INVALID_HANDOVER_OPERATOR");
    const completedAt = new Date().toISOString();
    const completion: HandoverCompletion = {
      id: request.completionId,
      completedAt,
      completedBy,
      stateToken: current.stateToken,
      acknowledgedWarnings: acknowledged,
      note,
      summary: current.summary
    };
    this.handovers.unshift(completion);
    this.writeAudit({
      category: "system",
      action: "完成运行交接",
      detail: `检查人 ${completedBy}；风险确认 ${acknowledged.join(",") || "无"}；${note ? `备注 ${note}；` : ""}安全状态 ${current.summary.baselineReady}，人工核对 ${current.summary.baselineManualCheck}，终端 ${current.summary.onlineTerminals}/${current.summary.pairedTerminals} 在线`,
      source: "admin",
      result: "success"
    });
    return clone(completion);
  }

  getConfiguration() {
    this.configuration.devices = this.devices;
    this.configuration.scenes = this.scenes.map((scene) => {
      const configured = this.configuration.scenes.find((item) => item.id === scene.id);
      return { ...scene, enabled: configured?.enabled ?? true, strategy: configured?.strategy ?? "serial" };
    });
    return clone(this.configuration);
  }

  setTerminalPresence(role: "primary" | "secondary", online: boolean) {
    const terminal = this.configuration.terminals.find((item) => item.role === role);
    if (!terminal || terminal.online === online) return;
    terminal.online = online;
    terminal.lastSeenAt = new Date().toISOString();
    this.publish<EdgeEvent>({ type: "terminal.updated", payload: clone(terminal) } as Omit<EdgeEvent, "sequence">);
  }

  reconcileTerminalPresence(roles: ReadonlySet<"primary" | "secondary">) {
    this.setTerminalPresence("primary", roles.has("primary"));
    this.setTerminalPresence("secondary", roles.has("secondary"));
  }

  revokeTerminal(id: string) {
    const terminal = this.configuration.terminals.find((item) => item.id === id);
    if (!terminal) throw new Error("TERMINAL_NOT_FOUND");
    if (terminal.role === "primary") throw new Error("PRIMARY_TERMINAL_CANNOT_BE_REVOKED");
    if (!terminal.paired) throw new Error("TERMINAL_ALREADY_REVOKED");
    terminal.paired = false;
    terminal.online = false;
    terminal.lastSeenAt = new Date().toISOString();
    this.writeAudit({
      category: "security",
      action: "撤销终端配对",
      detail: `${terminal.name}；旧令牌与在线事件流已失效`,
      source: "admin",
      result: "success"
    });
    this.publish<EdgeEvent>({ type: "terminal.updated", payload: clone(terminal) } as Omit<EdgeEvent, "sequence">);
    return clone(terminal);
  }

  pairSecondaryTerminal(request: { deviceId: string; name: string; role: string; version: string }, address: string) {
    if (request.role !== "secondary") throw new Error("INVALID_TERMINAL_ROLE");
    if (!/^[a-zA-Z0-9._-]{6,96}$/.test(request.deviceId)) throw new Error("INVALID_TERMINAL_ID");
    const terminal = this.configuration.terminals.find((item) => item.role === "secondary");
    if (!terminal) throw new Error("SECONDARY_TERMINAL_NOT_CONFIGURED");
    terminal.name = request.name.trim().slice(0, 80) || "副屏终端";
    terminal.paired = true;
    terminal.online = false;
    terminal.version = request.version.trim().slice(0, 40);
    terminal.address = address;
    terminal.lastSeenAt = new Date().toISOString();
    this.writeAudit({
      category: "security",
      action: "终端配对",
      detail: `${terminal.name}（${request.deviceId}）；已签发新凭据`,
      source: "pairing",
      result: "success"
    });
    this.publish<EdgeEvent>({ type: "terminal.updated", payload: clone(terminal) } as Omit<EdgeEvent, "sequence">);
    return clone(terminal);
  }

  updateConfiguration(next: AdminConfiguration) {
    if (next.version !== this.configuration.version) {
      this.writeAudit({
        category: "system",
        action: "更新配置",
        detail: `拒绝旧版本 ${next.version}，当前版本 ${this.configuration.version}`,
        source: "admin",
        result: "failed"
      });
      throw new Error("CONFIG_VERSION_CONFLICT");
    }
    this.preventTerminalCredentialReactivation(next);
    return this.applyConfiguration(next, "更新配置");
  }

  private preventTerminalCredentialReactivation(next: AdminConfiguration) {
    const revoked = new Set(this.configuration.terminals.filter((item) => !item.paired).map((item) => item.id));
    if (next.terminals.some((item) => revoked.has(item.id) && item.paired)) throw new Error("TERMINAL_REPAIR_REQUIRES_NEW_PAIRING");
  }

  private applyConfiguration(next: AdminConfiguration, auditAction: "更新配置" | "恢复配置备份") {
    if (!Array.isArray(next.rooms) || !Array.isArray(next.scenes) || !Array.isArray(next.automations))
      throw new Error("INVALID_CONFIGURATION");
    const benchResetPolicy = next.benchResetPolicy ?? { ...defaultBenchResetPolicy };
    if (!new Set(["off", "unchanged"]).has(benchResetPolicy.power)) throw new Error("INVALID_BENCH_RESET_POWER_POLICY");
    if (!new Set(["closed", "open", "unchanged"]).has(benchResetPolicy.cover)) throw new Error("INVALID_BENCH_RESET_COVER_POLICY");
    if (
      !Number.isInteger(benchResetPolicy.automationSuppressionSeconds) ||
      benchResetPolicy.automationSuppressionSeconds < 3 ||
      benchResetPolicy.automationSuppressionSeconds > 30
    )
      throw new Error("INVALID_BENCH_RESET_SUPPRESSION");
    if (!next.rooms.length || next.rooms.some((item) => !item.name.trim())) throw new Error("INVALID_CONFIGURATION_ROOMS");
    const roomNames = next.rooms.map((item) => item.name.trim());
    if (new Set(roomNames).size !== roomNames.length) throw new Error("DUPLICATE_ROOM_NAME");
    if (next.devices.some((device) => device.kind !== "gateway" && !roomNames.includes(device.room.trim())))
      throw new Error("DEVICE_ROOM_NOT_FOUND");
    if (new Set(next.devices.map((item) => item.id)).size !== next.devices.length) throw new Error("DUPLICATE_DEVICE_ID");
    if (next.scenes.some((item) => !item.name.trim())) throw new Error("INVALID_SCENE_NAME");
    if (next.automations.some((item) => !item.name.trim())) throw new Error("INVALID_AUTOMATION_NAME");
    if (
      next.automations.some((item) => !Number.isInteger(item.cooldownSeconds) || item.cooldownSeconds < 1 || item.cooldownSeconds > 86_400)
    )
      throw new Error("INVALID_AUTOMATION_COOLDOWN");
    if (next.gateways.some((item) => !item.name.trim() || !item.host.trim())) throw new Error("INVALID_GATEWAY_ADDRESS");
    if (!next.gateways.length) throw new Error("GATEWAY_REQUIRED");
    if (new Set(next.gateways.map((item) => item.id)).size !== next.gateways.length) throw new Error("DUPLICATE_GATEWAY_ID");
    if (next.gateways.some((item) => !Number.isInteger(item.port) || item.port < 1 || item.port > 65_535))
      throw new Error("INVALID_GATEWAY_PORT");
    if (next.gateways.some((item) => !item.credentialRef.startsWith("keystore://")))
      throw new Error("GATEWAY_CREDENTIAL_MUST_USE_KEYSTORE_REFERENCE");
    const gatewayIds = new Set(next.gateways.map((item) => item.id));
    if (next.devices.some((device) => device.integration.gatewayId && !gatewayIds.has(device.integration.gatewayId)))
      throw new Error("DEVICE_GATEWAY_NOT_FOUND");
    if (next.devices.some((device) => (device.kind === "sensor" || device.kind === "lock") && device.display?.hidden))
      throw new Error("SAFETY_DEVICE_CANNOT_BE_HIDDEN");
    validateSecondarySlots(next.devices);
    const devicesById = new Map(next.devices.map((device) => [device.id, device]));
    for (const action of next.scenes.flatMap((scene) => scene.actions)) {
      const device = devicesById.get(action.deviceId);
      if (!device) throw new Error(`SCENE_DEVICE_NOT_FOUND:${action.deviceId}`);
      const capability = device.capabilities.find((capability) => capability.property === action.property && capability.writable);
      if (!capability) throw new Error(`SCENE_CAPABILITY_NOT_WRITABLE:${action.deviceId}.${action.property}`);
      const valueError = capabilityValueError(capability, action.value);
      if (valueError) throw new Error(`SCENE_VALUE_INVALID:${action.deviceId}.${action.property}:${valueError}`);
    }
    for (const automation of next.automations) {
      const source = devicesById.get(automation.condition.deviceId);
      if (!source) throw new Error(`AUTOMATION_DEVICE_NOT_FOUND:${automation.condition.deviceId}`);
      const conditionCapability = source.capabilities.find((capability) => capability.property === automation.condition.property);
      if (!conditionCapability) throw new Error(`AUTOMATION_CONDITION_NOT_FOUND:${automation.condition.property}`);
      if (!automationOperatorSupported(conditionCapability, automation.condition.operator, source.state[automation.condition.property]))
        throw new Error(`AUTOMATION_OPERATOR_INVALID:${automation.condition.deviceId}.${automation.condition.property}`);
      const conditionValueError = capabilityValueError(conditionCapability, automation.condition.value);
      if (conditionValueError)
        throw new Error(
          `AUTOMATION_CONDITION_VALUE_INVALID:${automation.condition.deviceId}.${automation.condition.property}:${conditionValueError}`
        );
      for (const action of automation.actions) {
        const target = devicesById.get(action.deviceId);
        if (!target) throw new Error(`AUTOMATION_ACTION_DEVICE_NOT_FOUND:${action.deviceId}`);
        const capability = target.capabilities.find((capability) => capability.property === action.property && capability.writable);
        if (!capability) throw new Error(`AUTOMATION_CAPABILITY_NOT_WRITABLE:${action.deviceId}.${action.property}`);
        const valueError = capabilityValueError(capability, action.value);
        if (valueError) throw new Error(`AUTOMATION_VALUE_INVALID:${action.deviceId}.${action.property}:${valueError}`);
      }
    }
    const emptyEnabledScene = next.scenes.find((item) => item.enabled !== false && !item.actions.length);
    if (emptyEnabledScene) throw new Error(`SCENE_ACTION_REQUIRED:${emptyEnabledScene.id}`);
    const emptyEnabledAutomation = next.automations.find((item) => item.enabled && !item.actions.length);
    if (emptyEnabledAutomation) throw new Error(`AUTOMATION_ACTION_REQUIRED:${emptyEnabledAutomation.id}`);
    const runtimeTerminals = new Map(this.configuration.terminals.map((item) => [item.id, item]));
    const terminals = next.terminals.map((terminal) => {
      const runtime = runtimeTerminals.get(terminal.id);
      return runtime
        ? {
            ...terminal,
            paired: runtime.paired ? terminal.paired : false,
            online: runtime.online,
            version: runtime.version,
            address: runtime.address,
            lastSeenAt: runtime.lastSeenAt
          }
        : { ...terminal, online: false };
    });
    this.configuration = clone({
      ...next,
      benchResetPolicy,
      terminals,
      version: this.configuration.version + 1,
      exportedAt: undefined
    });
    const gatewayNames = new Map(next.gateways.map((item) => [item.id, item.name]));
    this.devices = clone(next.devices).map((device) =>
      device.kind === "gateway" && gatewayNames.has(device.id) ? { ...device, name: gatewayNames.get(device.id)! } : device
    );
    this.configuration.devices = this.devices;
    this.scenes = clone(next.scenes);
    this.writeAudit({
      category: "system",
      action: auditAction,
      detail:
        auditAction === "恢复配置备份"
          ? `源版本 ${next.version}，配置版本 ${this.configuration.version}`
          : `配置版本 ${this.configuration.version}`,
      source: "admin",
      result: "success"
    });
    this.publish<EdgeEvent>({ type: "snapshot", payload: this.snapshot() } as Omit<EdgeEvent, "sequence">);
    return this.getConfiguration();
  }

  exportBackup() {
    return clone({ ...this.getConfiguration(), exportedAt: new Date().toISOString() });
  }

  restoreBackup(backup: AdminConfiguration) {
    if (!backup.version || !Array.isArray(backup.devices) || !Array.isArray(backup.rooms)) throw new Error("INVALID_BACKUP");
    if (backup.version > this.configuration.version + 100) throw new Error("BACKUP_VERSION_UNSUPPORTED");
    const defaults = this.createConfiguration();
    const migrated: AdminConfiguration = {
      ...defaults,
      ...backup,
      rooms: backup.rooms,
      devices: backup.devices,
      scenes: backup.scenes ?? defaults.scenes,
      automations: backup.automations ?? [],
      gateways: backup.gateways ?? defaults.gateways,
      terminals: backup.terminals ?? defaults.terminals,
      benchResetPolicy: backup.benchResetPolicy ?? defaults.benchResetPolicy
    };
    this.preventTerminalCredentialReactivation(migrated);
    // 配置资源执行全量替换并生成新版本。
    return this.applyConfiguration(migrated, "恢复配置备份");
  }

  testGateway(gatewayId: string) {
    const gateway = this.configuration.gateways.find((item) => item.id === gatewayId);
    if (!gateway) throw new Error("GATEWAY_NOT_FOUND");
    gateway.lastTest = {
      ok: gateway.mode === "test-fixture",
      message: gateway.mode === "test-fixture" ? "隔离测试网关可用；未连接真实设备" : "实机适配器未启用，未执行真实连通测试",
      testedAt: new Date().toISOString()
    };
    this.writeAudit({
      category: "system",
      action: "网关连通测试",
      detail: `${gateway.name}: ${gateway.lastTest.message}`,
      source: "admin",
      result: "success"
    });
    return clone(gateway);
  }

  private publish<T extends EdgeEvent>(event: Omit<T, "sequence">): T {
    this.sequence += 1;
    const sequenced = { ...event, sequence: this.sequence } as T;
    this.emit("event", clone(sequenced));
    return sequenced;
  }

  private writeAudit(record: Omit<AuditRecord, "id" | "occurredAt">) {
    const audit: AuditRecord = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      ...record
    };
    this.audits.unshift(audit);
    this.publish<EdgeEvent>({ type: "audit.created", payload: audit } as Omit<EdgeEvent, "sequence">);
  }

  private operationKey(deviceId: string, property: string) {
    return `${deviceId}.${property}`;
  }

  private acquireProperty(deviceId: string, property: string, owner: string, source: CommandRequest["source"]) {
    const key = this.operationKey(deviceId, property);
    const current = this.propertyOwners.get(key);
    if (current && current !== owner) {
      this.writeAudit({
        category: "command",
        action: `${deviceId}.${property}`,
        detail: "设备属性正在执行其他操作",
        source,
        result: "failed"
      });
      throw new Error("DEVICE_OPERATION_CONFLICT");
    }
    if (!current) this.propertyOwners.set(key, owner);
    return !current;
  }

  private releaseOwner(owner: string) {
    for (const [key, current] of this.propertyOwners) if (current === owner) this.propertyOwners.delete(key);
    if (this.activeScene?.owner === owner) this.activeScene = undefined;
  }

  async command(
    deviceId: string,
    request: CommandRequest,
    leaseOwner = request.requestId,
    suppressAutomations = false
  ): Promise<CommandRecord> {
    const generation = this.runtimeGeneration;
    if (!commandSources.has(request.source)) throw new Error("INVALID_COMMAND_SOURCE");
    const duplicate = this.commandByRequestId.get(request.requestId);
    if (duplicate) return clone(duplicate);
    const acquired = this.acquireProperty(deviceId, request.property, leaseOwner, request.source);
    try {
      const device = this.devices.find((item) => item.id === deviceId);
      if (!device) throw new Error("DEVICE_NOT_FOUND");
      const capability = device.capabilities.find((item) => item.property === request.property);
      if (!capability?.writable) throw new Error("PROPERTY_NOT_WRITABLE");
      const valueError = capabilityValueError(capability, request.value);
      if (valueError) throw new Error(`INVALID_CAPABILITY_VALUE:${deviceId}.${request.property}:${valueError}`);

      const command: CommandRecord = {
        id: randomUUID(),
        deviceId,
        status: "pending",
        createdAt: new Date().toISOString(),
        ...request
      };
      this.commands.unshift(command);
      this.commandByRequestId.set(request.requestId, command);
      this.publish<EdgeEvent>({ type: "command.updated", payload: command } as Omit<EdgeEvent, "sequence">);
      this.writeAudit({
        category: "command",
        action: `${device.name}.${request.property}`,
        detail: `下发 ${String(request.value)}`,
        source: request.source,
        result: "pending"
      });

      if (this.homeAssistant && device.integration.adapter === "home-assistant") {
        try {
          const snapshot: HaSnapshot = await this.homeAssistant.command(request.property, request.value);
          applyHaSnapshot(this.devices, snapshot);
          device.updatedAt = snapshot.updatedAt;
          command.status = "confirmed";
          command.confirmedAt = device.updatedAt;
          this.publish<EdgeEvent>({ type: "device.updated", payload: device } as Omit<EdgeEvent, "sequence">);
          this.publish<EdgeEvent>({ type: "command.updated", payload: command } as Omit<EdgeEvent, "sequence">);
          this.writeAudit({
            category: "command",
            action: `${device.name}.${request.property}`,
            detail: `HA 权威状态确认 ${String(request.value)}`,
            source: request.source,
            result: "success"
          });
          if (!suppressAutomations) this.evaluateAutomations(device, request.property);
          return clone(command);
        } catch (error) {
          command.status = error instanceof Error && error.message === "HA_STATE_CONFIRMATION_TIMEOUT" ? "timeout" : "failed";
          command.error = error instanceof Error ? error.message : "HA_COMMAND_FAILED";
          this.publish<EdgeEvent>({ type: "command.updated", payload: command } as Omit<EdgeEvent, "sequence">);
          this.writeAudit({
            category: "command",
            action: `${device.name}.${request.property}`,
            detail: command.error,
            source: request.source,
            result: "failed"
          });
          return clone(command);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 420));
      if (generation !== this.runtimeGeneration) {
        return clone({ ...command, status: "failed", error: "测试夹具已复位，旧周期命令已取消" });
      }
      const gatewayOffline = device.integration.gatewayId
        ? this.devices.find((item) => item.id === device.integration.gatewayId)?.health === "offline"
        : false;
      const mustTimeout = this.timeoutNextCommandFor.delete(deviceId);
      if (mustTimeout) {
        await new Promise((resolve) => setTimeout(resolve, 650));
        command.status = "timeout";
        command.error = "设备确认超时";
        this.publish<EdgeEvent>({ type: "command.updated", payload: command } as Omit<EdgeEvent, "sequence">);
        this.writeAudit({
          category: "command",
          action: `${device.name}.${request.property}`,
          detail: command.error,
          source: request.source,
          result: "failed"
        });
        return clone(command);
      }
      const mustFail = this.failNextCommandFor.delete(deviceId) || device.health === "offline" || gatewayOffline;

      if (mustFail) {
        command.status = "failed";
        command.error = gatewayOffline ? "所属网关离线" : "测试设备未确认命令";
        this.publish<EdgeEvent>({ type: "command.updated", payload: command } as Omit<EdgeEvent, "sequence">);
        this.writeAudit({
          category: "command",
          action: `${device.name}.${request.property}`,
          detail: command.error,
          source: request.source,
          result: "failed"
        });
        return clone(command);
      }

      device.state[request.property] = request.value;
      if (request.property === "motor") {
        if (request.value === "open") device.state.position = 100;
        if (request.value === "close") device.state.position = 0;
        device.state.motor = "stopped";
      }
      device.updatedAt = new Date().toISOString();
      command.status = "confirmed";
      command.confirmedAt = device.updatedAt;
      this.publish<EdgeEvent>({ type: "device.updated", payload: device } as Omit<EdgeEvent, "sequence">);
      this.publish<EdgeEvent>({ type: "command.updated", payload: command } as Omit<EdgeEvent, "sequence">);
      this.writeAudit({
        category: "command",
        action: `${device.name}.${request.property}`,
        detail: `设备确认 ${String(request.value)}`,
        source: request.source,
        result: "success"
      });
      if (!suppressAutomations) this.evaluateAutomations(device, request.property);
      return clone(command);
    } finally {
      if (acquired) this.releaseOwner(leaseOwner);
    }
  }

  private compare(condition: AutomationConfig["condition"], actual: unknown) {
    const expected = condition.value;
    if (condition.operator === "eq") return actual === expected;
    if (condition.operator === "neq") return actual !== expected;
    if (condition.operator === "gt") return Number(actual) > Number(expected);
    if (condition.operator === "gte") return Number(actual) >= Number(expected);
    if (condition.operator === "lt") return Number(actual) < Number(expected);
    return Number(actual) <= Number(expected);
  }

  private evaluateAutomations(device: Device, changedProperty: string) {
    for (const automation of this.configuration.automations) {
      if (!automation.enabled || automation.condition.deviceId !== device.id || automation.condition.property !== changedProperty) continue;
      const last = automation.lastTriggeredAt ? Date.parse(automation.lastTriggeredAt) : 0;
      if (Date.now() - last < automation.cooldownSeconds * 1000) continue;
      if (!this.compare(automation.condition, device.state[automation.condition.property])) continue;
      automation.lastTriggeredAt = new Date().toISOString();
      const triggeredAt = Date.now();
      void Promise.allSettled(
        automation.actions.map((action, index) =>
          this.command(action.deviceId, {
            requestId: `automation:${automation.id}:${action.id}:${triggeredAt}:${index}`,
            property: action.property,
            value: action.value,
            source: "automation"
          })
        )
      ).then((results) => {
        const confirmed = results.filter((result) => result.status === "fulfilled" && result.value.status === "confirmed").length;
        this.writeAudit({
          category: "system",
          action: "自动联动",
          detail: `${automation.name}: ${confirmed}/${automation.actions.length} 项已确认`,
          source: "automation",
          result: confirmed === automation.actions.length ? "success" : "failed"
        });
      });
    }
  }

  private reconcileAvailabilityAlert(device: Device, timestamp: string) {
    if (device.kind !== "sensor" && device.kind !== "lock") return;
    const title = "监控链路不可用";
    const existing = this.alerts.find((alert) => alert.deviceId === device.id && alert.title === title && !alert.recoveredAt);
    if (device.health === "offline") {
      if (existing) return;
      const alert: AlertRecord = {
        id: randomUUID(),
        deviceId: device.id,
        level: "warning",
        title,
        message: `${device.room}的${device.name}已离线，当前无法确认安防状态，请检查供电、网关与通信链路。`,
        occurredAt: timestamp,
        recoveryProperty: "__health",
        recoveryValue: "online"
      };
      this.alerts.unshift(alert);
      this.publish<EdgeEvent>({ type: "alert.created", payload: alert } as Omit<EdgeEvent, "sequence">);
      this.writeAudit({ category: "alert", action: title, detail: alert.message, source: "gateway", result: "failed" });
      return;
    }
    if (!existing) return;
    existing.recoveredAt = timestamp;
    this.publish<EdgeEvent>({ type: "alert.updated", payload: existing } as Omit<EdgeEvent, "sequence">);
    this.writeAudit({ category: "alert", action: "监控链路恢复", detail: device.name, source: "gateway", result: "success" });
  }

  async executeScene(sceneId: string, source: CommandRequest["source"]): Promise<SceneExecution> {
    const generation = this.runtimeGeneration;
    if (!commandSources.has(source)) throw new Error("INVALID_SCENE_SOURCE");
    const scene = this.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error("SCENE_NOT_FOUND");
    if (scene.enabled === false) throw new Error("SCENE_DISABLED");
    if (!scene.actions.length) throw new Error("SCENE_ACTION_REQUIRED");
    if (this.activeScene) {
      this.writeAudit({
        category: "scene",
        action: scene.name,
        detail: `${this.activeScene.name}场景正在执行`,
        source,
        result: "failed"
      });
      throw new Error(`SCENE_EXECUTION_CONFLICT:${this.activeScene.name}:${this.activeScene.source}`);
    }
    const executionId = randomUUID();
    const keys = [...new Set(scene.actions.map((action) => this.operationKey(action.deviceId, action.property)))];
    if (keys.some((key) => this.propertyOwners.has(key))) {
      this.writeAudit({ category: "scene", action: scene.name, detail: "场景设备正在执行其他操作", source, result: "failed" });
      throw new Error("SCENE_DEVICE_OPERATION_CONFLICT");
    }
    this.activeScene = { owner: executionId, name: scene.name, source };
    keys.forEach((key) => this.propertyOwners.set(key, executionId));
    const execution: SceneExecution = {
      id: executionId,
      sceneId,
      source,
      status: "running",
      completedActions: 0,
      totalActions: scene.actions.length,
      startedAt: new Date().toISOString()
    };
    this.executions.unshift(execution);
    this.publish<EdgeEvent>({ type: "scene.execution", payload: execution } as Omit<EdgeEvent, "sequence">);
    try {
      const runAction = async (action: Scene["actions"][number]) => {
        let confirmed = false;
        if (generation !== this.runtimeGeneration) return confirmed;
        try {
          const result = await this.command(
            action.deviceId,
            {
              requestId: `${execution.id}:${action.id}`,
              property: action.property,
              value: action.value,
              source
            },
            execution.id
          );
          confirmed = generation === this.runtimeGeneration && result.status === "confirmed";
          if (confirmed) execution.completedActions += 1;
        } catch {
          /* action result is captured as false */
        }
        if (generation === this.runtimeGeneration) {
          this.publish<EdgeEvent>({ type: "scene.execution", payload: execution } as Omit<EdgeEvent, "sequence">);
        }
        return confirmed;
      };
      let results: boolean[];
      if (scene.strategy === "parallel") {
        results = await Promise.all(scene.actions.map(runAction));
      } else {
        results = [];
        for (const action of scene.actions) results.push(await runAction(action));
      }
      if (generation !== this.runtimeGeneration) {
        execution.status = execution.completedActions > 0 ? "partial" : "failed";
        execution.finishedAt = new Date().toISOString();
        return clone(execution);
      }
      const failed = results.filter((result) => !result).length;
      execution.status = failed === 0 ? "completed" : execution.completedActions > 0 ? "partial" : "failed";
      execution.finishedAt = new Date().toISOString();
      scene.lastExecutedAt = execution.finishedAt;
      this.publish<EdgeEvent>({ type: "scene.updated", payload: scene } as Omit<EdgeEvent, "sequence">);
      this.publish<EdgeEvent>({ type: "scene.execution", payload: execution } as Omit<EdgeEvent, "sequence">);
      this.writeAudit({
        category: "scene",
        action: scene.name,
        detail: `${execution.completedActions}/${execution.totalActions} 个动作确认`,
        source,
        result: execution.status === "completed" ? "success" : "failed"
      });
      return clone(execution);
    } finally {
      this.releaseOwner(executionId);
    }
  }

  acknowledgeAlert(alertId: string, source: CommandRequest["source"] = "primary") {
    if (!commandSources.has(source) || source === "automation") throw new Error("INVALID_ALERT_SOURCE");
    const alert = this.alerts.find((item) => item.id === alertId);
    if (!alert) throw new Error("ALERT_NOT_FOUND");
    alert.acknowledgedAt = new Date().toISOString();
    this.publish<EdgeEvent>({ type: "alert.updated", payload: alert } as Omit<EdgeEvent, "sequence">);
    this.writeAudit({ category: "alert", action: "确认告警", detail: alert.title, source, result: "success" });
    return clone(alert);
  }

  recoverAlert(alertId: string, source: "admin" | "gateway" = "admin") {
    const alert = this.alerts.find((item) => item.id === alertId);
    if (!alert) throw new Error("ALERT_NOT_FOUND");
    if (alert.recoveredAt) return clone(alert);
    if (alert.recoveryProperty) {
      const device = this.devices.find((item) => item.id === alert.deviceId);
      if (!device) throw new Error("ALERT_RECOVERY_STATE_UNAVAILABLE");
      const actual = alert.recoveryProperty === "__health" ? device.health : device.state[alert.recoveryProperty];
      if (alert.recoveryProperty !== "__health" && (device.health !== "online" || !(alert.recoveryProperty in device.state))) {
        throw new Error("ALERT_RECOVERY_STATE_UNAVAILABLE");
      }
      if (actual !== alert.recoveryValue) {
        throw new Error("ALERT_CONDITION_STILL_ACTIVE");
      }
    }
    alert.recoveredAt = new Date().toISOString();
    if (!alert.acknowledgedAt) alert.acknowledgedAt = alert.recoveredAt;
    this.publish<EdgeEvent>({ type: "alert.updated", payload: alert } as Omit<EdgeEvent, "sequence">);
    this.writeAudit({ category: "alert", action: "恢复告警", detail: alert.title, source, result: "success" });
    return clone(alert);
  }

  injectFault(request: TestFaultRequest) {
    const device = this.devices.find((item) => item.id === request.targetId);
    if (!device) throw new Error("TARGET_NOT_FOUND");
    const timestamp = new Date().toISOString();

    if (request.kind === "offline" || request.kind === "online") {
      device.health = request.kind;
      device.updatedAt = timestamp;
      this.publish<EdgeEvent>({ type: "device.updated", payload: device } as Omit<EdgeEvent, "sequence">);
      this.reconcileAvailabilityAlert(device, timestamp);
      if (device.kind === "gateway") {
        if (request.kind === "offline") {
          this.devices
            .filter((item) => item.integration.gatewayId === device.id && item.health !== "offline")
            .forEach((child) => {
              child.health = "offline";
              child.updatedAt = timestamp;
              this.publish<EdgeEvent>({ type: "device.updated", payload: child } as Omit<EdgeEvent, "sequence">);
              this.reconcileAvailabilityAlert(child, timestamp);
            });
        }
        this.publish<EdgeEvent>({ type: "health.updated", payload: this.getHealth() } as Omit<EdgeEvent, "sequence">);
      }
    }
    if (request.kind === "fail-next-command") this.failNextCommandFor.add(device.id);
    if (request.kind === "timeout-next-command") this.timeoutNextCommandFor.add(device.id);
    if (request.kind === "water-leak" || request.kind === "clear-water-leak") {
      device.state.waterLeak = request.kind === "water-leak";
      device.updatedAt = timestamp;
      this.publish<EdgeEvent>({ type: "device.updated", payload: device } as Omit<EdgeEvent, "sequence">);
      this.evaluateAutomations(device, "waterLeak");
      if (request.kind === "water-leak") {
        const existing = this.alerts.find((alert) => alert.deviceId === device.id && alert.title === "检测到水浸" && !alert.recoveredAt);
        if (existing) {
          this.writeAudit({ category: "alert", action: "重复告警已抑制", detail: existing.title, source: "gateway", result: "ignored" });
          this.writeAudit({
            category: "system",
            action: `测试夹具：${request.kind}`,
            detail: device.name,
            source: "test-support",
            result: "success"
          });
          return clone(device);
        }
        const alert: AlertRecord = {
          id: randomUUID(),
          deviceId: device.id,
          level: "critical",
          title: "检测到水浸",
          message: `${device.room}的${device.name}触发，请立即检查。`,
          occurredAt: timestamp,
          recoveryProperty: "waterLeak",
          recoveryValue: false
        };
        this.alerts.unshift(alert);
        this.publish<EdgeEvent>({ type: "alert.created", payload: alert } as Omit<EdgeEvent, "sequence">);
      } else {
        this.alerts
          .filter(
            (alert) =>
              alert.deviceId === device.id && !alert.recoveredAt && alert.recoveryProperty === "waterLeak" && alert.recoveryValue === false
          )
          .forEach((alert) => this.recoverAlert(alert.id, "gateway"));
      }
    }
    this.writeAudit({
      category: "system",
      action: `测试夹具：${request.kind}`,
      detail: device.name,
      source: "test-support",
      result: "success"
    });
    return clone(device);
  }

  reset() {
    this.runtimeGeneration += 1;
    this.devices = createSeedDevices();
    this.scenes = createSeedScenes();
    this.alerts = createSeedAlerts();
    this.commands = [];
    this.executions = [];
    this.failNextCommandFor.clear();
    this.timeoutNextCommandFor.clear();
    this.commandByRequestId.clear();
    // 测试夹具复位会开启新的运行周期，不能把上一周期尚未释放的场景/属性租约带入下一轮测试。
    this.propertyOwners.clear();
    this.activeScene = undefined;
    this.configuration = this.createConfiguration();
    const snapshot = this.snapshot();
    this.publish<EdgeEvent>({ type: "snapshot", payload: snapshot } as Omit<EdgeEvent, "sequence">);
    this.writeAudit({
      category: "system",
      action: "重置测试夹具",
      detail: "恢复初始设备与场景状态",
      source: "test-support",
      result: "success"
    });
    return this.snapshot();
  }
}
