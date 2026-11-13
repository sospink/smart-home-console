package cn.zhijing.smartlab.edgecore

import java.security.SecureRandom
import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SecurityServiceTest {
  private val now = Instant.parse("2026-07-24T00:00:00Z")

  @Test
  fun `admin pin creates expiring bearer session without storing pin`() {
    var clock = now
    val service = SecurityService(FakeRepository(), "2468", { "123456" }, clock = { clock }, random = seededRandom())

    val session = service.login("2468", "127.0.0.1")
    assertTrue(service.isAdmin(session.token))
    assertNotEquals("2468", session.token)

    clock = now.plusSeconds(8 * 60 * 60 + 1)
    assertFalse(service.isAdmin(session.token))
  }

  @Test
  fun `invalid admin pin is rejected`() {
    val service = SecurityService(FakeRepository(), "2468", { "123456" }, clock = { now }, random = seededRandom())
    val error = runCatching { service.login("1111", "127.0.0.1") }.exceptionOrNull()
    assertEquals(401, (error as DomainException).status)
  }

  @Test
  fun `repeated invalid pin attempts are rate limited and recover after block`() {
    var clock = now
    val service = SecurityService(FakeRepository(), "2468", { "123456" }, clock = { clock }, random = seededRandom())

    repeat(5) {
      assertEquals(401, (runCatching { service.login("1111", "192.168.10.9") }.exceptionOrNull() as DomainException).status)
    }
    assertEquals(429, (runCatching { service.login("2468", "192.168.10.9") }.exceptionOrNull() as DomainException).status)

    clock = now.plusSeconds(15 * 60 + 1)
    assertTrue(service.isAdmin(service.login("2468", "192.168.10.9").token))
  }

  @Test
  fun `admin pin rotation persists before switching and revokes every old session`() {
    val service = SecurityService(FakeRepository(), "2468", { "123456" }, clock = { now }, random = seededRandom())
    val first = service.login("2468", "127.0.0.1")
    val second = service.login("2468", "192.168.10.2")
    var persisted = ""

    service.changeAdminPin(AdminPinChangeRequestDto("2468", "135790", "135790"), "127.0.0.1") { persisted = it }

    assertEquals("135790", persisted)
    assertFalse(service.isAdmin(first.token))
    assertFalse(service.isAdmin(second.token))
    assertEquals(401, (runCatching { service.login("2468", "127.0.0.1") }.exceptionOrNull() as DomainException).status)
    assertTrue(service.isAdmin(service.login("135790", "127.0.0.1").token))
  }

  @Test
  fun `failed pin persistence keeps old credential and sessions valid`() {
    val service = SecurityService(FakeRepository(), "2468", { "123456" }, clock = { now }, random = seededRandom())
    val session = service.login("2468", "127.0.0.1")
    val failure = runCatching {
      service.changeAdminPin(AdminPinChangeRequestDto("2468", "135790", "135790"), "127.0.0.1") { error("keystore unavailable") }
    }.exceptionOrNull()
    assertEquals("keystore unavailable", failure?.message)
    assertTrue(service.isAdmin(session.token))
    assertTrue(service.isAdmin(service.login("2468", "127.0.0.1").token))
  }

  @Test
  fun `pin rotation rejects wrong current confirmation weak and unchanged values`() {
    val service = SecurityService(FakeRepository(), "2468", { "123456" }, clock = { now }, random = seededRandom())
    assertEquals(401, (runCatching { service.changeAdminPin(AdminPinChangeRequestDto("0000", "135790", "135790"), "127.0.0.1") {} }.exceptionOrNull() as DomainException).status)
    assertEquals(400, (runCatching { service.changeAdminPin(AdminPinChangeRequestDto("2468", "135790", "135791"), "127.0.0.1") {} }.exceptionOrNull() as DomainException).status)
    assertEquals(400, (runCatching { service.changeAdminPin(AdminPinChangeRequestDto("2468", "1234", "1234"), "127.0.0.1") {} }.exceptionOrNull() as DomainException).status)
    assertEquals(409, (runCatching { service.changeAdminPin(AdminPinChangeRequestDto("2468", "2468", "2468"), "127.0.0.1") {} }.exceptionOrNull() as DomainException).status)
  }

  @Test
  fun `repeated wrong current pin locks only the rotation attempt window`() {
    val service = SecurityService(FakeRepository(), "2468", { "123456" }, clock = { now }, random = seededRandom())
    val session = service.login("2468", "127.0.0.1")
    repeat(5) {
      val error = runCatching {
        service.changeAdminPin(AdminPinChangeRequestDto("0000", "135790", "135790"), "192.168.10.2") {}
      }.exceptionOrNull() as DomainException
      assertEquals(401, error.status)
    }
    val blocked = runCatching {
      service.changeAdminPin(AdminPinChangeRequestDto("2468", "135790", "135790"), "192.168.10.2") {}
    }.exceptionOrNull() as DomainException
    assertEquals(429, blocked.status)
    assertTrue(service.isAdmin(session.token))
  }

  @Test
  fun `secondary pairing stores only token hash and authenticates`() = runBlocking {
    val repository = FakeRepository()
    val domainId = "11111111-1111-4111-8111-111111111111"
    val service = SecurityService(repository, "2468", { "123456" }, controlDomainId = domainId, clock = { now }, random = seededRandom())

    val paired = service.pair(
      PairTerminalRequestDto("123456", "android-abcdef123456", "副屏", "secondary", "0.1.0"),
      "192.168.10.22",
    )

    assertNotNull(service.authenticateTerminal(paired.token, "192.168.10.22"))
    assertEquals(domainId, paired.controlDomainId)
    assertEquals(32, java.util.Base64.getUrlDecoder().decode(paired.controlDomainProofKey).size)
    val other = service.derivedControlDomainProofKey("android-other-secondary", "other-pairing-reference")
    assertNotEquals(paired.controlDomainProofKey, other)
    assertNull(service.authenticateTerminal("wrong-token", "192.168.10.22"))
    assertTrue(repository.terminalValues.values.none { it.second == paired.token })
    assertFalse(repository.terminals().single().online)
  }

  @Test
  fun `primary token authenticates without being stored in repository`() = runBlocking {
    val repository = FakeRepository()
    val service = SecurityService(
      repository,
      "2468",
      { "123456" },
      primaryToken = "primary-keystore-token",
      clock = { now },
      random = seededRandom(),
    )

    assertEquals("primary", service.authenticateTerminal("primary-keystore-token", "127.0.0.1")?.role)
    assertNull(service.authenticateTerminal("wrong-token", "127.0.0.1"))
    assertTrue(repository.terminalValues.isEmpty())
  }

  @Test
  fun `event ticket is short lived and one time`() = runBlocking {
    val repository = FakeRepository()
    val service = SecurityService(repository, "2468", { "123456" }, clock = { now }, random = seededRandom())
    val paired = service.pair(
      PairTerminalRequestDto("123456", "android-abcdef123456", "副屏", "secondary", "0.1.0"),
      "192.168.10.22",
    )

    val ticket = service.issueEventTicket(paired.token, "192.168.10.22")
    assertEquals(repository.terminals().single().id, service.consumeEventTicket(ticket.ticket)?.terminalId)
    assertNull(service.consumeEventTicket(ticket.ticket))
  }

  private fun seededRandom() = SecureRandom.getInstance("SHA1PRNG").apply { setSeed(byteArrayOf(1, 2, 3, 4)) }
}
