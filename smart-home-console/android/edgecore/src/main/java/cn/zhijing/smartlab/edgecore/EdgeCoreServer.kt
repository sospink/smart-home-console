package cn.zhijing.smartlab.edgecore

import cn.zhijing.smartlab.gateway.GatewayAdapter
import cn.zhijing.smartlab.gateway.RawGatewayEvent
import cn.zhijing.smartlab.gateway.GatewayHealth
import io.ktor.http.*
import io.ktor.serialization.ContentConvertException
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.plugins.origin
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import java.time.Instant
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement

class EdgeCoreServer(
  private val repository: EdgeRepository,
  private val adapterForDevice: suspend (DeviceDto) -> GatewayAdapter? = { null },
  private val gatewayEvents: Flow<RawGatewayEvent> = emptyFlow(),
  private val gatewayHealthEvents: Flow<GatewayHealth> = emptyFlow(),
  private val gatewayTester: suspend (String) -> GatewayHealth? = { null },
  private val port: Int = 8787,
  adminPin: String = "2468",
  pairingCodeProvider: () -> String = { "000000" },
  pairingCodeRotator: () -> Unit = {},
  private val controlDomainId: String = "00000000-0000-4000-8000-000000000000",
  private val controlDomainProofKey: String = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  primaryToken: String? = null,
  private val adminPinUpdater: ((String) -> Unit)? = null,
  private val diagnosticProvider: suspend (EdgeRepository) -> DiagnosticBundleDto? = { null },
  private val databaseBackupCoordinator: DatabaseBackupCoordinator? = null,
  private val uiUpdateCoordinator: UiUpdateCoordinator? = null,
  private val operationalLogger: (String, String, String) -> Unit = { _, _, _ -> },
) {
  private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
  private val events = EdgeEventBus(repository, json)
  private val operationCoordinator = OperationCoordinator()
  private val commandService = CommandService(repository, adapterForDevice, events, coordinator = operationCoordinator)
  private val sceneEngine = SceneEngine(repository, commandService, events, operationCoordinator)
  private val alertService = AlertService(repository, events)
  private val automationEngine = AutomationEngine(repository, commandService)
  private val stateStore = StateStore(repository, events, automationEngine, alertService)
  private val security = SecurityService(repository, adminPin, pairingCodeProvider, pairingCodeRotator, controlDomainId, controlDomainProofKey, primaryToken)
  private val terminalPresence = TerminalPresenceService(repository, events)
  private val benchReset = BenchResetService(repository, commandService)
  /** Serializes ordinary configuration writes and backup restores. */
  private val configurationMutex = Mutex()
  private var server: EmbeddedServer<CIOApplicationEngine, CIOApplicationEngine.Configuration>? = null

  fun start(wait: Boolean = false) {
    if (server != null) return
    server = embeddedServer(CIO, host = "0.0.0.0", port = port) { module() }.also {
      it.start(wait = wait)
      operationalLogger("info", "edgecore.server.start", "port=$port")
    }
  }

  fun stop() {
    server?.stop(1_000, 3_000)
    operationalLogger("info", "edgecore.server.stop", "")
    server = null
  }

  fun Application.module() {
    launch {
      gatewayEvents.collect { event ->
        try {
          stateStore.ingest(event)
        } catch (error: Throwable) {
          repository.saveAudit(
            "system", "网关事件摄取失败", "${event.gatewayId}/${event.externalId}.${event.property}: ${error.message}",
            "gateway", "failed",
          )
          operationalLogger("warn", "gateway.event.rejected", "gateway=${event.gatewayId} property=${event.property}")
        }
      }
    }
    launch {
      gatewayHealthEvents.collect { health ->
        try {
          stateStore.ingestHealth(health)
        } catch (error: Throwable) {
          repository.saveAudit(
            "system", "网关健康事件摄取失败", "${health.gatewayId}: ${error.message}",
            "gateway", "failed",
          )
          operationalLogger("warn", "gateway.health.rejected", "gateway=${health.gatewayId}")
        }
      }
    }
    install(ContentNegotiation) { json(json) }
    install(WebSockets) { pingPeriod = 20.seconds; timeout = 30.seconds }
    install(CORS) {
      allowMethod(HttpMethod.Get)
      allowMethod(HttpMethod.Post)
      allowMethod(HttpMethod.Put)
      allowHeader(HttpHeaders.ContentType)
      allowHeader(HttpHeaders.Authorization)
      allowHeader("X-Smart-Lab-Version")
      allowHost("appassets.androidplatform.net", schemes = listOf("http", "https"))
      allowHost("localhost:8083", schemes = listOf("http"))
      allowHost("127.0.0.1:8083", schemes = listOf("http"))
    }
    install(StatusPages) {
      exception<DomainException> { call, cause ->
        operationalLogger(if (cause.status >= 500) "error" else "warn", "api.domain", "status=${cause.status} path=${call.request.path()}")
        call.respond(HttpStatusCode.fromValue(cause.status), ErrorDto(cause.message))
      }
      exception<DatabaseBackupUnavailableException> { call, cause ->
        repository.saveAudit("system", "数据库快照创建失败", cause.message.orEmpty(), "edgecore", "failed")
        operationalLogger("warn", "database.backup.capacity", "path=${call.request.path()}")
        call.respond(HttpStatusCode.fromValue(507), ErrorDto(cause.message.orEmpty()))
      }
      exception<io.ktor.server.plugins.ContentTransformationException> { call, cause ->
        operationalLogger("warn", "api.invalid_body", "path=${call.request.path()} type=${cause::class.java.simpleName}")
        call.respond(HttpStatusCode.BadRequest, ErrorDto("INVALID_REQUEST_BODY"))
      }
      exception<ContentConvertException> { call, cause ->
        operationalLogger("warn", "api.invalid_body", "path=${call.request.path()} type=${cause::class.java.simpleName}")
        call.respond(HttpStatusCode.BadRequest, ErrorDto("INVALID_REQUEST_BODY"))
      }
      exception<SerializationException> { call, cause ->
        operationalLogger("warn", "api.invalid_body", "path=${call.request.path()} type=${cause::class.java.simpleName}")
        call.respond(HttpStatusCode.BadRequest, ErrorDto("INVALID_REQUEST_BODY"))
      }
      exception<Throwable> { call, cause ->
        if (cause.isInvalidRequestBody()) {
          operationalLogger("warn", "api.invalid_body", "path=${call.request.path()} type=${cause::class.java.simpleName}")
          call.respond(HttpStatusCode.BadRequest, ErrorDto("INVALID_REQUEST_BODY"))
          return@exception
        }
        repository.saveAudit("system", "API 异常", cause.message ?: cause::class.java.simpleName, "edgecore", "failed")
        operationalLogger("error", "api.unhandled", "path=${call.request.path()} type=${cause::class.java.simpleName}")
        call.respond(HttpStatusCode.InternalServerError, ErrorDto("服务内部错误"))
      }
    }

    routing {
      get("/api/v1/health") { call.respond(Envelope(repository.health(), repository.sequence())) }
      post("/api/v1/control-domain/challenge") {
        val request = call.receive<ControlDomainChallengeRequestDto>()
        if (!request.nonce.matches(Regex("[A-Za-z0-9_-]{43}"))) throw DomainException(400, "INVALID_CONTROL_DOMAIN_NONCE")
        if (!request.deviceId.matches(Regex("[a-zA-Z0-9._-]{6,96}"))) throw DomainException(400, "INVALID_TERMINAL_ID")
        val key = Base64.getUrlDecoder().decode(security.activeControlDomainProofKey(request.deviceId))
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
        val expectedClientProof = mac.doFinal(
          "client:$controlDomainId:${request.deviceId}:${request.nonce}".toByteArray(Charsets.UTF_8),
        )
        val presentedClientProof = runCatching { Base64.getUrlDecoder().decode(request.clientProof) }
          .getOrElse { throw DomainException(401, "CONTROL_DOMAIN_CLIENT_PROOF_REQUIRED") }
        if (!java.security.MessageDigest.isEqual(expectedClientProof, presentedClientProof)) {
          throw DomainException(401, "CONTROL_DOMAIN_CLIENT_PROOF_REQUIRED")
        }
        mac.reset()
        val proof = Base64.getUrlEncoder().withoutPadding()
          .encodeToString(mac.doFinal("server:$controlDomainId:${request.deviceId}:${request.nonce}".toByteArray(Charsets.UTF_8)))
        call.respond(Envelope(ControlDomainChallengeResponseDto(controlDomainId, request.nonce, proof), repository.sequence()))
      }
      post("/api/v1/terminals/pair") {
        val response = security.pair(call.receive(), call.request.origin.remoteHost)
        call.respond(HttpStatusCode.Created, Envelope(response, repository.sequence()))
      }
      post("/api/v1/terminals/event-ticket") {
        val response = security.issueEventTicket(call.bearer(), call.request.origin.remoteHost, call.terminalVersion())
        call.respond(Envelope(response, repository.sequence()))
      }
      post("/api/v1/admin/login") {
        val request = call.receive<AdminLoginRequestDto>()
        call.respond(Envelope(security.login(request.pin, call.request.origin.remoteHost), repository.sequence()))
      }
      post("/api/v1/admin/logout") {
        security.logout(call.bearer())
        call.respond(Envelope(true, repository.sequence()))
      }
      post("/api/v1/admin/change-pin") {
        call.requireAdmin(security)
        val updater = adminPinUpdater ?: throw DomainException(501, "ADMIN_PIN_CHANGE_NOT_AVAILABLE")
        val request = call.receive<AdminPinChangeRequestDto>()
        security.changeAdminPin(request, call.request.origin.remoteHost, updater)
        runCatching { repository.saveAudit("security", "轮换管理员 PIN", "旧管理会话已全部吊销", "admin", "success") }
          .onFailure { operationalLogger("error", "security.admin-pin.audit-failed", it::class.java.simpleName) }
        operationalLogger("info", "security.admin-pin.changed", "sessions=revoked")
        call.respond(Envelope(true, repository.sequence()))
      }
      get("/api/v1/snapshot") {
        call.requireTerminal(security)
        call.respond(Envelope(snapshot(), repository.sequence()))
      }
      get("/api/v1/ui-update/sync") {
        call.requireTerminal(security)
        val coordinator = uiUpdateCoordinator ?: throw DomainException(501, "UI_UPDATE_NOT_AVAILABLE")
        val activeVersion = coordinator.status().activeVersion
        val currentVersion = call.request.queryParameters["currentVersion"]
        call.respond(
          Envelope(
            UiUpdateSyncDto(
              targetVersion = activeVersion,
              update = if (activeVersion != null && activeVersion != currentVersion) coordinator.syncPackage() else null,
            ),
            repository.sequence(),
          ),
        )
      }
      get("/api/v1/devices") {
        call.requireTerminal(security)
        call.respond(Envelope(repository.devices(), repository.sequence()))
      }
      post("/api/v1/devices/{id}/commands") {
        val source = call.requireControlSource(security)
        val id = call.parameters["id"] ?: throw DomainException(400, "缺少设备 ID")
        call.respond(Envelope(commandService.execute(id, call.receive<CommandRequestDto>().copy(source = source)), repository.sequence()))
      }
      get("/api/v1/scenes") {
        call.requireTerminal(security)
        call.respond(Envelope(repository.scenes(), repository.sequence()))
      }
      post("/api/v1/scenes/{id}/execute") {
        val source = call.requireControlSource(security)
        val id = call.parameters["id"] ?: throw DomainException(400, "缺少场景 ID")
        call.receive<SceneExecuteRequestDto>()
        call.respond(Envelope(sceneEngine.execute(id, source), repository.sequence()))
      }
      get("/api/v1/alerts") {
        call.requireTerminal(security)
        call.respond(Envelope(repository.alerts(), repository.sequence()))
      }
      post("/api/v1/alerts/{id}/acknowledge") {
        val source = call.requireControlSource(security)
        val id = call.parameters["id"] ?: throw DomainException(400, "缺少告警 ID")
        call.receive<AlertAcknowledgeRequestDto>()
        val alert = alertService.acknowledge(id, source)
        call.respond(Envelope(alert, repository.sequence()))
      }
      get("/api/v1/admin/audits") {
        call.requireAdmin(security)
        call.respond(Envelope(repository.audits(), repository.sequence()))
      }
      get("/api/v1/admin/bench-reset/preview") {
        call.requireAdmin(security)
        call.respond(Envelope(benchReset.preview(), repository.sequence()))
      }
      post("/api/v1/admin/bench-reset") {
        call.requireAdmin(security)
        val result = benchReset.execute()
        call.respond(if (result.status == "completed") HttpStatusCode.OK else HttpStatusCode.MultiStatus, Envelope(result, repository.sequence()))
      }
      get("/api/v1/admin/handover") {
        call.requireAdmin(security)
        call.respond(Envelope(benchReset.handoverChecklist(), repository.sequence()))
      }
      post("/api/v1/admin/handover/complete") {
        call.requireAdmin(security)
        call.respond(Envelope(benchReset.completeHandover(call.receive()), repository.sequence()))
      }
      get("/api/v1/admin/diagnostics") {
        call.requireAdmin(security)
        val bundle = diagnosticProvider(repository) ?: throw DomainException(501, "DIAGNOSTICS_NOT_AVAILABLE")
        repository.saveAudit("system", "导出诊断包", "诊断信息已脱敏", "admin", "success")
        operationalLogger("info", "diagnostics.export", "")
        call.respond(Envelope(bundle, repository.sequence()))
      }
      get("/api/v1/admin/database-backups") {
        call.requireAdmin(security)
        val coordinator = databaseBackupCoordinator ?: throw DomainException(501, "DATABASE_BACKUP_NOT_AVAILABLE")
        call.respond(Envelope(coordinator.list(), repository.sequence()))
      }
      get("/api/v1/admin/database-backups/storage") {
        call.requireAdmin(security)
        val coordinator = databaseBackupCoordinator ?: throw DomainException(501, "DATABASE_BACKUP_NOT_AVAILABLE")
        call.respond(Envelope(coordinator.storage(), repository.sequence()))
      }
      get("/api/v1/admin/data-lifecycle") {
        call.requireAdmin(security)
        val coordinator = databaseBackupCoordinator ?: throw DomainException(501, "DATA_LIFECYCLE_NOT_AVAILABLE")
        call.respond(Envelope(coordinator.lifecycle(), repository.sequence()))
      }
      post("/api/v1/admin/database-backups") {
        call.requireAdmin(security)
        val coordinator = databaseBackupCoordinator ?: throw DomainException(501, "DATABASE_BACKUP_NOT_AVAILABLE")
        val artifact = coordinator.create()
        repository.saveAudit("system", "创建数据库快照", "${artifact.filename} · ${artifact.sha256}", "admin", "success")
        operationalLogger("info", "database.backup.manual", "file=${artifact.filename}")
        call.respond(Envelope(artifact, repository.sequence()))
      }
      get("/api/v1/admin/database-backups/{filename}") {
        call.requireAdmin(security)
        val coordinator = databaseBackupCoordinator ?: throw DomainException(501, "DATABASE_BACKUP_NOT_AVAILABLE")
        val filename = call.parameters["filename"] ?: throw DomainException(400, "缺少数据库快照文件名")
        if (!validDatabaseBackupFilename(filename)) throw DomainException(400, "INVALID_DATABASE_BACKUP_FILENAME")
        val artifact = coordinator.list().firstOrNull { it.filename == filename }
          ?: throw DomainException(404, "DATABASE_BACKUP_NOT_FOUND")
        if (artifact.integrityStatus != "ok") throw DomainException(409, "DATABASE_BACKUP_INTEGRITY_FAILED")
        val input = coordinator.open(filename) ?: throw DomainException(404, "DATABASE_BACKUP_NOT_FOUND")
        repository.saveAudit("system", "导出数据库快照", filename, "admin", "success")
        operationalLogger("info", "database.backup.export", "file=$filename")
        call.response.header(HttpHeaders.ContentDisposition, "attachment; filename=\"$filename\"")
        call.respondOutputStream(ContentType.Application.OctetStream) { input.use { it.copyTo(this) } }
      }
      get("/api/v1/admin/ui-update") {
        call.requireAdmin(security)
        val status = uiUpdateCoordinator?.status() ?: throw DomainException(501, "UI_UPDATE_NOT_AVAILABLE")
        call.respond(Envelope(status, repository.sequence()))
      }
      post("/api/v1/admin/ui-update") {
        call.requireAdmin(security)
        val contentLength = call.request.headers[HttpHeaders.ContentLength]?.toLongOrNull()
        if (contentLength != null && contentLength > 58L * 1024 * 1024) {
          throw DomainException(413, "UI_UPDATE_PACKAGE_TOO_LARGE")
        }
        val coordinator = uiUpdateCoordinator ?: throw DomainException(501, "UI_UPDATE_NOT_AVAILABLE")
        val status = coordinator.install(call.receive())
        repository.saveAudit("system", "安装界面资源更新", status.activeVersion.orEmpty(), "admin", "success")
        operationalLogger("info", "ui-update.install", "version=${status.activeVersion.orEmpty()}")
        call.respond(Envelope(status, repository.sequence()))
      }
      post("/api/v1/admin/ui-update/rollback") {
        call.requireAdmin(security)
        val coordinator = uiUpdateCoordinator ?: throw DomainException(501, "UI_UPDATE_NOT_AVAILABLE")
        val status = coordinator.rollback()
        repository.saveAudit("system", "回滚界面资源", status.activeVersion ?: status.bundledVersion, "admin", "success")
        operationalLogger("warn", "ui-update.rollback", "version=${status.activeVersion ?: "bundled"}")
        call.respond(Envelope(status, repository.sequence()))
      }
      get("/api/v1/admin/config") {
        call.requireAdmin(security)
        call.respond(Envelope(repository.adminConfiguration(), repository.sequence()))
      }
      put("/api/v1/admin/config") {
        call.requireAdmin(security)
        val request = call.receive<AdminConfigurationDto>()
        val configuration = configurationMutex.withLock {
          val current = repository.adminConfiguration()
          preventTerminalCredentialReactivation(current, request)
          repository.saveAdminConfiguration(request)
        }
        events.publish("snapshot", snapshot())
        call.respond(Envelope(configuration, repository.sequence()))
      }
      get("/api/v1/admin/backup") {
        call.requireAdmin(security)
        call.respond(Envelope(repository.adminConfiguration(Instant.now().toString()), repository.sequence()))
      }
      post("/api/v1/admin/backup") {
        call.requireAdmin(security)
        val backup = call.receive<AdminConfigurationDto>()
        val configuration = configurationMutex.withLock {
          val current = repository.adminConfiguration()
          if (backup.version <= 0 || backup.version > (current.version + 100)) {
            throw DomainException(400, "BACKUP_VERSION_UNSUPPORTED")
          }
          preventTerminalCredentialReactivation(current, backup)
          repository.saveAdminConfiguration(
            backup.copy(exportedAt = null),
            enforceVersion = false,
            auditAction = "恢复配置备份",
          )
        }
        events.publish("snapshot", snapshot())
        call.respond(Envelope(configuration, repository.sequence()))
      }
      get("/api/v1/admin/resources/{resource}") {
        call.requireAdmin(security)
        val resource = call.parameters["resource"] ?: throw DomainException(400, "缺少资源类型")
        val page = call.request.queryParameters["page"].toSafeInt(1)
        val pageSize = call.request.queryParameters["pageSize"].toSafeInt(10).coerceIn(1, 100)
        val q = call.request.queryParameters["q"].orEmpty().trim()
        val status = call.request.queryParameters["status"].orEmpty().trim()
        if (resource == "audits") {
          call.respond(Envelope(repository.auditPage(page, pageSize, q, status), repository.sequence()))
          return@get
        }
        val configuration = repository.adminConfiguration()
        val items: List<JsonElement> = when (resource) {
          "rooms" -> configuration.rooms.filter { it.matches(q, it.name) && it.matchesStatus(status, if (it.enabled) "enabled" else "disabled") }.map { json.encodeToJsonElement(it) }
          "devices" -> configuration.devices.filter { it.matches(q, it.name, it.room, it.kind, it.health) && it.matchesStatus(status, it.health, it.integration.verificationStatus) }.map { json.encodeToJsonElement(it) }
          "scenes" -> configuration.scenes.filter { it.matches(q, it.name, it.description, it.strategy) && it.matchesStatus(status, if (it.enabled) "enabled" else "disabled") }.map { json.encodeToJsonElement(it) }
          "automations" -> configuration.automations.filter { it.matches(q, it.name, it.condition.deviceId, it.condition.property) && it.matchesStatus(status, if (it.enabled) "enabled" else "disabled") }.map { json.encodeToJsonElement(it) }
          "alerts" -> repository.alerts().filter { it.matches(q, it.title, it.message, it.level, it.deviceId) && it.matchesStatus(status, it.alertStatus()) }.map { json.encodeToJsonElement(it) }
          "gateways" -> configuration.gateways.filter { it.matches(q, it.name, it.host, it.mode) && it.matchesStatus(status, it.mode, if (it.lastTest != null) "tested" else "untested") }.map { json.encodeToJsonElement(it) }
          "terminals" -> configuration.terminals.filter { it.matches(q, it.name, it.role, it.address, it.version) && it.matchesStatus(status, if (it.online) "online" else "offline", if (it.paired) "paired" else "unpaired") }.map { json.encodeToJsonElement(it) }
          else -> throw DomainException(404, "ADMIN_RESOURCE_NOT_FOUND")
        }
        call.respond(Envelope(items.paginated(page, pageSize), repository.sequence()))
      }
      get("/api/v1/admin/terminals/pairing-code") {
        call.requireAdmin(security)
        call.respond(Envelope(security.pairingCode(), repository.sequence()))
      }
      post("/api/v1/admin/terminals/{id}/revoke") {
        call.requireAdmin(security)
        val id = call.parameters["id"] ?: throw DomainException(400, "缺少终端 ID")
        val current = repository.terminals().firstOrNull { it.id == id } ?: throw DomainException(404, "TERMINAL_NOT_FOUND")
        if (current.role == "primary") throw DomainException(409, "PRIMARY_TERMINAL_CANNOT_BE_REVOKED")
        val revoked = repository.revokeTerminal(id) ?: throw DomainException(409, "TERMINAL_ALREADY_REVOKED")
        security.revokeEventTickets(id)
        terminalPresence.revoke(id)
        repository.saveAudit("security", "撤销终端配对", "${current.name} (${current.deviceId})；旧令牌与在线事件流已失效", "admin", "success")
        events.publish("terminal.updated", revoked)
        call.respond(Envelope(revoked, repository.sequence()))
      }
      post("/api/v1/admin/alerts/{id}/recover") {
        call.requireAdmin(security)
        val id = call.parameters["id"] ?: throw DomainException(400, "缺少告警 ID")
        call.respond(Envelope(alertService.recover(id), repository.sequence()))
      }
      post("/api/v1/admin/gateways/{id}/test") {
        call.requireAdmin(security)
        val id = call.parameters["id"] ?: throw DomainException(400, "缺少网关 ID")
        val gateway = repository.adminConfiguration().gateways.firstOrNull { it.id == id }
          ?: throw DomainException(404, "GATEWAY_NOT_FOUND")
        val live = runCatching { gatewayTester(id) }.getOrNull()
        val result = gateway.copy(lastTest = GatewayTestDto(
          ok = live?.online == true,
          message = when {
            live == null -> "实机适配器未启用，未执行真实连通测试"
            live.online -> "HA 云链路连通，网关与灯实体均可达${live.detail?.let { "（$it）" }.orEmpty()}"
            else -> "HA 云链路不可用：${live.detail ?: "健康检查失败"}"
          },
          testedAt = Instant.now().toString(),
        ))
        repository.saveGatewayTest(id, result.lastTest!!)
        repository.saveAudit("system", "网关连通测试", "${gateway.name}: ${result.lastTest?.message}", "admin", if (result.lastTest?.ok == true) "success" else "failed")
        call.respond(Envelope(result, repository.sequence()))
      }
      webSocket("/api/v1/events") {
        val identity = security.consumeEventTicket(call.request.queryParameters["ticket"])
        val surface = call.request.queryParameters["surface"]
        if (identity == null || surface !in setOf("primary", "secondary") || identity.role != surface) {
          close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "TERMINAL_AUTH_REQUIRED"))
          return@webSocket
        }
        if (security.isTerminalRevoked(identity.terminalId)) {
          close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "TERMINAL_REVOKED"))
          return@webSocket
        }
        terminalPresence.connected(identity, this)
        if (security.isTerminalRevoked(identity.terminalId)) {
          terminalPresence.disconnected(identity, this)
          close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "TERMINAL_REVOKED"))
          return@webSocket
        }
        val initial = EdgeEventDto("snapshot", repository.sequence(), json.encodeToJsonElement(SystemSnapshotDto.serializer(), snapshot()))
        send(Frame.Text(json.encodeToString(initial)))
        val eventSender = launch {
          events.events.collectLatest { send(Frame.Text(json.encodeToString(it))) }
        }
        val heartbeat = launch {
          var beats = 0
          while (isActive) {
            delay(5_000)
            val event = EdgeEventDto(
              "heartbeat",
              repository.sequence(),
              json.encodeToJsonElement(mapOf("serverTime" to Instant.now().toString())),
            )
            send(Frame.Text(json.encodeToString(event)))
            beats += 1
            // 事件心跳需要足够密集以发现半开连接；终端租约仍保持 20 秒落库，避免放大写入。
            if (beats % 4 == 0) terminalPresence.refresh(identity)
          }
        }
        try {
          // 主协程必须消费客户端帧，才能在没有业务事件时也立即感知 Close。
          for (frame in incoming) {
            if (frame is Frame.Close) break
          }
        } finally {
          eventSender.cancel()
          heartbeat.cancel()
          terminalPresence.disconnected(identity, this)
        }
      }
    }
  }

  private suspend fun snapshot() = SystemSnapshotDto(
    sequence = repository.sequence(),
    devices = repository.devices(),
    scenes = repository.scenes(),
    alerts = repository.alerts(),
    commands = repository.commands(),
    executions = repository.executions(),
    health = repository.health(),
  )


}

