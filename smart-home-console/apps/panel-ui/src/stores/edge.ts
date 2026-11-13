import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { CommandRecord, CommandStatus, Device, EdgeEvent, SystemSnapshot, TerminalConfig } from "@smart-lab/contracts";
import { edgeApi, eventUrl, resolveEdgeBase } from "../lib/api";
import { activeAlerts as selectActiveAlerts, unacknowledgedAlerts as selectUnacknowledgedAlerts } from "../lib/alerts";
import { sequenceDecision } from "../lib/sequence";
import { operationKey, pendingCommandsByProperty } from "../lib/runtime";
import { runtimeId } from "../lib/runtime-id";
import { readSnapshotCache, snapshotCacheKey, writeSnapshotCache } from "../lib/snapshot-cache";
import { runtimeCommandSource, runtimeTerminalRole } from "../lib/terminal-runtime";
import {
  ConnectionIntent,
  connectionIssue as describeConnectionIssue,
  EventLiveness,
  eventStreamIsStale,
  preferConnectionIssue,
  reconnectDelay,
  type ConnectionIssue
} from "../lib/connection";

export const useEdgeStore = defineStore("edge", () => {
  const snapshot = ref<SystemSnapshot>();
  const connected = ref(false);
  const loading = ref(true);
  const connectionError = ref<string>();
  const connectionIssue = ref<ConnectionIssue>();
  const networkOnline = ref(typeof navigator === "undefined" ? true : navigator.onLine);
  const recoveringSequence = ref(false);
  const staleSince = ref<string>();
  const cachedSnapshotAt = ref<string>();
  const pendingByProperty = ref<Record<string, CommandRecord>>({});
  const requestingByProperty = ref<Record<string, boolean>>({});
  const requestingSceneIds = ref<Record<string, boolean>>({});
  const pendingByDevice = computed(() => aggregateCommandsByDevice(pendingByProperty.value));
  const activeExecution = computed(() => snapshot.value?.executions.find((execution) => execution.status === "running"));
  const feedbackByProperty = ref<Record<string, DeviceFeedback>>({});
  const feedbackByDevice = computed(() => aggregateFeedbackByDevice(feedbackByProperty.value));
  const syncPulse = ref<SyncPulse>();
  const operationNotice = ref<OperationNotice>();
  const reconnectAttempt = ref(0);
  const retryInSeconds = ref<number>();
  const lastEventReceivedAt = ref<number>();
  const terminalRevision = ref(0);
  const latestTerminalUpdate = ref<TerminalConfig>();
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let reconnectCountdownTimer: number | undefined;
  let socketOpenTimer: number | undefined;
  let authoritativeSnapshotTimer: number | undefined;
  let connectAttempt: Promise<void> | undefined;
  const connectionIntent = new ConnectionIntent();
  const eventLiveness = new EventLiveness(16_000, handleStaleEventStream);
  const feedbackTimers = new Map<string, number>();
  let syncTimer: number | undefined;
  let operationNoticeTimer: number | undefined;
  let sequenceRecovery: Promise<void> | undefined;
  let cacheWriteTimer: number | undefined;
  let hasAuthoritativeSnapshot = false;
  const commandLocks = new Map<string, Promise<Awaited<ReturnType<typeof edgeApi.command>> | undefined>>();
  const commandRequestIds = new Map<string, string>();
  const sceneLocks = new Map<string, Promise<Awaited<ReturnType<typeof edgeApi.executeScene>> | undefined>>();
  const localSurface = runtimeTerminalRole();
  const cacheKey = snapshotCacheKey(resolveEdgeBase() || import.meta.env.VITE_EDGE_CACHE_SCOPE || window.location.origin, localSurface);

  if (cacheKey) {
    const cached = readSnapshotCache(window.localStorage, cacheKey);
    if (cached) {
      snapshot.value = cached.snapshot;
      cachedSnapshotAt.value = cached.savedAt;
      staleSince.value = cached.savedAt;
      loading.value = false;
    }
  }

  const devices = computed(() => snapshot.value?.devices ?? []);
  const scenes = computed(() => snapshot.value?.scenes ?? []);
  const alerts = computed(() => snapshot.value?.alerts ?? []);
  const activeAlerts = computed(() => selectActiveAlerts(alerts.value));
  const unacknowledgedAlerts = computed(() => selectUnacknowledgedAlerts(alerts.value));
  // 兼容旧调用方；该名称只代表“待确认”，不能用于判断设备是否已恢复。
  const unresolvedAlerts = unacknowledgedAlerts;
  const health = computed(() => snapshot.value?.health);
  const onlineCount = computed(() => devices.value.filter((item) => item.health === "online").length);

  function replaceDevice(device: Device) {
    if (!snapshot.value) return;
    const index = snapshot.value.devices.findIndex((item) => item.id === device.id);
    if (index >= 0) snapshot.value.devices.splice(index, 1, device);
    else snapshot.value.devices.push(device);
  }

  function replaceSnapshot(next: SystemSnapshot, authoritative = true) {
    snapshot.value = next;
    pendingByProperty.value = pendingCommandsByProperty(next.commands);
    reconcileFeedbackWithSnapshot(next.commands);
    if (authoritative) {
      hasAuthoritativeSnapshot = true;
      cachedSnapshotAt.value = undefined;
      staleSince.value = undefined;
      scheduleCacheWrite();
    }
  }

  /**
   * HTTP/事件流重连时，终态可能先通过全量快照到达，而对应 command.updated
   * 已在断线窗口丢失。此时必须把本地 pending 回执推进到权威终态并安排消失，
   * 否则 ToastStack 会从快照读到 confirmed，却永久保留原 pending 反馈槽位。
   */
  function reconcileFeedbackWithSnapshot(commands: CommandRecord[]) {
    for (const feedback of Object.values(feedbackByProperty.value)) {
      const command = commands.find((item) => item.id === feedback.id);
      if (command && command.status !== feedback.status) setDeviceFeedback(command);
    }
  }

  function scheduleCacheWrite() {
    if (!cacheKey || !hasAuthoritativeSnapshot || !snapshot.value) return;
    window.clearTimeout(cacheWriteTimer);
    cacheWriteTimer = window.setTimeout(() => {
      cacheWriteTimer = undefined;
      if (snapshot.value) writeSnapshotCache(window.localStorage, cacheKey, snapshot.value);
    }, 750);
  }

  function applyEvent(event: EdgeEvent) {
    if (event.type === "heartbeat") return;
    const decision = sequenceDecision(snapshot.value?.sequence, event.sequence, event.type === "snapshot");
    if (decision === "ignore") return;
    if (decision === "recover") {
      void recoverSequenceGap(snapshot.value?.sequence ?? 0, event.sequence);
      return;
    }
    if (event.type === "snapshot") replaceSnapshot(event.payload);
    if (!snapshot.value) return;
    snapshot.value.sequence = event.sequence;
    if (event.type === "device.updated") replaceDevice(event.payload);
    if (event.type === "command.updated") {
      const command = event.payload;
      const key = operationKey(command.deviceId, command.property);
      const index = snapshot.value.commands.findIndex((item) => item.id === command.id);
      if (index >= 0) snapshot.value.commands.splice(index, 1, command);
      else snapshot.value.commands.unshift(command);
      if (command.status === "pending") pendingByProperty.value[key] = command;
      else if (pendingByProperty.value[key]?.id === command.id) delete pendingByProperty.value[key];
      if (command.status !== "pending" && commandRequestIds.get(key) === command.requestId) {
        commandRequestIds.delete(key);
        commandLocks.delete(key);
        delete requestingByProperty.value[key];
      }
      setDeviceFeedback(command);
      if (command.status !== "pending" && command.source !== runtimeCommandSource()) announceSync(command);
    }
    if (event.type === "scene.updated") {
      const index = snapshot.value.scenes.findIndex((item) => item.id === event.payload.id);
      if (index >= 0) snapshot.value.scenes.splice(index, 1, event.payload);
    }
    if (event.type === "scene.execution") {
      const execution = event.payload;
      const index = snapshot.value.executions.findIndex((item) => item.id === execution.id);
      if (index >= 0) snapshot.value.executions.splice(index, 1, execution);
      else snapshot.value.executions.unshift(execution);
      // 任一权威 execution 已证明 EdgeCore 接收请求，发送态应立即让位给真实执行进度。
      delete requestingSceneIds.value[execution.sceneId];
      if (execution.status !== "running") {
        sceneLocks.delete(execution.sceneId);
      }
    }
    if (event.type === "alert.created") snapshot.value.alerts.unshift(event.payload);
    if (event.type === "alert.updated") {
      const index = snapshot.value.alerts.findIndex((item) => item.id === event.payload.id);
      if (index >= 0) snapshot.value.alerts.splice(index, 1, event.payload);
    }
    if (event.type === "health.updated") snapshot.value.health = event.payload;
    if (event.type === "terminal.updated") {
      latestTerminalUpdate.value = event.payload;
      terminalRevision.value += 1;
    }
    if (hasAuthoritativeSnapshot) scheduleCacheWrite();
  }

  async function recoverSequenceGap(previous: number, received: number) {
    if (sequenceRecovery) return sequenceRecovery;
    recoveringSequence.value = true;
    staleSince.value = new Date().toISOString();
    sequenceRecovery = edgeApi
      .snapshot()
      .then((latest) => {
        replaceSnapshot(latest.data);
        connectionError.value = `检测到事件序号缺口 ${previous}→${received}，已自动恢复快照`;
        window.setTimeout(() => {
          if (connectionError.value?.includes("序号缺口")) connectionError.value = undefined;
        }, 2400);
      })
      .finally(() => {
        recoveringSequence.value = false;
        staleSince.value = undefined;
        sequenceRecovery = undefined;
      });
    return sequenceRecovery;
  }

  function setDeviceFeedback(command: CommandRecord) {
    const key = operationKey(command.deviceId, command.property);
    window.clearTimeout(feedbackTimers.get(key));
    feedbackByProperty.value[key] = {
      id: command.id,
      deviceId: command.deviceId,
      status: command.status,
      property: command.property,
      source: command.source,
      changedAt: Date.now()
    };
    if (command.status !== "pending") {
      const timer = window.setTimeout(
        () => {
          if (feedbackByProperty.value[key]?.id === command.id) {
            delete feedbackByProperty.value[key];
          }
          feedbackTimers.delete(key);
        },
        command.status === "confirmed" ? 1150 : 1650
      );
      feedbackTimers.set(key, timer);
    }
  }

  function announceSync(command: CommandRecord) {
    window.clearTimeout(syncTimer);
    syncPulse.value = {
      id: command.id,
      deviceId: command.deviceId,
      source: command.source,
      status: command.status,
      changedAt: Date.now()
    };
    syncTimer = window.setTimeout(() => {
      syncPulse.value = undefined;
    }, 1400);
  }

  function sourceLabel(source?: string) {
    if (source === "primary") return "主屏";
    if (source === "secondary") return "副屏";
    if (source === "admin") return "后台";
    if (source === "automation") return "自动联动";
    return "其他终端";
  }

  function publishOperationFailure(kind: OperationNotice["kind"], error: unknown) {
    const code = error instanceof Error ? error.message : "OPERATION_FAILED";
    let title = kind === "scene" ? "场景执行失败" : "设备控制失败";
    let detail = "本地控制服务暂时无法完成操作，请稍后重试";
    if (code.startsWith("SCENE_EXECUTION_CONFLICT:")) {
      const [, sceneName, source] = code.split(":");
      title = "场景正在执行";
      detail = `${sourceLabel(source)}正在执行“${sceneName || "其他"}”场景，请等待本次执行完成`;
    } else if (code === "SCENE_DEVICE_OPERATION_CONFLICT" || code.includes("场景涉及的设备正在执行其他操作")) {
      title = "场景暂时无法执行";
      detail = "相关设备正在响应其他控制，请等待状态确认后重试";
    } else if (code === "DEVICE_OPERATION_CONFLICT" || code.includes("该设备属性正在执行其他操作")) {
      title = "设备正在响应其他操作";
      detail = "该项控制已被场景或另一终端占用，请等待状态确认后重试";
    } else if (code === "API_REQUEST_TIMEOUT") {
      title = kind === "scene" ? "场景请求等待超时" : "控制请求等待超时";
      detail = "请求结果暂时未知，请先等待实时状态同步，确认未执行后再操作";
    } else if (!code.startsWith("HTTP_")) {
      detail = code;
    }
    window.clearTimeout(operationNoticeTimer);
    operationNotice.value = { id: runtimeId(), kind, title, detail, changedAt: Date.now() };
    operationNoticeTimer = window.setTimeout(() => {
      operationNotice.value = undefined;
    }, 3200);
  }

  async function connectOnce(generation: number) {
    loading.value = true;
    let attemptHasAuthoritativeSnapshot = false;
    try {
      const initial = await edgeApi.snapshot();
      if (!connectionIntent.accepts(generation)) return;
      replaceSnapshot(initial.data);
      attemptHasAuthoritativeSnapshot = true;
      connectionError.value = undefined;
      connectionIssue.value = undefined;
    } catch (error) {
      if (!connectionIntent.accepts(generation)) return;
      connectionError.value = error instanceof Error ? error.message : "无法连接本地服务";
      connectionIssue.value = describeConnectionIssue(error, "snapshot");
    } finally {
      if (connectionIntent.accepts(generation)) loading.value = false;
    }
    if (!connectionIntent.accepts(generation)) return;
    const previous = socket;
    socket = undefined;
    if (previous) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onerror = null;
      previous.onclose = null;
      previous.close();
    }
    let ticket: string;
    try {
      ticket = (await edgeApi.eventTicket()).data.ticket;
    } catch (error) {
      if (!connectionIntent.accepts(generation)) return;
      connectionError.value = error instanceof Error ? error.message : "无法获取安全事件票据";
      connectionIssue.value = preferConnectionIssue(connectionIssue.value, describeConnectionIssue(error, "ticket"));
      connected.value = false;
      scheduleReconnect(generation);
      return;
    }
    if (!connectionIntent.accepts(generation)) return;
    // 实时流始终绑定物理终端身份；切到另一套工作界面不能冒充另一台终端。
    const current = new WebSocket(eventUrl(ticket, localSurface));
    socket = current;
    window.clearTimeout(socketOpenTimer);
    socketOpenTimer = window.setTimeout(() => {
      if (socket !== current || !connectionIntent.accepts(generation) || current.readyState === WebSocket.OPEN) return;
      socket = undefined;
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      current.close();
      connected.value = false;
      connectionError.value = "EVENT_STREAM_CONNECT_TIMEOUT";
      connectionIssue.value = describeConnectionIssue(connectionError.value, "events");
      scheduleReconnect(generation);
    }, 8_000);
    current.onopen = () => {
      if (socket !== current || !connectionIntent.accepts(generation)) return;
      // socket open 只证明传输层握手成功；冷启动缓存存在时，必须等本进程拿到
      // HTTP 或 WebSocket 权威快照后才允许解锁控制。
      connected.value = attemptHasAuthoritativeSnapshot;
      window.clearTimeout(socketOpenTimer);
      reconnectAttempt.value = 0;
      retryInSeconds.value = undefined;
      window.clearInterval(reconnectCountdownTimer);
      if (attemptHasAuthoritativeSnapshot) {
        connectionError.value = undefined;
        connectionIssue.value = undefined;
      }
      lastEventReceivedAt.value = Date.now();
      eventLiveness.received();
      window.clearTimeout(authoritativeSnapshotTimer);
      if (!attemptHasAuthoritativeSnapshot) {
        authoritativeSnapshotTimer = window.setTimeout(() => {
          if (socket !== current || !connectionIntent.accepts(generation) || attemptHasAuthoritativeSnapshot) return;
          socket = undefined;
          current.onopen = null;
          current.onmessage = null;
          current.onerror = null;
          current.onclose = null;
          current.close();
          eventLiveness.stop();
          connected.value = false;
          connectionError.value = "AUTHORITATIVE_SNAPSHOT_TIMEOUT";
          connectionIssue.value = describeConnectionIssue(connectionError.value, "events");
          scheduleReconnect(generation);
        }, 6_000);
      }
    };
    current.onmessage = (message) => {
      if (socket !== current || !connectionIntent.accepts(generation)) return;
      lastEventReceivedAt.value = Date.now();
      eventLiveness.received();
      const event = JSON.parse(message.data) as EdgeEvent;
      applyEvent(event);
      if (event.type === "snapshot") attemptHasAuthoritativeSnapshot = true;
      if (attemptHasAuthoritativeSnapshot && !connected.value) {
        window.clearTimeout(authoritativeSnapshotTimer);
        connected.value = true;
        connectionError.value = undefined;
        connectionIssue.value = undefined;
      }
    };
    current.onerror = () => {
      if (socket !== current || !connectionIntent.accepts(generation)) return;
      // 首次启动尚无权威快照时，snapshot / ticket 已提供更接近根因的诊断；
      // 通用 WebSocket 错误不得把“地址不可达/认证失效”降级成“状态流中断”。
      if (!attemptHasAuthoritativeSnapshot && connectionIssue.value && connectionIssue.value.phase !== "events") return;
      connectionError.value = "实时状态流连接失败";
      connectionIssue.value = describeConnectionIssue(connectionError.value, "events");
    };
    current.onclose = () => {
      if (socket !== current || !connectionIntent.shouldReconnect(generation)) return;
      socket = undefined;
      window.clearTimeout(socketOpenTimer);
      window.clearTimeout(authoritativeSnapshotTimer);
      eventLiveness.stop();
      connected.value = false;
      scheduleReconnect(generation);
    };
  }

  function handleStaleEventStream() {
    if (!connected.value || !socket) return;
    connected.value = false;
    connectionError.value = "EVENT_STREAM_STALE";
    connectionIssue.value = describeConnectionIssue(connectionError.value, "events");
    const current = socket;
    socket = undefined;
    current.onopen = null;
    current.onmessage = null;
    current.onerror = null;
    current.onclose = null;
    current.close();
    scheduleReconnect(connectionIntent.nextAttempt() ?? 0);
  }

  function scheduleReconnect(generation: number) {
    window.clearTimeout(reconnectTimer);
    window.clearInterval(reconnectCountdownTimer);
    if (!networkOnline.value) {
      retryInSeconds.value = undefined;
      return;
    }
    reconnectAttempt.value += 1;
    const delay = reconnectDelay(reconnectAttempt.value);
    const retryAt = Date.now() + delay;
    const updateCountdown = () => {
      retryInSeconds.value = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
    };
    updateCountdown();
    reconnectCountdownTimer = window.setInterval(updateCountdown, 250);
    reconnectTimer = window.setTimeout(() => {
      window.clearInterval(reconnectCountdownTimer);
      retryInSeconds.value = undefined;
      if (!connectionIntent.shouldReconnect(generation)) return;
      void beginConnection(true);
    }, delay);
  }

  function beginConnection(retry = false) {
    if (!retry && (connectAttempt || socket)) return connectAttempt ?? Promise.resolve();
    const generation = retry ? connectionIntent.nextAttempt() : connectionIntent.start();
    if (generation === undefined) return Promise.resolve();
    window.clearTimeout(reconnectTimer);
    const attempt = connectOnce(generation).finally(() => {
      if (connectAttempt === attempt) connectAttempt = undefined;
    });
    connectAttempt = attempt;
    return attempt;
  }

  function connect() {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      // 首次启动即离线时也要保留“希望连接”的意图，网络恢复事件才能建立新代次。
      connectionIntent.start();
      suspendForOffline();
      return Promise.resolve();
    }
    return beginConnection(false);
  }

  function reconnectNow() {
    if (connected.value) return Promise.resolve();
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      suspendForOffline();
      return Promise.resolve();
    }
    window.clearTimeout(reconnectTimer);
    window.clearInterval(reconnectCountdownTimer);
    retryInSeconds.value = undefined;
    window.clearTimeout(socketOpenTimer);
    window.clearTimeout(authoritativeSnapshotTimer);
    reconnectAttempt.value = 0;
    const current = socket;
    socket = undefined;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      current.close();
    }
    connectAttempt = undefined;
    return beginConnection(true);
  }

  function suspendForOffline() {
    networkOnline.value = false;
    connected.value = false;
    connectionError.value = "NETWORK_OFFLINE";
    connectionIssue.value = describeConnectionIssue(connectionError.value, "network");
    window.clearTimeout(reconnectTimer);
    window.clearInterval(reconnectCountdownTimer);
    retryInSeconds.value = undefined;
    window.clearTimeout(socketOpenTimer);
    window.clearTimeout(authoritativeSnapshotTimer);
    eventLiveness.stop();
    // 使仍在途中的 fetch/票据结果失效；离线期间不制造无意义的重试流量。
    connectionIntent.nextAttempt();
    connectAttempt = undefined;
    const current = socket;
    socket = undefined;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      current.close();
    }
  }

  function resumeConnection() {
    networkOnline.value = typeof navigator === "undefined" ? true : navigator.onLine;
    if (!networkOnline.value || connected.value) return Promise.resolve();
    return reconnectNow();
  }

  function verifyConnectionLiveness() {
    if (!connected.value) return resumeConnection();
    if (eventStreamIsStale(lastEventReceivedAt.value)) handleStaleEventStream();
    return Promise.resolve();
  }

  async function refreshSnapshot() {
    const latest = await edgeApi.snapshot();
    replaceSnapshot(latest.data);
    staleSince.value = undefined;
    connectionError.value = undefined;
    connectionIssue.value = undefined;
    return latest.data;
  }

  function disconnect() {
    connectionIntent.stop();
    // fetch 无法可靠中止；释放单飞占位，让快速重新挂载可立即开启新代次。
    // 旧 Promise 的 finally 受身份检查保护，不会清除新尝试。
    connectAttempt = undefined;
    window.clearTimeout(reconnectTimer);
    window.clearInterval(reconnectCountdownTimer);
    window.clearTimeout(socketOpenTimer);
    window.clearTimeout(authoritativeSnapshotTimer);
    window.clearTimeout(syncTimer);
    window.clearTimeout(operationNoticeTimer);
    window.clearTimeout(cacheWriteTimer);
    if (cacheKey && hasAuthoritativeSnapshot && snapshot.value) writeSnapshotCache(window.localStorage, cacheKey, snapshot.value);
    feedbackTimers.forEach((timer) => window.clearTimeout(timer));
    feedbackTimers.clear();
    feedbackByProperty.value = {};
    connected.value = false;
    loading.value = false;
    reconnectAttempt.value = 0;
    retryInSeconds.value = undefined;
    lastEventReceivedAt.value = undefined;
    eventLiveness.stop();
    const current = socket;
    socket = undefined;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      current.close();
    }
  }

  async function sendCommand(deviceId: string, property: string, value: string | number | boolean, source: CommandRequestSource) {
    const key = operationKey(deviceId, property);
    const existing = commandLocks.get(key);
    if (existing) return existing;
    const requestId = runtimeId();
    const promise = edgeApi
      .command(deviceId, { requestId, property, value, source: runtimeCommandSource(source) })
      .catch((error: unknown) => {
        // 若权威 WebSocket 终态已经提前结算，本次 HTTP 回包失败不能再制造一条假失败。
        if (commandRequestIds.get(key) === requestId) publishOperationFailure("command", error);
        return undefined;
      });
    commandLocks.set(key, promise);
    commandRequestIds.set(key, requestId);
    requestingByProperty.value[key] = true;
    void promise.finally(() => {
      if (commandLocks.get(key) === promise && commandRequestIds.get(key) === requestId) {
        commandLocks.delete(key);
        commandRequestIds.delete(key);
        delete requestingByProperty.value[key];
      }
    });
    return promise;
  }

  function propertyFeedback(deviceId: string, property: string) {
    return feedbackByProperty.value[operationKey(deviceId, property)];
  }

  function isPropertyRequesting(deviceId: string, property: string) {
    return Boolean(requestingByProperty.value[operationKey(deviceId, property)]);
  }

  function isDeviceRequesting(deviceId: string) {
    return Object.keys(requestingByProperty.value).some((key) => key.startsWith(`${deviceId}.`));
  }

  function isPropertyPending(deviceId: string, property: string) {
    const key = operationKey(deviceId, property);
    return Boolean(requestingByProperty.value[key] || pendingByProperty.value[key]);
  }

  async function executeScene(sceneId: string, source: CommandRequestSource) {
    const existing = sceneLocks.get(sceneId);
    if (existing) return existing;
    const promise = edgeApi.executeScene(sceneId, runtimeCommandSource(source)).catch((error: unknown) => {
      if (requestingSceneIds.value[sceneId]) publishOperationFailure("scene", error);
      return undefined;
    });
    sceneLocks.set(sceneId, promise);
    requestingSceneIds.value[sceneId] = true;
    void promise.finally(() => {
      if (sceneLocks.get(sceneId) === promise) {
        sceneLocks.delete(sceneId);
        delete requestingSceneIds.value[sceneId];
      }
    });
    return promise;
  }

  return {
    snapshot,
    connected,
    loading,
    connectionError,
    connectionIssue,
    networkOnline,
    recoveringSequence,
    staleSince,
    cachedSnapshotAt,
    pendingByProperty,
    requestingByProperty,
    requestingSceneIds,
    pendingByDevice,
    activeExecution,
    feedbackByProperty,
    feedbackByDevice,
    syncPulse,
    operationNotice,
    reconnectAttempt,
    retryInSeconds,
    lastEventReceivedAt,
    terminalRevision,
    latestTerminalUpdate,
    devices,
    scenes,
    alerts,
    activeAlerts,
    unacknowledgedAlerts,
    unresolvedAlerts,
    health,
    onlineCount,
    connect,
    reconnectNow,
    resumeConnection,
    verifyConnectionLiveness,
    suspendForOffline,
    refreshSnapshot,
    disconnect,
    sendCommand,
    executeScene,
    propertyFeedback,
    isPropertyRequesting,
    isDeviceRequesting,
    isPropertyPending,
    acknowledgeAlert: (alertId: string, source?: CommandRequestSource) => edgeApi.acknowledgeAlert(alertId, runtimeCommandSource(source))
  };
});

