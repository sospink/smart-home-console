package cn.zhijing.smartlab.edgecore

import cn.zhijing.smartlab.gateway.GatewayAdapter
import cn.zhijing.smartlab.gateway.GatewayConfig
import cn.zhijing.smartlab.gateway.GatewayHealth
import cn.zhijing.smartlab.gateway.RawCommand
import cn.zhijing.smartlab.gateway.RawCommandAck
import cn.zhijing.smartlab.gateway.RawDevice
import cn.zhijing.smartlab.gateway.RawGatewayEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandServiceTest {
  @Test
  fun `command rejects values outside capability range`() = runBlocking {
    val repository = FakeRepository()
    val service = CommandService(repository, { TrustedAdapter }, EdgeEventBus(repository))

    val error = runCatching {
      service.execute("light-1", CommandRequestDto("range-1", "brightness", JsonPrimitive(120), "primary"))
    }.exceptionOrNull()

    assertTrue(error is DomainException)
    assertEquals(400, (error as DomainException).status)
    assertTrue(repository.commands().isEmpty())
  }

  @Test
  fun `command rejects wrong primitive types and enum values before creating pending records`() = runBlocking {
    val base = FakeRepository()
    val curtain = base.device("light-1")!!.copy(
      id = "curtain-test",
      capabilities = listOf(
        DeviceCapabilityDto(
          "motor", "电机", "enum", writable = true,
          options = listOf(CapabilityOptionDto("打开", JsonPrimitive("open")), CapabilityOptionDto("关闭", JsonPrimitive("close"))),
        ),
      ),
    )
    val repository = object : EdgeRepository by base {
      override suspend fun device(id: String) = if (id == curtain.id) curtain else base.device(id)
    }
    val service = CommandService(repository, { TrustedAdapter }, EdgeEventBus(repository))

    val wrongType = runCatching {
      service.execute("light-1", CommandRequestDto("wrong-type", "brightness", JsonPrimitive("80"), "primary"))
    }.exceptionOrNull() as DomainException
    val wrongOption = runCatching {
      service.execute("curtain-test", CommandRequestDto("wrong-option", "motor", JsonPrimitive("reverse"), "primary"))
    }.exceptionOrNull() as DomainException

    assertEquals("INVALID_CAPABILITY_VALUE:light-1.brightness:TYPE", wrongType.message)
    assertEquals("INVALID_CAPABILITY_VALUE:curtain-test.motor:OPTION", wrongOption.message)
    assertTrue(base.commands().isEmpty())
  }

  @Test
  fun `read-only capability cannot be written`() = runBlocking {
    val repository = FakeRepository()
    val service = CommandService(repository, { TrustedAdapter }, EdgeEventBus(repository))

    val error = runCatching {
      service.execute("sensor-1", CommandRequestDto("readonly-1", "motion", JsonPrimitive(true), "primary"))
    }.exceptionOrNull()

    assertEquals(403, (error as DomainException).status)
  }

  @Test
  fun `request id is idempotent and trusted ack confirms state`() = runBlocking {
    val repository = FakeRepository()
    val service = CommandService(repository, { TrustedAdapter }, EdgeEventBus(repository))
    val request = CommandRequestDto("same-request", "brightness", JsonPrimitive(72), "primary")

    val first = service.execute("light-1", request)
    val second = service.execute("light-1", request)

    assertEquals("confirmed", first.status)
    assertEquals(first.id, second.id)
    assertEquals(72, repository.device("light-1")?.state?.get("brightness")?.toString()?.toInt())
    assertEquals(1, repository.commands().size)
  }

  @Test
  fun `missing adapter fails explicitly without changing confirmed state`() = runBlocking {
    val repository = FakeRepository()
    val service = CommandService(repository, { null }, EdgeEventBus(repository))

    val result = service.execute("light-1", CommandRequestDto("no-adapter", "brightness", JsonPrimitive(68), "primary"))

    assertEquals("failed", result.status)
    assertTrue(result.error!!.contains("适配器"))
    assertEquals(40, repository.device("light-1")?.state?.get("brightness")?.toString()?.toInt())
  }

  @Test
  fun `concurrent duplicate request id dispatches once and returns one command`() = runBlocking {
    val repository = FakeRepository()
    var sends = 0
    val adapter = object : GatewayAdapter by TrustedAdapter {
      override suspend fun send(command: RawCommand): RawCommandAck {
        sends += 1
        delay(80)
        return RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
      }
    }
    val service = CommandService(repository, { adapter }, EdgeEventBus(repository))
    val request = CommandRequestDto("concurrent-request", "brightness", JsonPrimitive(73), "primary")

    val commands = List(12) { async { service.execute("light-1", request) } }.awaitAll()

    assertEquals(1, sends)
    assertEquals(1, commands.map { it.id }.distinct().size)
    assertEquals(1, repository.commands().size)
  }

  @Test
  fun `same request id cannot be replayed with a different payload`() = runBlocking {
    val repository = FakeRepository()
    val service = CommandService(repository, { TrustedAdapter }, EdgeEventBus(repository))
    service.execute("light-1", CommandRequestDto("conflicting-request", "brightness", JsonPrimitive(72), "primary"))

    val error = runCatching {
      service.execute("light-1", CommandRequestDto("conflicting-request", "brightness", JsonPrimitive(20), "primary"))
    }.exceptionOrNull()

    assertEquals(409, (error as DomainException).status)
    assertEquals(72, repository.device("light-1")?.state?.get("brightness")?.toString()?.toInt())
  }

  @Test
  fun `adapter timeout becomes terminal timeout without changing confirmed state`() = runBlocking {
    val repository = FakeRepository()
    val adapter = object : GatewayAdapter by TrustedAdapter {
      override suspend fun send(command: RawCommand): RawCommandAck {
        delay(200)
        return RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
      }
    }
    val service = CommandService(repository, { adapter }, EdgeEventBus(repository), commandTimeoutMillis = 35)

    val result = service.execute("light-1", CommandRequestDto("timeout-real", "brightness", JsonPrimitive(74), "primary"))

    assertEquals("timeout", result.status)
    assertTrue(result.error!!.contains("超时"))
    assertEquals(40, repository.device("light-1")?.state?.get("brightness")?.toString()?.toInt())
  }

  @Test
  fun `gateway-backed command is rejected when gateway is offline even if device state is stale online`() = runBlocking {
    val repository = FakeRepository().apply { gatewayOnline = false }
    var sends = 0
    val adapter = object : GatewayAdapter by TrustedAdapter {
      override suspend fun send(command: RawCommand): RawCommandAck {
        sends += 1
        return RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
      }
    }
    val service = CommandService(repository, { adapter }, EdgeEventBus(repository))

    val error = runCatching {
      service.execute("light-1", CommandRequestDto("gateway-offline", "brightness", JsonPrimitive(75), "primary"))
    }.exceptionOrNull()

    assertEquals(409, (error as DomainException).status)
    assertTrue(error.message!!.contains("网关离线"))
    assertEquals(0, sends)
    assertTrue(repository.commands().isEmpty())
    assertEquals(40, repository.device("light-1")?.state?.get("brightness")?.toString()?.toInt())
  }
}

