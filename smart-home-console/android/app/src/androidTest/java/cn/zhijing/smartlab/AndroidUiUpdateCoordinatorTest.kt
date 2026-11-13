package cn.zhijing.smartlab

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import cn.zhijing.smartlab.edgecore.UiUpdateFileDto
import cn.zhijing.smartlab.edgecore.UiUpdateInstallRequestDto
import com.google.crypto.tink.subtle.Ed25519Sign
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidUiUpdateCoordinatorTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private lateinit var keys: Ed25519Sign.KeyPair
  private lateinit var coordinator: AndroidUiUpdateCoordinator

  @Before
  fun setUp() {
    clearUpdates()
    keys = Ed25519Sign.KeyPair.newKeyPair()
    val x509Prefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
    val publicKey = Base64.getEncoder().encodeToString(x509Prefix + keys.publicKey)
    coordinator = AndroidUiUpdateCoordinator(context, publicKey, "0.1.0")
  }

  @After
  fun tearDown() = clearUpdates()

  @Test
  fun signedResourcesActivateAtomicallyRollbackAndSynchronizeToBundled() {
    val first = packageRequest("0.1.1", "<main>first</main>")
    assertEquals("0.1.1", coordinator.install(first).activeVersion)
    assertEquals("<main>first</main>", File(AndroidUiUpdateCoordinator.activeDirectory(context), "index.html").readText())
    assertEquals(first.manifestJson, coordinator.syncPackage()?.manifestJson)

    val second = packageRequest("0.1.2", "<main>second</main>")
    assertEquals("0.1.2", coordinator.install(second).activeVersion)
    assertEquals("0.1.1", coordinator.rollback().activeVersion)
    assertEquals("<main>first</main>", File(AndroidUiUpdateCoordinator.activeDirectory(context), "index.html").readText())

    val bundled = coordinator.synchronize(null, null)
    assertNull(bundled.activeVersion)
    assertNull(AndroidUiUpdateCoordinator.activeDirectory(context))
    assertTrue(bundled.message.contains("内置资源"))
  }

  @Test
  fun secondarySynchronizationAcceptsSignedAuthoritativeDowngrade() {
    coordinator.install(packageRequest("0.1.2", "second"))
    val authoritative = packageRequest("0.1.1", "first")
    assertEquals("0.1.1", coordinator.synchronize("0.1.1", authoritative).activeVersion)
    assertEquals("first", File(AndroidUiUpdateCoordinator.activeDirectory(context), "index.html").readText())
  }

  @Test
  fun apkUpgradeDiscardsAnOlderPersistedUiOverride() {
    coordinator.install(packageRequest("0.1.1", "older signed UI"))
    assertEquals("0.1.1", coordinator.status().activeVersion)

    val upgraded = AndroidUiUpdateCoordinator(context, coordinatorPublicKey(), "0.1.2")

    assertNull(upgraded.status().activeVersion)
    assertNull(AndroidUiUpdateCoordinator.activeDirectory(context))
    assertTrue(upgraded.status().message.contains("内置资源"))
  }

  private fun packageRequest(version: String, index: String): UiUpdateInstallRequestDto {
    val bytes = index.toByteArray()
    val entry = UiUpdateFileDto(
      "index.html",
      MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) },
      bytes.size.toLong(),
    )
    val manifestJson = JSONObject()
      .put("version", version)
      .put("minAppVersion", "0.1.0")
      .put("createdAt", Instant.now().toString())
      .put("files", JSONArray().put(JSONObject().put("path", entry.path).put("sha256", entry.sha256).put("size", entry.size)))
      .toString()
    val signature = Base64.getEncoder().encodeToString(Ed25519Sign(keys.privateKey).sign(manifestJson.toByteArray()))
    return UiUpdateInstallRequestDto(manifestJson, signature, mapOf("index.html" to Base64.getEncoder().encodeToString(bytes)))
  }

  private fun coordinatorPublicKey(): String {
    val x509Prefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
    return Base64.getEncoder().encodeToString(x509Prefix + keys.publicKey)
  }

  private fun clearUpdates() {
    context.getSharedPreferences("smart-lab-ui-updates", android.content.Context.MODE_PRIVATE).edit().clear().commit()
    File(context.filesDir, "panel-ui-updates").deleteRecursively()
  }
}
