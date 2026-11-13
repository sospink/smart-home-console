package cn.zhijing.smartlab.edgecore

import java.time.Instant
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

class BenchResetService(
  private val repository: EdgeRepository,
  private val commands: CommandService,
  private val clock: () -> Instant = Instant::now,
) {
  private val executionMutex = Mutex()
  private val handoverMutex = Mutex()
  private val retained = listOf(
    "审计记录",
    "告警历史与当前告警",
    "设备、场景与网关配置",
    "终端配对与管理员凭据",
  )

  suspend fun preview(): BenchResetPreviewDto {
    val policy = repository.adminConfiguration().benchResetPolicy
    val blockers = buildList {
      if (repository.alerts().any { it.level == "critical" && it.recoveredAt == null }) add("ACTIVE_CRITICAL_ALERT")
      if (repository.commands().any { it.status == "pending" } || repository.executions().any { it.status == "running" }) add("ACTIVE_OPERATION")
    }
    return BenchResetPreviewDto(
      Instant.now().toString(), blockers.isEmpty(), blockers,
      repository.devices().filter { it.kind != "gateway" }.map { previewItem(it, policy) }, retained,
    )
  }

  suspend fun execute(): BenchResetResultDto {
    if (!executionMutex.tryLock()) throw DomainException(409, "BENCH_RESET_IN_PROGRESS")
    try {
      val preview = preview()
      if (preview.blockers.isNotEmpty()) throw DomainException(409, preview.blockers.first())
      val id = "bench-reset-${UUID.randomUUID()}"
      val startedAt = clock().toString()
      val policy = repository.adminConfiguration().benchResetPolicy
      extendSuppressionThroughCommand(policy)
      val results = preview.items.map { item ->
        when (item.disposition) {
          "excluded" -> item.result("excluded")
          "manual-check" -> item.result("manual-check")
          "already-safe" -> item.result("unchanged")
          else -> {
            extendSuppressionThroughCommand(policy)
            executeItem(id, item)
          }
        }
      }
      repository.suppressAutomationsUntil(clock().plusSeconds(policy.automationSuppressionSeconds.toLong()).toString())
      val summary = BenchResetSummaryDto(
        results.count { it.outcome == "confirmed" }, results.count { it.outcome == "unchanged" },
        results.count { it.outcome == "failed" }, results.count { it.outcome == "timeout" },
        results.count { it.outcome == "manual-check" }, results.count { it.outcome == "excluded" },
      )
      val status = when {
        summary.failed + summary.timeout > 0 -> "partial"
        summary.manualCheck > 0 -> "manual-check"
        else -> "completed"
      }
      repository.saveAudit(
        "system", "设备安全复位",
        "确认 ${summary.confirmed}，已在安全状态 ${summary.unchanged}，失败 ${summary.failed + summary.timeout}，人工核对 ${summary.manualCheck}；告警与审计记录保留",
        "admin", if (status == "completed") "success" else "failed",
      )
      return BenchResetResultDto(id, status, startedAt, clock().toString(), results, summary, retained)
    } finally {
      executionMutex.unlock()
    }
  }

  suspend fun handoverChecklist(): HandoverChecklistDto {
    val reset = preview()
    val config = repository.adminConfiguration()
    val alerts = repository.alerts()
    val devices = repository.devices()
    val terminals = config.terminals.filter { it.paired }
    val summary = HandoverSummaryDto(
      activeCriticalAlerts = alerts.count { it.level == "critical" && it.recoveredAt == null },
      activeWarnings = alerts.count { it.level != "critical" && it.recoveredAt == null },
      offlineGateways = devices.count { it.kind == "gateway" && it.health != "online" },
      offlineDevices = devices.count { it.kind != "gateway" && it.health != "online" },
      pendingOperations = repository.commands().count { it.status == "pending" } + repository.executions().count { it.status == "running" },
      pairedTerminals = terminals.size,
      onlineTerminals = terminals.count { it.online },
      baselineReady = reset.items.count { it.disposition in setOf("already-safe", "excluded") },
      baselineManualCheck = reset.items.count { it.disposition == "manual-check" },
      baselineNotReady = reset.items.count { it.disposition == "ready" },
    )
    val blockers = buildList {
      if (summary.activeCriticalAlerts > 0) add("ACTIVE_CRITICAL_ALERT")
      if (summary.pendingOperations > 0) add("ACTIVE_OPERATION")
      if (summary.offlineGateways > 0) add("OFFLINE_GATEWAY")
      if (summary.baselineNotReady > 0) add("BENCH_NOT_RESET")
    }
    val warnings = buildList {
      if (summary.activeWarnings > 0) add("ACTIVE_NONCRITICAL_ALERTS")
      if (summary.offlineDevices > 0) add("OFFLINE_DEVICES")
      if (summary.baselineManualCheck > 0) add("MANUAL_BASELINE_CHECK")
      if (summary.onlineTerminals < summary.pairedTerminals) add("PAIRED_TERMINALS_OFFLINE")
    }
    val tokenMaterial = listOf(blockers.joinToString(","), warnings.joinToString(","), summary.toString()).joinToString("|")
    val stateToken = MessageDigest.getInstance("SHA-256").digest(tokenMaterial.toByteArray())
      .joinToString("") { "%02x".format(it) }
    return HandoverChecklistDto(clock().toString(), stateToken, blockers.isEmpty(), blockers, warnings, summary, repository.latestHandover())
  }

  suspend fun completeHandover(request: HandoverCompleteRequestDto): HandoverCompletionDto = handoverMutex.withLock {
    if (!request.completionId.matches(Regex("[A-Za-z0-9_-]{8,80}"))) throw DomainException(400, "INVALID_HANDOVER_COMPLETION_ID")
    repository.handoverById(request.completionId)?.let { return it }
    val current = handoverChecklist()
    if (!MessageDigest.isEqual(request.stateToken.toByteArray(), current.stateToken.toByteArray()))
      throw DomainException(409, "HANDOVER_STATE_CHANGED")
    if (current.blockers.isNotEmpty()) throw DomainException(409, current.blockers.first())
    val acknowledged = request.acknowledgedWarnings.distinct()
    if (current.warnings.any { it !in acknowledged }) throw DomainException(409, "HANDOVER_WARNINGS_UNACKNOWLEDGED")
    if (acknowledged.any { it !in current.warnings }) throw DomainException(400, "INVALID_HANDOVER_WARNING")
    val note = request.note.trim()
    if (note.length > 200) throw DomainException(400, "INVALID_HANDOVER_NOTE")
    val completedBy = request.completedBy.trim()
    if (completedBy.length !in 2..40) throw DomainException(400, "INVALID_HANDOVER_OPERATOR")
    val completedAt = clock().toString()
    val completion = HandoverCompletionDto(
      request.completionId, completedAt, completedBy, current.stateToken, acknowledged, note, current.summary,
    )
    repository.saveHandover(
      completion,
      "检查人 $completedBy；风险确认 ${acknowledged.joinToString(",").ifBlank { "无" }}；${if (note.isNotBlank()) "备注 $note；" else ""}安全状态 ${current.summary.baselineReady}，人工核对 ${current.summary.baselineManualCheck}，终端 ${current.summary.onlineTerminals}/${current.summary.pairedTerminals} 在线",
    )
    completion
  }

  /**
   * Keep automation suppression alive for the whole current command, not merely for a fixed window
   * measured from the beginning of a potentially long serial reset. The extra command timeout also
   * leaves a bounded fail-safe window if EdgeCore exits before the normal post-reset deadline is saved.
   */
  private suspend fun extendSuppressionThroughCommand(policy: BenchResetPolicyDto) {
    val commandSeconds = (CommandService.COMMAND_TIMEOUT_MILLIS + 999) / 1_000
    repository.suppressAutomationsUntil(
      clock().plusSeconds(commandSeconds + policy.automationSuppressionSeconds.toLong()).toString(),
    )
  }

  private fun previewItem(device: DeviceDto, policy: BenchResetPolicyDto): BenchResetItemDto {
    fun item(property: String?, target: JsonElement?, disposition: String, reason: String) =
      BenchResetItemDto(device.id, device.name, device.room, property, target, disposition, reason)
    val target = targetFor(device, policy)
      ?: return item(
        null, null, "excluded",
        if (device.kind == "lock") "门锁只读，安全复位禁止主动开锁或改锁态"
        else if ((policy.power == "unchanged" && device.kind in setOf("light", "media", "switch", "panel")) ||
          (policy.cover == "unchanged" && device.kind == "cover")) "交接策略设为保持现状"
        else "只读或不属于安全基线",
      )
    if (device.health != "online") return item(target.first, target.second, "manual-check", "设备离线，需现场核对")
    if (device.state[target.first] == target.second) return item(target.first, target.second, "already-safe", "已处于安全基线")
    return item(target.first, target.second, "ready", "将通过正常命令链路复位")
  }

  private fun targetFor(device: DeviceDto, policy: BenchResetPolicyDto): Pair<String, JsonElement>? {
    if (policy.power == "unchanged" && device.kind in setOf("light", "media", "switch", "panel")) return null
    if (device.kind in setOf("light", "media", "switch", "panel") && device.capabilities.any { it.property == "power" && it.writable }) {
      return "power" to JsonPrimitive(false)
    }
    if (policy.cover == "unchanged" && device.kind == "cover") return null
    if (device.kind == "cover" && device.capabilities.any { it.property == "position" && it.writable })
      return "position" to JsonPrimitive(if (policy.cover == "open") 100 else 0)
    return null
  }

  private suspend fun executeItem(resetId: String, item: BenchResetItemDto): BenchResetResultItemDto = try {
    val command = commands.execute(
      item.deviceId,
      CommandRequestDto("$resetId:${item.deviceId}:${item.property}", item.property!!, item.targetValue!!, "admin"),
    )
    item.result(if (command.status == "confirmed") "confirmed" else command.status, command)
  } catch (error: Throwable) {
    item.copy(reason = error.message ?: "复位命令失败").result("failed")
  }

  private fun BenchResetItemDto.result(outcome: String, command: CommandDto? = null) = BenchResetResultItemDto(
    deviceId, deviceName, room, property, targetValue, disposition, reason, outcome, command,
  )
}