internal object TrustedAdapter : GatewayAdapter {
  override suspend fun start(config: GatewayConfig) = Unit
  override suspend fun stop() = Unit
  override suspend fun discover(): List<RawDevice> = emptyList()
  override fun events(): Flow<RawGatewayEvent> = emptyFlow()
  override suspend fun send(command: RawCommand) = RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
  override suspend fun health() = GatewayHealth("gateway", true, 1)
}

internal class FakeRepository : EdgeRepository {
  private var seq = 0L
  private var configurationVersion = 1
  private var savedConfiguration: AdminConfigurationDto? = null
  internal var gatewayOnline = true
  private val deviceValues = mutableMapOf(
    "light-1" to DeviceDto(
      "light-1", "主灯", "客厅", "light", "online", "2026-01-01T00:00:00Z",
      mapOf("power" to JsonPrimitive(false), "brightness" to JsonPrimitive(40)),
      listOf(
        DeviceCapabilityDto("power", "电源", "boolean", writable = true),
        DeviceCapabilityDto("brightness", "亮度", "number", min = 1.0, max = 100.0, step = 1.0, unit = "%", writable = true),
      ),
      DeviceIntegrationDto("dmwg03lm", externalId = "light-1", protocol = "ble-mesh", gatewayId = "gateway", verificationStatus = "hardware-pending"),
    ),
    "sensor-1" to DeviceDto(
      "sensor-1", "人体传感器", "客厅", "sensor", "online", "2026-01-01T00:00:00Z",
      mapOf("motion" to JsonPrimitive(false)),
      listOf(DeviceCapabilityDto("motion", "有人移动", "readonly", writable = false)),
      DeviceIntegrationDto("dmwg03lm", externalId = "sensor-1", protocol = "ble", gatewayId = "gateway", verificationStatus = "hardware-pending"),
    ),
    "water-1" to DeviceDto(
      "water-1", "水浸传感器", "设备区", "sensor", "online", "2026-01-01T00:00:00Z",
      mapOf("waterLeak" to JsonPrimitive(true)),
      listOf(DeviceCapabilityDto("waterLeak", "水浸", "readonly", writable = false)),
      DeviceIntegrationDto("dmwg03lm", externalId = "water-1", protocol = "zigbee", gatewayId = "gateway", verificationStatus = "hardware-pending"),
    ),
  )
  private val commandValues = LinkedHashMap<String, CommandDto>()
  private val executionValues = LinkedHashMap<String, SceneExecutionDto>()
  internal val alertValues = LinkedHashMap<String, AlertDto>()
  internal val terminalValues = LinkedHashMap<String, Pair<TerminalDto, String>>()
  internal val automationValues = LinkedHashMap<String, AutomationDto>()
  internal val auditValues = LinkedHashMap<String, AuditDto>()
  internal val propertyTimes = LinkedHashMap<String, String>()
  internal var automationSuppressedUntil: String? = null
  internal val automationSuppressionHistory = mutableListOf<String>()

