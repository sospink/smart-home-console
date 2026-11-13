package cn.zhijing.smartlab.edgecore

import cn.zhijing.smartlab.gateway.RawGatewayEvent
import cn.zhijing.smartlab.gateway.GatewayHealth
import java.time.Instant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

private data class SafetyAlertPolicy(
  val activeValue: JsonElement,
  val clearedValue: JsonElement,
  val level: String,
  val title: String,
  val message: (DeviceDto) -> String,
)

private val safetyAlertPolicies = mapOf(
  "waterLeak" to SafetyAlertPolicy(
    activeValue = JsonPrimitive(true),
    clearedValue = JsonPrimitive(false),
    level = "critical",
    title = "检测到水浸",
    message = { "${it.room}的${it.name}触发，请立即检查。" },
  ),
)

/** 只接收 GatewayAdapter 上报的可信状态；UI 不能直接写入 StateStore。 */
class StateStore(
  private val repository: EdgeRepository,
  private val events: EdgeEventBus,
  private val automations: AutomationEngine,
  private val alerts: AlertService = AlertService(repository, events),
) {
  suspend fun ingest(event: RawGatewayEvent): DeviceDto {
    val device = repository.deviceByExternalId(event.gatewayId, event.externalId)
      ?: throw DomainException(404, "GATEWAY_DEVICE_MAPPING_NOT_FOUND")
    if (device.capabilities.none { it.property == event.property }) {
      throw DomainException(400, "GATEWAY_PROPERTY_NOT_MAPPED")
    }
    val occurredAt = runCatching { Instant.parse(event.occurredAt).toString() }.getOrElse { Instant.now().toString() }
    val previousAt = repository.propertyConfirmedAt(device.id, event.property)?.let { runCatching { Instant.parse(it) }.getOrNull() }
    val incomingAt = Instant.parse(occurredAt)
    // 网关重连时可能补发旧队列；旧事件只用于诊断，不能覆盖较新的权威属性状态，也不能触发自动联动。
    if (previousAt != null && !incomingAt.isAfter(previousAt)) {
      repository.saveAudit(
        "system", if (incomingAt == previousAt) "忽略重复状态" else "忽略乱序状态",
        "${device.id}.${event.property} event=$occurredAt confirmed=$previousAt",
        "gateway", "ignored",
      )
      return device
    }
    val updated = device.copy(
      health = "online",
      updatedAt = occurredAt,
      state = device.state + (event.property to event.value),
    )
    val valueChanged = device.state[event.property] != event.value
    repository.saveConfirmedProperty(updated, event.property, event.value)
    // 任一可信子设备事件都能证明所属网关在本运行周期可达，但不能据此推断其他子设备在线。
    repository.updateGatewayConnectivity(event.gatewayId, true, occurredAt).forEach {
      events.publish("device.updated", it)
    }
    events.publish("device.updated", updated)
    events.publish("health.updated", repository.health())
    alerts.reconcileAvailability(updated)
    // 重启或断线恢复时，适配器会重发一帧权威现状来恢复在线状态。
    // 属性值未改变不属于状态转换，不能因此重复触发自动联动。
    if (valueChanged) automations.evaluate(updated, event.property, event.value, occurredAt)
    safetyAlertPolicies[event.property]?.let { policy ->
      if (event.value == policy.activeValue) {
        alerts.raise(updated.id, policy.level, policy.title, policy.message(updated), event.property, policy.clearedValue)
      } else {
        alerts.reconcileDevice(updated, event.property)
      }
    } ?: alerts.reconcileDevice(updated, event.property)
    return updated
  }

  suspend fun ingestHealth(health: GatewayHealth): List<DeviceDto> {
    if (repository.health().gateways.none { it.id == health.gatewayId }) {
      throw DomainException(404, "GATEWAY_NOT_FOUND")
    }
    val at = Instant.now().toString()
    val impacted = repository.updateGatewayConnectivity(health.gatewayId, health.online, at)
    impacted.forEach {
      events.publish("device.updated", it)
      alerts.reconcileAvailability(it)
    }
    events.publish("health.updated", repository.health())
    repository.saveAudit(
      "system", if (health.online) "网关恢复在线" else "网关连接中断",
      "${health.gatewayId}: ${health.detail ?: if (health.online) "可信健康检查通过" else "健康检查失败"}",
      "gateway", if (health.online) "success" else "failed",
    )
    return impacted
  }
}
