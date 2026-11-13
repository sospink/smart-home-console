package cn.zhijing.smartlab.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert

@Dao
interface EdgeDao {
  @Query("SELECT * FROM gateways ORDER BY id") suspend fun gateways(): List<GatewayEntity>
  @Query("SELECT * FROM rooms WHERE enabled = 1 ORDER BY sortOrder") suspend fun rooms(): List<RoomEntity>
  @Query("SELECT * FROM rooms ORDER BY sortOrder") suspend fun allRooms(): List<RoomEntity>
  @Query("SELECT * FROM devices ORDER BY roomName, name") suspend fun devices(): List<DeviceEntity>
  @Query("SELECT * FROM capabilities ORDER BY deviceId, property") suspend fun capabilities(): List<CapabilityEntity>
  @Query("SELECT * FROM device_states ORDER BY deviceId, property") suspend fun states(): List<DeviceStateEntity>
  @Query("SELECT * FROM device_states WHERE deviceId = :deviceId AND property = :property LIMIT 1") suspend fun state(deviceId: String, property: String): DeviceStateEntity?
  @Query("SELECT * FROM scenes WHERE enabled = 1 ORDER BY name") suspend fun scenes(): List<SceneEntity>
  @Query("SELECT * FROM scenes ORDER BY name") suspend fun allScenes(): List<SceneEntity>
  @Query("SELECT * FROM scene_actions ORDER BY sceneId, sortOrder") suspend fun sceneActions(): List<SceneActionEntity>
  @Query("SELECT * FROM commands ORDER BY createdAt DESC LIMIT :limit") suspend fun commands(limit: Int = 100): List<CommandEntity>
  @Query("SELECT * FROM scene_executions ORDER BY startedAt DESC LIMIT :limit") suspend fun executions(limit: Int = 100): List<SceneExecutionEntity>
  @Query("SELECT * FROM alerts ORDER BY occurredAt DESC LIMIT :limit") suspend fun alerts(limit: Int = 100): List<AlertEntity>
  @Query("SELECT * FROM audit_logs ORDER BY occurredAt DESC LIMIT :limit") suspend fun audits(limit: Int = 500): List<AuditEntity>
  @Query("SELECT * FROM handover_records ORDER BY completedAt DESC, id DESC LIMIT 1") suspend fun latestHandover(): HandoverRecordEntity?
  @Query("SELECT * FROM handover_records WHERE id = :id LIMIT 1") suspend fun handoverById(id: String): HandoverRecordEntity?
  @Query("""
    SELECT COUNT(*) FROM audit_logs
    WHERE (:q = '' OR action LIKE '%' || :q || '%' COLLATE NOCASE OR detail LIKE '%' || :q || '%' COLLATE NOCASE
      OR source LIKE '%' || :q || '%' COLLATE NOCASE OR category LIKE '%' || :q || '%' COLLATE NOCASE
      OR result LIKE '%' || :q || '%' COLLATE NOCASE)
      AND (:status = '' OR :status = 'all' OR result = :status OR category = :status)
  """)
  suspend fun auditQueryCount(q: String, status: String): Int
  @Query("""
    SELECT * FROM audit_logs
    WHERE (:q = '' OR action LIKE '%' || :q || '%' COLLATE NOCASE OR detail LIKE '%' || :q || '%' COLLATE NOCASE
      OR source LIKE '%' || :q || '%' COLLATE NOCASE OR category LIKE '%' || :q || '%' COLLATE NOCASE
      OR result LIKE '%' || :q || '%' COLLATE NOCASE)
      AND (:status = '' OR :status = 'all' OR result = :status OR category = :status)
    ORDER BY occurredAt DESC, id DESC LIMIT :limit OFFSET :offset
  """)
  suspend fun auditQuery(q: String, status: String, limit: Int, offset: Int): List<AuditEntity>
  @Query("SELECT * FROM terminals ORDER BY name") suspend fun terminals(): List<TerminalEntity>
  @Query("SELECT * FROM automations ORDER BY name") suspend fun automations(): List<AutomationEntity>
  @Query("SELECT COUNT(*) FROM commands") suspend fun commandCount(): Long
  @Query("SELECT MIN(createdAt) FROM commands") suspend fun oldestCommandAt(): String?
  @Query("SELECT COUNT(*) FROM scene_executions") suspend fun executionCount(): Long
  @Query("SELECT MIN(startedAt) FROM scene_executions") suspend fun oldestExecutionAt(): String?
  @Query("SELECT COUNT(*) FROM alerts") suspend fun alertCount(): Long
  @Query("SELECT MIN(occurredAt) FROM alerts") suspend fun oldestAlertAt(): String?
  @Query("SELECT COUNT(*) FROM audit_logs") suspend fun auditCount(): Long
  @Query("SELECT MIN(occurredAt) FROM audit_logs") suspend fun oldestAuditAt(): String?