  override suspend fun sequence() = seq
  override suspend fun nextSequence() = ++seq
  override suspend fun devices() = deviceValues.values.toList()
  override suspend fun device(id: String) = deviceValues[id]
  override suspend fun deviceByExternalId(gatewayId: String, externalId: String) = deviceValues[externalId]
  override suspend fun propertyConfirmedAt(deviceId: String, property: String) = propertyTimes["$deviceId.$property"]
  override suspend fun scenes() = listOf(
    SceneDto(
      "scene-test", "测试场景", "用于状态汇总", "cyan",
      listOf(
        SceneActionDto("a1", "light-1", "power", JsonPrimitive(true), "开灯"),
        SceneActionDto("a2", "sensor-1", "motion", JsonPrimitive(true), "错误写入只读传感器"),
      ),
    )
  )
  override suspend fun scene(id: String) = scenes().firstOrNull { it.id == id }
  override suspend fun alerts() = alertValues.values.toList()
  override suspend fun audits() = auditValues.values.toList()
  internal val handoverValues = LinkedHashMap<String, HandoverCompletionDto>()
  override suspend fun latestHandover() = handoverValues.values.lastOrNull()
  override suspend fun handoverById(id: String) = handoverValues[id]
  override suspend fun auditPage(page: Int, pageSize: Int, q: String, status: String): AuditPageDto {
    val filtered = auditValues.values.reversed().filter { audit ->
      val queryMatches = q.isBlank() || listOf(
        audit.action, audit.detail, audit.source, audit.category, audit.result,
      ).any { it.contains(q, ignoreCase = true) }
      val statusMatches = status.isBlank() || status == "all" || audit.result == status || audit.category == status
      queryMatches && statusMatches
    }
    val totalPages = maxOf(1, (filtered.size + pageSize - 1) / pageSize)
    val effectivePage = page.coerceIn(1, totalPages)
    return AuditPageDto(
      filtered.drop((effectivePage - 1) * pageSize).take(pageSize), effectivePage, pageSize, filtered.size, totalPages,
    )
  }
  override suspend fun terminals() = terminalValues.values.map { it.first }
  override suspend fun adminConfiguration(exportedAt: String?) =
    (savedConfiguration ?: AdminConfigurationDto(
      configurationVersion, null, emptyList(), devices(), scenes(), emptyList(), emptyList(), terminals(),
    )).copy(exportedAt = exportedAt)

