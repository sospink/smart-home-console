import type {
  ApiEnvelope,
  AuditRecord,
  AdminConfiguration,
  AdminResourceName,
  AdminSession,
  BenchResetPreview,
  BenchResetResult,
  HandoverChecklist,
  HandoverCompletion,
  CommandRecord,
  CommandRequest,
  PageQuery,
  PaginatedResult,
  SceneExecution,
  SystemSnapshot,
  TerminalConfig,
  UiUpdateInstallRequest,
  UiUpdateStatus
} from "@smart-lab/contracts";
import { nativeBridge, nativeTerminalRole, type SmartLabNativeBridge } from "./terminal-runtime";

let adminToken = "";
let adminAuthExpiredHandler: (() => void) | undefined;

function nativeValue(key: "getEdgeBaseUrl" | "getTerminalToken" | "getAppVersion") {
  if (typeof window === "undefined") return "";
  const bridge = nativeBridge();
  try {
    return bridge?.[key]?.() ?? "";
  } catch {
    return "";
  }
}

export function terminalToken() {
  const runtimeToken = nativeValue("getTerminalToken");
  if (runtimeToken) return runtimeToken;
  // 调试 APK 也属于原生信任域；桥存在但凭据损坏时必须重新配对，不能伪装成浏览器 Mock 身份。
  if (typeof window !== "undefined" && (window as SmartLabWindow).SmartLabNative) return "";
  // 仅 Vite 开发/测试服务使用；生产构建会静态移除此分支，正式凭据只来自原生 Keystore 桥。
  if (import.meta.env.DEV && typeof window !== "undefined") {
    return window.location.pathname.startsWith("/secondary") ? "mock-secondary-terminal-token" : "mock-primary-terminal-token";
  }
  return "";
}

function normalizeBase(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function resolveEdgeBase(location: Pick<Location, "hostname" | "search"> = window.location) {
  // 原生容器的 Bearer 只能发往壳层受控地址；页面查询参数仅供纯浏览器故障调试。
  if ((globalThis.window as SmartLabWindow | undefined)?.SmartLabNative) {
    return normalizeBase(nativeValue("getEdgeBaseUrl"));
  }
  const configured = new URLSearchParams(location.search).get("edge");
  if (configured) return normalizeBase(configured);
  return "";
}

function apiUrl(path: string) {
  return `${resolveEdgeBase()}${path}`;
}

export const requestDeadlines = {
  read: 8_000,
  connect: 6_000,
  command: 12_000,
  scene: 45_000,
  adminWrite: 30_000,
  artifact: 120_000
} as const;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = requestDeadlines.read,
  fetcher: typeof fetch = fetch
) {
  return runWithTimeout<Response>((signal) => fetcher(input, { ...init, signal }), timeoutMs, init.signal ?? undefined);
}

export async function runWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, callerSignal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort("API_REQUEST_TIMEOUT");
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) throw new Error("API_REQUEST_TIMEOUT", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export function setAdminToken(token: string) {
  adminToken = token;
}

export function setAdminAuthExpiredHandler(handler?: () => void) {
  adminAuthExpiredHandler = handler;
}

export function responseExpiresCurrentAdminSession(status: number, error: unknown, presentedBearer: string, currentAdminToken: string) {
  return status === 401 && error === "ADMIN_AUTH_REQUIRED" && Boolean(currentAdminToken) && presentedBearer === currentAdminToken;
}

export function requestNativeDatabaseBackupDownload(filename: string) {
  const bridge = typeof window === "undefined" ? undefined : (window as SmartLabWindow).SmartLabNative;
  if (!bridge?.downloadDatabaseBackup) return false;
  try {
    return bridge.downloadDatabaseBackup(filename, adminToken) === true;
  } catch {
    return false;
  }
}

export function configureNativeHomeAssistant(payload: { baseUrl: string; token: string; gatewayEntityId: string; lightEntityId: string }) {
  const bridge = typeof window === "undefined" ? undefined : (window as SmartLabWindow).SmartLabNative;
  return bridge?.configureHomeAssistant?.(JSON.stringify(payload), adminToken) === true;
}

export function nativeHomeAssistantConfigurationAvailable() {
  const bridge = nativeBridge();
  return nativeTerminalRole(bridge) === "primary" && typeof bridge?.configureHomeAssistant === "function";
}

export function notifyNativeTerminalAuthenticationInvalid(
  status: number,
  error: unknown,
  bridge = typeof window === "undefined" ? undefined : (window as SmartLabWindow).SmartLabNative
) {
  if (status !== 401 || error !== "TERMINAL_AUTH_REQUIRED" || !bridge?.onTerminalAuthenticationInvalid) return false;
  try {
    bridge.onTerminalAuthenticationInvalid();
    return true;
  } catch {
    return false;
  }
}

type RequestAuth = "auto" | "terminal" | "admin";

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = requestDeadlines.read,
  auth: RequestAuth = "auto"
): Promise<ApiEnvelope<T>> {
  const appVersion = nativeValue("getAppVersion");
  const bearer = auth === "terminal" ? terminalToken() : auth === "admin" ? adminToken : adminToken || terminalToken();
  const { response, body } = await runWithTimeout<{ response: Response; body: Record<string, unknown> }>(
    async (signal) => {
      const response = await fetch(apiUrl(path), {
        ...init,
        signal,
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(appVersion ? { "x-smart-lab-version": appVersion } : {}),
          ...(init.headers ?? {})
        }
      });
      return { response, body: (await response.json()) as Record<string, unknown> };
    },
    timeoutMs,
    init.signal ?? undefined
  );
  // 登录前发出的旧请求可能在登录后才返回 401；只有本次真正携带当前管理令牌时才能吊销新会话。
  if (responseExpiresCurrentAdminSession(response.status, body.error, bearer, adminToken)) {
    adminToken = "";
    adminAuthExpiredHandler?.();
  }
  notifyNativeTerminalAuthenticationInvalid(response.status, body.error);
  // 207 和带 data 的 409 是设备命令的可观测业务结果；只带 error 的 409 是配置并发冲突。
  if (!response.ok && response.status !== 207 && !(response.status === 409 && body.data !== undefined)) {
    throw new Error(typeof body.error === "string" ? body.error : `HTTP_${response.status}`);
  }
  return body as unknown as ApiEnvelope<T>;
}

