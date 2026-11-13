package cn.zhijing.smartlab

import android.content.Context
import android.provider.Settings
import cn.zhijing.smartlab.data.PersistentSecretStore
import cn.zhijing.smartlab.edgecore.UiUpdateCoordinator
import cn.zhijing.smartlab.edgecore.UiUpdateInstallRequestDto
import cn.zhijing.smartlab.edgecore.UiUpdateStatusDto
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

class TerminalPairingClient(context: Context) {
  private val appContext = context.applicationContext
  private val secrets = PersistentSecretStore(appContext)

  val deviceId: String by lazy {
    val androidId = Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
    "android-${sha256(androidId.ifBlank { "unknown-terminal" }).take(24)}"
  }

  fun token(edgeBase: String): String? {
    val binding = binding() ?: return null
    return binding.tokenFor(addressHash(edgeBase))
  }

  /** 只向发现层暴露非敏感控制域身份，不暴露令牌。 */
  fun boundControlDomainId(): String? = binding()?.controlDomainId

  /**
   * 先通过公开健康端点核验稳定控制域，再允许读取 Bearer。不同实训台永远拿不到旧令牌。
   * 旧版全局/IP 令牌没有可验证的主屏身份，升级后主动失效并要求一次重新配对。
   */
  fun prepare(edgeBase: String): Boolean {
    val controlDomainId = fetchControlDomainId(edgeBase)
    val current = binding() ?: run {
      removeLegacyCredentials(edgeBase)
      return false
    }
    val verified = current.verify(controlDomainId, addressHash(edgeBase), fetchControlDomainProof(edgeBase, current)) ?: return false
    storeBinding(verified)
    return true
  }

  fun pair(edgeBase: String, code: String): String {
    require(code.matches(Regex("\\d{6}"))) { "请输入 6 位配对码" }
    val expectedControlDomainId = fetchControlDomainId(edgeBase)
    val connection = (URL("${edgeBase.trimEnd('/')}/api/v1/terminals/pair").openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 5_000
      readTimeout = 8_000
      doOutput = true
      setRequestProperty("Content-Type", "application/json; charset=utf-8")
    }
    val body = JSONObject()
      .put("pairingCode", code)
      .put("deviceId", deviceId)
      .put("name", "实训台副屏")
      .put("role", "secondary")
      .put("version", BuildConfig.VERSION_NAME)
      .toString()
    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
    val responseText = (if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream)
      ?.bufferedReader()
      ?.use { it.readText() }
      .orEmpty()
    if (connection.responseCode !in 200..299) {
      val error = runCatching { JSONObject(responseText).optString("error") }.getOrNull().orEmpty()
      throw IllegalStateException(if (error == "INVALID_PAIRING_CODE") "配对码错误" else error.ifBlank { "配对失败 HTTP ${connection.responseCode}" })
    }
    val data = JSONObject(responseText).getJSONObject("data")
    val token = data.getString("token")
    val pairedControlDomainId = validatedControlDomainId(data.getString("controlDomainId"))
    val controlDomainProofKey = validatedProofKey(data.getString("controlDomainProofKey"))
    check(pairedControlDomainId == expectedControlDomainId) { "主屏身份在配对期间发生变化，请重新连接" }
    storeBinding(TerminalBinding(pairedControlDomainId, token, controlDomainProofKey, addressHash(edgeBase)))
    removeLegacyCredentials(edgeBase)
    return token
  }

  fun clear(edgeBase: String) {
    if (token(edgeBase) != null) secrets.remove(BINDING_REFERENCE)
    removeLegacyCredentials(edgeBase)
  }

  /**
   * 副屏只接受主屏配对令牌保护的版本目标，真正落盘前仍由本机 Ed25519 公钥逐文件验签。
   * Web UI 无法绕过此方法安装任意资源。
   */
  fun synchronizeUi(edgeBase: String, coordinator: UiUpdateCoordinator): UiUpdateStatusDto {
    val token = token(edgeBase) ?: throw IllegalStateException("副屏尚未配对")
    val current = coordinator.status().activeVersion.orEmpty()
    val encodedVersion = URLEncoder.encode(current, StandardCharsets.UTF_8.name())
    val connection = (URL("${edgeBase.trimEnd('/')}/api/v1/ui-update/sync?currentVersion=$encodedVersion").openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 5_000
      readTimeout = 20_000
      setRequestProperty("Authorization", "Bearer $token")
      setRequestProperty("Accept", "application/json")
      setRequestProperty("X-Smart-Lab-Version", BuildConfig.VERSION_NAME)
    }
    val statusCode = connection.responseCode
    val responseText = (if (statusCode in 200..299) connection.inputStream else connection.errorStream)
      ?.bufferedReader()?.use { it.readText() }.orEmpty()
    connection.disconnect()
    if (statusCode !in 200..299) {
      if (statusCode == 401) clear(edgeBase)
      val error = runCatching { JSONObject(responseText).optString("error") }.getOrNull().orEmpty()
      throw IllegalStateException(error.ifBlank { "界面版本同步失败 HTTP $statusCode" })
    }
    val data = JSONObject(responseText).getJSONObject("data")
    val targetVersion = data.optString("targetVersion").takeIf { it.isNotBlank() }
    val request = data.optJSONObject("update")?.let { update ->
      val fileObject = update.getJSONObject("files")
      val files = buildMap {
        val keys = fileObject.keys()
        while (keys.hasNext()) {
          val path = keys.next()
          put(path, fileObject.getString(path))
        }
      }
      UiUpdateInstallRequestDto(update.getString("manifestJson"), update.getString("signature"), files)
    }
    return coordinator.synchronize(targetVersion, request)
  }

