package cn.zhijing.smartlab.edgecore

import cn.zhijing.smartlab.gateway.GatewayAdapter
import cn.zhijing.smartlab.gateway.RawCommand
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout

class CommandService(
  private val repository: EdgeRepository,
  private val adapterForDevice: suspend (DeviceDto) -> GatewayAdapter?,
  private val events: EdgeEventBus,
  private val commandTimeoutMillis: Long = COMMAND_TIMEOUT_MILLIS,
  internal val coordinator: OperationCoordinator = OperationCoordinator(),
) {
  private val requestLocks = ConcurrentHashMap<String, Mutex>()

  suspend fun execute(deviceId: String, request: CommandRequestDto, leaseOwner: String = request.requestId): CommandDto {
    val lock = requestLocks.computeIfAbsent(request.requestId) { Mutex() }
    return try {
      try {
        lock.withLock {
          repository.commandByRequest(request.requestId)?.let { existing ->
            if (existing.deviceId != deviceId || existing.property != request.property || existing.value != request.value || existing.source != request.source) {
              throw DomainException(409, "requestId 已用于不同命令")
            }
            return@withLock existing
          }
          coordinator.withCommandLease(deviceId, request.property, leaseOwner) { executeOnce(deviceId, request) }
        }
      } catch (error: DomainException) {
        repository.saveAudit("command", "$deviceId.${request.property}", error.message, request.source, "failed")
        throw error
      }
    } finally {
      requestLocks.remove(request.requestId, lock)
    }
  }

  private suspend fun executeOnce(deviceId: String, request: CommandRequestDto): CommandDto {
    val device = repository.device(deviceId) ?: throw DomainException(404, "设备不存在")
    val capability = device.capabilities.firstOrNull { it.property == request.property }
      ?: throw DomainException(400, "设备不支持该能力")
    if (!capability.writable) throw DomainException(403, "该能力为只读")
    capabilityValueError(capability, request.value)?.let {
      throw DomainException(400, "INVALID_CAPABILITY_VALUE:$deviceId.${request.property}:$it")
    }
    if (device.health == "offline") throw DomainException(409, "设备离线")
    device.integration.gatewayId?.let { gatewayId ->
      val gateway = repository.health().gateways.firstOrNull { it.id == gatewayId }
        ?: throw DomainException(409, "所属网关不存在")
      if (gateway.status != "online") throw DomainException(409, "所属网关离线")
    }

    val createdAt = Instant.now().toString()
    val pending = CommandDto(
      id = "cmd-${UUID.randomUUID()}",
      requestId = request.requestId,
      deviceId = deviceId,
      property = request.property,
      value = request.value,
      source = request.source,
      status = "pending",
      createdAt = createdAt,
    )
    repository.saveCommand(pending)
    events.publish("command.updated", pending)

    val adapter = adapterForDevice(device)
    if (adapter == null) return fail(pending, "网关适配器尚未连接")
    val ack = try {
      val externalId = device.integration.externalId ?: return fail(pending, "设备外部 ID 尚未标定")
      withTimeout(commandTimeoutMillis) {
        adapter.send(RawCommand(request.requestId, externalId, request.property, request.value))
      }
    } catch (_: TimeoutCancellationException) {
      return timeout(pending)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (error: Throwable) {
      return fail(pending, error.message ?: "网关指令下发失败")
    }
    if (!ack.accepted) return fail(pending, ack.error ?: "网关拒绝指令")
    if (!ack.trustedConfirmation) return fail(pending, "已下发但未收到可信状态确认")

    val confirmedAt = Instant.now().toString()
    val confirmed = pending.copy(status = "confirmed", confirmedAt = confirmedAt)
    val updated = device.copy(state = device.state + (request.property to request.value), updatedAt = confirmedAt)
    repository.saveConfirmedProperty(updated, request.property, request.value)
    repository.saveCommand(confirmed)
    repository.saveAudit("command", "${device.name}.${request.property}", "设备状态已确认", request.source, "success")
    events.publish("device.updated", updated)
    events.publish("command.updated", confirmed)
    return confirmed
  }

  private suspend fun fail(pending: CommandDto, error: String): CommandDto {
    val failed = pending.copy(status = "failed", error = error)
    repository.saveCommand(failed)
    repository.saveAudit("command", "${pending.deviceId}.${pending.property}", error, pending.source, "failed")
    events.publish("command.updated", failed)
    return failed
  }

  private suspend fun timeout(pending: CommandDto): CommandDto {
    val timedOut = pending.copy(status = "timeout", error = "等待网关可信确认超时")
    repository.saveCommand(timedOut)
    repository.saveAudit("command", "${pending.deviceId}.${pending.property}", timedOut.error.orEmpty(), pending.source, "failed")
    events.publish("command.updated", timedOut)
    return timedOut
  }

  companion object {
    internal const val COMMAND_TIMEOUT_MILLIS = 8_000L
  }
}

class DomainException(val status: Int, override val message: String) : RuntimeException(message)
