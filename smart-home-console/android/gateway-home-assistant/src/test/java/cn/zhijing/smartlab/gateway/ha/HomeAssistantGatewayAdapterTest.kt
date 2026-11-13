package cn.zhijing.smartlab.gateway.ha

import cn.zhijing.smartlab.gateway.GatewayConfig
import cn.zhijing.smartlab.gateway.RawCommand
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeAssistantGatewayAdapterTest {
  private var server: TinyHttpServer? = null

  @After fun close() { server?.close() }

  @Test fun commandConfirmsOnlyAfterAuthoritativeStateChanges() = runBlocking {
    var brightness = 255
    val adapter = adapter { request ->
      when {
        request.path.startsWith("/api/services/light/") -> {
          Regex("\\\"brightness_pct\\\":(\\d+)").find(request.body)?.groupValues?.get(1)?.toInt()?.let {
            brightness = kotlin.math.round(it / 100.0 * 255).toInt()
          }
          "[]"
        }
        request.path.contains("gateway") -> state("sensor.gateway", "192.168.1.2", "{}")
        else -> state("light.test", "on", "{\"brightness\":$brightness,\"color_temp_kelvin\":4000}")
      }
    }
    adapter.start(config())
    val ack = adapter.send(RawCommand("req-1", "light.test", "brightness", JsonPrimitive(62)))
    assertTrue(ack.accepted)
    assertTrue(ack.trustedConfirmation)
    adapter.stop()
  }

  @Test fun commandFailsClosedWhenStateNeverMatches() = runBlocking {
    val adapter = adapter(timeout = 1_000) { request ->
      when {
        request.path.startsWith("/api/services/") -> "[]"
        request.path.contains("gateway") -> state("sensor.gateway", "192.168.1.2", "{}")
        else -> state("light.test", "off", "{\"brightness\":0}")
      }
    }
    adapter.start(config())
    val ack = adapter.send(RawCommand("req-2", "light.test", "power", JsonPrimitive(true)))
    assertTrue(ack.accepted)
    assertFalse(ack.trustedConfirmation)
    assertEquals("HA_STATE_CONFIRMATION_TIMEOUT", ack.error)
    adapter.stop()
  }

  @Test fun invalidPowerValueIsRejectedWithoutCallingHomeAssistant() = runBlocking {
    var serviceCalls = 0
    val adapter = adapter { request ->
      when {
        request.path.startsWith("/api/services/") -> {
          serviceCalls += 1
          "[]"
        }
        request.path.contains("gateway") -> state("sensor.gateway", "192.168.1.2", "{}")
        else -> state("light.test", "on", "{\"brightness\":255,\"color_temp_kelvin\":4000}")
      }
    }
    adapter.start(config())
    val ack = adapter.send(RawCommand("req-invalid", "light.test", "power", JsonPrimitive("off")))
    assertFalse(ack.accepted)
    assertFalse(ack.trustedConfirmation)
    assertEquals("HA_VALUE_INVALID", ack.error)
    assertEquals(0, serviceCalls)
    adapter.stop()
  }

  @Test fun discoveryUsesAuthoritativeColorTemperatureRangeAndEffectOptions() = runBlocking {
    var effect = "空场景（灯不在任何情况模式时，上报该属性值）"
    val adapter = adapter { request ->
      when {
        request.path.startsWith("/api/services/light/") -> {
          Regex("\\\"effect\\\":\\\"([^\\\"]+)\\\"").find(request.body)?.groupValues?.get(1)?.let { effect = it }
          "[]"
        }
        request.path.contains("gateway") -> state("sensor.gateway", "192.168.1.2", "{}")
        else -> state(
          "light.test",
          "on",
          """{"brightness":128,"color_temp_kelvin":2700,"min_color_temp_kelvin":2700,"max_color_temp_kelvin":5700,"supported_color_modes":["color_temp"],"effect_list":["空场景（灯不在任何情况模式时，上报该属性值）","夜灯模式"],"effect":"$effect"}""",
        )
      }
    }
    adapter.start(config())
    val light = adapter.discover().first { it.externalId == "light.test" }
    val colorTemperature = light.capabilities.first { it.property == "colorTemperature" }
    val effects = light.capabilities.first { it.property == "effect" }
    assertEquals(2700.0, colorTemperature.minimum!!, 0.0)
    assertEquals(5700.0, colorTemperature.maximum!!, 0.0)
    assertEquals(listOf("常规", "夜灯"), effects.options!!.map { it.label })
    val ack = adapter.send(RawCommand("req-effect", "light.test", "effect", JsonPrimitive("夜灯模式")))
    assertTrue(ack.accepted)
    assertTrue(ack.trustedConfirmation)
    adapter.stop()
  }

  @Test fun startupSnapshotUsesCurrentObservationTimeEvenWhenHaStateHasNotChangedRecently() = runBlocking {
    val adapter = adapter { request ->
      when {
        request.path.contains("gateway") -> state("sensor.gateway", "192.168.1.2", "{}")
        else -> state("light.test", "on", "{\"brightness\":128}")
      }
    }
    val startedAt = java.time.Instant.now().minusSeconds(1)
    adapter.start(config())

    val startupEvents = adapter.events().take(2).toList()
    assertEquals(setOf("power", "brightness"), startupEvents.map { it.property }.toSet())
    assertTrue(startupEvents.all { java.time.Instant.parse(it.occurredAt).isAfter(startedAt) })
    assertTrue(startupEvents.none { it.occurredAt == "2026-07-27T00:00:00Z" })
    adapter.stop()
  }

  @Test fun readOnlyHealthCheckCannotConsumeAChangeBeforeTheEventPollerPublishesIt() = runBlocking {
    var brightness = 128
    val adapter = adapter { request ->
      when {
        request.path.contains("gateway") -> state("sensor.gateway", "192.168.1.2", "{}")
        else -> state("light.test", "on", "{\"brightness\":$brightness}")
      }
    }
    adapter.start(config())
    val events = mutableListOf<cn.zhijing.smartlab.gateway.RawGatewayEvent>()
    val collector = launch { adapter.events().take(3).toList(events) }

    brightness = 200
    assertTrue(adapter.health().online)
    withTimeout(2_000) { collector.join() }

    assertEquals(78, events.last { it.property == "brightness" }.value.jsonPrimitive.intOrNull)
    adapter.stop()
  }

  @Test fun pollingFailureForcesAnAuthoritativeReplayWhenHaRecoversWithUnchangedValues() = runBlocking {
    var unavailable = false
    val adapter = adapter { request ->
      if (unavailable) "not-json" else
      when {
        request.path.contains("gateway") -> state("sensor.gateway", "192.168.1.2", "{}")
        else -> state("light.test", "on", "{\"brightness\":128}")
      }
    }
    adapter.start(config())
    val events = mutableListOf<cn.zhijing.smartlab.gateway.RawGatewayEvent>()
    val collector = launch { adapter.events().take(4).toList(events) }

    unavailable = true
    delay(700)
    unavailable = false
    withTimeout(2_000) { collector.join() }

    assertEquals(2, events.count { it.property == "power" })
    assertEquals(2, events.count { it.property == "brightness" })
    adapter.stop()
  }

  @Test fun validUnavailableHealthAlsoForcesReplayWhenEntityRecoversUnchanged() = runBlocking {
    var unavailable = false
    val adapter = adapter { request ->
      when {
        request.path.contains("gateway") -> state("sensor.gateway", "192.168.1.2", "{}")
        unavailable -> state("light.test", "unavailable", "{}")
        else -> state("light.test", "on", "{\"brightness\":128}")
      }
    }
    adapter.start(config())
    val events = mutableListOf<cn.zhijing.smartlab.gateway.RawGatewayEvent>()
    val collector = launch { adapter.events().take(4).toList(events) }

    // HA 的 unavailable 是合法响应，不会走异常分支；健康检查却会据此把灯置离线。
    unavailable = true
    assertFalse(adapter.health().online)
    unavailable = false
    withTimeout(2_000) { collector.join() }

    assertEquals(2, events.count { it.property == "power" })
    assertEquals(2, events.count { it.property == "brightness" })
    adapter.stop()
  }

  private fun adapter(timeout: Long = 2_000, handler: (Request) -> String): HomeAssistantGatewayAdapter {
    server = TinyHttpServer(handler)
    return HomeAssistantGatewayAdapter(
      HomeAssistantCredential("http://127.0.0.1:${server!!.port}", "secret", "sensor.gateway", "light.test", 500, timeout)
    )
  }

  private fun config() = GatewayConfig("gateway-main", "http://127.0.0.1", server!!.port, "keystore://gateway-main")
  private fun state(entity: String, state: String, attributes: String) =
    "{\"entity_id\":\"$entity\",\"state\":\"$state\",\"attributes\":$attributes,\"last_updated\":\"2026-07-27T00:00:00Z\"}"
}

