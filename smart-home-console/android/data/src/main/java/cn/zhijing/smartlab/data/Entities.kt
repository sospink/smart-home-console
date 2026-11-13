package cn.zhijing.smartlab.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.ColumnInfo

@Entity(tableName = "gateways")
data class GatewayEntity(
  @PrimaryKey val id: String,
  val name: String,
  val host: String,
  val port: Int,
  val model: String,
  val firmware: String,
  val credentialRef: String,
  val mode: String,
  val health: String,
  val updatedAt: String,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val lastTestOk: Boolean? = null,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val lastTestMessage: String? = null,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val lastTestAt: String? = null,
)

@Entity(tableName = "rooms")
data class RoomEntity(
  @PrimaryKey val id: String,
  val name: String,
  val sortOrder: Int,
  val enabled: Boolean,
)

@Entity(
  tableName = "devices",
  foreignKeys = [
    ForeignKey(
      entity = GatewayEntity::class,
      parentColumns = ["id"],
      childColumns = ["gatewayId"],
      onDelete = ForeignKey.SET_NULL,
    )
  ],
  indices = [Index("gatewayId"), Index(value = ["externalId", "gatewayId"], unique = true)],
)
data class DeviceEntity(
  @PrimaryKey val id: String,
  val externalId: String,
  val name: String,
  val roomId: String,
  val roomName: String,
  val kind: String,
  val health: String,
  val marketModel: String?,
  val internalModel: String?,
  val protocol: String,
  val gatewayId: String?,
  val verificationStatus: String,
  val note: String?,
  val updatedAt: String,
  @ColumnInfo(defaultValue = "NULL") val displayIcon: String? = null,
  @ColumnInfo(defaultValue = "0") val displayOrder: Int = 0,
  @ColumnInfo(defaultValue = "0") val displayHidden: Boolean = false,
  @ColumnInfo(defaultValue = "0") val displayFavorite: Boolean = false,
  @ColumnInfo(defaultValue = "NULL") val secondarySlot: String? = null,
)

@Entity(
  tableName = "capabilities",
  primaryKeys = ["deviceId", "property"],
  foreignKeys = [
    ForeignKey(
      entity = DeviceEntity::class,
      parentColumns = ["id"],
      childColumns = ["deviceId"],
      onDelete = ForeignKey.CASCADE,
    )
  ],
  indices = [Index("deviceId")],
)
data class CapabilityEntity(
  val deviceId: String,
  val property: String,
  val label: String,
  val type: String,
  val minimum: Double?,
  val maximum: Double?,
  val step: Double?,
  val unit: String?,
  val writable: Boolean,
  val optionsJson: String?,
)

@Entity(
  tableName = "device_states",
  primaryKeys = ["deviceId", "property"],
  foreignKeys = [
    ForeignKey(
      entity = DeviceEntity::class,
      parentColumns = ["id"],
      childColumns = ["deviceId"],
      onDelete = ForeignKey.CASCADE,
    )
  ],
  indices = [Index("deviceId")],
)
data class DeviceStateEntity(
  val deviceId: String,
  val property: String,
  val valueJson: String,
  val confirmedAt: String,
  val sequence: Long,
)

@Entity(tableName = "scenes")
data class SceneEntity(
  @PrimaryKey val id: String,
  val name: String,
  val description: String,
  val tone: String,
  val enabled: Boolean,
  val strategy: String,
  val lastExecutedAt: String?,
)

@Entity(
  tableName = "scene_actions",
  foreignKeys = [
    ForeignKey(
      entity = SceneEntity::class,
      parentColumns = ["id"],
      childColumns = ["sceneId"],
      onDelete = ForeignKey.CASCADE,
    )
  ],
  indices = [Index("sceneId"), Index("deviceId")],
)
data class SceneActionEntity(
  @PrimaryKey val id: String,
  val sceneId: String,
  val sortOrder: Int,
  val deviceId: String,
  val property: String,
  val valueJson: String,
  val label: String,
)

@Entity(tableName = "automations")
data class AutomationEntity(
  @PrimaryKey val id: String,
  val name: String,
  val enabled: Boolean,
  val conditionJson: String,
  val actionsJson: String,
  val cooldownSeconds: Int,
  val lastTriggeredAt: String?,
)

