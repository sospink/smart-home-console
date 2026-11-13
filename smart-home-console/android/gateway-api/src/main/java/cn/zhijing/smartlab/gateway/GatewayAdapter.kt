package cn.zhijing.smartlab.gateway

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonElement

data class GatewayConfig(
  val id: String,
  val host: String,
  val port: Int,
  val credentialRef: String,
)

data class RawDevice(
  val externalId: String,
  val model: String,
  val gatewayId: String,
  val properties: Map<String, JsonElement>,
  val capabilities: List<RawCapability> = emptyList(),
)

data class RawCapability(
  val property: String,
  val label: String,
  val type: String,
  val minimum: Double? = null,
  val maximum: Double? = null,
  val step: Double? = null,
  val unit: String? = null,
  val writable: Boolean,
  val options: List<RawCapabilityOption>? = null,
)

data class RawCapabilityOption(val label: String, val value: JsonElement)

data class RawGatewayEvent(
  val gatewayId: String,
  val externalId: String,
  val property: String,
  val value: JsonElement,
  val occurredAt: String,
)

data class RawCommand(
  val requestId: String,
  val externalId: String,
  val property: String,
  val value: JsonElement,
)

data class RawCommandAck(
  val requestId: String,
  val accepted: Boolean,
  val trustedConfirmation: Boolean = false,
  val error: String? = null,
)

data class GatewayHealth(
  val gatewayId: String,
  val online: Boolean,
  val latencyMs: Long,
  val firmware: String? = null,
  val detail: String? = null,
)

/** 真机到货后只通过此边界接入，不允许 UI 直接构造网关原始指令。 */
interface GatewayAdapter {
  suspend fun start(config: GatewayConfig)
  suspend fun stop()
  suspend fun discover(): List<RawDevice>
  fun events(): Flow<RawGatewayEvent>
  suspend fun send(command: RawCommand): RawCommandAck
  suspend fun health(): GatewayHealth
}
