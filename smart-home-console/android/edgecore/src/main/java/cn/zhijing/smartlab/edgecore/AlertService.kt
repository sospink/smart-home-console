package cn.zhijing.smartlab.edgecore

import java.time.Instant
import java.util.UUID

class AlertService(
  private val repository: EdgeRepository,
  private val events: EdgeEventBus,
  private val clock: () -> Instant = Instant::now,
) {
  suspend fun reconcileAvailability(device: DeviceDto): AlertDto? {
    if (device.kind != "sensor" && device.kind != "lock") return null
    val title = "监控链路不可用"
    val open = repository.openAlert(device.id, title)
    if (device.health == "offline") {
      return open ?: raise(
        device.id,
        "warning",
        title,
        "${device.room}的${device.name}已离线，当前无法确认安防状态，请检查供电、网关与通信链路。",
        DEVICE_HEALTH_PROPERTY,
        kotlinx.serialization.json.JsonPrimitive("online"),
      )
    }
    if (open == null) return null
    val at = clock().toString()
    val recovered = repository.recoverAlert(open.id, at) ?: return null
    repository.saveAudit("alert", "监控链路恢复", device.name, "gateway", "success")
    events.publish("alert.updated", recovered)
    return recovered
  }

  suspend fun raise(
    deviceId: String,
    level: String,
    title: String,
    message: String,
    recoveryProperty: String? = null,
    recoveryValue: kotlinx.serialization.json.JsonElement? = null,
  ): AlertDto {
    repository.device(deviceId) ?: throw DomainException(404, "告警设备不存在")
    val now = clock()
    val duplicate = repository.openAlert(deviceId, title)
    if (duplicate != null) {
      repository.saveAudit("alert", title, "重复告警已抑制", "gateway", "success")
      return duplicate
    }
    val alert = AlertDto(
      id = "alert-${UUID.randomUUID()}",
      deviceId = deviceId,
      level = level,
      title = title.take(120),
      message = message.take(1_000),
      occurredAt = now.toString(),
      recoveryProperty = recoveryProperty,
      recoveryValue = recoveryValue,
    )
    repository.saveAlert(alert)
    repository.saveAudit("alert", alert.title, alert.message, "gateway", "success")
    events.publish("alert.created", alert)
    return alert
  }

  suspend fun acknowledge(id: String, source: String = "admin"): AlertDto {
    val at = clock().toString()
    val alert = repository.acknowledgeAlert(id, at) ?: throw DomainException(404, "告警不存在")
    repository.saveAudit("alert", alert.title, "告警已确认", source, "success")
    events.publish("alert.updated", alert)
    return alert
  }

  suspend fun recover(id: String, source: String = "admin"): AlertDto {
    val current = repository.alerts().firstOrNull { it.id == id } ?: throw DomainException(404, "告警不存在")
    if (current.recoveredAt != null) return current
    if (current.recoveryProperty != null) {
      val device = repository.device(current.deviceId) ?: throw DomainException(409, "ALERT_RECOVERY_STATE_UNAVAILABLE")
      val value = if (current.recoveryProperty == DEVICE_HEALTH_PROPERTY) {
        kotlinx.serialization.json.JsonPrimitive(device.health)
      } else {
        if (device.health != "online") throw DomainException(409, "ALERT_RECOVERY_STATE_UNAVAILABLE")
        device.state[current.recoveryProperty] ?: throw DomainException(409, "ALERT_RECOVERY_STATE_UNAVAILABLE")
      }
      if (value != current.recoveryValue) throw DomainException(409, "ALERT_CONDITION_STILL_ACTIVE")
    }
    val at = clock().toString()
    val alert = repository.recoverAlert(id, at) ?: throw DomainException(404, "告警不存在")
    repository.saveAudit("alert", alert.title, "告警已恢复", source, "success")
    events.publish("alert.updated", alert)
    return alert
  }

  suspend fun reconcileDevice(device: DeviceDto, changedProperty: String): List<AlertDto> {
    if (device.health != "online") return emptyList()
    return repository.alerts()
      .filter {
        it.deviceId == device.id && it.recoveredAt == null && it.recoveryProperty == changedProperty &&
          device.state[changedProperty] == it.recoveryValue
      }
      .map { recover(it.id, "gateway") }
  }

  companion object {
    const val DEVICE_HEALTH_PROPERTY = "__health"
  }
}
