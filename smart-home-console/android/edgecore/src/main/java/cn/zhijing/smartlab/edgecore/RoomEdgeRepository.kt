package cn.zhijing.smartlab.edgecore

import cn.zhijing.smartlab.data.*
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class RoomEdgeRepository(
  private val dao: EdgeDao,
  private val json: Json = Json { ignoreUnknownKeys = true },
  private val appVersion: String = "0.1.0",
  private val controlDomainId: String = "00000000-0000-4000-8000-000000000000",
) : EdgeRepository {
  private val startedAt = Instant.now()
  private val configMutex = Mutex()

  override suspend fun sequence() = dao.meta()?.eventSequence ?: 0
  override suspend fun nextSequence() = dao.nextSequence()

  override suspend fun devices(): List<DeviceDto> {
    val capabilities = dao.capabilities().groupBy { it.deviceId }
    val states = dao.states().groupBy { it.deviceId }
    val gatewayModes = dao.gateways().associate { it.id to it.mode }
    return dao.devices().map { entity ->
      DeviceDto(
        id = entity.id,
        name = entity.name,
        room = entity.roomName,
        kind = entity.kind,
        health = entity.health,
        updatedAt = entity.updatedAt,
        state = states[entity.id].orEmpty().associate { it.property to json.parseToJsonElement(it.valueJson) },
        capabilities = capabilities[entity.id].orEmpty().map {
          val options = it.optionsJson?.let { raw ->
            json.parseToJsonElement(raw).jsonArray.map { value ->
              runCatching {
                val objectValue = value.jsonObject
                CapabilityOptionDto(objectValue.getValue("label").jsonPrimitive.content, objectValue.getValue("value"))
              }.getOrElse { CapabilityOptionDto(value.toString().trim('"'), value) }
            }
          }
          DeviceCapabilityDto(it.property, it.label, it.type, it.minimum, it.maximum, it.step, it.unit, it.writable, options)
        },
        integration = DeviceIntegrationDto(
          adapter = when {
            entity.kind == "gateway" && gatewayModes[entity.id] == "ha-cloud" -> "home-assistant"
            entity.verificationStatus == "hardware-verified" && entity.gatewayId != null &&
              gatewayModes[entity.gatewayId] == "ha-cloud" -> "home-assistant"
            entity.verificationStatus == "hardware-verified" && entity.gatewayId != null -> "dmwg03lm"
            entity.verificationStatus == "hardware-verified" && entity.protocol == "wifi" -> "miot-local"
            else -> "vendor"
          },
          externalId = entity.externalId,
          marketModel = entity.marketModel,
          internalModel = entity.internalModel,
          protocol = entity.protocol,
          gatewayId = entity.gatewayId,
          verificationStatus = entity.verificationStatus,
          note = entity.note,
        ),
        display = DeviceDisplayDto(entity.displayIcon, entity.displayOrder, entity.displayHidden, entity.displayFavorite, entity.secondarySlot),
      )
    }
  }

  override suspend fun device(id: String) = devices().firstOrNull { it.id == id }
  override suspend fun deviceByExternalId(gatewayId: String, externalId: String) = dao.deviceByExternalId(gatewayId, externalId)?.let { entity ->
    devices().firstOrNull { it.id == entity.id }
  }
  override suspend fun propertyConfirmedAt(deviceId: String, property: String) = dao.state(deviceId, property)?.confirmedAt

  override suspend fun scenes(): List<SceneDto> {
    val actions = dao.sceneActions().groupBy { it.sceneId }
    return dao.scenes().map { scene ->
      SceneDto(
        scene.id,
        scene.name,
        scene.description,
        scene.tone,
        actions[scene.id].orEmpty().map { SceneActionDto(it.id, it.deviceId, it.property, json.parseToJsonElement(it.valueJson), it.label) },
        scene.lastExecutedAt,
        scene.enabled,
        scene.strategy,
      )
    }
  }

  override suspend fun scene(id: String) = scenes().firstOrNull { it.id == id }

  override suspend fun alerts() = dao.alerts().map {
    AlertDto(
      it.id, it.deviceId, it.level, it.title, it.message, it.occurredAt, it.acknowledgedAt, it.recoveredAt,
      it.recoveryProperty, it.recoveryValue?.let(json::parseToJsonElement),
    )
  }

  override suspend fun audits() = dao.audits().map {
    AuditDto(it.id, it.category, it.action, it.detail, it.source, it.result, it.occurredAt)
  }

  private fun HandoverRecordEntity.toDto() = HandoverCompletionDto(
    id, completedAt, completedBy, stateToken,
    json.decodeFromString(ListSerializer(String.serializer()), acknowledgedWarningsJson), note,
    json.decodeFromString(HandoverSummaryDto.serializer(), summaryJson),
  )

  override suspend fun latestHandover() = dao.latestHandover()?.toDto()

  override suspend fun handoverById(id: String) = dao.handoverById(id)?.toDto()

  override suspend fun auditPage(page: Int, pageSize: Int, q: String, status: String): AuditPageDto {
    val normalizedQuery = q.trim()
    val normalizedStatus = status.trim()
    val total = dao.auditQueryCount(normalizedQuery, normalizedStatus)
    val totalPages = maxOf(1, (total + pageSize - 1) / pageSize)
    val effectivePage = page.coerceIn(1, totalPages)
    val offset = (effectivePage - 1) * pageSize
    val entities = dao.auditQuery(normalizedQuery, normalizedStatus, pageSize, offset)
    val items = entities.map {
      AuditDto(it.id, it.category, it.action, it.detail, it.source, it.result, it.occurredAt)
    }
    return AuditPageDto(items, effectivePage, pageSize, total, totalPages)
  }

  override suspend fun terminals() = dao.terminals().map { it.toDto() }

  override suspend fun adminConfiguration(exportedAt: String?): AdminConfigurationDto {
    val devices = devices()
    val scenesById = dao.allScenes().associateBy { it.id }
    val actions = dao.sceneActions().groupBy { it.sceneId }
    return AdminConfigurationDto(
      version = dao.meta()?.version ?: 1,
      exportedAt = exportedAt,
      rooms = dao.allRooms().map { RoomConfigDto(it.id, it.name, it.sortOrder, it.enabled) },
      devices = devices,
      scenes = scenesById.values.map { scene ->
        SceneDto(
          scene.id, scene.name, scene.description, scene.tone,
          actions[scene.id].orEmpty().map { SceneActionDto(it.id, it.deviceId, it.property, json.parseToJsonElement(it.valueJson), it.label) },
          scene.lastExecutedAt, scene.enabled, scene.strategy,
        )
      },
      automations = dao.automations().map { automation ->
        AutomationDto(
          automation.id, automation.name, automation.enabled,
          json.decodeFromString<AutomationConditionDto>(automation.conditionJson),
          json.decodeFromString<List<SceneActionDto>>(automation.actionsJson),
          automation.cooldownSeconds, automation.lastTriggeredAt,
        )
      },
      gateways = dao.gateways().map {
        GatewayConfigDto(
          it.id, it.name, it.host, it.port, it.credentialRef, it.mode,
          it.lastTestAt?.let { at -> GatewayTestDto(it.lastTestOk == true, it.lastTestMessage.orEmpty(), at) },
        )
      },
      terminals = terminals(),
      benchResetPolicy = (dao.meta() ?: ConfigurationMetaEntity(version = 1, updatedAt = Instant.now().toString())).let {
        BenchResetPolicyDto(it.benchResetPower, it.benchResetCover, it.benchResetSuppressionSeconds)
      },
    )
  }

  override suspend fun saveAdminConfiguration(
    configuration: AdminConfigurationDto,
    enforceVersion: Boolean,
    auditAction: String,
  ): AdminConfigurationDto = configMutex.withLock {
    validateConfiguration(configuration)
    val currentDevices = dao.devices().associateBy { it.id }
    val currentStates = dao.states().groupBy { it.deviceId }
    val currentTerminals = dao.terminals().associateBy { it.id }
    val currentGateways = dao.gateways().associateBy { it.id }
    val currentMeta = dao.meta()
    val currentVersion = currentMeta?.version ?: 0
    validateBenchResetPolicy(configuration.benchResetPolicy)
    if (enforceVersion && configuration.version != currentVersion) {
      saveAudit(
        "system", "更新配置", "拒绝旧版本 ${configuration.version}，当前版本 $currentVersion", "admin", "failed",
      )
      throw DomainException(409, "CONFIG_VERSION_CONFLICT")
    }
    val at = Instant.now().toString()
    val nextVersion = currentVersion + 1
    var sequence = currentMeta?.eventSequence ?: 0
    val rooms = configuration.rooms.map { RoomEntity(it.id, it.name.take(80), it.order, it.enabled) }
    val gateways = configuration.gateways.map {
      val existing = currentGateways[it.id]
      GatewayEntity(
        it.id, it.name.take(80), it.host.take(120), it.port, existing?.model ?: "DMWG03LM",
        existing?.firmware ?: "待实机读取", it.credentialRef, it.mode, existing?.health ?: "offline",
        existing?.updatedAt ?: at, existing?.lastTestOk, existing?.lastTestMessage, existing?.lastTestAt,
      )
    }
    val gatewayNames = configuration.gateways.associate { it.id to it.name }
    val devices = configuration.devices.map { device ->
      val existing = currentDevices[device.id]
      DeviceEntity(
        device.id, existing?.externalId ?: device.integration.externalId ?: device.id,
        (if (device.kind == "gateway") gatewayNames[device.id] ?: device.name else device.name).take(100),
        roomIdFor(device.room, configuration.rooms), device.room.take(80),
        existing?.kind ?: device.kind, existing?.health ?: "offline", existing?.marketModel ?: device.integration.marketModel,
        existing?.internalModel ?: device.integration.internalModel, existing?.protocol ?: device.integration.protocol,
        existing?.gatewayId ?: device.integration.gatewayId, existing?.verificationStatus ?: "hardware-pending",
        existing?.note ?: device.integration.note, existing?.updatedAt ?: device.updatedAt,
        device.display.icon?.take(80), device.display.order.coerceIn(0, 10_000), device.display.hidden, device.display.favorite,
        device.display.secondarySlot,
      )
    }
    val capabilities = configuration.devices.flatMap { device ->
      device.capabilities.map {
        CapabilityEntity(
          device.id, it.property, it.label, it.type, it.min, it.max, it.step, it.unit, it.writable,
          it.options?.let { options -> json.encodeToString(options.map { option -> option.value }) },
        )
      }
    }
    val states = configuration.devices.flatMap { device ->
      val confirmed = currentStates[device.id].orEmpty()
      val stateValues = if (confirmed.isNotEmpty()) confirmed.associate { it.property to json.parseToJsonElement(it.valueJson) } else device.state
      val confirmedAt = confirmed.maxOfOrNull { it.confirmedAt } ?: device.updatedAt
      stateValues.map { (property, value) -> DeviceStateEntity(device.id, property, value.toString(), confirmedAt, ++sequence) }
    }
    val scenes = configuration.scenes.map { scene ->
      SceneEntity(scene.id, scene.name.take(100), scene.description.take(500), scene.tone, scene.enabled, scene.strategy, scene.lastExecutedAt)
    }
    val sceneActions = configuration.scenes.flatMap { scene ->
      scene.actions.mapIndexed { index, action ->
        SceneActionEntity(action.id, scene.id, index, action.deviceId, action.property, action.value.toString(), action.label.take(120))
      }
    }
    val automations = configuration.automations.map {
        AutomationEntity(
          it.id, it.name.take(100), it.enabled, json.encodeToString(AutomationConditionDto.serializer(), it.condition),
          json.encodeToString(ListSerializer(SceneActionDto.serializer()), it.actions),
          it.cooldownSeconds, it.lastTriggeredAt,
        )
    }
    val terminals = configuration.terminals.map { terminal ->
      val existing = currentTerminals[terminal.id]
      TerminalEntity(
        terminal.id, terminal.deviceId, terminal.name, terminal.role, existing?.tokenRef.orEmpty(), terminal.paired && existing?.paired == true,
        existing?.online ?: false, existing?.version ?: terminal.version, existing?.address ?: terminal.address,
        existing?.lastSeenAt ?: terminal.lastSeenAt,
      )
    }
    // 配置资源在单个 Room 事务中替换；旧版本遗留表不属于正式配置域。
    dao.replaceConfiguration(
      rooms, gateways, devices, capabilities, states, scenes, sceneActions, automations, terminals,
      ConfigurationMetaEntity(
        version = nextVersion,
        updatedAt = at,
        eventSequence = sequence,
        benchResetPower = configuration.benchResetPolicy.power,
        benchResetCover = configuration.benchResetPolicy.cover,
        benchResetSuppressionSeconds = configuration.benchResetPolicy.automationSuppressionSeconds,
        automationSuppressedUntil = currentMeta?.automationSuppressedUntil,
      ),
    )
    val detail = if (auditAction == "恢复配置备份") {
      "源版本 ${configuration.version}，配置版本 $nextVersion"
    } else {
      "配置版本 $nextVersion"
    }
    saveAudit("system", auditAction, detail, "admin", "success")
    return adminConfiguration()
  }

  override suspend fun commands() = dao.commands().map { it.toDto(json) }
  override suspend fun commandByRequest(requestId: String) = dao.commandByRequest(requestId)?.toDto(json)
  override suspend fun executions() = dao.executions().map {
    SceneExecutionDto(it.id, it.sceneId, it.source, it.status, it.completedActions, it.totalActions, it.startedAt, it.finishedAt)
  }

  override suspend fun health(): SystemHealthDto {
    val now = Instant.now()
    return SystemHealthDto(
      controlDomainId = controlDomainId,
      mode = "hardware",
      version = appVersion,
      serverTime = now.toString(),
      uptimeSeconds = Duration.between(startedAt, now).seconds,
      gateways = dao.gateways().map {
        GatewayHealthDto(it.id, it.name, it.model, it.firmware, it.health, 0, it.updatedAt, it.mode)
      },
    )
  }

  override suspend fun saveCommand(command: CommandDto) {
    dao.putCommand(
      CommandEntity(
        command.id, command.requestId, command.deviceId, command.property, command.value.toString(), command.source,
        command.status, command.createdAt, command.confirmedAt, command.error,
      )
    )
  }

  override suspend fun saveExecution(execution: SceneExecutionDto) {
    dao.putExecution(
      SceneExecutionEntity(
        execution.id, execution.sceneId, execution.source, execution.status, execution.completedActions,
        execution.totalActions, execution.startedAt, execution.finishedAt,
      )
    )
  }

  override suspend fun saveDevice(device: DeviceDto) {
    val existing = dao.devices().firstOrNull { it.id == device.id } ?: return
    dao.putDevice(existing.copy(health = device.health, updatedAt = device.updatedAt))
    device.state.forEach { (property, value) ->
      dao.putState(DeviceStateEntity(device.id, property, value.toString(), device.updatedAt, nextSequence()))
    }
  }

  override suspend fun saveConfirmedProperty(device: DeviceDto, property: String, value: JsonElement) {
    val existing = dao.devices().firstOrNull { it.id == device.id } ?: return
    dao.putDevice(existing.copy(health = device.health, updatedAt = device.updatedAt))
    dao.putState(DeviceStateEntity(device.id, property, value.toString(), device.updatedAt, nextSequence()))
  }

  override suspend fun saveAudit(category: String, action: String, detail: String, source: String, result: String) {
    dao.putAudit(
      AuditEntity(
        "audit-${UUID.randomUUID()}", category, action, redact(detail), source, result,
        Instant.now().toString(), null, null,
      )
    )
  }

  override suspend fun saveHandover(completion: HandoverCompletionDto, auditDetail: String) {
    dao.putHandoverWithAudit(
      HandoverRecordEntity(
        completion.id, completion.completedAt, completion.completedBy, completion.stateToken,
        json.encodeToString(ListSerializer(String.serializer()), completion.acknowledgedWarnings), completion.note,
        json.encodeToString(HandoverSummaryDto.serializer(), completion.summary),
      ),
      AuditEntity(
        "audit-${UUID.randomUUID()}", "system", "完成运行交接", redact(auditDetail), "admin", "success",
        completion.completedAt,
      ),
    )
  }

  override suspend fun saveAlert(alert: AlertDto) {
    dao.putAlert(
      AlertEntity(
        alert.id, alert.deviceId, alert.level, alert.title, alert.message.take(1_000), alert.occurredAt,
        alert.acknowledgedAt, alert.recoveredAt, alert.recoveryProperty, alert.recoveryValue?.toString(),
      )
    )
  }

  override suspend fun recoverAlert(id: String, at: String): AlertDto? {
    dao.recoverAlert(id, at)
    return alerts().firstOrNull { it.id == id }
  }

  override suspend fun openAlert(deviceId: String, title: String) = dao.openAlert(deviceId, title)?.let {
    AlertDto(
      it.id, it.deviceId, it.level, it.title, it.message, it.occurredAt, it.acknowledgedAt, it.recoveredAt,
      it.recoveryProperty, it.recoveryValue?.let(json::parseToJsonElement),
    )
  }

  override suspend fun saveTerminal(terminal: TerminalDto, tokenHash: String) {
    dao.putTerminal(
      TerminalEntity(
        terminal.id, terminal.deviceId, terminal.name.take(80), terminal.role, tokenHash, terminal.paired,
        terminal.online, terminal.version.take(40), terminal.address.take(120), terminal.lastSeenAt,
      )
    )
  }

  override suspend fun terminalProofReference(deviceId: String) = dao.terminalProofReference(deviceId)

  override suspend fun revokeTerminal(id: String): TerminalDto? {
    if (dao.revokeTerminal(id) == 0) return null
    return dao.terminals().firstOrNull { it.id == id }?.toDto()
  }

  override suspend fun terminalByTokenHash(tokenHash: String) = dao.terminalByTokenHash(tokenHash)?.toDto()

  override suspend fun touchTerminal(id: String, address: String, version: String, at: String) {
    dao.touchTerminal(id, true, address.take(120), version.take(40), at)
  }

  override suspend fun updateTerminalContact(id: String, address: String, version: String, at: String) {
    dao.updateTerminalContact(id, address.take(120), version.take(40), at)
  }

  override suspend fun setTerminalOnline(id: String, online: Boolean) = dao.setTerminalOnline(id, online)

  override suspend fun saveGatewayTest(id: String, result: GatewayTestDto) {
    dao.saveGatewayTest(id, result.ok, result.message.take(500), result.testedAt)
  }

  override suspend fun automations() = adminConfiguration().automations
  override suspend fun markAutomationTriggered(id: String, at: String) = dao.markAutomationTriggered(id, at)
  override suspend fun suppressAutomationsUntil(until: String) = dao.suppressAutomationsUntil(until)
  override suspend fun automationsSuppressed(at: String): Boolean {
    val until = dao.meta()?.automationSuppressedUntil?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return false
    return Instant.parse(at).isBefore(until)
  }

  override suspend fun acknowledgeAlert(id: String, at: String): AlertDto? {
    dao.acknowledgeAlert(id, at)
    return alerts().firstOrNull { it.id == id }
  }

  override suspend fun recoverInterruptedRuntime(at: String): RuntimeRecoveryResult {
    val counts = dao.recoverInterruptedRuntime(
      at = at,
      commandError = "EdgeCore 重启，命令最终状态未知，请核对设备",
    )
    if (counts.timedOutCommands > 0) {
      saveAudit(
        "system", "收口中断命令",
        "${counts.timedOutCommands} 条命令因 EdgeCore 重启转为超时；未推断设备最终状态，请现场核对",
        "edgecore", "failed",
      )
    }
    val interruptedExecutions = counts.failedExecutions + counts.partialExecutions
    if (interruptedExecutions > 0) {
      saveAudit(
        "scene", "收口中断场景",
        "$interruptedExecutions 次执行因 EdgeCore 重启中断，其中部分执行 ${counts.partialExecutions} 次、未开始 ${counts.failedExecutions} 次",
        "edgecore", "failed",
      )
    }
    if (counts.offlineTerminals > 0) {
      saveAudit(
        "system", "重置终端在线状态",
        "${counts.offlineTerminals} 台终端等待重新握手；本机主屏将在服务启动时重新上线",
        "edgecore", "success",
      )
    }
    if (counts.invalidatedGateways + counts.invalidatedDevices > 0) {
      saveAudit(
        "system", "重置连接可信状态",
        "EdgeCore 重启后 ${counts.invalidatedGateways} 个网关、${counts.invalidatedDevices} 个设备等待本次运行周期的可信上报",
        "edgecore", "success",
      )
    }
    return RuntimeRecoveryResult(
      counts.timedOutCommands,
      counts.failedExecutions,
      counts.partialExecutions,
      counts.offlineTerminals,
      counts.invalidatedGateways,
      counts.invalidatedDevices,
    )
  }

  override suspend fun updateGatewayConnectivity(gatewayId: String, online: Boolean, at: String): List<DeviceDto> {
    val health = if (online) "online" else "offline"
    dao.updateGatewayHealth(gatewayId, health, at)
    dao.updateGatewayDeviceHealth(gatewayId, health, at)
    if (!online) dao.markGatewayChildrenOffline(gatewayId, at)
    return devices().filter { it.id == gatewayId || (!online && it.integration.gatewayId == gatewayId) }
  }

  private fun redact(value: String) = value
    .replace(Regex("(?i)(token|key|secret|password|pin)\\s*[:=]\\s*[^\\s,;]+"), "$1=[REDACTED]")
    .take(2_000)
}

