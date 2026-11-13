package cn.zhijing.smartlab.edgecore

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlin.math.abs
import kotlin.math.round

@Serializable
data class CapabilityOptionDto(
  val label: String,
  val value: JsonElement,
)

@Serializable data class Envelope<T>(val data: T, val sequence: Long)

@Serializable
data class DeviceCapabilityDto(
  val property: String,
  val label: String,
  val type: String,
  val min: Double? = null,
  val max: Double? = null,
  val step: Double? = null,
  val unit: String? = null,
  val writable: Boolean,
  val options: List<CapabilityOptionDto>? = null,
)

internal fun capabilityValueError(capability: DeviceCapabilityDto, value: JsonElement): String? {
  val primitive = value as? JsonPrimitive
  if (capability.type == "boolean") return if (primitive?.isString == false && primitive.booleanOrNull != null) null else "TYPE"
  if (capability.type == "number") {
    val number = primitive?.takeUnless { it.isString }?.doubleOrNull ?: return "TYPE"
    if (!number.isFinite()) return "TYPE"
    if (capability.min != null && number < capability.min) return "MIN"
    if (capability.max != null && number > capability.max) return "MAX"
    if (capability.step != null && capability.step > 0) {
      val steps = (number - (capability.min ?: 0.0)) / capability.step
      if (abs(steps - round(steps)) > 1e-9) return "STEP"
    }
    return null
  }
  if (capability.type == "enum" || capability.type == "action") {
    return if (capability.options?.any { it.value == value } == true) null else "OPTION"
  }
  return null
}

