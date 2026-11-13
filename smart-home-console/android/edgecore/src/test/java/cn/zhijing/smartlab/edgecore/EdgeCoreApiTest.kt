package cn.zhijing.smartlab.edgecore

import io.ktor.client.request.*
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import cn.zhijing.smartlab.gateway.RawGatewayEvent
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.MutableSharedFlow
import cn.zhijing.smartlab.gateway.GatewayHealth
import kotlinx.serialization.json.JsonPrimitive
import io.ktor.websocket.Frame
import io.ktor.websocket.CloseReason
import io.ktor.websocket.readText
import java.time.Instant
import java.io.ByteArrayInputStream
import kotlinx.coroutines.withTimeout

class EdgeCoreApiTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `formal bench reset requires admin preserves operational records and uses trusted command confirmations`() = testApplication {
    val repository = FakeRepository()
    repository.saveConfirmedProperty(repository.device("light-1")!!.copy(state = repository.device("light-1")!!.state + ("power" to JsonPrimitive(true))), "power", JsonPrimitive(true))
    val server = EdgeCoreServer(repository, adminPin = "2468", adapterForDevice = { TrustedAdapter })
    application { with(server) { module() } }

    assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/admin/bench-reset/preview").status)
    assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/admin/bench-reset").status)
    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json); setBody("""{"pin":"2468"}""")
    }
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    val preview = client.get("/api/v1/admin/bench-reset/preview") { bearerAuth(token) }
    assertEquals(HttpStatusCode.OK, preview.status)
    assertTrue(preview.bodyAsText().contains("审计记录"))
    val result = client.post("/api/v1/admin/bench-reset") { bearerAuth(token); contentType(ContentType.Application.Json); setBody("{}") }
    assertEquals(HttpStatusCode.OK, result.status)
    assertEquals(JsonPrimitive(false), repository.device("light-1")?.state?.get("power"))
    assertTrue(repository.audits().any { it.action == "设备安全复位" })
  }

  @Test
  fun `formal bench reset refuses active critical alerts`() = testApplication {
    val repository = FakeRepository()
    repository.saveAlert(AlertDto("critical-active", "water-1", "critical", "检测到水浸", "需现场处置", "2026-07-25T00:20:00Z"))
    val server = EdgeCoreServer(repository, adminPin = "2468", adapterForDevice = { TrustedAdapter })
    application { with(server) { module() } }
    val login = client.post("/api/v1/admin/login") { contentType(ContentType.Application.Json); setBody("""{"pin":"2468"}""") }
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    assertEquals(HttpStatusCode.Conflict, client.post("/api/v1/admin/bench-reset") { bearerAuth(token); contentType(ContentType.Application.Json); setBody("{}") }.status)
    assertTrue(repository.commands().isEmpty())
  }

  @Test
  fun `admin pin rotation requires authentication and durable secret storage`() = testApplication {
    val server = EdgeCoreServer(FakeRepository(), adminPin = "2468")
    application { with(server) { module() } }
    val body = """{"currentPin":"2468","newPin":"135790","confirmPin":"135790"}"""

    assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/admin/change-pin") {
      contentType(ContentType.Application.Json); setBody(body)
    }.status)
    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json); setBody("""{"pin":"2468"}""")
    }
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    assertEquals(HttpStatusCode.NotImplemented, client.post("/api/v1/admin/change-pin") {
      bearerAuth(token); contentType(ContentType.Application.Json); setBody(body)
    }.status)
    assertEquals(HttpStatusCode.OK, client.get("/api/v1/admin/config") { bearerAuth(token) }.status)
  }

  @Test
  fun `admin pin rotation persists revokes all sessions and never exposes either pin in audit`() = testApplication {
    val repository = FakeRepository()
    var persisted = "2468"
    val server = EdgeCoreServer(repository, adminPin = persisted, adminPinUpdater = { persisted = it })
    application { with(server) { module() } }
    suspend fun login(pin: String): String {
      val response = client.post("/api/v1/admin/login") {
        contentType(ContentType.Application.Json); setBody("""{"pin":"$pin"}""")
      }
      assertEquals(HttpStatusCode.OK, response.status)
      return json.parseToJsonElement(response.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    }
    val first = login("2468")
    val second = login("2468")
    val changed = client.post("/api/v1/admin/change-pin") {
      bearerAuth(first); contentType(ContentType.Application.Json)
      setBody("""{"currentPin":"2468","newPin":"135790","confirmPin":"135790"}""")
    }
    assertEquals(HttpStatusCode.OK, changed.status)
    assertEquals("135790", persisted)
    assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/admin/config") { bearerAuth(first) }.status)
    assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/admin/config") { bearerAuth(second) }.status)
    assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json); setBody("""{"pin":"2468"}""")
    }.status)
    assertTrue(client.get("/api/v1/admin/config") { bearerAuth(login("135790")) }.status == HttpStatusCode.OK)
    val audit = repository.audits().single { it.action == "轮换管理员 PIN" }
    assertFalse(audit.detail.contains("2468"))
    assertFalse(audit.detail.contains("135790"))
  }

  @Test
  fun `database backups require admin and stream only allowlisted artifacts with audit`() = testApplication {
    val repository = FakeRepository()
    val filename = "smart-lab-2026-07-25T03-00-00.000Z.db"
    val bytes = "sqlite-backup-evidence".encodeToByteArray()
    val artifact = DatabaseBackupArtifactDto(
      filename, "2026-07-25T03:00:00Z", bytes.size.toLong(), "a".repeat(64), "ok", 11, "2026-07-25T03:00:01Z",
    )
    val storage = DatabaseBackupStorageDto(8_000_000_000, 4_000_000_000, 268_435_456, 16_777_216, true, "healthy", "存储余量满足下一次数据库快照")
    val lifecycle = DataLifecycleReportDto(
      "2026-07-25T03:00:02Z", 32_000_000, 4_000_000_000, 268_435_456, 1_000_000, 3_731, 7, "healthy", "长期数据增长与当前存储余量正常",
      listOf(DataDomainFootprintDto("audits", "审计证据", 620, "2026-01-01T00:00:00Z", "authoritative", false, "不允许按条数截断")),
    )
    val coordinator = object : DatabaseBackupCoordinator {
      override suspend fun list() = listOf(artifact)
      override suspend fun storage() = storage
      override suspend fun lifecycle() = lifecycle
      override suspend fun create() = artifact
      override suspend fun open(filename: String) = if (filename == artifact.filename) ByteArrayInputStream(bytes) else null
    }
    val server = EdgeCoreServer(repository, adminPin = "2468", databaseBackupCoordinator = coordinator)
    application { with(server) { module() } }

    assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/admin/database-backups").status)
    assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/admin/database-backups/storage").status)
    assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/admin/data-lifecycle").status)
    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json)
      setBody("""{"pin":"2468"}""")
    }
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    val list = client.get("/api/v1/admin/database-backups") { bearerAuth(token) }
    assertEquals(HttpStatusCode.OK, list.status)
    assertTrue(list.bodyAsText().contains(filename))
    assertTrue(list.bodyAsText().contains("\"integrityStatus\":\"ok\""))
    val storageResponse = client.get("/api/v1/admin/database-backups/storage") { bearerAuth(token) }
    assertEquals(HttpStatusCode.OK, storageResponse.status)
    assertTrue(storageResponse.bodyAsText().contains("\"canCreate\":true"))
    val lifecycleResponse = client.get("/api/v1/admin/data-lifecycle") { bearerAuth(token) }
    assertEquals(HttpStatusCode.OK, lifecycleResponse.status)
    assertTrue(lifecycleResponse.bodyAsText().contains("\"protection\":\"authoritative\""))
    assertTrue(lifecycleResponse.bodyAsText().contains("\"automaticDeletion\":false"))
    assertEquals(HttpStatusCode.OK, client.post("/api/v1/admin/database-backups") {
      bearerAuth(token); contentType(ContentType.Application.Json); setBody("{}")
    }.status)
    val download = client.get("/api/v1/admin/database-backups/$filename") { bearerAuth(token) }
    assertEquals(HttpStatusCode.OK, download.status)
    assertEquals("sqlite-backup-evidence", download.bodyAsText())
    assertTrue(download.headers[HttpHeaders.ContentDisposition].orEmpty().contains(filename))
    assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/admin/database-backups/%2E%2E%2Fsecret.db") { bearerAuth(token) }.status)
    assertTrue(repository.audits().any { it.action == "创建数据库快照" })
    assertTrue(repository.audits().any { it.action == "导出数据库快照" })
  }

  @Test
  fun `database backup creation reports capacity exhaustion without a false success`() = testApplication {
    val repository = FakeRepository()
    val coordinator = object : DatabaseBackupCoordinator {
      override suspend fun list() = emptyList<DatabaseBackupArtifactDto>()
      override suspend fun storage() = DatabaseBackupStorageDto(1_000, 100, 256, 512, false, "critical", "剩余空间不足")
      override suspend fun lifecycle() = DataLifecycleReportDto(
        "2026-07-25T03:00:00Z", 900, 100, 256, null, null, 0, "critical", "长期数据容量已进入高风险区", emptyList(),
      )
      override suspend fun create(): DatabaseBackupArtifactDto = throw DatabaseBackupUnavailableException("数据库快照创建已暂停：剩余空间不足")
      override suspend fun open(filename: String) = null
    }
    val server = EdgeCoreServer(repository, adminPin = "2468", databaseBackupCoordinator = coordinator)
    application { with(server) { module() } }
    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json); setBody("""{"pin":"2468"}""")
    }
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    val response = client.post("/api/v1/admin/database-backups") {
      bearerAuth(token); contentType(ContentType.Application.Json); setBody("{}")
    }
    assertEquals(HttpStatusCode.fromValue(507), response.status)
    assertTrue(response.bodyAsText().contains("剩余空间不足"))
    assertTrue(repository.audits().any { it.action == "数据库快照创建失败" && it.result == "failed" })
    assertFalse(repository.audits().any { it.action == "创建数据库快照" && it.result == "success" })
  }

  @Test
  fun `formal server consumes trusted gateway events into the alert lifecycle`() = testApplication {
    val repository = FakeRepository()
    val server = EdgeCoreServer(
      repository,
      gatewayEvents = flowOf(
        RawGatewayEvent("gateway", "water-1", "waterLeak", JsonPrimitive(true), "2026-07-25T00:00:00Z"),
      ),
    )
    application { with(server) { module() } }

    assertEquals(HttpStatusCode.OK, client.get("/api/v1/health").status)
    repeat(20) {
      if (repository.alertValues.isNotEmpty()) return@repeat
      delay(10)
    }

    val alert = repository.alertValues.values.single()
    assertEquals("检测到水浸", alert.title)
    assertEquals("waterLeak", alert.recoveryProperty)
    assertEquals(JsonPrimitive(false), alert.recoveryValue)
  }

  @Test
  fun `formal server consumes gateway health outage and cascades child devices offline`() = testApplication {
    val repository = FakeRepository()
    val healthEvents = MutableSharedFlow<GatewayHealth>(extraBufferCapacity = 1)
    val server = EdgeCoreServer(repository, gatewayHealthEvents = healthEvents)
    application { with(server) { module() } }
    assertEquals(HttpStatusCode.OK, client.get("/api/v1/health").status)

    healthEvents.emit(GatewayHealth("gateway", false, 0, detail = "adapter disconnected"))
    repeat(50) {
      if (repository.device("light-1")?.health == "offline") return@repeat
      delay(10)
    }

    assertEquals("offline", repository.device("light-1")?.health)
    assertTrue(repository.audits().any { it.action == "网关连接中断" && it.source == "gateway" })
  }

  @Test
  fun `embedded WebView preflight permits bearer and version headers`() = testApplication {
    val server = EdgeCoreServer(FakeRepository(), adminPin = "2468", primaryToken = "primary-cors-token")
    application { with(server) { module() } }

    val preflight = client.options("/api/v1/snapshot") {
      header(HttpHeaders.Origin, "http://appassets.androidplatform.net")
      header(HttpHeaders.AccessControlRequestMethod, HttpMethod.Get.value)
      header(HttpHeaders.AccessControlRequestHeaders, "authorization,x-smart-lab-version")
    }

    assertEquals(HttpStatusCode.OK, preflight.status)
    assertEquals("http://appassets.androidplatform.net", preflight.headers[HttpHeaders.AccessControlAllowOrigin])
    val allowed = preflight.headers[HttpHeaders.AccessControlAllowHeaders].orEmpty().lowercase()
    assertTrue("authorization" in allowed)
    assertTrue("x-smart-lab-version" in allowed)
  }

  @Test
  fun `admin routes reject unauthenticated access and accept a valid session`() = testApplication {
    val repository = FakeRepository()
    val server = EdgeCoreServer(repository, adminPin = "2468", pairingCodeProvider = { "123456" })
    application { with(server) { module() } }

    assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/admin/resources/devices").status)
    assertEquals(
      HttpStatusCode.Unauthorized,
      client.post("/api/v1/admin/login") {
        contentType(ContentType.Application.Json)
        setBody("""{"pin":"1111"}""")
      }.status,
    )

    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json)
      setBody("""{"pin":"2468"}""")
    }
    assertEquals(HttpStatusCode.OK, login.status)
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content

    val devices = client.get("/api/v1/admin/resources/devices?page=99&pageSize=1&q=%E4%B8%BB%E7%81%AF") {
      bearerAuth(token)
    }
    assertEquals(HttpStatusCode.OK, devices.status)
    val page = json.parseToJsonElement(devices.bodyAsText()).jsonObject["data"]!!.jsonObject
    assertEquals("1", page["page"]!!.jsonPrimitive.content)
    assertEquals("1", page["pageSize"]!!.jsonPrimitive.content)
    assertEquals("1", page["total"]!!.jsonPrimitive.content)
  }

  @Test
  fun `audit resource paginates and searches history beyond five hundred records`() = testApplication {
    val repository = FakeRepository()
    repeat(620) { index ->
      val id = "audit-$index"
      repository.auditValues[id] = AuditDto(
        id, "command", if (index == 0) "最早设备关键操作" else "普通操作 $index", "过程证据 $index",
        "primary", "success", "2026-07-25T00:00:${(index % 60).toString().padStart(2, '0')}Z",
      )
    }
    val server = EdgeCoreServer(repository, adminPin = "2468")
    application { with(server) { module() } }
    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json)
      setBody("""{"pin":"2468"}""")
    }
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content

    val latePage = client.get("/api/v1/admin/resources/audits?page=6&pageSize=100") { bearerAuth(token) }
    assertEquals(HttpStatusCode.OK, latePage.status)
    val lateData = json.parseToJsonElement(latePage.bodyAsText()).jsonObject["data"]!!.jsonObject
    assertEquals("620", lateData["total"]!!.jsonPrimitive.content)
    assertEquals(100, lateData["items"]!!.toString().split("\"id\"").size - 1)

    val historical = client.get("/api/v1/admin/resources/audits?q=%E6%9C%80%E6%97%A9%E8%AE%BE%E5%A4%87%E5%85%B3%E9%94%AE%E6%93%8D%E4%BD%9C&page=1&pageSize=10") { bearerAuth(token) }
    val historicalData = json.parseToJsonElement(historical.bodyAsText()).jsonObject["data"]!!.jsonObject
    assertEquals("1", historicalData["total"]!!.jsonPrimitive.content)
    assertTrue(historical.bodyAsText().contains("最早设备关键操作"))
  }

  @Test
  fun `stale admin configuration returns conflict and backup restore remains explicit replacement`() = testApplication {
    val repository = FakeRepository()
    val server = EdgeCoreServer(repository, adminPin = "2468")
    application { with(server) { module() } }
    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json)
      setBody("""{"pin":"2468"}""")
    }
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    val original = repository.adminConfiguration()

    val winner = client.put("/api/v1/admin/config") {
      bearerAuth(token)
      contentType(ContentType.Application.Json)
      setBody(json.encodeToString(AdminConfigurationDto.serializer(), original))
    }
    assertEquals(HttpStatusCode.OK, winner.status)

    val stale = client.put("/api/v1/admin/config") {
      bearerAuth(token)
      contentType(ContentType.Application.Json)
      setBody(json.encodeToString(AdminConfigurationDto.serializer(), original))
    }
    assertEquals(HttpStatusCode.Conflict, stale.status)
    assertTrue(stale.bodyAsText().contains("CONFIG_VERSION_CONFLICT"))
    assertEquals(original.version + 1, repository.adminConfiguration().version)

    val restore = client.post("/api/v1/admin/backup") {
      bearerAuth(token)
      contentType(ContentType.Application.Json)
      setBody(json.encodeToString(AdminConfigurationDto.serializer(), original))
    }
    assertEquals(HttpStatusCode.OK, restore.status)
    assertEquals(original.version + 2, repository.adminConfiguration().version)
    assertTrue(repository.audits().any { it.action == "恢复配置备份" })
  }

  @Test
  fun `admin cannot recover an alert while its authoritative condition is active`() = testApplication {
    val repository = FakeRepository()
    repository.alertValues["water-alert"] = AlertDto(
      "water-alert", "water-1", "critical", "水浸告警", "检测到水浸", "2026-07-25T00:00:00Z",
      recoveryProperty = "waterLeak", recoveryValue = kotlinx.serialization.json.JsonPrimitive(false),
    )
    val server = EdgeCoreServer(repository, adminPin = "2468")
    application { with(server) { module() } }
    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json)
      setBody("""{"pin":"2468"}""")
    }
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content

    val blocked = client.post("/api/v1/admin/alerts/water-alert/recover") {
      bearerAuth(token)
      contentType(ContentType.Application.Json)
      setBody("""{"acknowledgedWarnings":["NO_PAIRED_TERMINALS"]}""")
    }

    assertEquals(HttpStatusCode.Conflict, blocked.status)
    assertTrue(blocked.bodyAsText().contains("ALERT_CONDITION_STILL_ACTIVE"))
    assertEquals(null, repository.alertValues["water-alert"]?.recoveredAt)
  }

  @Test
  fun `secondary pairing issues a stored credential and a one-time event ticket`() = testApplication {
    val repository = FakeRepository()
    var pairingCode = "123456"
    var rotated = false
    val server = EdgeCoreServer(
      repository,
      adminPin = "2468",
      controlDomainId = "11111111-1111-4111-8111-111111111111",
      controlDomainProofKey = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() }),
      pairingCodeProvider = { pairingCode },
      pairingCodeRotator = { pairingCode = "654321"; rotated = true },
    )
    application { with(server) { module() } }

    val pair = client.post("/api/v1/terminals/pair") {
      contentType(ContentType.Application.Json)
      setBody(
        """{"pairingCode":"123456","deviceId":"android-api-test","name":"副屏","role":"secondary","version":"0.1.0"}"""
      )
    }
    assertEquals(HttpStatusCode.Created, pair.status)
    assertTrue(rotated)
    val pairData = json.parseToJsonElement(pair.bodyAsText()).jsonObject["data"]!!.jsonObject
    assertEquals("11111111-1111-4111-8111-111111111111", pairData["controlDomainId"]!!.jsonPrimitive.content)
    val nonce = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { (it + 1).toByte() })
    val derivedKey = java.util.Base64.getUrlDecoder().decode(pairData["controlDomainProofKey"]!!.jsonPrimitive.content)
    val clientProof = javax.crypto.Mac.getInstance("HmacSHA256").apply {
      init(javax.crypto.spec.SecretKeySpec(derivedKey, "HmacSHA256"))
    }.doFinal("client:11111111-1111-4111-8111-111111111111:android-api-test:$nonce".toByteArray())
    val challenge = client.post("/api/v1/control-domain/challenge") {
      contentType(ContentType.Application.Json)
      setBody("""{"deviceId":"android-api-test","nonce":"$nonce","clientProof":"${java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(clientProof)}"}""")
    }
    assertEquals(HttpStatusCode.OK, challenge.status)
    val challengeData = json.parseToJsonElement(challenge.bodyAsText()).jsonObject["data"]!!.jsonObject
    assertEquals(nonce, challengeData["nonce"]!!.jsonPrimitive.content)
    val expectedProof = javax.crypto.Mac.getInstance("HmacSHA256").apply {
      init(javax.crypto.spec.SecretKeySpec(derivedKey, "HmacSHA256"))
    }.doFinal("server:11111111-1111-4111-8111-111111111111:android-api-test:$nonce".toByteArray())
    assertEquals(
      java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(expectedProof),
      challengeData["proof"]!!.jsonPrimitive.content,
    )
    val token = pairData["token"]!!.jsonPrimitive.content
    assertTrue(repository.terminalValues.values.none { it.second == token })

    val ticket = client.post("/api/v1/terminals/event-ticket") {
      bearerAuth(token)
      header("X-Smart-Lab-Version", "0.1.1-secondary")
      contentType(ContentType.Application.Json)
      setBody("{}")
    }
    assertEquals(HttpStatusCode.OK, ticket.status)
    assertFalse(
      json.parseToJsonElement(ticket.bodyAsText()).jsonObject["data"]!!.jsonObject["ticket"]!!.jsonPrimitive.content.isBlank()
    )
    assertEquals("0.1.1-secondary", repository.terminalValues.values.single().first.version)

    repository.alertValues["alert-source"] = AlertDto(
      "alert-source", "sensor-1", "warning", "来源校验", "测试告警", "2026-07-25T00:00:00Z",
    )
    val acknowledged = client.post("/api/v1/alerts/alert-source/acknowledge") {
      bearerAuth(token)
      contentType(ContentType.Application.Json)
      setBody("""{"source":"primary"}""")
    }
    assertEquals(HttpStatusCode.OK, acknowledged.status)
    assertEquals("secondary", repository.audits().first { it.action == "来源校验" }.source)

    val command = client.post("/api/v1/devices/light-1/commands") {
      bearerAuth(token)
      contentType(ContentType.Application.Json)
      setBody("""{"requestId":"secondary-source-check","property":"brightness","value":52,"source":"admin"}""")
    }
    assertEquals(HttpStatusCode.OK, command.status)
    val commandBody = json.parseToJsonElement(command.bodyAsText()).jsonObject["data"]!!.jsonObject
    assertEquals("secondary", commandBody["source"]!!.jsonPrimitive.content)

    assertEquals(
      HttpStatusCode.Unauthorized,
      client.post("/api/v1/terminals/pair") {
        contentType(ContentType.Application.Json)
        setBody(
          """{"pairingCode":"123456","deviceId":"android-api-test-2","name":"副屏2","role":"secondary","version":"0.1.0"}"""
        )
      }.status,
    )
  }

  @Test
  fun `revoking a secondary also revokes its control domain proof`() = testApplication {
    val repository = FakeRepository()
    val domainId = "11111111-1111-4111-8111-111111111111"
    val server = EdgeCoreServer(
      repository,
      adminPin = "2468",
      controlDomainId = domainId,
      controlDomainProofKey = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() }),
      pairingCodeProvider = { "123456" },
    )
    application { with(server) { module() } }
    val pair = client.post("/api/v1/terminals/pair") {
      contentType(ContentType.Application.Json)
      setBody("""{"pairingCode":"123456","deviceId":"revoked-proof-secondary","name":"副屏","role":"secondary","version":"0.1.0"}""")
    }
    val data = json.parseToJsonElement(pair.bodyAsText()).jsonObject["data"]!!.jsonObject
    val proofKey = java.util.Base64.getUrlDecoder().decode(data["controlDomainProofKey"]!!.jsonPrimitive.content)
    val nonce = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { 7 })
    val clientProof = javax.crypto.Mac.getInstance("HmacSHA256").apply {
      init(javax.crypto.spec.SecretKeySpec(proofKey, "HmacSHA256"))
    }.doFinal("client:$domainId:revoked-proof-secondary:$nonce".toByteArray())
    repository.revokeTerminal(data["terminal"]!!.jsonObject["id"]!!.jsonPrimitive.content)

    val challenge = client.post("/api/v1/control-domain/challenge") {
      contentType(ContentType.Application.Json)
      setBody("""{"deviceId":"revoked-proof-secondary","nonce":"$nonce","clientProof":"${java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(clientProof)}"}""")
    }
    assertEquals(HttpStatusCode.Unauthorized, challenge.status)
  }

  @Test
  fun `secondary presence follows its authenticated event stream lifecycle`() = testApplication {
    val repository = FakeRepository()
    val server = EdgeCoreServer(repository, adminPin = "2468", pairingCodeProvider = { "123456" })
    application { with(server) { module() } }
    val pair = client.post("/api/v1/terminals/pair") {
      contentType(ContentType.Application.Json)
      setBody(
        """{"pairingCode":"123456","deviceId":"presence-secondary","name":"副屏","role":"secondary","version":"0.1.0"}"""
      )
    }
    val token = json.parseToJsonElement(pair.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    assertFalse(repository.terminals().single().online)
    val ticketResponse = client.post("/api/v1/terminals/event-ticket") {
      bearerAuth(token)
      header("X-Smart-Lab-Version", "0.1.1")
    }
    val ticket = json.parseToJsonElement(ticketResponse.bodyAsText()).jsonObject["data"]!!.jsonObject["ticket"]!!.jsonPrimitive.content
    assertFalse(repository.terminals().single().online)

    val websocketClient = createClient { install(WebSockets) }
    websocketClient.webSocket("/api/v1/events?surface=secondary&ticket=$ticket") {
      incoming.receive() as Frame.Text
      assertTrue(repository.terminals().single().online)
    }

    repeat(100) {
      if (!repository.terminals().single().online) return@repeat
      delay(20)
    }
    assertFalse(repository.terminals().single().online)
  }

  @Test
  fun `event ticket is role bound and consumed after a cross-role attempt`() = testApplication {
    val repository = FakeRepository()
    val server = EdgeCoreServer(repository, adminPin = "2468", pairingCodeProvider = { "123456" })
    application { with(server) { module() } }
    val pair = client.post("/api/v1/terminals/pair") {
      contentType(ContentType.Application.Json)
      setBody("""{"pairingCode":"123456","deviceId":"role-bound-secondary","name":"副屏","role":"secondary","version":"0.1.0"}""")
    }
    val token = json.parseToJsonElement(pair.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    val ticketResponse = client.post("/api/v1/terminals/event-ticket") { bearerAuth(token) }
    val ticket = json.parseToJsonElement(ticketResponse.bodyAsText()).jsonObject["data"]!!.jsonObject["ticket"]!!.jsonPrimitive.content
    val websocketClient = createClient { install(WebSockets) }

    websocketClient.webSocket("/api/v1/events?surface=primary&ticket=$ticket") {
      val reason = withTimeout(2_000) { closeReason.await() }
      assertEquals(CloseReason.Codes.VIOLATED_POLICY.code, reason?.code)
      assertEquals("TERMINAL_AUTH_REQUIRED", reason?.message)
    }
    websocketClient.webSocket("/api/v1/events?surface=secondary&ticket=$ticket") {
      val reason = withTimeout(2_000) { closeReason.await() }
      assertEquals(CloseReason.Codes.VIOLATED_POLICY.code, reason?.code)
      assertEquals("TERMINAL_AUTH_REQUIRED", reason?.message)
    }
  }

  @Test
  fun `terminal revocation invalidates token ticket and stale configuration reactivation`() = testApplication {
    val repository = FakeRepository()
    val server = EdgeCoreServer(repository, adminPin = "2468", pairingCodeProvider = { "123456" })
    application { with(server) { module() } }
    val pair = client.post("/api/v1/terminals/pair") {
      contentType(ContentType.Application.Json)
      setBody("""{"pairingCode":"123456","deviceId":"revoked-secondary","name":"待撤销副屏","role":"secondary","version":"0.1.0"}""")
    }
    val terminalData = json.parseToJsonElement(pair.bodyAsText()).jsonObject["data"]!!.jsonObject
    val terminalToken = terminalData["token"]!!.jsonPrimitive.content
    val terminalId = terminalData["terminal"]!!.jsonObject["id"]!!.jsonPrimitive.content
    val ticketResponse = client.post("/api/v1/terminals/event-ticket") { bearerAuth(terminalToken) }
    val ticket = json.parseToJsonElement(ticketResponse.bodyAsText()).jsonObject["data"]!!.jsonObject["ticket"]!!.jsonPrimitive.content
    val stale = repository.adminConfiguration()
    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json); setBody("""{"pin":"2468"}""")
    }
    val admin = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    val websocketClient = createClient { install(WebSockets) }
    websocketClient.webSocket("/api/v1/events?surface=secondary&ticket=$ticket") {
      assertTrue(incoming.receive() is Frame.Text)
      assertTrue(repository.terminals().single().online)
      val revoked = client.post("/api/v1/admin/terminals/$terminalId/revoke") { bearerAuth(admin); setBody("{}") }
      assertEquals(HttpStatusCode.OK, revoked.status)
      val reason = withTimeout(2_000) { closeReason.await() }
      assertEquals(CloseReason.Codes.VIOLATED_POLICY.code, reason?.code)
      assertEquals("TERMINAL_REVOKED", reason?.message)
    }
    assertFalse(repository.terminals().single().paired)
    assertFalse(repository.terminals().single().online)
    assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/terminals/event-ticket") { bearerAuth(terminalToken) }.status)
    val replay = stale.copy(version = repository.adminConfiguration().version)
    val restore = client.put("/api/v1/admin/config") {
      bearerAuth(admin); contentType(ContentType.Application.Json)
      setBody(json.encodeToString(AdminConfigurationDto.serializer(), replay))
    }
    assertEquals(HttpStatusCode.Conflict, restore.status)
    assertTrue(restore.bodyAsText().contains("TERMINAL_REPAIR_REQUIRES_NEW_PAIRING"))
  }

  @Test
  fun `idle event stream emits heartbeat without advancing business sequence`() = testApplication {
    val repository = FakeRepository()
    val primaryToken = "heartbeat-primary-token"
    val server = EdgeCoreServer(repository, primaryToken = primaryToken)
    application { with(server) { module() } }
    val ticketResponse = client.post("/api/v1/terminals/event-ticket") { bearerAuth(primaryToken) }
    val ticket = json.parseToJsonElement(ticketResponse.bodyAsText()).jsonObject["data"]!!.jsonObject["ticket"]!!.jsonPrimitive.content

    val websocketClient = createClient { install(WebSockets) }
    websocketClient.webSocket("/api/v1/events?surface=primary&ticket=$ticket") {
      val snapshot = json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
      val heartbeat = withTimeout(7_000) {
        json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
      }
      assertEquals("snapshot", snapshot["type"]!!.jsonPrimitive.content)
      assertEquals("heartbeat", heartbeat["type"]!!.jsonPrimitive.content)
      assertEquals(snapshot["sequence"]!!.jsonPrimitive.long, heartbeat["sequence"]!!.jsonPrimitive.long)
      Instant.parse(heartbeat["payload"]!!.jsonObject["serverTime"]!!.jsonPrimitive.content)
    }
  }

  @Test
  fun `retired training and simulator routes are absent and public payloads contain no training field`() = testApplication {
    val repository = FakeRepository()
    val primaryToken = "formal-primary-token"
    val server = EdgeCoreServer(repository, adminPin = "2468", primaryToken = primaryToken)
    application { with(server) { module() } }

    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json)
      setBody("""{"pin":"2468"}""")
    }
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    assertEquals(HttpStatusCode.NotFound, client.post("/api/v1/admin/training") { bearerAuth(token) }.status)
    assertEquals(HttpStatusCode.NotFound, client.get("/api/v1/admin/resources/training") { bearerAuth(token) }.status)
    assertEquals(HttpStatusCode.NotFound, client.post("/api/v1/simulator/reset").status)
    val snapshot = json.parseToJsonElement(client.get("/api/v1/snapshot") { bearerAuth(primaryToken) }.bodyAsText())
      .jsonObject["data"]!!.jsonObject
    val configuration = json.parseToJsonElement(client.get("/api/v1/admin/config") { bearerAuth(token) }.bodyAsText())
      .jsonObject["data"]!!.jsonObject
    assertFalse(snapshot.containsKey("training"))
    assertFalse(configuration.containsKey("training"))
  }

  @Test
  fun `formal diagnostics requires admin auth and returns provider output`() = testApplication {
    val repository = FakeRepository()
    val server = EdgeCoreServer(
      repository,
      adminPin = "2468",
      diagnosticProvider = {
        DiagnosticBundleDto(
          generatedAt = "2026-07-24T00:00:00Z",
          appVersion = "0.1.0",
          databaseVersion = 5,
          eventSequence = 7,
          health = repository.health(),
          logs = listOf("token=[REDACTED]"),
          databaseBackups = listOf("smart-lab.db"),
        )
      },
    )
    application { with(server) { module() } }

    assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/admin/diagnostics").status)
    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json)
      setBody("""{"pin":"2468"}""")
    }
    val token = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    val diagnostics = client.get("/api/v1/admin/diagnostics") { bearerAuth(token) }

    assertEquals(HttpStatusCode.OK, diagnostics.status)
    val data = json.parseToJsonElement(diagnostics.bodyAsText()).jsonObject["data"]!!.jsonObject
    assertEquals("5", data["databaseVersion"]!!.jsonPrimitive.content)
    assertEquals("0.1.0", data["appVersion"]!!.jsonPrimitive.content)
    assertTrue(repository.audits().any { it.action == "导出诊断包" })
  }

  @Test
  fun `signed UI update is admin controlled and paired secondary receives only a mismatched version`() = testApplication {
    val repository = FakeRepository()
    val primaryToken = "ui-update-primary-token"
    val updateRequest = UiUpdateInstallRequestDto("{}", "signed", mapOf("index.html" to "aW5kZXg="))
    val coordinator = object : UiUpdateCoordinator {
      private var active: String? = null
      override fun status() = UiUpdateStatusDto(true, "0.1.0", active, message = "test")
      override fun install(request: UiUpdateInstallRequestDto): UiUpdateStatusDto {
        assertEquals(updateRequest, request)
        active = "0.1.1"
        return status()
      }
      override fun rollback(): UiUpdateStatusDto { active = null; return status() }
      override fun syncPackage() = updateRequest.takeIf { active != null }
      override fun synchronize(targetVersion: String?, request: UiUpdateInstallRequestDto?) = status()
    }
    val server = EdgeCoreServer(
      repository,
      adminPin = "2468",
      pairingCodeProvider = { "123456" },
      primaryToken = primaryToken,
      uiUpdateCoordinator = coordinator,
    )
    application { with(server) { module() } }

    assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/admin/ui-update").status)
    // 即便是 loopback，主屏内嵌页面也必须携带 Keystore 主终端令牌。
    assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/ui-update/sync").status)
    assertEquals(HttpStatusCode.OK, client.get("/api/v1/ui-update/sync") { bearerAuth(primaryToken) }.status)
    val login = client.post("/api/v1/admin/login") {
      contentType(ContentType.Application.Json)
      setBody("""{"pin":"2468"}""")
    }
    val adminToken = json.parseToJsonElement(login.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    val installed = client.post("/api/v1/admin/ui-update") {
      bearerAuth(adminToken)
      contentType(ContentType.Application.Json)
      setBody("""{"manifestJson":"{}","signature":"signed","files":{"index.html":"aW5kZXg="}}""")
    }
    assertEquals(HttpStatusCode.OK, installed.status)

    val pair = client.post("/api/v1/terminals/pair") {
      contentType(ContentType.Application.Json)
      setBody("""{"pairingCode":"123456","deviceId":"ui-sync-secondary","name":"副屏","role":"secondary","version":"0.1.0"}""")
    }
    val terminalToken = json.parseToJsonElement(pair.bodyAsText()).jsonObject["data"]!!.jsonObject["token"]!!.jsonPrimitive.content
    val mismatch = client.get("/api/v1/ui-update/sync?currentVersion=0.1.0") { bearerAuth(terminalToken) }
    val mismatchData = json.parseToJsonElement(mismatch.bodyAsText()).jsonObject["data"]!!.jsonObject
    assertEquals("0.1.1", mismatchData["targetVersion"]!!.jsonPrimitive.content)
    assertTrue(mismatchData["update"]!!.jsonObject.containsKey("signature"))

    val current = client.get("/api/v1/ui-update/sync?currentVersion=0.1.1") { bearerAuth(terminalToken) }
    val currentData = json.parseToJsonElement(current.bodyAsText()).jsonObject["data"]!!.jsonObject
    assertEquals("0.1.1", currentData["targetVersion"]!!.jsonPrimitive.content)
    assertTrue(currentData["update"]!!.toString() == "null")
  }
}
