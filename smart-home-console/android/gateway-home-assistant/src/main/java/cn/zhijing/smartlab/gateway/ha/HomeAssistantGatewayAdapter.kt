package cn.zhijing.smartlab.gateway.ha

import cn.zhijing.smartlab.gateway.GatewayAdapter
import cn.zhijing.smartlab.gateway.GatewayConfig
import cn.zhijing.smartlab.gateway.GatewayHealth
import cn.zhijing.smartlab.gateway.RawCommand
import cn.zhijing.smartlab.gateway.RawCommandAck
import cn.zhijing.smartlab.gateway.RawCapability
import cn.zhijing.smartlab.gateway.RawCapabilityOption
import cn.zhijing.smartlab.gateway.RawDevice
import cn.zhijing.smartlab.gateway.RawGatewayEvent
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonArray

@Serializable
data class HomeAssistantCredential(
  val baseUrl: String,
  val token: String,
  val gatewayEntityId: String,
  val lightEntityId: String,
  val pollIntervalMs: Long = 2_000,
  val confirmationTimeoutMs: Long = 10_000,
) {
  init {
    require(baseUrl.startsWith("http://") || baseUrl.startsWith("https://")) { "HA_URL_INVALID" }
    require(token.isNotBlank()) { "HA_TOKEN_MISSING" }
    require(gatewayEntityId.startsWith("sensor.")) { "HA_GATEWAY_ENTITY_INVALID" }
    require(lightEntityId.startsWith("light.")) { "HA_LIGHT_ENTITY_INVALID" }
    require(pollIntervalMs in 500..60_000) { "HA_POLL_INTERVAL_INVALID" }
    require(confirmationTimeoutMs in 1_000..30_000) { "HA_CONFIRMATION_TIMEOUT_INVALID" }
  }
}

/**
 * 通过 HA 官方 REST API 接入 Xiaomi Home。该适配器明确是云链路，不声明 DMWG03LM 本地控制。
 * HTTP 2xx 只代表 HA 接受请求；只有实体权威状态达到目标才返回 trustedConfirmation=true。
 */
