package cn.zhijing.smartlab.edgecore

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeRecoveryTest {
  @Test
  fun `restart closes transient states without inventing device outcomes`() = runBlocking {
    val repository = FakeRepository()
    repository.saveCommand(
      CommandDto(
        "cmd-pending", "request-pending", "light-1", "power", JsonPrimitive(true), "primary",
        "pending", "2026-07-25T00:00:00Z",
      )
    )
    repository.saveExecution(
      SceneExecutionDto(
        "execution-zero", "scene-test", "primary", "running", 0, 2, "2026-07-25T00:00:01Z",
      )
    )
    repository.saveExecution(
      SceneExecutionDto(
        "execution-one", "scene-test", "primary", "running", 1, 2, "2026-07-25T00:00:02Z",
      )
    )
    repository.saveTerminal(
      TerminalDto(
        "secondary", "android-secondary", "副屏", "secondary", true, true, "0.1.0",
        "192.168.1.20", "2026-07-25T00:00:03Z",
      ),
      "token-hash",
    )

    val at = "2026-07-25T00:10:00Z"
    val result = repository.recoverInterruptedRuntime(at)

    assertEquals(RuntimeRecoveryResult(1, 1, 1, 1, 0, 3), result)
    val command = repository.commands().single()
    assertEquals("timeout", command.status)
    assertNull(command.confirmedAt)
    assertEquals("EdgeCore 重启，命令最终状态未知，请核对设备", command.error)
    assertEquals("failed", repository.executions().first { it.id == "execution-zero" }.status)
    assertEquals("partial", repository.executions().first { it.id == "execution-one" }.status)
    assertEquals(at, repository.executions().first { it.id == "execution-one" }.finishedAt)
    assertFalse(repository.terminals().single().online)
    assertTrue(repository.devices().all { it.health == "offline" })
  }
}
