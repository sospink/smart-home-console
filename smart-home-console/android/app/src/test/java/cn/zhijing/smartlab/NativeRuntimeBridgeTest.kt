package cn.zhijing.smartlab

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeRuntimeBridgeTest {
  @Test
  fun `terminal surface wire values are explicitly whitelisted`() {
    assertEquals(TerminalSurface.PRIMARY, TerminalSurface.fromWire("primary"))
    assertEquals(TerminalSurface.SECONDARY, TerminalSurface.fromWire(" SECONDARY "))
    assertEquals(TerminalSurface.ADMIN, TerminalSurface.fromWire("admin"))
    assertNull(TerminalSurface.fromWire("engineering"))
    assertNull(TerminalSurface.fromWire(""))
  }

  @Test
  fun `default surface follows physical role without changing that role`() {
    assertEquals(TerminalSurface.PRIMARY, TerminalSurface.defaultFor(TerminalRole.PRIMARY))
    assertEquals(TerminalSurface.SECONDARY, TerminalSurface.defaultFor(TerminalRole.SECONDARY))
  }

  @Test
  fun `admin draft payload is bounded and must be a json object`() {
    assertTrue(validAdminConfigurationDraftPayload("{\"schema\":1}"))
    assertFalse(validAdminConfigurationDraftPayload("[]"))
    assertFalse(validAdminConfigurationDraftPayload("not-json"))
    assertFalse(validAdminConfigurationDraftPayload("{\"value\":\"${"x".repeat(512 * 1024)}\"}"))
  }
}