  @Upsert suspend fun putGateway(value: GatewayEntity)
  @Upsert suspend fun putRoom(value: RoomEntity)
  @Upsert suspend fun putDevice(value: DeviceEntity)
  @Upsert suspend fun putCapabilities(values: List<CapabilityEntity>)
  @Query("DELETE FROM capabilities WHERE deviceId = :deviceId") suspend fun clearDeviceCapabilities(deviceId: String)
  @Upsert suspend fun putState(value: DeviceStateEntity)
  @Upsert suspend fun putScene(value: SceneEntity)
  @Upsert suspend fun putSceneActions(values: List<SceneActionEntity>)
  @Upsert suspend fun putCommand(value: CommandEntity)
  @Upsert suspend fun putExecution(value: SceneExecutionEntity)
  @Upsert suspend fun putAlert(value: AlertEntity)
  @Upsert suspend fun putAudit(value: AuditEntity)
  @Upsert suspend fun putHandover(value: HandoverRecordEntity)
  @Upsert suspend fun putTerminal(value: TerminalEntity)
  @Upsert suspend fun putAutomation(value: AutomationEntity)
  @Upsert suspend fun putMeta(value: ConfigurationMetaEntity)

  @Query("SELECT EXISTS(SELECT 1 FROM scenes WHERE id = 'scene-training')") suspend fun hasLegacyTrainingScene(): Boolean
  @Query("DELETE FROM scene_actions WHERE sceneId = 'scene-training'") suspend fun clearLegacyTrainingSceneActions()
  @Query("DELETE FROM scenes WHERE id = 'scene-training'") suspend fun clearLegacyTrainingScene()

  /**
   * v0.1.0 以前把一个教学演示误当成默认家居场景。启动时只迁移这一条稳定旧 ID，
   * 不覆盖管理员创建或编辑的其他场景；动作仍由真实设备状态机确认。
   */
  @Transaction
  suspend fun migrateLegacyTrainingScene() {
    if (!hasLegacyTrainingScene()) return
    clearLegacyTrainingSceneActions()
    clearLegacyTrainingScene()
    putScene(SceneEntity("scene-movie", "观影", "窗帘闭合，灯带与音乐营造观影氛围", "violet", true, "serial", null))
    putSceneActions(
      listOf(
        SceneActionEntity("movie-1", "scene-movie", 1, "living-main-light", "power", "false", "关闭客厅主灯"),
        SceneActionEntity("movie-2", "scene-movie", 2, "ambient-strip", "power", "true", "打开氛围灯带"),
        SceneActionEntity("movie-3", "scene-movie", 3, "curtain-c3", "position", "0", "关闭窗帘"),
        SceneActionEntity("movie-4", "scene-movie", 4, "music-r11", "power", "true", "启动背景音乐"),
      )
    )
  }

  @Transaction
  suspend fun putHandoverWithAudit(handover: HandoverRecordEntity, audit: AuditEntity) {
    putHandover(handover)
    putAudit(audit)
  }

