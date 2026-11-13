package cn.zhijing.smartlab

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OperationalLogTest {
  @Test
  fun `credentials and bearer values are redacted without hiding safe context`() {
    val redacted = redactOperationalDetail(
      "gateway=lab-a token:abc123 key = xyz789 Authorization=BearerSecret bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    )

    assertFalse(redacted.contains("abc123"))
    assertFalse(redacted.contains("xyz789"))
    assertFalse(redacted.contains("BearerSecret"))
    assertFalse(redacted.contains("eyJhbGciOiJIUzI1NiJ9"))
    assertTrue(redacted.contains("gateway=lab-a"))
    assertTrue(redacted.contains("[REDACTED]"))
  }
}
