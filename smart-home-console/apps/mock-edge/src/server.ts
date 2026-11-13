import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { URL, pathToFileURL } from "node:url";
import type { AdminConfiguration, AdminResourceName, CommandRequest, EdgeEvent } from "@smart-lab/contracts";
import { WebSocket, WebSocketServer } from "ws";
import { SimulationEngine, type TestFaultRequest } from "./engine.js";
import { HomeAssistantClient, homeAssistantConfigFromEnvironment } from "./home-assistant.js";

const port = Number(process.env.EDGE_PORT ?? 18787);
function loginAddress(req: IncomingMessage) {
  return req.socket.remoteAddress ?? "unknown";
}

function enforceLoginWindow(loginAttempts: Map<string, { startedAt: number; failures: number; blockedUntil?: number }>, address: string) {
  const now = Date.now();
  const attempt = loginAttempts.get(address);
  if (!attempt) return false;
  if (attempt.blockedUntil && attempt.blockedUntil > now) return true;
  if (now - attempt.startedAt > 10 * 60 * 1000) loginAttempts.delete(address);
  return false;
}

function recordLoginFailure(loginAttempts: Map<string, { startedAt: number; failures: number; blockedUntil?: number }>, address: string) {
  const now = Date.now();
  const current = loginAttempts.get(address);
  const active = current && now - current.startedAt <= 10 * 60 * 1000 ? current : { startedAt: now, failures: 0 };
  const failures = active.failures + 1;
  loginAttempts.set(address, {
    startedAt: active.startedAt,
    failures,
    ...(failures >= 5 ? { blockedUntil: now + 15 * 60 * 1000 } : {})
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    // 与 Android EdgeCore 保持一致；原生 WebView 会附带壳层版本用于兼容性校验。
    "access-control-allow-headers": "content-type,authorization,x-smart-lab-version,x-smart-lab-test-terminal-token",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS"
  });
  res.end(JSON.stringify(body));
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

export function createEdgeServer(options: { heartbeatIntervalMs?: number; testSupport?: boolean } = {}) {
  // 每个服务实例拥有独立的实训台状态和事件监听器，避免重启或测试串台、累积内存。
  const testSupportEnabled = options.testSupport ?? process.env.EDGE_ENABLE_TEST_SUPPORT === "1";
  const haConfig = homeAssistantConfigFromEnvironment();
  const engine = new SimulationEngine(undefined, haConfig ? new HomeAssistantClient(haConfig) : undefined);
  let haPoll: NodeJS.Timeout | undefined;
  if (haConfig) {
    void engine.syncHomeAssistant(false);
    haPoll = setInterval(() => void engine.syncHomeAssistant().catch(() => undefined), haConfig.pollIntervalMs);
  }
  const sessions = new Map<string, number>();
  let adminPinHash = createHash("sha256")
    .update(process.env.ADMIN_PIN ?? "2468")
    .digest();
  const loginAttempts = new Map<string, { startedAt: number; failures: number; blockedUntil?: number }>();
  const pinChangeAttempts = new Map<string, { startedAt: number; failures: number; blockedUntil?: number }>();
  const pairingAttempts = new Map<string, { startedAt: number; failures: number; blockedUntil?: number }>();
  const terminalTokens = new Map<string, string>();
  const eventTickets = new Map<string, { terminalId: string; role: "primary" | "secondary"; expiresAt: number }>();
  let pairingCode = "123456";
  const controlDomainProofKey = randomBytes(32).toString("base64url");
  // 每次配对都生成新随机材料；撤销时删除，使旧证明与旧 Bearer 同时失效。
  const terminalProofReferences = new Map<string, string>();
  const derivedControlDomainProofKey = (deviceId: string, proofReference: string) =>
    createHmac("sha256", Buffer.from(controlDomainProofKey, "base64url"))
      .update(`terminal-proof:${deviceId}:${proofReference}`)
      .digest("base64url");
  const terminalConnections = new Map<"primary" | "secondary", number>();
  const terminalSockets = new Map<"primary" | "secondary", Set<WebSocket>>();
  const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
  // 固定凭据只存在于 Mock EdgeCore 进程，用于本地 UI 和契约测试；正式 APK 仍只从 Keystore 桥接取凭据。
  terminalTokens.set(hashToken("mock-primary-terminal-token"), "terminal-primary");
  terminalTokens.set(hashToken("mock-secondary-terminal-token"), "terminal-secondary");
  terminalTokens.set(hashToken("contract-primary-terminal-token"), "terminal-primary");

  type ControlIdentity = { role: "primary" | "secondary" | "admin"; terminalId?: string };
  const resolveControlIdentity = (req: IncomingMessage): ControlIdentity | undefined => {
    // 后者是 Playwright APIRequestContext 直连 Mock 时的专用兜底，正式 Android EdgeCore 不实现此头。
    const token =
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
      (typeof req.headers["x-smart-lab-test-terminal-token"] === "string" ? req.headers["x-smart-lab-test-terminal-token"] : undefined);
    if (!token) return undefined;
    const expiresAt = sessions.get(token);
    if (expiresAt && expiresAt >= Date.now()) return { role: "admin" };
    if (expiresAt) sessions.delete(token);
    const terminalId = terminalTokens.get(hashToken(token));
    const terminal = terminalId ? engine.getConfiguration().terminals.find((item) => item.id === terminalId && item.paired) : undefined;
    return terminal ? { role: terminal.role, terminalId: terminal.id } : undefined;
  };
  const authenticateControl = (req: IncomingMessage, res: ServerResponse) => {
    const identity = resolveControlIdentity(req);
    if (identity) return identity;
    json(res, 401, { error: "TERMINAL_AUTH_REQUIRED" });
    return undefined;
  };
  const requireAdmin = (req: IncomingMessage, res: ServerResponse) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const expiresAt = token ? sessions.get(token) : undefined;
    if (token && expiresAt && expiresAt >= Date.now()) return true;
    if (token) sessions.delete(token);
    json(res, 401, { error: "ADMIN_AUTH_REQUIRED" });
    return false;
  };
  const server = createServer(async (req, res) => {
    if (!req.url) return json(res, 404, { error: "NOT_FOUND" });
    if (req.method === "OPTIONS") return json(res, 204, null);
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (req.method === "POST" && url.pathname === "/api/v1/control-domain/challenge") {
        const body = await readBody<{ deviceId?: string; nonce?: string; clientProof?: string }>(req);
        if (!body.deviceId?.match(/^[a-zA-Z0-9._-]{6,96}$/)) return json(res, 400, { error: "INVALID_TERMINAL_ID" });
        if (!body.nonce?.match(/^[A-Za-z0-9_-]{43}$/)) return json(res, 400, { error: "INVALID_CONTROL_DOMAIN_NONCE" });
        const proofReference = terminalProofReferences.get(body.deviceId);
        if (!proofReference) return json(res, 401, { error: "CONTROL_DOMAIN_CLIENT_PROOF_REQUIRED" });
        const derivedKey = Buffer.from(derivedControlDomainProofKey(body.deviceId, proofReference), "base64url");
        const expectedClientProof = createHmac("sha256", derivedKey)
          .update(`client:${engine.controlDomainId}:${body.deviceId}:${body.nonce}`)
          .digest();
        const clientProof = Buffer.from(body.clientProof ?? "", "base64url");
        if (clientProof.length !== expectedClientProof.length || !timingSafeEqual(clientProof, expectedClientProof)) {
          return json(res, 401, { error: "CONTROL_DOMAIN_CLIENT_PROOF_REQUIRED" });
        }
        const proof = createHmac("sha256", derivedKey)
          .update(`server:${engine.controlDomainId}:${body.deviceId}:${body.nonce}`)
          .digest("base64url");
        return json(res, 200, {
          data: { controlDomainId: engine.controlDomainId, nonce: body.nonce, proof },
          sequence: engine.getSequence()
        });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/terminals/pair") {
        const address = loginAddress(req);
        if (enforceLoginWindow(pairingAttempts, address)) return json(res, 429, { error: "TOO_MANY_AUTH_ATTEMPTS" });
        const body = await readBody<{ pairingCode?: string; deviceId?: string; name?: string; role?: string; version?: string }>(req);
        const candidate = Buffer.from(body.pairingCode ?? "");
        const expected = Buffer.from(pairingCode);
        if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
          recordLoginFailure(pairingAttempts, address);
          return json(res, 401, { error: "INVALID_PAIRING_CODE" });
        }
        pairingAttempts.delete(address);
        const terminal = engine.pairSecondaryTerminal(
          {
            deviceId: body.deviceId ?? "",
            name: body.name ?? "",
            role: body.role ?? "",
            version: body.version ?? ""
          },
          address
        );
        const token = randomBytes(32).toString("base64url");
        const proofReference = randomBytes(32).toString("base64url");
        terminalProofReferences.set(body.deviceId ?? "", proofReference);
        terminalTokens.set(createHash("sha256").update(token).digest("hex"), terminal.id);
        pairingCode = String((Number(pairingCode) + 104729) % 1_000_000).padStart(6, "0");
        return json(res, 200, {
          data: {
            token,
            terminal,
            controlDomainId: engine.controlDomainId,
            controlDomainProofKey: derivedControlDomainProofKey(body.deviceId ?? "", proofReference)
          },
          sequence: engine.getSequence()
        });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/terminals/event-ticket") {
        const identity = authenticateControl(req, res);
        if (!identity) return;
        if (!identity.terminalId || identity.role === "admin") return json(res, 401, { error: "TERMINAL_AUTH_REQUIRED" });
        const ticket = randomBytes(24).toString("base64url");
        const expiresAt = Date.now() + 60_000;
        eventTickets.set(hashToken(ticket), { terminalId: identity.terminalId, role: identity.role, expiresAt });
        return json(res, 200, {
          data: { ticket, expiresAt: new Date(expiresAt).toISOString() },
          sequence: engine.getSequence()
        });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/snapshot") {
        if (!authenticateControl(req, res)) return;
        return json(res, 200, { data: engine.snapshot(), sequence: engine.getSequence() });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/devices") {
        if (!authenticateControl(req, res)) return;
        return json(res, 200, { data: engine.getDevices(), sequence: engine.getSequence() });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/scenes") {
        if (!authenticateControl(req, res)) return;
        return json(res, 200, { data: engine.getScenes(), sequence: engine.getSequence() });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/alerts") {
        if (!authenticateControl(req, res)) return;
        return json(res, 200, { data: engine.getAlerts(), sequence: engine.getSequence() });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/health")
        return json(res, 200, { data: engine.getHealth(), sequence: engine.getSequence() });
      if (req.method === "GET" && url.pathname === "/api/v1/admin/bench-reset/preview") {
        if (!requireAdmin(req, res)) return;
        return json(res, 200, { data: engine.benchResetPreview(), sequence: engine.getSequence() });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/admin/bench-reset") {
        if (!requireAdmin(req, res)) return;
        const result = await engine.benchReset();
        return json(res, result.status === "completed" ? 200 : 207, { data: result, sequence: engine.getSequence() });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/admin/handover") {
        if (!requireAdmin(req, res)) return;
        return json(res, 200, { data: engine.handoverChecklist(), sequence: engine.getSequence() });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/admin/handover/complete") {
        if (!requireAdmin(req, res)) return;
        const body = await readBody<{
          completionId?: string;
          completedBy?: string;
          stateToken?: string;
          acknowledgedWarnings?: string[];
          note?: string;
        }>(req);
        return json(res, 200, {
          data: engine.completeHandover({
            completionId: body.completionId ?? "",
            completedBy: body.completedBy ?? "",
            stateToken: body.stateToken ?? "",
            acknowledgedWarnings: body.acknowledgedWarnings ?? [],
            note: body.note ?? ""
          }),
          sequence: engine.getSequence()
        });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/admin/login") {
        const address = loginAddress(req);
        if (enforceLoginWindow(loginAttempts, address)) return json(res, 429, { error: "TOO_MANY_AUTH_ATTEMPTS" });
        const body = await readBody<{ pin?: string }>(req);
        const candidate = createHash("sha256")
          .update(body.pin ?? "")
          .digest();
        if (!timingSafeEqual(candidate, adminPinHash)) {
          recordLoginFailure(loginAttempts, address);
          return json(res, 401, { error: "INVALID_ADMIN_PIN" });
        }
        loginAttempts.delete(address);
        const token = randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
        sessions.set(token, expiresAt);
        return json(res, 200, { data: { token, expiresAt: new Date(expiresAt).toISOString() }, sequence: engine.getSequence() });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/admin/logout") {
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (token) sessions.delete(token);
        return json(res, 200, { data: true, sequence: engine.getSequence() });
      }

      if (url.pathname.startsWith("/api/v1/admin/") && !requireAdmin(req, res)) return;
      if (req.method === "POST" && url.pathname === "/api/v1/admin/change-pin") {
        const address = loginAddress(req);
        if (enforceLoginWindow(pinChangeAttempts, address)) return json(res, 429, { error: "TOO_MANY_AUTH_ATTEMPTS" });
        const body = await readBody<{ currentPin?: string; newPin?: string; confirmPin?: string }>(req);
        const currentHash = createHash("sha256")
          .update(body.currentPin ?? "")
          .digest();
        if (!timingSafeEqual(currentHash, adminPinHash)) {
          recordLoginFailure(pinChangeAttempts, address);
          return json(res, 401, { error: "INVALID_CURRENT_ADMIN_PIN" });
        }
        if (body.newPin !== body.confirmPin) return json(res, 400, { error: "ADMIN_PIN_CONFIRMATION_MISMATCH" });
        const nextHash = createHash("sha256").update(body.newPin!).digest();
        if (timingSafeEqual(nextHash, adminPinHash)) return json(res, 409, { error: "ADMIN_PIN_UNCHANGED" });
        if (!/^\d{6,12}$/.test(body.newPin ?? "")) return json(res, 400, { error: "INVALID_NEW_ADMIN_PIN" });
        adminPinHash = nextHash;
        sessions.clear();
        loginAttempts.clear();
        pinChangeAttempts.clear();
        engine.recordAdminPinRotation();
        return json(res, 200, { data: true, sequence: engine.getSequence() });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/admin/terminals/pairing-code")
        return json(res, 200, { data: { code: pairingCode }, sequence: engine.getSequence() });
      if (req.method === "GET" && url.pathname === "/api/v1/admin/audits")
        return json(res, 200, { data: engine.getAudits(), sequence: engine.getSequence() });
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "admin" && parts[3] === "resources" && parts[4]) {
        const resources: AdminResourceName[] = ["rooms", "devices", "scenes", "automations", "alerts", "gateways", "terminals", "audits"];
        const resource = parts[4] as AdminResourceName;
        if (!resources.includes(resource)) return json(res, 404, { error: "ADMIN_RESOURCE_NOT_FOUND" });
        return json(res, 200, {
          data: engine.queryAdminResource(resource, {
            page: Number(url.searchParams.get("page") ?? 1),
            pageSize: Number(url.searchParams.get("pageSize") ?? 10),
            q: url.searchParams.get("q") ?? undefined,
            status: url.searchParams.get("status") ?? undefined
          }),
          sequence: engine.getSequence()
        });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/admin/config")
        return json(res, 200, { data: engine.getConfiguration(), sequence: engine.getSequence() });
      if (req.method === "PUT" && url.pathname === "/api/v1/admin/config") {
        const config = await readBody<AdminConfiguration>(req);
        return json(res, 200, { data: engine.updateConfiguration(config), sequence: engine.getSequence() });
      }
      if (
        req.method === "POST" &&
        parts[0] === "api" &&
        parts[1] === "v1" &&
        parts[2] === "admin" &&
        parts[3] === "terminals" &&
        parts[5] === "revoke"
      ) {
        const revoked = engine.revokeTerminal(parts[4]);
        terminalProofReferences.clear();
        for (const [tokenHash, terminalId] of terminalTokens) if (terminalId === revoked.id) terminalTokens.delete(tokenHash);
        for (const [ticketHash, identity] of eventTickets) if (identity.terminalId === revoked.id) eventTickets.delete(ticketHash);
        terminalConnections.delete(revoked.role);
        const sockets = terminalSockets.get(revoked.role);
        terminalSockets.delete(revoked.role);
        sockets?.forEach((socket) => socket.close(1008, "TERMINAL_REVOKED"));
        return json(res, 200, { data: revoked, sequence: engine.getSequence() });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/admin/backup")
        return json(res, 200, { data: engine.exportBackup(), sequence: engine.getSequence() });
      if (req.method === "POST" && url.pathname === "/api/v1/admin/backup") {
        const backup = await readBody<AdminConfiguration>(req);
        return json(res, 200, { data: engine.restoreBackup(backup), sequence: engine.getSequence() });
      }
      if (
        req.method === "POST" &&
        parts[0] === "api" &&
        parts[1] === "v1" &&
        parts[2] === "admin" &&
        parts[3] === "gateways" &&
        parts[5] === "test"
      ) {
        return json(res, 200, { data: engine.testGateway(parts[4]), sequence: engine.getSequence() });
      }
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "devices" && parts[4] === "commands") {
        const identity = authenticateControl(req, res);
        if (!identity) return;
        const request = await readBody<CommandRequest>(req);
        const command = await engine.command(parts[3], { ...request, source: identity.role });
        return json(res, command.status === "confirmed" ? 200 : 409, { data: command, sequence: engine.getSequence() });
      }
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "scenes" && parts[4] === "execute") {
        const identity = authenticateControl(req, res);
        if (!identity) return;
        await readBody<{ source?: CommandRequest["source"] }>(req);
        const execution = await engine.executeScene(parts[3], identity.role);
        return json(res, execution.status === "completed" ? 200 : 207, { data: execution, sequence: engine.getSequence() });
      }
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "alerts" && parts[4] === "acknowledge") {
        const identity = authenticateControl(req, res);
        if (!identity) return;
        await readBody<{ source?: CommandRequest["source"] }>(req);
        return json(res, 200, { data: engine.acknowledgeAlert(parts[3], identity.role), sequence: engine.getSequence() });
      }
      if (
        req.method === "POST" &&
        parts[0] === "api" &&
        parts[1] === "v1" &&
        parts[2] === "admin" &&
        parts[3] === "alerts" &&
        parts[5] === "recover"
      ) {
        if (!requireAdmin(req, res)) return;
        return json(res, 200, { data: engine.recoverAlert(parts[4]), sequence: engine.getSequence() });
      }
      if (testSupportEnabled && req.method === "POST" && url.pathname === "/api/v1/_test/faults") {
        if (!requireAdmin(req, res)) return;
        const fault = await readBody<TestFaultRequest>(req);
        return json(res, 200, { data: engine.injectFault(fault), sequence: engine.getSequence() });
      }
      if (testSupportEnabled && req.method === "POST" && url.pathname === "/api/v1/_test/reset") {
        if (!requireAdmin(req, res)) return;
        engine.reset();
        engine.reconcileTerminalPresence(new Set(terminalConnections.keys()));
        return json(res, 200, { data: engine.snapshot(), sequence: engine.getSequence() });
      }
      return json(res, 404, { error: "NOT_FOUND", path: url.pathname });
    } catch (error) {
      const message = error instanceof Error ? error.message : "BAD_REQUEST";
      const conflictErrors = new Set([
        "CONFIG_VERSION_CONFLICT",
        "ALERT_RECOVERY_STATE_UNAVAILABLE",
        "ALERT_CONDITION_STILL_ACTIVE",
        "DEVICE_OPERATION_CONFLICT",
        "SCENE_DEVICE_OPERATION_CONFLICT",
        "PRIMARY_TERMINAL_CANNOT_BE_REVOKED",
        "TERMINAL_ALREADY_REVOKED",
        "TERMINAL_REPAIR_REQUIRES_NEW_PAIRING",
        "ACTIVE_CRITICAL_ALERT",
        "ACTIVE_OPERATION",
        "OFFLINE_GATEWAY",
        "BENCH_NOT_RESET",
        "HANDOVER_STATE_CHANGED",
        "HANDOVER_WARNINGS_UNACKNOWLEDGED"
      ]);
      return json(res, conflictErrors.has(message) || message.startsWith("SCENE_EXECUTION_CONFLICT:") ? 409 : 400, { error: message });
    }
  });
  server.on("close", () => haPoll && clearInterval(haPoll));

  const websocket = new WebSocketServer({ server, path: "/api/v1/events" });
  const initializedClients = new WeakSet<WebSocket>();
  websocket.on("connection", (socket, request) => {
    const params = new URL(request.url ?? "/", "http://localhost").searchParams;
    const surface = params.get("surface");
    const terminalRole = surface === "primary" || surface === "secondary" ? surface : undefined;
    const ticket = params.get("ticket");
    if (!ticket || !terminalRole) {
      socket.close(1008, "TERMINAL_AUTH_REQUIRED");
      return;
    }
    const ticketHash = hashToken(ticket);
    const identity = eventTickets.get(ticketHash);
    eventTickets.delete(ticketHash);
    if (!identity || identity.expiresAt <= Date.now() || identity.role !== terminalRole) {
      socket.close(1008, "TERMINAL_AUTH_REQUIRED");
      return;
    }
    if (terminalRole) {
      const terminal = engine.getConfiguration().terminals.find((item) => item.role === terminalRole);
      if (!terminal?.paired) {
        socket.close(1008, "TERMINAL_REVOKED");
        return;
      }
      terminalConnections.set(terminalRole, (terminalConnections.get(terminalRole) ?? 0) + 1);
      const roleSockets = terminalSockets.get(terminalRole) ?? new Set<WebSocket>();
      roleSockets.add(socket);
      terminalSockets.set(terminalRole, roleSockets);
      engine.setTerminalPresence(terminalRole, true);
      socket.once("close", () => {
        terminalSockets.get(terminalRole)?.delete(socket);
        const remaining = Math.max(0, (terminalConnections.get(terminalRole) ?? 1) - 1);
        if (remaining) terminalConnections.set(terminalRole, remaining);
        else {
          terminalConnections.delete(terminalRole);
          engine.setTerminalPresence(terminalRole, false);
        }
      });
    }
    const event: EdgeEvent = { type: "snapshot", sequence: engine.getSequence(), payload: engine.snapshot() };
    socket.send(JSON.stringify(event));
    initializedClients.add(socket);
  });
  const heartbeat = setInterval(() => {
    const payload = JSON.stringify({
      type: "heartbeat",
      sequence: engine.getSequence(),
      payload: { serverTime: new Date().toISOString() }
    } satisfies EdgeEvent);
    websocket.clients.forEach((client) => {
      if (initializedClients.has(client) && client.readyState === client.OPEN) client.send(payload);
    });
  }, options.heartbeatIntervalMs ?? 5_000);
  heartbeat.unref();
  server.once("close", () => clearInterval(heartbeat));
  engine.on("event", (event: EdgeEvent) => {
    const payload = JSON.stringify(event);
    websocket.clients.forEach((client) => {
      if (initializedClients.has(client) && client.readyState === client.OPEN) client.send(payload);
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createEdgeServer().listen(port, "0.0.0.0", () => {
    console.log(`Mock EdgeCore listening on http://0.0.0.0:${port}`);
  });
}
