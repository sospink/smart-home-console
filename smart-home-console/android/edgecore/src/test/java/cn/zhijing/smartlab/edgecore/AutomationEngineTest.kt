package cn.zhijing.smartlab.edgecore

import cn.zhijing.smartlab.gateway.GatewayAdapter
import cn.zhijing.smartlab.gateway.GatewayConfig
import cn.zhijing.smartlab.gateway.GatewayHealth
import cn.zhijing.smartlab.gateway.RawCommand
import cn.zhijing.smartlab.gateway.RawCommandAck
import cn.zhijing.smartlab.gateway.RawDevice
import cn.zhijing.smartlab.gateway.RawGatewayEvent
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AutomationEngineTest {
  @Test
  fun `legacy enabled automation without actions cannot create a zero of zero success audit`() = runBlocking {
    val repository = FakeRepository()
    val now = Instant.parse("2026-07-24T00:00:00Z")
    repository.automationValues["empty-auto"] = AutomationDto(
      "empty-auto", "旧版空联动", true,
      AutomationConditionDto("sensor-1", "motion", "eq", JsonPrimitive(true)),
      emptyList(), 30,
    )
    val engine = AutomationEngine(repository, CommandService(repository, { TrustedAutomationAdapter }, EdgeEventBus(repository))) { now }

    engine.evaluate(repository.device("sensor-1")!!, "motion", JsonPrimitive(true), now.toString())

    assertTrue(repository.commands().isEmpty())
    assertTrue(repository.audits().none { it.action == "自动联动" && it.detail.contains("旧版空联动") })
  }

  @Test
  fun `matching automation executes writable actions and applies cooldown`() = runBlocking {
    val repository = FakeRepository()
    val commandService = CommandService(repository, { TrustedAutomationAdapter }, EdgeEventBus(repository))
    val now = Instant.parse("2026-07-24T00:00:00Z")
    val engine = AutomationEngine(repository, commandService) { now }
    repository.automationValues["auto-1"] = AutomationDto(
      "auto-1", "有人开灯", true,
      AutomationConditionDto("sensor-1", "motion", "eq", JsonPrimitive(true)),
      listOf(SceneActionDto("action-1", "light-1", "power", JsonPrimitive(true), "开主灯")),
      30,
    )

    engine.evaluate(repository.device("sensor-1")!!, "motion", JsonPrimitive(true), now.toString())
    engine.evaluate(repository.device("sensor-1")!!, "motion", JsonPrimitive(true), now.plusSeconds(2).toString())

    assertEquals(true, repository.device("light-1")!!.state["power"].toString().toBoolean())
    assertEquals(1, repository.commands().size)
  }
}

private object TrustedAutomationAdapter : GatewayAdapter {
  override suspend fun start(config: GatewayConfig) = Unit
  override suspend fun stop() = Unit
  override suspend fun discover(): List<RawDevice> = emptyList()
  override fun events(): Flow<RawGatewayEvent> = emptyFlow()
  override suspend fun send(command: RawCommand) = RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
  override suspend fun health() = GatewayHealth("gateway", true, 1)
}
