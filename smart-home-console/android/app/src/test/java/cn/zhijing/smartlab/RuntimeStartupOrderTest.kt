package cn.zhijing.smartlab

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeStartupOrderTest {
  @Test
  fun `runtime recovery always completes before gateway can emit its first observation`() = runBlocking {
    val operations = mutableListOf<String>()

    val adapter = startGatewayAfterRuntimeRecovery(
      recover = { operations += "recover" },
      startGateway = {
        operations += "gateway-first-observation"
        "adapter"
      },
    )

    assertEquals("adapter", adapter)
    assertEquals(listOf("recover", "gateway-first-observation"), operations)
  }

  @Test
  fun `gateway is not started when runtime recovery fails`() = runBlocking {
    var gatewayStarted = false

    val failure = runCatching {
      startGatewayAfterRuntimeRecovery(
        recover = { error("database recovery failed") },
        startGateway = {
          gatewayStarted = true
          "adapter"
        },
      )
    }.exceptionOrNull()

    assertTrue(failure?.message?.contains("database recovery failed") == true)
    assertTrue(!gatewayStarted)
  }
}