type CommandRequestSource = "primary" | "secondary" | "admin" | "automation";

export interface DeviceFeedback {
  id: string;
  deviceId: string;
  status: CommandStatus;
  property: string;
  source: CommandRequestSource;
  changedAt: number;
}

function aggregateCommandsByDevice(values: Record<string, CommandRecord>) {
  const result: Record<string, CommandRecord> = {};
  for (const command of Object.values(values)) {
    const current = result[command.deviceId];
    if (!current || command.createdAt > current.createdAt) result[command.deviceId] = command;
  }
  return result;
}

function aggregateFeedbackByDevice(values: Record<string, DeviceFeedback>) {
  const result: Record<string, DeviceFeedback> = {};
  for (const feedback of Object.values(values)) {
    const current = result[feedback.deviceId];
    const shouldReplace =
      !current ||
      (feedback.status === "pending" && current.status !== "pending") ||
      (feedback.status === current.status && feedback.changedAt > current.changedAt) ||
      (feedback.status !== "pending" && current.status !== "pending" && feedback.changedAt > current.changedAt);
    if (shouldReplace) {
      result[feedback.deviceId] = feedback;
    }
  }
  return result;
}

export interface SyncPulse {
  id: string;
  deviceId: string;
  source: CommandRequestSource;
  status: CommandStatus;
  changedAt: number;
}

export interface OperationNotice {
  id: string;
  kind: "scene" | "command";
  title: string;
  detail: string;
  changedAt: number;
}
