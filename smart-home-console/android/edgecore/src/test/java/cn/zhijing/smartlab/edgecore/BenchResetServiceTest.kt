package cn.zhijing.smartlab.edgecore

import cn.zhijing.smartlab.gateway.GatewayAdapter
import cn.zhijing.smartlab.gateway.RawCommand
import cn.zhijing.smartlab.gateway.RawCommandAck
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class BenchResetServiceTest {
  @Test
  fun `serial reset keeps suppression alive through a slow command and after final confirmation`() = runBlocking {
    val repository = FakeRepository()
    repository.saveConfirmedProperty(
      repository.device("light-1")!!.copy(state = repository.device("light-1")!!.state + ("power" to JsonPrimitive(true))),
      "power",
      JsonPrimitive(true),
    )
    val now = AtomicReference(Instant.parse("2026-07-25T02:00:00Z"))
    val adapter = object : GatewayAdapter by TrustedAdapter {
      override suspend fun send(command: RawCommand): RawCommandAck {
        now.set(now.get().plusSeconds(10))
        return RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
      }
    }
    val commands = CommandService(repository, { adapter }, EdgeEventBus(repository))
    val service = BenchResetService(repository, commands, now::get)

    val result = service.execute()

    assertEquals("completed", result.status)
    assertTrue(repository.automationSuppressionHistory.first() >= "2026-07-25T02:00:11Z")
    assertEquals("2026-07-25T02:00:18Z", repository.automationSuppressionHistory.last())
    assertTrue(repository.automationsSuppressed("2026-07-25T02:00:17Z"))
  }

  @Test
  fun `handover requires a fresh checklist and archives acknowledged risks`() = runBlocking {
    val repository = FakeRepository()
    repository.saveConfirmedProperty(
      repository.device("light-1")!!.copy(state = repository.device("light-1")!!.state + ("power" to JsonPrimitive(true))),
      "power",
      JsonPrimitive(true),
    )
    val service = BenchResetService(repository, CommandService(repository, { TrustedAdapter }, EdgeEventBus(repository)))
    val blocked = service.handoverChecklist()
    assertFalse(blocked.canComplete)
    assertTrue("BENCH_NOT_RESET" in blocked.blockers)

    service.execute()
    val ready = service.handoverChecklist()
    assertTrue(ready.canComplete)
    val requestId = "handover-test-001"
    if (ready.warnings.isNotEmpty()) {
      val missing = runCatching {
        service.completeHandover(HandoverCompleteRequestDto("handover-missing-001", "张老师", ready.stateToken))
      }.exceptionOrNull()
      assertEquals("HANDOVER_WARNINGS_UNACKNOWLEDGED", (missing as DomainException).message)
    }
    val completed = service.completeHandover(
      HandoverCompleteRequestDto(requestId, "张老师", ready.stateToken, ready.warnings, "离线设备已现场核对"),
    )
    assertEquals("张老师", service.handoverChecklist().lastCompletion?.completedBy)
    assertEquals(completed, service.completeHandover(HandoverCompleteRequestDto(requestId, "忽略", "stale")))
    assertEquals(1, repository.handoverValues.size)
    assertTrue(repository.audits().any { it.action == "完成运行交接" && it.detail.contains("离线设备已现场核对") })

    val stale = runCatching {
      service.completeHandover(HandoverCompleteRequestDto("handover-test-002", "张老师", blocked.stateToken, blocked.warnings))
    }.exceptionOrNull() as DomainException
    assertEquals(409, stale.status)
    assertEquals("HANDOVER_STATE_CHANGED", stale.message)
  }
}