  @Query("SELECT * FROM configuration_meta WHERE id = 'current' LIMIT 1") suspend fun meta(): ConfigurationMetaEntity?
  @Query("SELECT * FROM commands WHERE requestId = :requestId LIMIT 1") suspend fun commandByRequest(requestId: String): CommandEntity?
  @Query("SELECT * FROM devices WHERE gatewayId = :gatewayId AND externalId = :externalId LIMIT 1") suspend fun deviceByExternalId(gatewayId: String, externalId: String): DeviceEntity?
  @Query("SELECT * FROM terminals WHERE deviceId = :deviceId LIMIT 1") suspend fun terminalByDevice(deviceId: String): TerminalEntity?
  @Query("SELECT * FROM terminals WHERE tokenRef = :tokenHash AND paired = 1 LIMIT 1") suspend fun terminalByTokenHash(tokenHash: String): TerminalEntity?
  @Query("SELECT tokenRef FROM terminals WHERE deviceId = :deviceId AND paired = 1 AND tokenRef != '' LIMIT 1")
  suspend fun terminalProofReference(deviceId: String): String?
  @Query("SELECT * FROM alerts WHERE deviceId = :deviceId AND title = :title AND recoveredAt IS NULL ORDER BY occurredAt DESC LIMIT 1") suspend fun openAlert(deviceId: String, title: String): AlertEntity?
  @Query("UPDATE alerts SET acknowledgedAt = :at WHERE id = :id") suspend fun acknowledgeAlert(id: String, at: String)
  @Query("UPDATE alerts SET recoveredAt = :at WHERE id = :id") suspend fun recoverAlert(id: String, at: String)
  @Query("UPDATE terminals SET online = :online, address = :address, version = CASE WHEN :version = '' THEN version ELSE :version END, lastSeenAt = :at WHERE id = :id AND paired = 1")
  suspend fun touchTerminal(id: String, online: Boolean, address: String, version: String, at: String)
  @Query("UPDATE terminals SET address = :address, version = CASE WHEN :version = '' THEN version ELSE :version END, lastSeenAt = :at WHERE id = :id")
  suspend fun updateTerminalContact(id: String, address: String, version: String, at: String)
  @Query("UPDATE terminals SET online = :online WHERE id = :id") suspend fun setTerminalOnline(id: String, online: Boolean)
  @Query("UPDATE terminals SET paired = 0, online = 0, tokenRef = '' WHERE id = :id AND role != 'primary'")
  suspend fun revokeTerminal(id: String): Int
  @Query("UPDATE gateways SET lastTestOk = :ok, lastTestMessage = :message, lastTestAt = :at WHERE id = :id") suspend fun saveGatewayTest(id: String, ok: Boolean, message: String, at: String)
  @Query("UPDATE automations SET lastTriggeredAt = :at WHERE id = :id") suspend fun markAutomationTriggered(id: String, at: String)
  @Query("UPDATE configuration_meta SET automationSuppressedUntil = :until WHERE id = 'current'")
  suspend fun suppressAutomationsUntil(until: String)

