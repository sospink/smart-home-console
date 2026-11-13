package cn.zhijing.smartlab.edgecore

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.time.Instant
import java.util.Base64
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UiUpdateVerifierTest {
  private val json = Json { encodeDefaults = true }
  private val keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
  private val publicKey = Base64.getEncoder().encodeToString(keys.public.encoded)

  @Test fun `accepts an Ed25519 signed package and verifies every file`() {
    val request = packageRequest(mapOf("index.html" to "<main>知境</main>".toByteArray(), "assets/app.js" to "ok".toByteArray()))
    val verified = UiUpdateVerifier.verify(request, publicKey, "0.1.0")
    assertEquals("0.1.1", verified.manifest.version)
    assertEquals("ok", verified.files.getValue("assets/app.js").decodeToString())
  }

  @Test fun `rejects a tampered file even when the manifest signature remains valid`() {
    val request = packageRequest(mapOf("index.html" to "safe".toByteArray()))
    val tampered = request.copy(files = request.files + ("index.html" to Base64.getEncoder().encodeToString("tampered".toByteArray())))
    val error = runCatching { UiUpdateVerifier.verify(tampered, publicKey, "0.1.0") }.exceptionOrNull()
    assertTrue(error is DomainException && error.message == "UI_UPDATE_FILE_SIZE_MISMATCH")
  }

  @Test fun `rejects an unsigned manifest and unsafe traversal path`() {
    val request = packageRequest(mapOf("index.html" to "safe".toByteArray()))
    assertTrue(runCatching { UiUpdateVerifier.verify(request.copy(manifestJson = request.manifestJson + " "), publicKey, "0.1.0") }.isFailure)
    val unsafe = packageRequest(mapOf("index.html" to "safe".toByteArray(), "../escape.js" to "bad".toByteArray()))
    val error = runCatching { UiUpdateVerifier.verify(unsafe, publicKey, "0.1.0") }.exceptionOrNull()
    assertTrue(error is DomainException && error.message == "UI_UPDATE_PATH_INVALID")
  }

  @Test fun `enforces minimum app version`() {
    val request = packageRequest(mapOf("index.html" to "safe".toByteArray()), minAppVersion = "0.2.0")
    val error = runCatching { UiUpdateVerifier.verify(request, publicKey, "0.1.9") }.exceptionOrNull()
    assertTrue(error is DomainException && error.message == "UI_UPDATE_APP_VERSION_TOO_OLD")
  }

  private fun packageRequest(files: Map<String, ByteArray>, minAppVersion: String = "0.1.0"): UiUpdateInstallRequestDto {
    val entries = files.map { (path, bytes) ->
      UiUpdateFileDto(path, MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }, bytes.size.toLong())
    }
    val manifestJson = json.encodeToString(UiUpdateManifestDto("0.1.1", minAppVersion, Instant.now().toString(), entries))
    val signature = Signature.getInstance("Ed25519").run {
      initSign(keys.private)
      update(manifestJson.toByteArray())
      Base64.getEncoder().encodeToString(sign())
    }
    return UiUpdateInstallRequestDto(manifestJson, signature, files.mapValues { Base64.getEncoder().encodeToString(it.value) })
  }
}
