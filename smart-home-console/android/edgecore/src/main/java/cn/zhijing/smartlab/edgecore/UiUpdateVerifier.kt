package cn.zhijing.smartlab.edgecore

import com.google.crypto.tink.subtle.Ed25519Verify
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import kotlinx.serialization.json.Json

data class VerifiedUiUpdate(
  val manifest: UiUpdateManifestDto,
  val files: Map<String, ByteArray>,
)

object UiUpdateVerifier {
  private const val MAX_FILE_COUNT = 256
  private const val MAX_FILE_SIZE = 12L * 1024 * 1024
  private const val MAX_TOTAL_SIZE = 40L * 1024 * 1024
  private val safeVersion = Regex("[0-9A-Za-z][0-9A-Za-z._-]{0,47}")
  private val safePath = Regex("[0-9A-Za-z._/-]{1,180}")
  private val sha256 = Regex("[0-9a-f]{64}")
  private val json = Json { ignoreUnknownKeys = false }

  fun verify(request: UiUpdateInstallRequestDto, publicKeyBase64: String, appVersion: String): VerifiedUiUpdate {
    if (publicKeyBase64.isBlank()) throw DomainException(503, "UI_UPDATE_KEY_NOT_CONFIGURED")
    if (request.manifestJson.length > 128 * 1024 || request.signature.length > 1024) {
      throw DomainException(400, "UI_UPDATE_METADATA_TOO_LARGE")
    }
    val publicKeyBytes = decodeBase64(publicKeyBase64, "UI_UPDATE_PUBLIC_KEY_INVALID")
    val signatureBytes = decodeBase64(request.signature, "UI_UPDATE_SIGNATURE_INVALID")
    val validSignature = runCatching {
      val rawPublicKey = extractRawEd25519Key(publicKeyBytes)
      Ed25519Verify(rawPublicKey).verify(signatureBytes, request.manifestJson.toByteArray(Charsets.UTF_8))
      true
    }.getOrDefault(false)
    if (!validSignature) throw DomainException(403, "UI_UPDATE_SIGNATURE_INVALID")

    val manifest = runCatching { json.decodeFromString<UiUpdateManifestDto>(request.manifestJson) }
      .getOrElse { throw DomainException(400, "UI_UPDATE_MANIFEST_INVALID") }
    if (!safeVersion.matches(manifest.version)) throw DomainException(400, "UI_UPDATE_VERSION_INVALID")
    if (compareVersions(appVersion, manifest.minAppVersion) < 0) throw DomainException(409, "UI_UPDATE_APP_VERSION_TOO_OLD")
    runCatching { Instant.parse(manifest.createdAt) }.getOrElse { throw DomainException(400, "UI_UPDATE_CREATED_AT_INVALID") }
    if (manifest.files.isEmpty() || manifest.files.size > MAX_FILE_COUNT) throw DomainException(400, "UI_UPDATE_FILE_COUNT_INVALID")
    if (manifest.files.none { it.path == "index.html" }) throw DomainException(400, "UI_UPDATE_INDEX_MISSING")

    val paths = manifest.files.map { it.path }
    if (paths.toSet().size != paths.size || request.files.keys != paths.toSet()) {
      throw DomainException(400, "UI_UPDATE_FILE_SET_MISMATCH")
    }
    var totalSize = 0L
    val verified = linkedMapOf<String, ByteArray>()
    for (entry in manifest.files) {
      validatePath(entry.path)
      if (entry.size < 0 || entry.size > MAX_FILE_SIZE || !sha256.matches(entry.sha256)) {
        throw DomainException(400, "UI_UPDATE_FILE_METADATA_INVALID")
      }
      val encoded = request.files.getValue(entry.path)
      val maximumEncodedLength = ((entry.size + 2) / 3 * 4 + 4).toInt()
      if (encoded.length > maximumEncodedLength) throw DomainException(400, "UI_UPDATE_FILE_SIZE_MISMATCH")
      val bytes = decodeBase64(encoded, "UI_UPDATE_FILE_ENCODING_INVALID")
      if (bytes.size.toLong() != entry.size) throw DomainException(400, "UI_UPDATE_FILE_SIZE_MISMATCH")
      val actualHash = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()
      if (!MessageDigest.isEqual(actualHash.toByteArray(), entry.sha256.toByteArray())) {
        throw DomainException(400, "UI_UPDATE_FILE_HASH_MISMATCH")
      }
      totalSize += bytes.size
      if (totalSize > MAX_TOTAL_SIZE) throw DomainException(400, "UI_UPDATE_TOTAL_SIZE_EXCEEDED")
      verified[entry.path] = bytes
    }
    return VerifiedUiUpdate(manifest, verified)
  }

  fun compareVersions(left: String, right: String): Int {
    val a = left.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
    val b = right.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
    repeat(maxOf(a.size, b.size)) { index ->
      val result = (a.getOrElse(index) { 0 }).compareTo(b.getOrElse(index) { 0 })
      if (result != 0) return result
    }
    return 0
  }

  private fun validatePath(path: String) {
    val segments = path.split('/')
    if (!safePath.matches(path) || path.startsWith('/') || '\\' in path || ':' in path || segments.any { it.isBlank() || it == "." || it == ".." }) {
      throw DomainException(400, "UI_UPDATE_PATH_INVALID")
    }
  }

  private fun decodeBase64(value: String, error: String): ByteArray = runCatching { Base64.getDecoder().decode(value) }
    .getOrElse { throw DomainException(400, error) }

  /** Node/OpenSSL 输出标准 SubjectPublicKeyInfo；Tink 使用最后 32 字节原始 Ed25519 公钥。 */
  private fun extractRawEd25519Key(x509: ByteArray): ByteArray {
    val prefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
    if (x509.size != prefix.size + 32 || !MessageDigest.isEqual(x509.copyOfRange(0, prefix.size), prefix)) {
      throw DomainException(400, "UI_UPDATE_PUBLIC_KEY_INVALID")
    }
    return x509.copyOfRange(prefix.size, x509.size)
  }

  private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
}
