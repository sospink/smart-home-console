package cn.zhijing.smartlab.edgecore

import java.time.Instant
import io.ktor.websocket.CloseReason
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.close
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * 终端在线状态由活跃事件流连接决定。引用计数避免快速重连时旧连接的 finally
 * 把已经建立的新连接误标为离线。
 */
class TerminalPresenceService(
  private val repository: EdgeRepository,
  private val events: EdgeEventBus,
  private val clock: () -> Instant = Instant::now,
) {
  private val mutex = Mutex()
  private val connections = mutableMapOf<String, Int>()
  private val sessions = mutableMapOf<String, MutableSet<WebSocketSession>>()

  suspend fun connected(identity: EventTicketIdentity, session: WebSocketSession? = null) {
    mutex.withLock {
      connections[identity.terminalId] = (connections[identity.terminalId] ?: 0) + 1
      if (session != null) sessions.getOrPut(identity.terminalId) { mutableSetOf() }.add(session)
    }
    refresh(identity, publish = true)
  }

  suspend fun refresh(identity: EventTicketIdentity, publish: Boolean = false) {
    repository.touchTerminal(identity.terminalId, identity.address, identity.version, clock().toString())
    if (publish) repository.terminals().firstOrNull { it.id == identity.terminalId }?.let { events.publish("terminal.updated", it) }
  }

  suspend fun disconnected(identity: EventTicketIdentity, session: WebSocketSession? = null) {
    val wentOffline = mutex.withLock {
      val remaining = (connections[identity.terminalId] ?: 1) - 1
      if (remaining > 0) {
        connections[identity.terminalId] = remaining
        if (session != null) sessions[identity.terminalId]?.remove(session)
        false
      } else {
        connections.remove(identity.terminalId)
        sessions.remove(identity.terminalId)
        true
      }
    }
    if (!wentOffline) return
    repository.setTerminalOnline(identity.terminalId, false)
    repository.terminals().firstOrNull { it.id == identity.terminalId }?.let { events.publish("terminal.updated", it) }
  }

  suspend fun revoke(terminalId: String) {
    val active = mutex.withLock {
      connections.remove(terminalId)
      sessions.remove(terminalId)?.toList().orEmpty()
    }
    active.forEach { runCatching { it.close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "TERMINAL_REVOKED")) } }
  }
}