private fun Throwable.isInvalidRequestBody(): Boolean {
  var current: Throwable? = this
  val visited = mutableSetOf<Throwable>()
  while (current != null && visited.add(current)) {
    if (
      current is SerializationException ||
      current is ContentConvertException ||
      current is io.ktor.server.plugins.ContentTransformationException
    ) return true
    current = current.cause
  }
  return false
}

private fun preventTerminalCredentialReactivation(current: AdminConfigurationDto, next: AdminConfigurationDto) {
  val revoked = current.terminals.filter { !it.paired }.associateBy { it.id }
  if (next.terminals.any { candidate -> revoked.containsKey(candidate.id) && candidate.paired }) {
    throw DomainException(409, "TERMINAL_REPAIR_REQUIRES_NEW_PAIRING")
  }
}

@Serializable
private data class PageDto<T>(val items: List<T>, val page: Int, val pageSize: Int, val total: Int, val totalPages: Int)

private fun String?.toSafeInt(default: Int) = this?.toIntOrNull() ?: default
private fun ApplicationCall.bearer() = request.headers[HttpHeaders.Authorization]?.replace(Regex("^Bearer\\s+", RegexOption.IGNORE_CASE), "")
private fun ApplicationCall.terminalVersion() = request.headers["X-Smart-Lab-Version"].orEmpty().take(40)

