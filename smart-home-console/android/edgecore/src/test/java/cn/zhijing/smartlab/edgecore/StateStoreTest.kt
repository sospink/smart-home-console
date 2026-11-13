package cn.zhijing.smartlab.edgecore

import cn.zhijing.smartlab.gateway.RawGatewayEvent
import cn.zhijing.smartlab.gateway.GatewayHealth
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StateStoreTest {
  @Test
  fun `gateway confirmation during bench reset suppression cannot trigger automation`() = runBlocking {
    val repository = FakeRepository()
    repository.saveConfirmedProperty(
      repository.device("light-1")!!.copy(
        state = repository.device("light-1")!!.state + ("power" to JsonPrimitive(true)),
        updatedAt = "2026-07-24T02:00:00Z",
      ),
      "power",
      JsonPrimitive(true),
    )
    repository.automationValues["reverse"] = AutomationDto(
      "reverse", "反向联动", true,
      AutomationConditionDto("light-1", "power", "eq", JsonPrimitive(false)),
      listOf(SceneActionDto("reverse-action", "light-1", "power", JsonPrimitive(true), "重新开灯")), 1,
    )
    repository.suppressAutomationsUntil("2026-07-24T02:00:10Z")
    val events = EdgeEventBus(repository, Json)
    val commands = CommandService(repository, { TrustedAdapter }, events)
    val store = StateStore(repository, events, AutomationEngine(repository, commands))

    store.ingest(RawGatewayEvent("gateway", "light-1", "power", JsonPrimitive(false), "2026-07-24T02:00:01Z"))

    assertEquals(JsonPrimitive(false), repository.device("light-1")?.state?.get("power"))
    assertTrue(repository.commands().isEmpty())
    assertTrue(repository.audits().any { it.action == "复位期间联动抑制" && it.result == "ignored" })
  }
  @Test
  fun `trusted gateway state is persisted through external mapping`() = runBlocking {
    val repository = FakeRepository()
    val events = EdgeEventBus(repository, Json)
    val commands = CommandService(repository, { null }, events)
    val store = StateStore(repository, events, AutomationEngine(repository, commands))

    val updated = store.ingest(
      RawGatewayEvent("gateway", "light-1", "brightness", JsonPrimitive(63), "2026-07-24T01:00:00Z")
    )

    assertEquals(JsonPrimitive(63), updated.state["brightness"])
    assertEquals(JsonPrimitive(63), repository.device("light-1")?.state?.get("brightness"))
    assertEquals("online", repository.device("light-1")?.health)
  }

  @Test
  fun `current HA observation restores an offline device even when the property value did not change`() = runBlocking {
    val repository = FakeRepository()
    repository.automationValues["must-not-repeat"] = AutomationDto(
      "must-not-repeat", "恢复在线不重复开灯", true,
      AutomationConditionDto("light-1", "power", "eq", repository.device("light-1")!!.state.getValue("power")),
      listOf(SceneActionDto("repeat-action", "light-1", "power", JsonPrimitive(true), "重复开灯")), 1,
    )
    val events = EdgeEventBus(repository, Json)
    val commands = CommandService(repository, { null }, events)
    val store = StateStore(repository, events, AutomationEngine(repository, commands))
    val lastKnownPower = repository.device("light-1")!!.state.getValue("power")

    repository.recoverInterruptedRuntime("2026-07-28T08:00:00Z")
    assertEquals("offline", repository.device("light-1")?.health)

    store.ingest(RawGatewayEvent("gateway", "light-1", "power", lastKnownPower, "2026-07-28T08:00:01Z"))

    assertEquals(lastKnownPower, repository.device("light-1")?.state?.get("power"))
    assertEquals("online", repository.device("light-1")?.health)
    assertTrue(repository.gatewayOnline)
    assertTrue(repository.commands().isEmpty())
  }

  @Test
  fun `explicit gateway outage cascades offline without changing last known properties`() = runBlocking {
    val repository = FakeRepository()
    val events = EdgeEventBus(repository, Json)
    val commands = CommandService(repository, { null }, events)
    val store = StateStore(repository, events, AutomationEngine(repository, commands))
    val before = repository.device("light-1")!!.state

    val impacted = store.ingestHealth(GatewayHealth("gateway", false, 0, detail = "heartbeat timeout"))

    assertTrue(impacted.any { it.id == "light-1" })
    assertEquals("offline", repository.device("light-1")?.health)
    assertEquals(before, repository.device("light-1")?.state)
    assertTrue(repository.audits().any { it.action == "网关连接中断" && it.result == "failed" })
    assertEquals(
      setOf("sensor-1", "water-1"),
      repository.alertValues.values.filter { it.title == "监控链路不可用" && it.recoveredAt == null }.map { it.deviceId }.toSet(),
    )
  }

  @Test
  fun `safety availability event recovers only after that device reports trusted state`() = runBlocking {
    val repository = FakeRepository()
    val events = EdgeEventBus(repository, Json)
    val commands = CommandService(repository, { null }, events)
    val store = StateStore(repository, events, AutomationEngine(repository, commands))
    store.ingestHealth(GatewayHealth("gateway", false, 0, detail = "heartbeat timeout"))
    val sensorAlert = repository.alertValues.values.single { it.deviceId == "sensor-1" && it.title == "监控链路不可用" }
    val waterAlert = repository.alertValues.values.single { it.deviceId == "water-1" && it.title == "监控链路不可用" }

    store.ingest(RawGatewayEvent("gateway", "sensor-1", "motion", JsonPrimitive(false), "2026-07-24T02:00:00Z"))

    assertTrue(repository.alertValues[sensorAlert.id]?.recoveredAt != null)
    assertEquals(null, repository.alertValues[waterAlert.id]?.recoveredAt)
  }

  @Test
  fun `older queued event cannot overwrite a newer confirmed property`() = runBlocking {
    val repository = FakeRepository()
    val events = EdgeEventBus(repository, Json)
    val commands = CommandService(repository, { null }, events)
    val store = StateStore(repository, events, AutomationEngine(repository, commands))
    store.ingest(RawGatewayEvent("gateway", "light-1", "brightness", JsonPrimitive(80), "2026-07-24T02:00:00Z"))

    val ignored = store.ingest(
      RawGatewayEvent("gateway", "light-1", "brightness", JsonPrimitive(20), "2026-07-24T01:59:59Z")
    )

    assertEquals(JsonPrimitive(80), ignored.state["brightness"])
    assertEquals(JsonPrimitive(80), repository.device("light-1")?.state?.get("brightness"))
  }

  @Test
  fun `same timestamp retransmission is ignored before automation evaluation`() = runBlocking {
    val repository = FakeRepository()
    repository.automationValues["auto-repeat"] = AutomationDto(
      "auto-repeat", "重复事件不得再次执行", true,
      AutomationConditionDto("sensor-1", "motion", "eq", JsonPrimitive(true)),
      listOf(SceneActionDto("action-repeat", "light-1", "power", JsonPrimitive(true), "开主灯")),
      1,
    )
    val events = EdgeEventBus(repository, Json)
    val commands = CommandService(repository, { null }, events)
    val store = StateStore(repository, events, AutomationEngine(repository, commands))
    val at = "2026-07-24T02:00:00Z"

    store.ingest(RawGatewayEvent("gateway", "sensor-1", "motion", JsonPrimitive(true), at))
    store.ingest(RawGatewayEvent("gateway", "sensor-1", "motion", JsonPrimitive(true), at))

    assertEquals(1, repository.commands().size)
    assertEquals(1, repository.audits().count { it.action == "忽略重复状态" })
  }

  @Test
  fun `confirming one property does not advance another property timestamp`() = runBlocking {
    val repository = FakeRepository()
    val events = EdgeEventBus(repository, Json)
    val commands = CommandService(repository, { null }, events)
    val store = StateStore(repository, events, AutomationEngine(repository, commands))

    store.ingest(RawGatewayEvent("gateway", "light-1", "brightness", JsonPrimitive(64), "2026-07-24T02:00:00Z"))
    store.ingest(RawGatewayEvent("gateway", "light-1", "power", JsonPrimitive(true), "2026-07-24T01:59:00Z"))

    assertEquals(JsonPrimitive(64), repository.device("light-1")?.state?.get("brightness"))
    assertEquals(JsonPrimitive(true), repository.device("light-1")?.state?.get("power"))
    assertEquals("2026-07-24T02:00:00Z", repository.propertyConfirmedAt("light-1", "brightness"))
    assertEquals("2026-07-24T01:59:00Z", repository.propertyConfirmedAt("light-1", "power"))
  }

  @Test
  fun `unmapped gateway property is rejected without changing device`() = runBlocking {
    val repository = FakeRepository()
    val before = repository.device("light-1")!!
    val events = EdgeEventBus(repository, Json)
    val commands = CommandService(repository, { null }, events)
    val store = StateStore(repository, events, AutomationEngine(repository, commands))

    val error = runCatching {
      store.ingest(RawGatewayEvent("gateway", "light-1", "unlock", JsonPrimitive(true), "2026-07-24T02:00:00Z"))
    }.exceptionOrNull() as DomainException

    assertEquals(400, error.status)
    assertFalse(repository.device("light-1")!!.state.containsKey("unlock"))
    assertEquals(before.state, repository.device("light-1")!!.state)
  }

  @Test
  fun `trusted water leak events open and close a condition-bound alert`() = runBlocking {
    val repository = FakeRepository()
    val events = EdgeEventBus(repository, Json)
    val commands = CommandService(repository, { null }, events)
    val alerts = AlertService(repository, events)
    val store = StateStore(repository, events, AutomationEngine(repository, commands), alerts)

    store.ingest(RawGatewayEvent("gateway", "water-1", "waterLeak", JsonPrimitive(true), "2026-07-24T01:59:59Z"))
    val open = repository.alertValues.values.single()
    assertEquals("waterLeak", open.recoveryProperty)
    assertEquals(JsonPrimitive(false), open.recoveryValue)
    assertEquals("检测到水浸", open.title)

    store.ingest(RawGatewayEvent("gateway", "water-1", "waterLeak", JsonPrimitive(false), "2026-07-24T02:00:00Z"))

    assertFalse(repository.alertValues[open.id]?.recoveredAt == null)
  }
}
