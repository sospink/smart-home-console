package cn.zhijing.smartlab

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeAddressTest {
  @Test fun `normalizes private ipv4 and default port`() {
    assertEquals("http://192.168.10.8:8787", EdgeAddress.normalize("192.168.10.8"))
    assertEquals("https://10.0.0.2:9443", EdgeAddress.normalize("https://10.0.0.2:9443/"))
  }

  @Test fun `formats discovered ipv6 address with brackets`() {
    assertEquals("http://[fe80::1234]:8787", EdgeAddress.fromDiscoveredHost("fe80::1234", 8787))
  }

  @Test fun `rejects public hosts paths and credentials`() {
    for (value in listOf("8.8.8.8:8787", "https://example.com", "http://192.168.1.2:8787/api", "http://u:p@192.168.1.2")) {
      assertTrue(runCatching { EdgeAddress.normalize(value) }.isFailure)
    }
  }

  @Test fun `legacy secondary pairing token reference remains available only for cleanup`() {
    assertEquals("terminal-token-active-primary", TerminalPairingClient.terminalTokenReference())
  }

  @Test fun `terminal credential is withheld until the current address is identity verified`() {
    val binding = testBinding("old-address")
    assertEquals(null, binding.tokenFor("new-address"))
    val nonce = "test-nonce"
    val deviceId = "android-test-secondary"
    val proof = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(binding.expectedProof(deviceId, nonce))
    val verified = binding.verify("11111111-1111-4111-8111-111111111111", "new-address", ControlDomainProof(deviceId, nonce, proof))!!
    assertEquals("secret-token", verified.tokenFor("new-address"))
  }

  @Test fun `different control terminal can never rebind the old bearer`() {
    val binding = testBinding("old-address")
    assertEquals(null, binding.verify("22222222-2222-4222-8222-222222222222", "other-bench", ControlDomainProof("device", "", "")))
    assertEquals(null, binding.tokenFor("other-bench"))
  }

  @Test fun `automatic discovery returns only to the bound control terminal`() {
    val first = "11111111-1111-4111-8111-111111111111"
    val second = "22222222-2222-4222-8222-222222222222"
    assertTrue(ControlDomainDiscoveryPolicy.accepts(null, second))
    assertTrue(ControlDomainDiscoveryPolicy.accepts(first, first))
    assertTrue(!ControlDomainDiscoveryPolicy.accepts(first, second))
    assertTrue(!ControlDomainDiscoveryPolicy.accepts(first, null))
  }

  @Test fun `discovery timeout distinguishes no service other bench and resolution failure`() {
    val empty = DiscoveryAttemptProgress(bound = true)
    assertTrue(empty.timeoutMessage().contains("未发现主屏"))

    val otherBench = DiscoveryAttemptProgress(bound = true).apply { recordFound(); recordRejected() }
    assertTrue(otherBench.timeoutMessage().contains("其他或旧版实训台"))
    assertTrue(otherBench.timeoutMessage().contains("换台请手工输入目标 IP"))

    val brokenMdns = DiscoveryAttemptProgress(bound = false).apply { recordFound(); recordResolveFailure() }
    assertTrue(brokenMdns.timeoutMessage().contains("地址解析失败"))
  }

  @Test fun `late callbacks from stopped or replaced discovery attempts are ignored`() {
    val gate = DiscoveryGenerationGate()
    val first = gate.begin()
    assertTrue(gate.isActive(first))
    val second = gate.begin()
    assertTrue(!gate.isActive(first))
    assertTrue(gate.isActive(second))
    gate.invalidate()
    assertTrue(!gate.isActive(second))
  }

  @Test fun `copied public domain id cannot forge the private challenge proof`() {
    val binding = testBinding("old-address")
    val forged = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { 7 })
    assertEquals(
      null,
      binding.verify(
        "11111111-1111-4111-8111-111111111111",
        "attacker-address",
        ControlDomainProof("android-test-secondary", "fresh-nonce", forged),
      ),
    )
    assertEquals(null, binding.tokenFor("attacker-address"))
  }

  private fun testBinding(address: String) = TerminalBinding(
    "11111111-1111-4111-8111-111111111111",
    "secret-token",
    java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() }),
    address,
  )
}