  @Query("SELECT * FROM commands WHERE status = 'pending'") suspend fun pendingCommands(): List<CommandEntity>
  @Query("SELECT * FROM scene_executions WHERE status = 'running'") suspend fun runningExecutions(): List<SceneExecutionEntity>
  @Query("SELECT * FROM terminals WHERE online = 1") suspend fun onlineTerminals(): List<TerminalEntity>
  @Query("UPDATE commands SET status = 'timeout', error = :error WHERE status = 'pending'")
  suspend fun timeoutPendingCommands(error: String)
  @Query("UPDATE scene_executions SET status = CASE WHEN completedActions > 0 THEN 'partial' ELSE 'failed' END, finishedAt = :at WHERE status = 'running'")
  suspend fun closeRunningExecutions(at: String)
  @Query("UPDATE terminals SET online = 0 WHERE online = 1") suspend fun markOnlineTerminalsOffline()
  @Query("SELECT COUNT(*) FROM gateways WHERE health != 'offline'") suspend fun nonOfflineGatewayCount(): Int
  @Query("SELECT COUNT(*) FROM devices WHERE health != 'offline'") suspend fun nonOfflineDeviceCount(): Int
  @Query("UPDATE gateways SET health = 'offline', updatedAt = :at WHERE health != 'offline'") suspend fun invalidateGatewayHealth(at: String)
  @Query("UPDATE devices SET health = 'offline', updatedAt = :at WHERE health != 'offline'") suspend fun invalidateDeviceHealth(at: String)
  @Query("UPDATE gateways SET health = :health, updatedAt = :at WHERE id = :gatewayId")
  suspend fun updateGatewayHealth(gatewayId: String, health: String, at: String)
  @Query("UPDATE devices SET health = :health, updatedAt = :at WHERE id = :gatewayId")
  suspend fun updateGatewayDeviceHealth(gatewayId: String, health: String, at: String)
  @Query("UPDATE devices SET health = 'offline', updatedAt = :at WHERE gatewayId = :gatewayId AND health != 'offline'")
  suspend fun markGatewayChildrenOffline(gatewayId: String, at: String)

  @Query("UPDATE gateways SET host = :baseUrl, port = :port, firmware = '1.0.8_0013', mode = 'ha-cloud', health = 'offline', updatedAt = :at WHERE id = 'gateway-main'")
  suspend fun bindHomeAssistantGateway(baseUrl: String, port: Int, at: String)

  @Query("UPDATE devices SET externalId = :entityId, internalModel = 'lumi.gateway.mcn001', verificationStatus = 'hardware-verified', note = 'HA 官方 Xiaomi Home 云端接入；不是 DMWG03LM 本地控制。', health = 'offline', updatedAt = :at WHERE id = 'gateway-main'")
  suspend fun bindHomeAssistantGatewayDevice(entityId: String, at: String)

  @Query("UPDATE devices SET externalId = :entityId, name = '筒灯', roomId = 'bedroom', roomName = '卧室', marketModel = 'xiaomi.light.btlm2', internalModel = 'xiaomi.light.btlm2', protocol = 'ble-mesh', gatewayId = 'gateway-main', verificationStatus = 'hardware-verified', note = 'HA 实体动态提供开关、亮度、色温范围与灯效；状态写入必须经过设备确认。', health = 'offline', updatedAt = :at WHERE id = 'living-main-light'")
  suspend fun bindHomeAssistantMvpLight(entityId: String, at: String)

  @Transaction
  suspend fun activateHomeAssistantMvp(baseUrl: String, gatewayEntityId: String, lightEntityId: String, at: String) {
    val port = runCatching { java.net.URI(baseUrl).port }.getOrDefault(-1).takeIf { it > 0 }
      ?: if (baseUrl.startsWith("https://")) 443 else 80
    bindHomeAssistantGateway(baseUrl, port, at)
    bindHomeAssistantGatewayDevice(gatewayEntityId, at)
    bindHomeAssistantMvpLight(lightEntityId, at)
  }

  @Transaction
  suspend fun replaceDeviceCapabilities(deviceId: String, capabilities: List<CapabilityEntity>) {
    clearDeviceCapabilities(deviceId)
    putCapabilities(capabilities)
  }

  @Query("DELETE FROM scene_actions") suspend fun clearSceneActions()
  @Query("DELETE FROM scenes") suspend fun clearScenes()
  @Query("DELETE FROM automations") suspend fun clearAutomations()
  @Query("DELETE FROM capabilities") suspend fun clearCapabilities()
  @Query("DELETE FROM device_states") suspend fun clearStates()
  @Query("DELETE FROM devices") suspend fun clearDevices()
  @Query("DELETE FROM gateways") suspend fun clearGateways()
  @Query("DELETE FROM rooms") suspend fun clearRooms()
  @Query("DELETE FROM terminals") suspend fun clearTerminals()
  @Transaction
  suspend fun nextSequence(): Long {
    val current = meta() ?: ConfigurationMetaEntity(version = 1, updatedAt = java.time.Instant.now().toString())
    val next = current.eventSequence + 1
    putMeta(current.copy(eventSequence = next, updatedAt = java.time.Instant.now().toString()))
    return next
  }