internal fun automationOperatorSupported(capability: DeviceCapabilityDto, operator: String, currentValue: JsonElement?): Boolean {
  val numeric = capability.type == "number" || (currentValue as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull != null
  return numeric || operator == "eq" || operator == "neq"
}

@Serializable
data class DeviceIntegrationDto(
  val adapter: String,
  val externalId: String? = null,
  val marketModel: String? = null,
  val internalModel: String? = null,
  val protocol: String,
  val gatewayId: String? = null,
  val verificationStatus: String,
  val note: String? = null,
)

@Serializable
data class DeviceDisplayDto(
  val icon: String? = null,
  val order: Int = 0,
  val hidden: Boolean = false,
  val favorite: Boolean = false,
  val secondarySlot: String? = null,
)

@Serializable
data class DeviceDto(
  val id: String,
  val name: String,
  val room: String,
  val kind: String,
  val health: String,
  val updatedAt: String,
  val state: Map<String, JsonElement>,
  val capabilities: List<DeviceCapabilityDto>,
  val integration: DeviceIntegrationDto,
  val display: DeviceDisplayDto = DeviceDisplayDto(),
)

@Serializable
data class SceneActionDto(
  val id: String,
  val deviceId: String,
  val property: String,
  val value: JsonElement,
  val label: String,
)

@Serializable
data class SceneDto(
  val id: String,
  val name: String,
  val description: String,
  val tone: String,
  val actions: List<SceneActionDto>,
  val lastExecutedAt: String? = null,
  val enabled: Boolean = true,
  val strategy: String = "serial",
)

@Serializable
data class AlertDto(
  val id: String,
  val deviceId: String,
  val level: String,
  val title: String,
  val message: String,
  val occurredAt: String,
  val acknowledgedAt: String? = null,
  val recoveredAt: String? = null,
  val recoveryProperty: String? = null,
  val recoveryValue: JsonElement? = null,
)

@Serializable
data class CommandRequestDto(
  val requestId: String,
  val property: String,
  val value: JsonElement,
  val source: String,
)

@Serializable
data class CommandDto(
  val id: String,
  val requestId: String,
  val deviceId: String,
  val property: String,
  val value: JsonElement,
  val source: String,
  val status: String,
  val createdAt: String,
  val confirmedAt: String? = null,
  val error: String? = null,
)

@Serializable
data class SceneExecutionDto(
  val id: String,
  val sceneId: String,
  val source: String,
  val status: String,
  val completedActions: Int,
  val totalActions: Int,
  val startedAt: String,
  val finishedAt: String? = null,
)

data class RuntimeRecoveryResult(
  val timedOutCommands: Int,
  val failedExecutions: Int,
  val partialExecutions: Int,
  val offlineTerminals: Int,
  val invalidatedGateways: Int = 0,
  val invalidatedDevices: Int = 0,
) {
  val changed: Boolean
    get() = timedOutCommands + failedExecutions + partialExecutions + offlineTerminals + invalidatedGateways + invalidatedDevices > 0
}

@Serializable
data class GatewayHealthDto(
  val id: String,
  val name: String,
  val model: String,
  val firmware: String,
  val status: String,
  val latencyMs: Long,
  val lastHeartbeatAt: String,
  val mode: String,
)

@Serializable
data class SystemHealthDto(
  val controlDomainId: String,
  val mode: String,
  val version: String,
  val serverTime: String,
  val uptimeSeconds: Long,
  val gateways: List<GatewayHealthDto>,
)

@Serializable
data class SystemSnapshotDto(
  val sequence: Long,
  val devices: List<DeviceDto>,
  val scenes: List<SceneDto>,
  val alerts: List<AlertDto>,
  val commands: List<CommandDto>,
  val executions: List<SceneExecutionDto>,
  val health: SystemHealthDto,
)

@Serializable
data class EdgeEventDto(
  val type: String,
  val sequence: Long,
  val payload: JsonElement,
)

@Serializable data class ErrorDto(val error: String)
@Serializable data class SceneExecuteRequestDto(val source: String)
@Serializable data class AlertAcknowledgeRequestDto(val source: String = "primary")

@Serializable
data class TerminalDto(
  val id: String,
  val deviceId: String,
  val name: String,
  val role: String,
  val paired: Boolean,
  val online: Boolean,
  val version: String,
  val address: String,
  val lastSeenAt: String,
)

@Serializable
data class PairTerminalRequestDto(
  val pairingCode: String,
  val deviceId: String,
  val name: String,
  val role: String,
  val version: String,
)

@Serializable data class PairTerminalResponseDto(
  val token: String,
  val terminal: TerminalDto,
  val controlDomainId: String,
  /** 配对时交给副屏的控制域证明密钥；仅由副屏 Keystore 密文保存。 */
  val controlDomainProofKey: String,
)
@Serializable data class ControlDomainChallengeRequestDto(val deviceId: String, val nonce: String, val clientProof: String)
@Serializable data class ControlDomainChallengeResponseDto(val controlDomainId: String, val nonce: String, val proof: String)
@Serializable data class AdminLoginRequestDto(val pin: String)
@Serializable data class AdminSessionDto(val token: String, val expiresAt: String, val mustChangePin: Boolean = false)
@Serializable data class AdminPinChangeRequestDto(val currentPin: String, val newPin: String, val confirmPin: String)
@Serializable data class PairingCodeDto(val code: String)
@Serializable data class EventTicketDto(val ticket: String, val expiresAt: String)

@Serializable
data class BenchResetItemDto(
  val deviceId: String,
  val deviceName: String,
  val room: String,
  val property: String? = null,
  val targetValue: JsonElement? = null,
  val disposition: String,
  val reason: String,
)

@Serializable
data class BenchResetPreviewDto(
  val generatedAt: String,
  val canExecute: Boolean,
  val blockers: List<String>,
  val items: List<BenchResetItemDto>,
  val retained: List<String>,
)

@Serializable
data class BenchResetResultItemDto(
  val deviceId: String,
  val deviceName: String,
  val room: String,
  val property: String? = null,
  val targetValue: JsonElement? = null,
  val disposition: String,
  val reason: String,
  val outcome: String,
  val command: CommandDto? = null,
)

@Serializable
data class BenchResetSummaryDto(
  val confirmed: Int,
  val unchanged: Int,
  val failed: Int,
  val timeout: Int,
  val manualCheck: Int,
  val excluded: Int,
)

@Serializable
data class BenchResetResultDto(
  val id: String,
  val status: String,
  val startedAt: String,
  val finishedAt: String,
  val items: List<BenchResetResultItemDto>,
  val summary: BenchResetSummaryDto,
  val retained: List<String>,
)

@Serializable data class HandoverSummaryDto(
  val activeCriticalAlerts: Int,
  val activeWarnings: Int,
  val offlineGateways: Int,
  val offlineDevices: Int,
  val pendingOperations: Int,
  val pairedTerminals: Int,
  val onlineTerminals: Int,
  val baselineReady: Int,
  val baselineManualCheck: Int,
  val baselineNotReady: Int,
)
@Serializable data class HandoverChecklistDto(
  val generatedAt: String,
  val stateToken: String,
  val canComplete: Boolean,
  val blockers: List<String>,
  val warnings: List<String>,
  val summary: HandoverSummaryDto,
  val lastCompletion: HandoverCompletionDto? = null,
)
@Serializable data class HandoverCompleteRequestDto(
  val completionId: String,
  val completedBy: String,
  val stateToken: String,
  val acknowledgedWarnings: List<String> = emptyList(),
  val note: String = "",
)
@Serializable data class HandoverCompletionDto(
  val id: String,
  val completedAt: String,
  val completedBy: String,
  val stateToken: String,
  val acknowledgedWarnings: List<String>,
  val note: String,
  val summary: HandoverSummaryDto,
)

@Serializable
data class AuditDto(
  val id: String,
  val category: String,
  val action: String,
  val detail: String,
  val source: String,
  val result: String,
  val occurredAt: String,
)

@Serializable
data class AuditPageDto(
  val items: List<AuditDto>,
  val page: Int,
  val pageSize: Int,
  val total: Int,
  val totalPages: Int,
)

@Serializable data class RoomConfigDto(val id: String, val name: String, val order: Int, val enabled: Boolean)

@Serializable
data class AutomationConditionDto(
  val deviceId: String,
  val property: String,
  val operator: String,
  val value: JsonElement,
)

@Serializable
data class AutomationDto(
  val id: String,
  val name: String,
  val enabled: Boolean,
  val condition: AutomationConditionDto,
  val actions: List<SceneActionDto>,
  val cooldownSeconds: Int,
  val lastTriggeredAt: String? = null,
)

@Serializable
data class GatewayTestDto(val ok: Boolean, val message: String, val testedAt: String)

@Serializable
data class GatewayConfigDto(
  val id: String,
  val name: String,
  val host: String,
  val port: Int,
  val credentialRef: String,
  val mode: String,
  val lastTest: GatewayTestDto? = null,
)

@Serializable
data class AdminConfigurationDto(
  val version: Int,
  val exportedAt: String? = null,
  val rooms: List<RoomConfigDto>,
  val devices: List<DeviceDto>,
  val scenes: List<SceneDto>,
  val automations: List<AutomationDto>,
  val gateways: List<GatewayConfigDto>,
  val terminals: List<TerminalDto>,
  val benchResetPolicy: BenchResetPolicyDto = BenchResetPolicyDto(),
)

@Serializable
data class BenchResetPolicyDto(
  val power: String = "off",
  val cover: String = "closed",
  val automationSuppressionSeconds: Int = 8,
)

@Serializable
data class DiagnosticBundleDto(
  val generatedAt: String,
  val appVersion: String,
  val databaseVersion: Int,
  val eventSequence: Long,
  val health: SystemHealthDto,
  val logs: List<String>,
  val databaseBackups: List<String>,
)

@Serializable
data class DatabaseBackupArtifactDto(
  val filename: String,
  val createdAt: String,
  val sizeBytes: Long,
  val sha256: String,
  val integrityStatus: String,
  val schemaVersion: Int? = null,
  val verifiedAt: String,
)

@Serializable
data class DatabaseBackupStorageDto(
  val totalBytes: Long,
  val usableBytes: Long,
  val reserveBytes: Long,
  val estimatedNextBackupBytes: Long,
  val canCreate: Boolean,
  val level: String,
  val message: String,
)

@Serializable
data class DataDomainFootprintDto(
  val id: String,
  val label: String,
  val records: Long,
  val oldestAt: String? = null,
  val protection: String,
  val automaticDeletion: Boolean = false,
  val guidance: String,
)

@Serializable
data class DataLifecycleReportDto(
  val generatedAt: String,
  val databaseBytes: Long,
  val usableBytes: Long,
  val reserveBytes: Long,
  val growthBytesPerDay: Long? = null,
  val estimatedDaysToReserve: Int? = null,
  val trendSamples: Int,
  val level: String,
  val message: String,
  val domains: List<DataDomainFootprintDto>,
)

@Serializable
data class UiUpdateFileDto(
  val path: String,
  val sha256: String,
  val size: Long,
)

@Serializable
data class UiUpdateManifestDto(
  val version: String,
  val minAppVersion: String,
  val createdAt: String,
  val files: List<UiUpdateFileDto>,
)

@Serializable
data class UiUpdateInstallRequestDto(
  /** 签名覆盖的原始 UTF-8 manifest JSON；服务端解析后仍会逐文件复核。 */
  val manifestJson: String,
  val signature: String,
  val files: Map<String, String>,
)

@Serializable
data class UiUpdateStatusDto(
  val enabled: Boolean,
  val bundledVersion: String,
  val activeVersion: String? = null,
  val previousVersion: String? = null,
  val installedVersions: List<String> = emptyList(),
  val message: String,
)

@Serializable
data class UiUpdateSyncDto(
  /** null 表示主屏当前使用 APK 内置资源。 */
  val targetVersion: String? = null,
  /** 副屏版本已一致时省略包体，避免每次轮询传输数 MB 的 Base64 文件。 */
  val update: UiUpdateInstallRequestDto? = null,
)

interface UiUpdateCoordinator {
  fun status(): UiUpdateStatusDto
  fun install(request: UiUpdateInstallRequestDto): UiUpdateStatusDto
  fun rollback(): UiUpdateStatusDto
  fun syncPackage(): UiUpdateInstallRequestDto?
  fun synchronize(targetVersion: String?, request: UiUpdateInstallRequestDto?): UiUpdateStatusDto
}