private data class Request(val path: String, val body: String)

private class TinyHttpServer(private val handler: (Request) -> String) {
  private val socket = ServerSocket(0)
  private val running = AtomicBoolean(true)
  val port: Int = socket.localPort

  init {
    thread(isDaemon = true, name = "ha-adapter-test-server") {
      while (running.get()) runCatching { socket.accept() }.getOrNull()?.let(::handle)
    }
  }

  private fun handle(client: Socket) = client.use { connection ->
    val reader = BufferedReader(InputStreamReader(connection.getInputStream()))
    val requestLine = reader.readLine().orEmpty()
    val path = requestLine.split(' ').getOrNull(1).orEmpty()
    var contentLength = 0
    while (true) {
      val line = reader.readLine() ?: break
      if (line.isEmpty()) break
      if (line.startsWith("Content-Length:", ignoreCase = true)) contentLength = line.substringAfter(':').trim().toInt()
    }
    val body = CharArray(contentLength).also { if (contentLength > 0) reader.read(it) }.concatToString()
    val payload = handler(Request(path, body)).toByteArray()
    connection.getOutputStream().run {
      write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${payload.size}\r\nConnection: close\r\n\r\n".toByteArray())
      write(payload)
      flush()
    }
  }

  fun close() {
    running.set(false)
    socket.close()
  }
}