  override suspend fun saveAdminConfiguration(
    configuration: AdminConfigurationDto,
    enforceVersion: Boolean,
    auditAction: String,
  ): AdminConfigurationDto {
    if (enforceVersion && configuration.version != configurationVersion) throw DomainException(409, "CONFIG_VERSION_CONFLICT")
    configurationVersion += 1
    val detail = if (auditAction == "恢复配置备份") {
      "源版本 ${configuration.version}，配置版本 $configurationVersion"
    } else "配置版本 $configurationVersion"
    saveAudit("system", auditAction, detail, "admin", "success")
    return configuration.copy(version = configurationVersion, exportedAt = null).also { savedConfiguration = it }
  }
  override suspend fun commands() = commandValues.values.toList()
  override suspend fun commandByRequest(requestId: String) = commandValues.values.firstOrNull { it.requestId == requestId }
  override suspend fun executions() = executionValues.values.toList()
  override suspend fun health() = SystemHealthDto(
    controlDomainId = "00000000-0000-4000-8000-000000000000",
    "hardware", "test", "2026-01-01T00:00:00Z", 1,
    listOf(GatewayHealthDto("gateway", "测试网关", "DMWG03LM", "test", if (gatewayOnline) "online" else "offline", 1, "2026-01-01T00:00:00Z", "local")),
  )
  override suspend fun saveCommand(command: CommandDto) { commandValues[command.id] = command }
  override suspend fun saveExecution(execution: SceneExecutionDto) { executionValues[execution.id] = execution }
  override suspend fun saveDevice(device: DeviceDto) {
    deviceValues[device.id] = device
    device.state.keys.forEach { propertyTimes["${device.id}.$it"] = device.updatedAt }
  }
  override suspend fun saveConfirmedProperty(device: DeviceDto, property: String, value: kotlinx.serialization.json.JsonElement) {
    deviceValues[device.id] = device.copy(state = device.state + (property to value))
    propertyTimes["${device.id}.$property"] = device.updatedAt
  }
  override suspend fun saveAlert(alert: AlertDto) { alertValues[alert.id] = alert }
  override suspend fun recoverAlert(id: String, at: String): AlertDto? = alertValues[id]?.copy(recoveredAt = at)?.also { alertValues[id] = it }
  override suspend fun openAlert(deviceId: String, title: String) = alertValues.values.firstOrNull { it.deviceId == deviceId && it.title == title && it.recoveredAt == null }
  override suspend fun saveTerminal(terminal: TerminalDto, tokenHash: String) { terminalValues[terminal.id] = terminal to tokenHash }
  override suspend fun terminalProofReference(deviceId: String) = terminalValues.values
    .firstOrNull { it.first.deviceId == deviceId && it.first.paired && it.second.isNotBlank() }
    ?.second
  override suspend fun revokeTerminal(id: String): TerminalDto? {
    val current = terminalValues[id] ?: return null
    if (current.first.role == "primary") return null
    val revoked = current.first.copy(paired = false, online = false)
    terminalValues[id] = revoked to ""
    return revoked
  }
  override suspend fun terminalByTokenHash(tokenHash: String) = terminalValues.values.firstOrNull { it.second == tokenHash }?.first
  override suspend fun touchTerminal(id: String, address: String, version: String, at: String) {
    terminalValues[id]?.let {
      if (it.first.paired) {
        terminalValues[id] = it.first.copy(online = true, address = address, version = version.ifBlank { it.first.version }, lastSeenAt = at) to it.second
      }
    }
  }
  override suspend fun updateTerminalContact(id: String, address: String, version: String, at: String) {
    terminalValues[id]?.let {
      terminalValues[id] = it.first.copy(address = address, version = version.ifBlank { it.first.version }, lastSeenAt = at) to it.second
    }
  }
  override suspend fun setTerminalOnline(id: String, online: Boolean) {
    terminalValues[id]?.let { terminalValues[id] = it.first.copy(online = online) to it.second }
  }
  override suspend fun saveGatewayTest(id: String, result: GatewayTestDto) = Unit
  override suspend fun automations() = automationValues.values.toList()
  override suspend fun markAutomationTriggered(id: String, at: String) {
    automationValues[id]?.let { automationValues[id] = it.copy(lastTriggeredAt = at) }
  }
  override suspend fun suppressAutomationsUntil(until: String) {
    automationSuppressedUntil = until
    automationSuppressionHistory += until
  }
  override suspend fun automationsSuppressed(at: String): Boolean =
    automationSuppressedUntil?.let { java.time.Instant.parse(at).isBefore(java.time.Instant.parse(it)) } ?: false
  override suspend fun saveAudit(category: String, action: String, detail: String, source: String, result: String) {
    val id = "audit-${auditValues.size + 1}"
    auditValues[id] = AuditDto(id, category, action, detail, source, result, "2026-07-24T00:00:00Z")
  }
  override suspend fun saveHandover(completion: HandoverCompletionDto, auditDetail: String) {
    handoverValues[completion.id] = completion
    saveAudit("system", "完成运行交接", auditDetail, "admin", "success")
  }
  override suspend fun acknowledgeAlert(id: String, at: String): AlertDto? = alertValues[id]?.copy(acknowledgedAt = at)?.also { alertValues[id] = it }
  override suspend fun recoverInterruptedRuntime(at: String): RuntimeRecoveryResult {
    val pending = commandValues.values.filter { it.status == "pending" }
    pending.forEach { commandValues[it.id] = it.copy(status = "timeout", error = "EdgeCore 重启，命令最终状态未知，请核对设备") }
    val running = executionValues.values.filter { it.status == "running" }
    running.forEach {
      executionValues[it.id] = it.copy(
        status = if (it.completedActions > 0) "partial" else "failed",
        finishedAt = at,
      )
    }
    val online = terminalValues.values.filter { it.first.online }
    online.forEach { (terminal, token) -> terminalValues[terminal.id] = terminal.copy(online = false) to token }
    val staleDevices = deviceValues.values.count { it.health != "offline" }
    deviceValues.replaceAll { _, device -> device.copy(health = "offline", updatedAt = at) }
    return RuntimeRecoveryResult(
      pending.size,
      running.count { it.completedActions == 0 },
      running.count { it.completedActions > 0 },
      online.size,
      0,
      staleDevices,
    )
  }
  override suspend fun updateGatewayConnectivity(gatewayId: String, online: Boolean, at: String): List<DeviceDto> {
    gatewayOnline = online
    val health = if (online) "online" else "offline"
    val impacted = deviceValues.values.filter { it.id == gatewayId || (!online && it.integration.gatewayId == gatewayId) }
    impacted.forEach { deviceValues[it.id] = it.copy(health = health, updatedAt = at) }
    return impacted.map { deviceValues[it.id]!! }
  }
}