async function requestBlob(path: string): Promise<{ blob: Blob; filename?: string }> {
  const appVersion = nativeValue("getAppVersion");
  const response = await fetchWithTimeout(
    apiUrl(path),
    {
      headers: {
        ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
        ...(appVersion ? { "x-smart-lab-version": appVersion } : {})
      }
    },
    requestDeadlines.artifact
  );
  if (response.status === 401 && adminToken) {
    adminToken = "";
    adminAuthExpiredHandler?.();
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP_${response.status}`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  return { blob: await response.blob(), filename: /filename="([^"]+)"/.exec(disposition)?.[1] };
}

function adminResource<T>(resource: AdminResourceName, query: PageQuery = {}) {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.q) params.set("q", query.q);
  if (query.status && query.status !== "all") params.set("status", query.status);
  return request<PaginatedResult<T>>(`/api/v1/admin/resources/${resource}?${params}`);
}

async function allAdminResources<T>(resource: AdminResourceName, query: Omit<PageQuery, "page" | "pageSize"> = {}) {
  const items: T[] = [];
  let page = 1;
  while (true) {
    const result = await adminResource<T>(resource, { ...query, page, pageSize: 100 });
    items.push(...result.data.items);
    if (page >= result.data.totalPages) break;
    page += 1;
  }
  return items;
}

export const edgeApi = {
  snapshot: () => request<SystemSnapshot>("/api/v1/snapshot", {}, requestDeadlines.connect, "terminal"),
  eventTicket: () =>
    request<{ ticket: string; expiresAt: string }>(
      "/api/v1/terminals/event-ticket",
      { method: "POST", body: "{}" },
      requestDeadlines.connect,
      "terminal"
    ),
  command: (deviceId: string, command: CommandRequest) =>
    request<CommandRecord>(
      `/api/v1/devices/${deviceId}/commands`,
      { method: "POST", body: JSON.stringify(command) },
      requestDeadlines.command,
      command.source === "admin" ? "admin" : "terminal"
    ),
  executeScene: (sceneId: string, source: CommandRequest["source"]) =>
    request<SceneExecution>(
      `/api/v1/scenes/${sceneId}/execute`,
      { method: "POST", body: JSON.stringify({ source }) },
      requestDeadlines.scene,
      source === "admin" ? "admin" : "terminal"
    ),
  acknowledgeAlert: (alertId: string, source: CommandRequest["source"] = "primary") =>
    request(
      `/api/v1/alerts/${alertId}/acknowledge`,
      { method: "POST", body: JSON.stringify({ source }) },
      requestDeadlines.read,
      source === "admin" ? "admin" : "terminal"
    ),
  adminLogin: async (pin: string) => {
    const response = await request<AdminSession>("/api/v1/admin/login", { method: "POST", body: JSON.stringify({ pin }) });
    setAdminToken(response.data.token);
    return response;
  },
  adminLogout: async () => {
    try {
      return await request<boolean>("/api/v1/admin/logout", { method: "POST", body: "{}" });
    } finally {
      setAdminToken("");
    }
  },
  changeAdminPin: async (currentPin: string, newPin: string, confirmPin: string) => {
    const response = await request<boolean>(
      "/api/v1/admin/change-pin",
      { method: "POST", body: JSON.stringify({ currentPin, newPin, confirmPin }) },
      requestDeadlines.adminWrite
    );
    setAdminToken("");
    return response;
  },
  revokeTerminal: (terminalId: string) =>
    request<TerminalConfig>(
      `/api/v1/admin/terminals/${encodeURIComponent(terminalId)}/revoke`,
      { method: "POST", body: "{}" },
      requestDeadlines.adminWrite
    ),
  audits: () => request<AuditRecord[]>("/api/v1/admin/audits"),
  diagnostics: () =>
    request<{
      generatedAt: string;
      appVersion: string;
      databaseVersion: number;
      eventSequence: number;
      health: SystemSnapshot["health"];
      logs: string[];
      databaseBackups: string[];
    }>("/api/v1/admin/diagnostics", {}, requestDeadlines.artifact),
  databaseBackups: () =>
    request<
      Array<{
        filename: string;
        createdAt: string;
        sizeBytes: number;
        sha256: string;
        integrityStatus: "ok" | "failed";
        schemaVersion?: number;
        verifiedAt: string;
      }>
    >("/api/v1/admin/database-backups", {}, requestDeadlines.artifact),
  databaseBackupStorage: () =>
    request<{
      totalBytes: number;
      usableBytes: number;
      reserveBytes: number;
      estimatedNextBackupBytes: number;
      canCreate: boolean;
      level: "healthy" | "warning" | "critical";
      message: string;
    }>("/api/v1/admin/database-backups/storage", {}, requestDeadlines.artifact),
  dataLifecycle: () =>
    request<{
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
    }>("/api/v1/admin/data-lifecycle", {}, requestDeadlines.artifact),
  createDatabaseBackup: () =>
    request<{
      filename: string;
      createdAt: string;
      sizeBytes: number;
      sha256: string;
      integrityStatus: "ok" | "failed";
      schemaVersion?: number;
      verifiedAt: string;
    }>("/api/v1/admin/database-backups", { method: "POST", body: "{}" }, requestDeadlines.artifact),
  downloadDatabaseBackup: (filename: string) => requestBlob(`/api/v1/admin/database-backups/${encodeURIComponent(filename)}`),
  uiUpdateStatus: () => request<UiUpdateStatus>("/api/v1/admin/ui-update"),
  installUiUpdate: (update: UiUpdateInstallRequest) =>
    request<UiUpdateStatus>("/api/v1/admin/ui-update", { method: "POST", body: JSON.stringify(update) }, requestDeadlines.artifact),
  rollbackUiUpdate: () =>
    request<UiUpdateStatus>("/api/v1/admin/ui-update/rollback", { method: "POST", body: "{}" }, requestDeadlines.artifact),
  adminResource,
  allAdminResources,
  adminConfig: () => request<AdminConfiguration>("/api/v1/admin/config"),
  saveAdminConfig: (config: AdminConfiguration) =>
    request<AdminConfiguration>("/api/v1/admin/config", { method: "PUT", body: JSON.stringify(config) }, requestDeadlines.adminWrite),
  exportBackup: () => request<AdminConfiguration>("/api/v1/admin/backup", {}, requestDeadlines.adminWrite),
  restoreBackup: (config: AdminConfiguration) =>
    request<AdminConfiguration>("/api/v1/admin/backup", { method: "POST", body: JSON.stringify(config) }, requestDeadlines.adminWrite),
  testGateway: (id: string) => request(`/api/v1/admin/gateways/${id}/test`, { method: "POST", body: "{}" }, requestDeadlines.adminWrite),
  recoverAlert: (id: string) => request(`/api/v1/admin/alerts/${id}/recover`, { method: "POST", body: "{}" }),
  benchResetPreview: () => request<BenchResetPreview>("/api/v1/admin/bench-reset/preview"),
  benchReset: () => request<BenchResetResult>("/api/v1/admin/bench-reset", { method: "POST", body: "{}" }, requestDeadlines.scene),
  handoverChecklist: () => request<HandoverChecklist>("/api/v1/admin/handover"),
  completeHandover: (completionId: string, completedBy: string, stateToken: string, acknowledgedWarnings: string[], note: string) =>
    request<HandoverCompletion>(
      "/api/v1/admin/handover/complete",
      { method: "POST", body: JSON.stringify({ completionId, completedBy, stateToken, acknowledgedWarnings, note }) },
      requestDeadlines.adminWrite
    ),
  pairingCode: () => request<{ code: string }>("/api/v1/admin/terminals/pairing-code")
};

export function eventUrl(ticket?: string, surface?: "primary" | "secondary" | "admin") {
  const edgeBase = resolveEdgeBase();
  const params = new URLSearchParams();
  if (ticket) params.set("ticket", ticket);
  if (surface) params.set("surface", surface);
  const query = params.size ? `?${params}` : "";
  if (edgeBase) return `${edgeBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/api/v1/events${query}`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/events${query}`;
}

interface SmartLabWindow extends Window {
  SmartLabNative?: SmartLabNativeBridge;
}