@Entity(tableName = "commands", indices = [Index(value = ["requestId"], unique = true), Index("deviceId")])
data class CommandEntity(
  @PrimaryKey val id: String,
  val requestId: String,
  val deviceId: String,
  val property: String,
  val valueJson: String,
  val source: String,
  val status: String,
  val createdAt: String,
  val confirmedAt: String?,
  val error: String?,
)

@Entity(tableName = "scene_executions", indices = [Index("sceneId"), Index("startedAt")])
data class SceneExecutionEntity(
  @PrimaryKey val id: String,
  val sceneId: String,
  val source: String,
  val status: String,
  val completedActions: Int,
  val totalActions: Int,
  val startedAt: String,
  val finishedAt: String?,
)

@Entity(tableName = "alerts", indices = [Index("deviceId"), Index("acknowledgedAt")])
data class AlertEntity(
  @PrimaryKey val id: String,
  val deviceId: String,
  val level: String,
  val title: String,
  val message: String,
  val occurredAt: String,
  val acknowledgedAt: String?,
  val recoveredAt: String?,
  val recoveryProperty: String? = null,
  val recoveryValue: String? = null,
)

@Entity(tableName = "audit_logs", indices = [Index("occurredAt"), Index("category"), Index("result"), Index("trainingId"), Index("trainingEvidence")])
data class AuditEntity(
  @PrimaryKey val id: String,
  val category: String,
  val action: String,
  val detail: String,
  val source: String,
  val result: String,
  val occurredAt: String,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val trainingId: String? = null,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val trainingEvidence: String? = null,
)

@Entity(tableName = "handover_records", indices = [Index("completedAt")])
data class HandoverRecordEntity(
  @PrimaryKey val id: String,
  val completedAt: String,
  val completedBy: String,
  val stateToken: String,
  val acknowledgedWarningsJson: String,
  val note: String,
  val summaryJson: String,
)

@Entity(tableName = "terminals", indices = [Index(value = ["deviceId"], unique = true)])
data class TerminalEntity(
  @PrimaryKey val id: String,
  val deviceId: String,
  val name: String,
  val role: String,
  val tokenRef: String,
  val paired: Boolean,
  val online: Boolean,
  val version: String,
  val address: String,
  val lastSeenAt: String,
)

@Entity(tableName = "training_exercises", indices = [Index("status"), Index("targetId")])
data class TrainingExerciseEntity(
  @PrimaryKey val id: String,
  val title: String,
  val targetId: String,
  val fault: String,
  val status: String,
  val startedAt: String?,
  val completedAt: String?,
  val score: Int?,
  val cancelReason: String?,
  @androidx.room.ColumnInfo(defaultValue = "'未记录'") val participant: String = "未记录",
  @androidx.room.ColumnInfo(defaultValue = "NULL") val scoreCorrectionReason: String? = null,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val scoreCorrectedAt: String? = null,
  @androidx.room.ColumnInfo(defaultValue = "0") val scoreRevisionCount: Int = 0,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val startReadinessCheckedAt: String? = null,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val startTargetHealth: String? = null,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val startPairedTerminals: Int? = null,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val startOnlineTerminals: Int? = null,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val startAcknowledgedWarnings: String? = null,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val operationEvidenceVersion: Int? = null,
)

@Entity(tableName = "configuration_meta")
data class ConfigurationMetaEntity(
  @PrimaryKey val id: String = "current",
  val version: Int,
  val updatedAt: String,
  @androidx.room.ColumnInfo(defaultValue = "0") val eventSequence: Long = 0,
  @androidx.room.ColumnInfo(defaultValue = "'off'") val benchResetPower: String = "off",
  @androidx.room.ColumnInfo(defaultValue = "'closed'") val benchResetCover: String = "closed",
  @androidx.room.ColumnInfo(defaultValue = "8") val benchResetSuppressionSeconds: Int = 8,
  @androidx.room.ColumnInfo(defaultValue = "NULL") val automationSuppressedUntil: String? = null,
)