  /**
   * 在服务对外监听前原子收口上一次进程遗留的瞬时状态。
   * 这里不推断设备最终状态；pending 只表示回执丢失，因此统一归为 timeout。
   */
  @Transaction
  suspend fun recoverInterruptedRuntime(at: String, commandError: String): RuntimeRecoveryCounts {
    val pending = pendingCommands()
    val running = runningExecutions()
    val online = onlineTerminals()
    val staleGateways = nonOfflineGatewayCount()
    val staleDevices = nonOfflineDeviceCount()
    timeoutPendingCommands(commandError)
    closeRunningExecutions(at)
    markOnlineTerminalsOffline()
    invalidateGatewayHealth(at)
    invalidateDeviceHealth(at)
    return RuntimeRecoveryCounts(
      timedOutCommands = pending.size,
      failedExecutions = running.count { it.completedActions == 0 },
      partialExecutions = running.count { it.completedActions > 0 },
      offlineTerminals = online.size,
      invalidatedGateways = staleGateways,
      invalidatedDevices = staleDevices,
    )
  }

  @Transaction
  suspend fun replaceConfiguration(
    rooms: List<RoomEntity>,
    gateways: List<GatewayEntity>,
    devices: List<DeviceEntity>,
    capabilities: List<CapabilityEntity>,
    states: List<DeviceStateEntity>,
    scenes: List<SceneEntity>,
    sceneActions: List<SceneActionEntity>,
    automations: List<AutomationEntity>,
    terminals: List<TerminalEntity>,
    meta: ConfigurationMetaEntity,
  ) {
    clearSceneActions()
    clearScenes()
    clearAutomations()
    clearCapabilities()
    clearStates()
    clearDevices()
    clearGateways()
    clearRooms()
    clearTerminals()
    rooms.forEach { putRoom(it) }
    gateways.forEach { putGateway(it) }
    devices.forEach { putDevice(it) }
    putCapabilities(capabilities)
    states.forEach { putState(it) }
    scenes.forEach { putScene(it) }
    putSceneActions(sceneActions)
    automations.forEach { putAutomation(it) }
    terminals.forEach { putTerminal(it) }
    putMeta(meta)
  }

  @Transaction
  suspend fun seedIfEmpty(seed: DatabaseSeed) {
    if (meta() != null) return
    seed.gateways.forEach { putGateway(it) }
    seed.rooms.forEach { putRoom(it) }
    seed.devices.forEach { putDevice(it) }
    putCapabilities(seed.capabilities)
    seed.states.forEach { putState(it) }
    seed.scenes.forEach { putScene(it) }
    putSceneActions(seed.sceneActions)
    seed.alerts.forEach { putAlert(it) }
    putMeta(ConfigurationMetaEntity(version = 1, updatedAt = seed.createdAt))
  }
}

data class DatabaseSeed(
  val createdAt: String,
  val gateways: List<GatewayEntity>,
  val rooms: List<RoomEntity>,
  val devices: List<DeviceEntity>,
  val capabilities: List<CapabilityEntity>,
  val states: List<DeviceStateEntity>,
  val scenes: List<SceneEntity>,
  val sceneActions: List<SceneActionEntity>,
  val alerts: List<AlertEntity> = emptyList(),
)

data class RuntimeRecoveryCounts(
  val timedOutCommands: Int,
  val failedExecutions: Int,
  val partialExecutions: Int,
  val offlineTerminals: Int,
  val invalidatedGateways: Int,
  val invalidatedDevices: Int,
)