class HomeAssistantGatewayAdapter(
  private val credential: HomeAssistantCredential,
  private val requestTimeoutMs: Int = 5_000,
) : GatewayAdapter {
  private val json = Json { ignoreUnknownKeys = true }
  private val eventFlow = MutableSharedFlow<RawGatewayEvent>(replay = 8, extraBufferCapacity = 32)
  private var config: GatewayConfig? = null
  private var scope: CoroutineScope? = null
  private var polling: Job? = null
  // 只记录已经作为事件发布的基线。health/discover 的只读请求不能提前“吃掉”
  // 下一次轮询应发布的变化；链路失败后清空，使恢复时即使属性值没变也重发权威首帧。
  @Volatile private var lastEmittedSnapshot: Snapshot? = null

  override suspend fun start(config: GatewayConfig) {
    require(config.host.isNotBlank()) { "HA_URL_MISSING" }
    this.config = config
    snapshot(emitChanges = true)
    scope = CoroutineScope(SupervisorJob() + Dispatchers.IO).also { worker ->
      polling = worker.launch {
        while (isActive) {
          delay(credential.pollIntervalMs)
          runCatching { snapshot(emitChanges = true) }
            .onFailure { invalidateObservationBaseline() }
        }
      }
    }
  }

  override suspend fun stop() {
    polling?.cancel()
    scope?.cancel()
    polling = null
    scope = null
  }

  override suspend fun discover(): List<RawDevice> {
    val current = snapshot(emitChanges = false)
    return listOf(
      RawDevice(credential.gatewayEntityId, "lumi.gateway.mcn001", gatewayConfig().id, mapOf("ipAddress" to JsonPrimitive(current.gatewayIp))),
      RawDevice(
        credential.lightEntityId,
        "xiaomi.light.btlm2",
        gatewayConfig().id,
        current.light.properties(),
        current.light.capabilities,
      ),
    )
  }

  override fun events(): Flow<RawGatewayEvent> = eventFlow

  override suspend fun send(command: RawCommand): RawCommandAck {
    if (command.externalId != credential.lightEntityId) {
      return RawCommandAck(command.requestId, false, error = "HA_ENTITY_NOT_MAPPED")
    }
    val body = mutableMapOf<String, JsonElement>("entity_id" to JsonPrimitive(credential.lightEntityId))
    val service = when (command.property) {
      "power" -> when (command.value.jsonPrimitive.booleanOrNull) {
        true -> "turn_on"
        false -> "turn_off"
        null -> return RawCommandAck(command.requestId, false, error = "HA_VALUE_INVALID")
      }
      "brightness" -> if (command.value.jsonPrimitive.intOrNull != null) {
        "turn_on".also { body["brightness_pct"] = command.value }
      } else return RawCommandAck(command.requestId, false, error = "HA_VALUE_INVALID")
      "colorTemperature" -> if (command.value.jsonPrimitive.intOrNull != null) {
        "turn_on".also { body["color_temp_kelvin"] = command.value }
      } else return RawCommandAck(command.requestId, false, error = "HA_VALUE_INVALID")
      "effect" -> if (command.value.jsonPrimitive.isString) {
        "turn_on".also { body["effect"] = command.value }
      } else return RawCommandAck(command.requestId, false, error = "HA_VALUE_INVALID")
      else -> return RawCommandAck(command.requestId, false, error = "HA_PROPERTY_UNSUPPORTED")
    }
    return runCatching {
      request("/api/services/light/$service", "POST", JsonObject(body).toString())
      val deadline = System.currentTimeMillis() + credential.confirmationTimeoutMs
      while (System.currentTimeMillis() < deadline) {
        val confirmed = snapshot(emitChanges = true)
        if (confirmed.light.matches(command.property, command.value)) {
          return RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
        }
        delay(350)
      }
      RawCommandAck(command.requestId, accepted = true, trustedConfirmation = false, error = "HA_STATE_CONFIRMATION_TIMEOUT")
    }.getOrElse { RawCommandAck(command.requestId, false, error = safeError(it)) }
  }

  override suspend fun health(): GatewayHealth = runCatching {
    val started = System.nanoTime()
    val current = snapshot(emitChanges = false)
    val online = current.gatewayOnline && current.light.online
    // HA 对实体返回合法的 unavailable/unknown 并不会抛 HTTP/JSON 异常，但它同样
    // 会让 EdgeCore 把网关及子设备置离线。此时必须失效已发布基线：否则灯恢复后
    // 若开关/亮度等数值未改变，轮询会误认为“没有变化”而不重发权威首帧，设备会
    // 永久停留在 offline，APK 内全部控制按钮被锁死，直到实体属性再次发生变化。
    if (!online) invalidateObservationBaseline()
    GatewayHealth(
      gatewayConfig().id,
      online,
      (System.nanoTime() - started) / 1_000_000,
      firmware = "1.0.8_0013",
      detail = "HA 官方 Xiaomi Home 云链路",
    )
  }.getOrElse {
    invalidateObservationBaseline()
    GatewayHealth(gatewayConfig().id, false, 0, firmware = "1.0.8_0013", detail = safeError(it))
  }

  private suspend fun snapshot(emitChanges: Boolean): Snapshot {
    // HA REST 返回的是“此刻读取到的权威实体状态”。last_updated 可能早于本次
    // EdgeCore 启动（例如灯一整晚没有变化），不能拿它作为本次在线观测时间；
    // 否则启动恢复流程会把设备置离线，随后又把首帧误判为旧/重复事件，设备将
    // 一直保持离线直到物理状态再次变化。
    val observedAt = Instant.now().toString()
    val gateway = state(credential.gatewayEntityId)
    val lightState = state(credential.lightEntityId)
    val minimumColorTemperature = lightState.attributes["min_color_temp_kelvin"]?.jsonPrimitive?.intOrNull
    val maximumColorTemperature = lightState.attributes["max_color_temp_kelvin"]?.jsonPrimitive?.intOrNull
    val supportedColorModes = lightState.attributes["supported_color_modes"]?.let { element ->
      runCatching { element.jsonArray.mapNotNull { it.jsonPrimitive.content.takeIf(String::isNotBlank) } }.getOrDefault(emptyList())
    }.orEmpty()
    val effects = lightState.attributes["effect_list"]?.let { element ->
      runCatching { element.jsonArray.mapNotNull { it.jsonPrimitive.content.takeIf(String::isNotBlank) } }.getOrDefault(emptyList())
    }.orEmpty()
    val capabilities = buildList {
      add(RawCapability("power", "电源", "boolean", writable = true))
      add(RawCapability("brightness", "亮度", "number", 1.0, 100.0, 1.0, "%", true))
      if ("color_temp" in supportedColorModes && minimumColorTemperature != null && maximumColorTemperature != null) {
        add(RawCapability("colorTemperature", "色温", "number", minimumColorTemperature.toDouble(), maximumColorTemperature.toDouble(), 100.0, "K", true))
      }
      if (effects.isNotEmpty()) {
        add(RawCapability("effect", "灯效", "enum", writable = true, options = effects.map {
          RawCapabilityOption(friendlyEffectLabel(it), JsonPrimitive(it))
        }))
      }
    }
    val next = Snapshot(
      gatewayOnline = gateway.state !in unavailableStates,
      gatewayIp = gateway.state,
      light = LightState(
        online = lightState.state !in unavailableStates,
        power = lightState.state == "on",
        brightness = lightState.attributes["brightness"]?.jsonPrimitive?.intOrNull?.let { kotlin.math.round((it / 255.0) * 100).toInt().coerceIn(0, 100) } ?: 0,
        colorTemperature = lightState.attributes["color_temp_kelvin"]?.jsonPrimitive?.intOrNull ?: 0,
        effect = lightState.attributes["effect"]?.jsonPrimitive?.content,
        capabilities = capabilities,
        updatedAt = observedAt,
      ),
    )
    if (emitChanges) {
      val before = lastEmittedSnapshot
      if (next.light.online) {
        next.light.properties().forEach { (property, value) ->
          if (before?.light?.properties()?.get(property) != value) {
            eventFlow.emit(RawGatewayEvent(gatewayConfig().id, credential.lightEntityId, property, value, next.light.updatedAt))
          }
        }
      }
      lastEmittedSnapshot = next.takeIf { it.light.online }
    }
    return next
  }

  private fun invalidateObservationBaseline() {
    lastEmittedSnapshot = null
  }

  private fun state(entityId: String): HaEntityState {
    val payload = request("/api/states/${java.net.URLEncoder.encode(entityId, Charsets.UTF_8.name())}")
    return json.decodeFromString(HaEntityState.serializer(), payload)
  }

  private fun request(path: String, method: String = "GET", body: String? = null): String {
    val connection = URL("${baseUrl()}$path").openConnection() as HttpURLConnection
    connection.requestMethod = method
    connection.connectTimeout = requestTimeoutMs
    connection.readTimeout = requestTimeoutMs
    connection.setRequestProperty("Authorization", "Bearer ${credential.token}")
    connection.setRequestProperty("Content-Type", "application/json")
    connection.useCaches = false
    try {
      if (body != null) {
        connection.doOutput = true
        connection.outputStream.bufferedWriter().use { it.write(body) }
      }
      val code = connection.responseCode
      val stream = if (code in 200..299) connection.inputStream else connection.errorStream
      val response = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
      if (code !in 200..299) error("HA_HTTP_$code")
      return response
    } finally {
      connection.disconnect()
    }
  }

  private fun baseUrl(): String {
    return credential.baseUrl.trimEnd('/')
  }

  private fun gatewayConfig() = config ?: error("HA_ADAPTER_NOT_STARTED")
  private fun safeError(error: Throwable) = (error.message ?: error::class.simpleName ?: "HA_REQUEST_FAILED").take(200)

  private data class Snapshot(val gatewayOnline: Boolean, val gatewayIp: String, val light: LightState)
  private data class LightState(
    val online: Boolean,
    val power: Boolean,
    val brightness: Int,
    val colorTemperature: Int,
    val effect: String?,
    val capabilities: List<RawCapability>,
    val updatedAt: String,
  ) {
    fun properties() = buildMap {
      put("power", JsonPrimitive(power))
      put("brightness", JsonPrimitive(brightness))
      if (capabilities.any { it.property == "colorTemperature" }) put("colorTemperature", JsonPrimitive(colorTemperature))
      effect?.let { put("effect", JsonPrimitive(it)) }
    }

    fun matches(property: String, expected: JsonElement): Boolean {
      val actual = properties()[property] ?: return false
      val expectedNumber = expected.jsonPrimitive.intOrNull
      val actualNumber = actual.jsonPrimitive.intOrNull
      return if (expectedNumber != null && actualNumber != null) {
        kotlin.math.abs(expectedNumber - actualNumber) <= if (property == "colorTemperature") 100 else 1
      } else actual == expected
    }
  }

  companion object { private val unavailableStates = setOf("unknown", "unavailable", "") }
}

private fun friendlyEffectLabel(effect: String) = if (effect.startsWith("空场景")) "常规" else effect.removeSuffix("模式")

@Serializable
private data class HaEntityState(
  @kotlinx.serialization.SerialName("entity_id") val entityId: String,
  val state: String,
  val attributes: JsonObject = JsonObject(emptyMap()),
  @kotlinx.serialization.SerialName("last_updated") val lastUpdated: String = "",
)