  private fun legacyTokenReference(edgeBase: String) = "terminal-token-${sha256(edgeBase.trimEnd('/')).take(24)}"
  private fun addressHash(edgeBase: String) = sha256(edgeBase.trimEnd('/')).take(24)
  private fun sha256(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

  private fun fetchControlDomainId(edgeBase: String): String {
    val connection = (URL("${edgeBase.trimEnd('/')}/api/v1/health").openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 3_000
      readTimeout = 5_000
      setRequestProperty("Accept", "application/json")
    }
    return try {
      val statusCode = connection.responseCode
      val responseText = (if (statusCode in 200..299) connection.inputStream else connection.errorStream)
        ?.bufferedReader()?.use { it.readText() }.orEmpty()
      if (statusCode !in 200..299) throw IllegalStateException("主屏身份核验失败 HTTP $statusCode")
      validatedControlDomainId(JSONObject(responseText).getJSONObject("data").getString("controlDomainId"))
    } finally {
      connection.disconnect()
    }
  }

  private fun validatedControlDomainId(value: String): String = runCatching { UUID.fromString(value).toString() }
    .getOrElse { throw IllegalStateException("主屏未提供有效控制域身份") }

  private fun validatedProofKey(value: String): String = value.also {
    require(runCatching { Base64.getUrlDecoder().decode(it) }.getOrNull()?.size == 32) { "主屏未提供有效控制域证明密钥" }
  }

  private fun fetchControlDomainProof(edgeBase: String, binding: TerminalBinding): ControlDomainProof {
    val nonce = ByteArray(32).also(SecureRandom()::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
    val connection = (URL("${edgeBase.trimEnd('/')}/api/v1/control-domain/challenge").openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 3_000
      readTimeout = 5_000
      doOutput = true
      setRequestProperty("Content-Type", "application/json; charset=utf-8")
    }
    connection.outputStream.use {
      val clientProof = Base64.getUrlEncoder().withoutPadding().encodeToString(binding.clientProof(deviceId, nonce))
      it.write(
        JSONObject().put("deviceId", deviceId).put("nonce", nonce).put("clientProof", clientProof)
          .toString().toByteArray(Charsets.UTF_8),
      )
    }
    return try {
      val statusCode = connection.responseCode
      val responseText = (if (statusCode in 200..299) connection.inputStream else connection.errorStream)
        ?.bufferedReader()?.use { it.readText() }.orEmpty()
      if (statusCode !in 200..299) throw IllegalStateException("主屏控制域证明失败 HTTP $statusCode")
      val data = JSONObject(responseText).getJSONObject("data")
      val observedDomainId = validatedControlDomainId(data.getString("controlDomainId"))
      val echoedNonce = data.getString("nonce")
      check(observedDomainId == binding.controlDomainId && echoedNonce == nonce) { "主屏控制域证明不匹配" }
      ControlDomainProof(deviceId, nonce, data.getString("proof"))
    } finally { connection.disconnect() }
  }

  private fun binding(): TerminalBinding? = secrets.get(BINDING_REFERENCE)?.let { encoded ->
    runCatching {
      val value = JSONObject(encoded)
      TerminalBinding(
        validatedControlDomainId(value.getString("controlDomainId")),
        value.getString("token").also { require(it.length >= 32) },
        validatedProofKey(value.getString("controlDomainProofKey")),
        value.getString("verifiedAddressHash").also { require(it.matches(Regex("[a-f0-9]{24}"))) },
      )
    }.getOrNull()
  }

  private fun storeBinding(binding: TerminalBinding) {
    secrets.put(
      BINDING_REFERENCE,
      JSONObject()
        .put("controlDomainId", binding.controlDomainId)
        .put("token", binding.token)
        .put("controlDomainProofKey", binding.controlDomainProofKey)
        .put("verifiedAddressHash", binding.verifiedAddressHash)
        .toString(),
    )
  }

  private fun removeLegacyCredentials(edgeBase: String) {
    secrets.remove(terminalTokenReference())
    secrets.remove(legacyTokenReference(edgeBase))
  }

  companion object {
    private const val BINDING_REFERENCE = "terminal-binding-v3"
    /** 仅供清理 v1 凭据；v2 将控制域、令牌和已核验地址封装成一个 Keystore 密文。 */
    internal fun terminalTokenReference() = "terminal-token-active-primary"
  }
}

/** 纯策略对象，确保未核验地址永远无法取得令牌，同时允许同一控制域在 DHCP 变更后重新绑定。 */
internal data class TerminalBinding(
  val controlDomainId: String,
  val token: String,
  val controlDomainProofKey: String,
  val verifiedAddressHash: String,
) {
  fun tokenFor(addressHash: String) = token.takeIf { verifiedAddressHash == addressHash }
  private fun mac(message: String): ByteArray {
    val mac = Mac.getInstance("HmacSHA256").apply {
      init(SecretKeySpec(Base64.getUrlDecoder().decode(controlDomainProofKey), "HmacSHA256"))
    }
    return mac.doFinal(message.toByteArray(Charsets.UTF_8))
  }
  fun clientProof(deviceId: String, nonce: String) = mac("client:$controlDomainId:$deviceId:$nonce")
  fun expectedProof(deviceId: String, nonce: String) = mac("server:$controlDomainId:$deviceId:$nonce")
  fun verify(observedControlDomainId: String, addressHash: String, challenge: ControlDomainProof): TerminalBinding? {
    if (controlDomainId != observedControlDomainId) return null
    val proof = runCatching { Base64.getUrlDecoder().decode(challenge.proof) }.getOrNull() ?: return null
    return copy(verifiedAddressHash = addressHash).takeIf {
      MessageDigest.isEqual(expectedProof(challenge.deviceId, challenge.nonce), proof)
    }
  }
}

internal data class ControlDomainProof(val deviceId: String, val nonce: String, val proof: String)
