package cn.zhijing.smartlab.edgecore

import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedApiContractTest {
  private val json = Json { ignoreUnknownKeys = true }
  private val terminalToken = "contract-primary-terminal-token"

  @Test
  fun `Kotlin EdgeCore passes the language-neutral shared API contract suite`() = testApplication {
    val repository = FakeRepository()
    val server = EdgeCoreServer(repository, adminPin = "2468", primaryToken = terminalToken)
    application { with(server) { module() } }
    val cases = SharedApiContractTest::class.java.classLoader
      ?.getResourceAsStream("api-contract-cases.json")
      ?.bufferedReader()
      ?.use { json.decodeFromString<List<SharedContractCase>>(it.readText()) }
    assertNotNull("shared contract fixture must be available to Kotlin tests", cases)

    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json)
      setBody("""{"pin":"2468"}""")
    }
    val adminToken = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    val variables = mapOf("writableDeviceId" to "light-1", "sceneId" to "scene-test")
    fun interpolate(value: String) = variables.entries.fold(value) { result, (key, replacement) ->
      result.replace("{{$key}}", replacement)
    }
    val websocketClient = createClient { install(WebSockets) }

    cases!!.forEach { contractCase ->
      val path = interpolate(contractCase.path)
      if (contractCase.method == "WS") {
        val ticketResponse = client.post("/api/v1/terminals/event-ticket") { bearerAuth(terminalToken) }
        val ticket = json.parseToJsonElement(ticketResponse.bodyAsText()).jsonObject["data"]!!.jsonObject["ticket"]!!.jsonPrimitive.content
        websocketClient.webSocket("$path?surface=primary&ticket=$ticket") {
          val event = json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
          assertEquals(contractCase.name, "snapshot", event["type"]?.jsonPrimitive?.content)
          assertTrue(contractCase.name, event["sequence"]?.jsonPrimitive?.longOrNull != null)
          val payload = event["payload"]
          assertTrue(contractCase.name, payload is JsonObject)
          contractCase.requiredDataKeys.forEach { key -> assertTrue("${contractCase.name}: $key", key in (payload as JsonObject)) }
        }
        return@forEach
      }
      val response = client.request(path) {
        method = HttpMethod.parse(contractCase.method)
        if (contractCase.auth == "admin") bearerAuth(adminToken)
        if (contractCase.auth == "terminal") bearerAuth(terminalToken)
        contractCase.requestBody?.let {
          contentType(ContentType.Application.Json)
          setBody(interpolate(it.toString()))
        }
      }
      assertEquals(contractCase.name, contractCase.expectedStatus, response.status.value)
      val body = json.parseToJsonElement(response.bodyAsText()).jsonObject
      if (contractCase.bodyKind == "error") {
        assertTrue(contractCase.name, body["error"]?.jsonPrimitive?.content?.isNotBlank() == true)
        return@forEach
      }
      assertTrue(contractCase.name, body["sequence"]?.jsonPrimitive?.longOrNull != null)
      val data = body["data"]
      when (contractCase.dataKind) {
        "array" -> assertTrue(contractCase.name, data is JsonArray)
        "object" -> {
          assertTrue(contractCase.name, data is JsonObject)
          contractCase.requiredDataKeys.forEach { key -> assertTrue("${contractCase.name}: $key", key in (data as JsonObject)) }
        }
      }
    }
  }
}

@Serializable
private data class SharedContractCase(
  val name: String,
  val method: String,
  val path: String,
  val auth: String,
  val expectedStatus: Int,
  val bodyKind: String,
  val dataKind: String,
  val requestBody: JsonElement? = null,
  val requiredDataKeys: List<String>,
)
