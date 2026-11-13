package cn.zhijing.smartlab.edgecore

import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AlertServiceTest {
  @Test
  fun `duplicate alerts inside window are suppressed`() = runBlocking {
    val repository = FakeRepository()
    var now = Instant.parse("2026-07-24T00:00:00Z")
    val service = AlertService(repository, EdgeEventBus(repository)) { now }

    val first = service.raise("sensor-1", "critical", "水浸告警", "检测到水浸")
    now = now.plusSeconds(30)
    val duplicate = service.raise("sensor-1", "critical", "水浸告警", "重复事件")

    assertEquals(first.id, duplicate.id)
    assertEquals(1, repository.alertValues.size)
  }

  @Test
  fun `recovered alert allows a new alert and lifecycle is persisted`() = runBlocking {
    val repository = FakeRepository()
    var now = Instant.parse("2026-07-24T00:00:00Z")
    val service = AlertService(repository, EdgeEventBus(repository)) { now }
    val first = service.raise("sensor-1", "critical", "水浸告警", "检测到水浸")

    now = now.plusSeconds(10)
    assertNotNull(service.acknowledge(first.id).acknowledgedAt)
    assertNotNull(service.recover(first.id).recoveredAt)
    now = now.plusSeconds(10)
    val next = service.raise("sensor-1", "critical", "水浸告警", "再次水浸")

    assertEquals(2, repository.alertValues.size)
    assert(next.id != first.id)
  }

  @Test
  fun `an active alert remains deduplicated beyond the former time window`() = runBlocking {
    val repository = FakeRepository()
    var now = Instant.parse("2026-07-24T00:00:00Z")
    val service = AlertService(repository, EdgeEventBus(repository)) { now }
    val first = service.raise("water-1", "critical", "水浸告警", "检测到水浸")
    now = now.plusSeconds(3_600)

    val repeated = service.raise("water-1", "critical", "水浸告警", "仍在水浸")

    assertEquals(first.id, repeated.id)
    assertEquals(1, repository.alertValues.size)
  }

  @Test
  fun `recovery is rejected while authoritative condition remains active`() = runBlocking {
    val repository = FakeRepository()
    val service = AlertService(repository, EdgeEventBus(repository))
    val alert = service.raise(
      "water-1", "critical", "水浸告警", "检测到水浸", "waterLeak", kotlinx.serialization.json.JsonPrimitive(false),
    )

    val error = runCatching { service.recover(alert.id) }.exceptionOrNull() as DomainException
    assertEquals(409, error.status)
    assertEquals("ALERT_CONDITION_STILL_ACTIVE", error.message)
    assertNull(repository.alertValues[alert.id]?.recoveredAt)

    repository.saveDevice(repository.device("water-1")!!.copy(state = mapOf("waterLeak" to kotlinx.serialization.json.JsonPrimitive(false))))
    assertNotNull(service.recover(alert.id).recoveredAt)
  }

  @Test
  fun `trusted cleared device state automatically reconciles matching alerts`() = runBlocking {
    val repository = FakeRepository()
    val service = AlertService(repository, EdgeEventBus(repository))
    val alert = service.raise(
      "water-1", "critical", "水浸告警", "检测到水浸", "waterLeak", kotlinx.serialization.json.JsonPrimitive(false),
    )
    val cleared = repository.device("water-1")!!.copy(state = mapOf("waterLeak" to kotlinx.serialization.json.JsonPrimitive(false)))
    repository.saveDevice(cleared)

    val recovered = service.reconcileDevice(cleared, "waterLeak")

    assertEquals(listOf(alert.id), recovered.map { it.id })
    assertNotNull(repository.alertValues[alert.id]?.recoveredAt)
  }

  @Test
  fun `availability event cannot be manually recovered while device remains offline`() = runBlocking {
    val repository = FakeRepository()
    val service = AlertService(repository, EdgeEventBus(repository))
    val offline = repository.device("sensor-1")!!.copy(health = "offline")
    repository.saveDevice(offline)
    val alert = service.reconcileAvailability(offline)!!

    val error = runCatching { service.recover(alert.id) }.exceptionOrNull() as DomainException

    assertEquals(409, error.status)
    assertEquals("ALERT_CONDITION_STILL_ACTIVE", error.message)
    assertNull(repository.alertValues[alert.id]?.recoveredAt)
  }
}