internal fun validateConfiguration(configuration: AdminConfigurationDto) {
  validateBenchResetPolicy(configuration.benchResetPolicy)
  if (configuration.rooms.isEmpty()) throw DomainException(400, "INVALID_CONFIGURATION_ROOMS")
  if (configuration.rooms.any { it.name.isBlank() }) throw DomainException(400, "INVALID_CONFIGURATION_ROOMS")
  val roomNames = configuration.rooms.map { it.name.trim() }
  if (roomNames.distinct().size != roomNames.size) throw DomainException(400, "DUPLICATE_ROOM_NAME")
  if (configuration.devices.any { it.kind != "gateway" && it.room.trim() !in roomNames }) throw DomainException(400, "DEVICE_ROOM_NOT_FOUND")
  if (configuration.scenes.any { it.name.isBlank() }) throw DomainException(400, "INVALID_SCENE_NAME")
  if (configuration.automations.any { it.name.isBlank() }) throw DomainException(400, "INVALID_AUTOMATION_NAME")
  val deviceIds = configuration.devices.map { it.id }.toSet()
  if (deviceIds.size != configuration.devices.size) throw DomainException(400, "DUPLICATE_DEVICE_ID")
  if (configuration.devices.any { (it.kind == "sensor" || it.kind == "lock") && it.display.hidden }) {
    throw DomainException(400, "SAFETY_DEVICE_CANNOT_BE_HIDDEN")
  }
  val secondaryRequirements = mapOf(
    "light" to setOf("power", "brightness"),
    "curtain" to setOf("position", "motor"),
    "music" to setOf("power", "volume"),
  )
  val secondaryDevices = configuration.devices.filter { it.display.secondarySlot != null }
  if (secondaryDevices.any { it.display.secondarySlot !in secondaryRequirements }) {
    throw DomainException(400, "INVALID_SECONDARY_SLOT")
  }
  if (secondaryDevices.mapNotNull { it.display.secondarySlot }.distinct().size != secondaryDevices.size) {
    throw DomainException(400, "DUPLICATE_SECONDARY_SLOT")
  }
  secondaryDevices.forEach { device ->
    val slot = device.display.secondarySlot!!
    val required = secondaryRequirements.getValue(slot)
    if (required.any { property -> device.capabilities.none { it.property == property && it.writable } }) {
      throw DomainException(400, "SECONDARY_SLOT_CAPABILITY_MISMATCH:$slot:${device.id}")
    }
  }
  if (configuration.gateways.isEmpty()) throw DomainException(400, "GATEWAY_REQUIRED")
  val gatewayIds = configuration.gateways.map { it.id }.toSet()
  if (gatewayIds.size != configuration.gateways.size) throw DomainException(400, "DUPLICATE_GATEWAY_ID")
  if (configuration.devices.any { it.integration.gatewayId != null && it.integration.gatewayId !in gatewayIds }) {
    throw DomainException(400, "DEVICE_GATEWAY_NOT_FOUND")
  }
  configuration.scenes.flatMap { it.actions }.forEach {
    if (it.deviceId !in deviceIds) throw DomainException(400, "SCENE_DEVICE_NOT_FOUND:${it.deviceId}")
    val capability = configuration.devices.first { device -> device.id == it.deviceId }.capabilities.firstOrNull { capability -> capability.property == it.property }
    if (capability?.writable != true) throw DomainException(400, "SCENE_CAPABILITY_NOT_WRITABLE:${it.deviceId}.${it.property}")
    capabilityValueError(capability, it.value)?.let { error ->
      throw DomainException(400, "SCENE_VALUE_INVALID:${it.deviceId}.${it.property}:$error")
    }
  }
  configuration.automations.forEach { automation ->
    if (automation.cooldownSeconds !in 1..86_400) throw DomainException(400, "INVALID_AUTOMATION_COOLDOWN")
    val source = configuration.devices.firstOrNull { it.id == automation.condition.deviceId }
      ?: throw DomainException(400, "AUTOMATION_DEVICE_NOT_FOUND:${automation.condition.deviceId}")
    if (source.capabilities.none { it.property == automation.condition.property }) {
      throw DomainException(400, "AUTOMATION_CONDITION_NOT_FOUND:${automation.condition.property}")
    }
    val conditionCapability = source.capabilities.first { it.property == automation.condition.property }
    if (!automationOperatorSupported(conditionCapability, automation.condition.operator, source.state[automation.condition.property])) {
      throw DomainException(400, "AUTOMATION_OPERATOR_INVALID:${automation.condition.deviceId}.${automation.condition.property}")
    }
    capabilityValueError(conditionCapability, automation.condition.value)?.let { error ->
      throw DomainException(
        400,
        "AUTOMATION_CONDITION_VALUE_INVALID:${automation.condition.deviceId}.${automation.condition.property}:$error",
      )
    }
    automation.actions.forEach { action ->
      val target = configuration.devices.firstOrNull { it.id == action.deviceId }
        ?: throw DomainException(400, "AUTOMATION_ACTION_DEVICE_NOT_FOUND:${action.deviceId}")
      val capability = target.capabilities.firstOrNull { it.property == action.property && it.writable }
      if (capability == null) {
        throw DomainException(400, "AUTOMATION_CAPABILITY_NOT_WRITABLE:${action.deviceId}.${action.property}")
      }
      capabilityValueError(capability, action.value)?.let { error ->
        throw DomainException(400, "AUTOMATION_VALUE_INVALID:${action.deviceId}.${action.property}:$error")
      }
    }
  }
  configuration.scenes.firstOrNull { it.enabled && it.actions.isEmpty() }?.let {
    throw DomainException(400, "SCENE_ACTION_REQUIRED:${it.id}")
  }
  configuration.automations.firstOrNull { it.enabled && it.actions.isEmpty() }?.let {
    throw DomainException(400, "AUTOMATION_ACTION_REQUIRED:${it.id}")
  }
  configuration.gateways.forEach {
    if (it.name.isBlank() || it.host.isBlank()) throw DomainException(400, "INVALID_GATEWAY_ADDRESS")
    if (it.port !in 1..65535) throw DomainException(400, "INVALID_GATEWAY_PORT")
    if (!it.credentialRef.startsWith("keystore://")) throw DomainException(400, "GATEWAY_CREDENTIAL_MUST_USE_KEYSTORE_REFERENCE")
  }
}

internal fun validateBenchResetPolicy(policy: BenchResetPolicyDto) {
  if (policy.power !in setOf("off", "unchanged")) throw DomainException(400, "INVALID_BENCH_RESET_POWER_POLICY")
  if (policy.cover !in setOf("closed", "open", "unchanged")) throw DomainException(400, "INVALID_BENCH_RESET_COVER_POLICY")
  if (policy.automationSuppressionSeconds !in 3..30) throw DomainException(400, "INVALID_BENCH_RESET_SUPPRESSION")
}

private fun roomIdFor(name: String, rooms: List<RoomConfigDto>) = rooms.firstOrNull { it.name == name }?.id ?: rooms.first().id

private fun CommandEntity.toDto(json: Json) = CommandDto(
  id, requestId, deviceId, property, json.parseToJsonElement(valueJson), source, status, createdAt, confirmedAt, error,
)

private fun TerminalEntity.toDto() = TerminalDto(id, deviceId, name, role, paired, online, version, address, lastSeenAt)
