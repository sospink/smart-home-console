package cn.zhijing.smartlab.edgecore

import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalPresenceServiceTest {
  @Test
  fun `terminal stays online until its last event stream disconnects`() = runBlocking {
    val repository = FakeRepository()
    repository.saveTerminal(
      TerminalDto(
        "secondary", "android-secondary", "副屏", "secondary", true, false, "0.1.0",
        "192.168.1.20", "2026-07-25T00:00:00Z",
      ),
      "hash",
    )
    val presence = TerminalPresenceService(
      repository,
      EdgeEventBus(repository),
      clock = { Instant.parse("2026-07-25T00:10:00Z") },
    )
    val identity = EventTicketIdentity(
      "secondary", "secondary", "192.168.1.20", "0.1.1", Instant.parse("2026-07-25T00:11:00Z"),
    )

    presence.connected(identity)
    presence.connected(identity)
    assertTrue(repository.terminals().single().online)

    presence.disconnected(identity)
    assertTrue(repository.terminals().single().online)

    presence.disconnected(identity)
    assertFalse(repository.terminals().single().online)
  }

  @Test
  fun `revoked terminal cannot be resurrected by a late lease refresh`() = runBlocking {
    val repository = FakeRepository()
    repository.saveTerminal(
      TerminalDto("secondary", "android-secondary", "副屏", "secondary", true, true, "0.1.0", "192.168.1.20", "2026-07-25T00:00:00Z"),
      "hash",
    )
    val presence = TerminalPresenceService(repository, EdgeEventBus(repository))
    val identity = EventTicketIdentity("secondary", "secondary", "192.168.1.20", "0.1.1", Instant.parse("2026-07-25T00:11:00Z"))
    repository.revokeTerminal("secondary")

    presence.refresh(identity, publish = true)

    assertFalse(repository.terminals().single().paired)
    assertFalse(repository.terminals().single().online)
  }
}
