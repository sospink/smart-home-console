package cn.zhijing.smartlab

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.widget.Toast
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import cn.zhijing.smartlab.edgecore.validDatabaseBackupFilename
import cn.zhijing.smartlab.data.PersistentSecretStore
import cn.zhijing.smartlab.gateway.ha.HomeAssistantCredential
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.json.JSONObject

class NativeRuntimeBridge(
  private val context: Context,
  private val role: TerminalRole,
  private val edgeBase: String,
  private val tokenProvider: () -> String?,
  private val terminalAuthenticationInvalid: () -> Unit = {},
  private val surfaceChanged: (TerminalSurface) -> Unit = {},
  private val terminalReconfigurationRequested: () -> Unit = {},
  private val secrets: PersistentSecretStore = PersistentSecretStore(context),
) {
  @JavascriptInterface fun getRole() = role.name.lowercase()
  @JavascriptInterface fun getEdgeBaseUrl() = edgeBase
  @JavascriptInterface fun getTerminalToken() = tokenProvider().orEmpty()
  @JavascriptInterface fun getAppVersion() = BuildConfig.VERSION_NAME
  @JavascriptInterface fun onTerminalAuthenticationInvalid() = terminalAuthenticationInvalid()

  @JavascriptInterface
  fun rememberSurface(surface: String): Boolean = TerminalSurface.fromWire(surface)?.let {
    surfaceChanged(it)
    true
  } ?: false

  @JavascriptInterface
  fun requestTerminalReconfiguration(): Boolean = runCatching {
    terminalReconfigurationRequested()
    true
  }.getOrDefault(false)

  @JavascriptInterface
  fun getAdminConfigurationDraft(): String =
    secrets.get(ADMIN_DRAFT_REFERENCE).orEmpty()

  @JavascriptInterface
  fun saveAdminConfigurationDraft(payload: String): Boolean = runCatching {
    require(validAdminConfigurationDraftPayload(payload)) { "管理草稿格式或大小无效" }
    secrets.put(ADMIN_DRAFT_REFERENCE, payload)
    true
  }.getOrDefault(false)

  @JavascriptInterface
  fun clearAdminConfigurationDraft() {
    secrets.remove(ADMIN_DRAFT_REFERENCE)
  }

  /** Token 只从当前 WebView 内存进入 Keystore 密文；不写数据库、草稿、日志或诊断包。 */
  @JavascriptInterface
  fun configureHomeAssistant(payload: String, adminToken: String): Boolean = runCatching {
    require(role == TerminalRole.PRIMARY) { "仅主屏允许配置 HA" }
    require(adminToken.isNotBlank() && validateAdminSession(adminToken)) { "管理员会话无效" }
    require(payload.toByteArray(Charsets.UTF_8).size in 64..16 * 1024) { "HA 配置大小无效" }
    val source = JSONObject(payload)
    val credential = HomeAssistantCredential(
      baseUrl = source.getString("baseUrl").trim().trimEnd('/'),
      token = source.getString("token").trim(),
      gatewayEntityId = source.getString("gatewayEntityId").trim(),
      lightEntityId = source.getString("lightEntityId").trim(),
    )
    secrets.put(EdgeForegroundService.HA_CREDENTIAL_REFERENCE, Json.encodeToString(credential))
    // 让正在运行的 EdgeCore 完整关闭后再用新适配器启动；页面会自动重连并重新拉取权威快照。
    context.stopService(Intent(context, EdgeForegroundService::class.java))
    Handler(Looper.getMainLooper()).postDelayed({
      ContextCompat.startForegroundService(context, Intent(context, EdgeForegroundService::class.java))
    }, 750)
    true
  }.getOrDefault(false)

  @JavascriptInterface
  fun downloadDatabaseBackup(filename: String, adminToken: String): Boolean = runCatching {
    require(role == TerminalRole.PRIMARY) { "仅主屏允许导出数据库快照" }
    require(validDatabaseBackupFilename(filename)) { "数据库快照文件名无效" }
    require(adminToken.isNotBlank()) { "缺少管理员会话" }
    thread(name = "database-backup-export", isDaemon = true) { exportDatabaseBackup(filename, adminToken) }
    true
  }.getOrDefault(false)

  private fun exportDatabaseBackup(filename: String, adminToken: String) {
    var destination: Uri? = null
    runCatching {
      val connection = URL("$edgeBase/api/v1/admin/database-backups/$filename").openConnection() as HttpURLConnection
      connection.requestMethod = "GET"
      connection.connectTimeout = 8_000
      connection.readTimeout = 120_000
      connection.setRequestProperty("Authorization", "Bearer $adminToken")
      try {
        require(connection.responseCode == HttpURLConnection.HTTP_OK) { "EdgeCore 返回 ${connection.responseCode}" }
        val values = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, filename)
          put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
          put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/SmartLab")
          put(MediaStore.Downloads.IS_PENDING, 1)
        }
        destination = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
          ?: error("无法创建下载文件")
        context.contentResolver.openOutputStream(destination!!, "w")!!.buffered().use { output ->
          connection.inputStream.buffered().use { input -> input.copyTo(output) }
        }
        context.contentResolver.update(destination!!, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
      } finally {
        connection.disconnect()
      }
    }.onSuccess {
      toast("数据库快照已保存到 Download/SmartLab")
    }.onFailure { error ->
      destination?.let { context.contentResolver.delete(it, null, null) }
      toast("数据库快照导出失败：${error.message ?: "未知错误"}")
    }
  }

  private fun validateAdminSession(adminToken: String): Boolean = runCatching {
    val connection = URL("$edgeBase/api/v1/admin/config").openConnection() as HttpURLConnection
    connection.requestMethod = "GET"
    connection.connectTimeout = 3_000
    connection.readTimeout = 3_000
    connection.setRequestProperty("Authorization", "Bearer $adminToken")
    try { connection.responseCode == HttpURLConnection.HTTP_OK } finally { connection.disconnect() }
  }.getOrDefault(false)

  private fun toast(message: String) {
    Handler(Looper.getMainLooper()).post { Toast.makeText(context, message, Toast.LENGTH_LONG).show() }
  }
}

internal fun validAdminConfigurationDraftPayload(payload: String): Boolean =
  payload.toByteArray(Charsets.UTF_8).size in 2..512 * 1024 && payload.trim().let { it.startsWith("{") && it.endsWith("}") }

private const val ADMIN_DRAFT_REFERENCE = "admin-configuration-draft-v1"