private suspend fun ApplicationCall.requireTerminal(security: SecurityService) {
  security.authenticateTerminal(bearer(), request.origin.remoteHost, terminalVersion()) ?: throw DomainException(401, "TERMINAL_AUTH_REQUIRED")
}

private suspend fun ApplicationCall.requireControlSource(security: SecurityService): String {
  val token = bearer()
  if (security.isAdmin(token)) return "admin"
  return security.authenticateTerminal(token, request.origin.remoteHost, terminalVersion())?.role
    ?: throw DomainException(401, "TERMINAL_AUTH_REQUIRED")
}

private fun ApplicationCall.requireAdmin(security: SecurityService) {
  if (!security.isAdmin(bearer())) throw DomainException(401, "ADMIN_AUTH_REQUIRED")
}

private fun Any.matches(query: String, vararg values: Any?) = query.isBlank() || values.any { it.toString().contains(query, ignoreCase = true) }
private fun Any.matchesStatus(status: String, vararg values: String) = status.isBlank() || status == "all" || values.any { it == status }
private fun AlertDto.alertStatus() = if (recoveredAt != null) "recovered" else if (acknowledgedAt != null) "acknowledged" else "open"

private fun <T> List<T>.paginated(requestedPage: Int, pageSize: Int): PageDto<T> {
  val total = size
  val totalPages = maxOf(1, (total + pageSize - 1) / pageSize)
  val page = requestedPage.coerceIn(1, totalPages)
  return PageDto(drop((page - 1) * pageSize).take(pageSize), page, pageSize, total, totalPages)
}
