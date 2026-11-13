package cn.zhijing.smartlab

import android.content.Context
import android.content.Intent
import cn.zhijing.smartlab.edgecore.DomainException
import cn.zhijing.smartlab.edgecore.UiUpdateCoordinator
import cn.zhijing.smartlab.edgecore.UiUpdateInstallRequestDto
import cn.zhijing.smartlab.edgecore.UiUpdateStatusDto
import cn.zhijing.smartlab.edgecore.UiUpdateVerifier
import java.io.File
import java.io.FileOutputStream
import java.util.Base64
import java.util.UUID
import org.json.JSONObject

class AndroidUiUpdateCoordinator(
  context: Context,
  private val publicKeyBase64: String,
  private val bundledVersion: String,
) : UiUpdateCoordinator {
  private val appContext = context.applicationContext
  private val root = File(appContext.filesDir, "panel-ui-updates")
  private val versions = File(root, "versions")
  private val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  init {
    // 覆盖安装 APK 不会清除 filesDir。若仍激活着比新 APK 更旧的签名 UI，WebView
    // 会继续优先加载旧目录，使“APK 已更新”与实际运行页面不一致。新内置版本更高时
    // 回到内置 UI；比 APK 更新的合法签名 UI 仍保留，不破坏正常热更新能力。
    synchronized(LOCK) {
      val active = activeVersion()
      if (active != null && UiUpdateVerifier.compareVersions(active, bundledVersion) < 0) clearToBundled()
    }
  }

  override fun status(): UiUpdateStatusDto {
    val active = activeVersion()?.takeIf { versionDirectory(it).resolve("index.html").isFile }
    val previous = preferences.getString(KEY_PREVIOUS, null)?.takeIf { versionDirectory(it).resolve("index.html").isFile }
    return UiUpdateStatusDto(
      enabled = publicKeyBase64.isNotBlank(),
      bundledVersion = bundledVersion,
      activeVersion = active,
      previousVersion = previous,
      installedVersions = versions.listFiles().orEmpty().filter { it.isDirectory && !it.name.startsWith(".") }
        .map { it.name }.sortedDescending(),
      message = when {
        publicKeyBase64.isBlank() -> "未配置 UI 更新公钥；仅运行 APK 内置资源"
        active != null -> "签名资源版本 $active 已激活"
        else -> "正在运行 APK 内置资源"
      },
    )
  }

  override fun install(request: UiUpdateInstallRequestDto): UiUpdateStatusDto = synchronized(LOCK) {
    activate(request, requireNewer = true)
  }

  override fun syncPackage(): UiUpdateInstallRequestDto? = synchronized(LOCK) {
    val active = status().activeVersion ?: return@synchronized null
    val directory = versionDirectory(active)
    val manifestJson = File(directory, MANIFEST_FILE).readText(Charsets.UTF_8)
    val paths = runCatching {
      val entries = JSONObject(manifestJson).getJSONArray("files")
      List(entries.length()) { index -> entries.getJSONObject(index).getString("path") }
    }.getOrElse { throw DomainException(500, "UI_UPDATE_STORED_MANIFEST_INVALID") }
    val encodedFiles = paths.associate { path ->
      val file = File(directory, path)
      if (!file.isFile) throw DomainException(500, "UI_UPDATE_STORED_FILE_MISSING")
      path to Base64.getEncoder().encodeToString(file.readBytes())
    }
    UiUpdateInstallRequestDto(
      manifestJson = manifestJson,
      signature = File(directory, SIGNATURE_FILE).readText(Charsets.US_ASCII),
      files = encodedFiles,
    )
  }

  override fun synchronize(targetVersion: String?, request: UiUpdateInstallRequestDto?): UiUpdateStatusDto = synchronized(LOCK) {
    if (targetVersion == null) {
      return@synchronized if (status().activeVersion == null) status() else clearToBundled()
    }
    if (status().activeVersion == targetVersion) return@synchronized status()
    if (request == null) throw DomainException(409, "UI_UPDATE_SYNC_PACKAGE_REQUIRED")
    val verified = UiUpdateVerifier.verify(request, publicKeyBase64, bundledVersion)
    if (verified.manifest.version != targetVersion) throw DomainException(400, "UI_UPDATE_SYNC_VERSION_MISMATCH")
    activate(request, requireNewer = false, preverified = verified)
  }

  private fun activate(
    request: UiUpdateInstallRequestDto,
    requireNewer: Boolean,
    preverified: cn.zhijing.smartlab.edgecore.VerifiedUiUpdate? = null,
  ): UiUpdateStatusDto {
    val verified = preverified ?: UiUpdateVerifier.verify(request, publicKeyBase64, bundledVersion)
    val currentVersion = activeVersion() ?: bundledVersion
    if (requireNewer && UiUpdateVerifier.compareVersions(verified.manifest.version, currentVersion) <= 0) {
      throw DomainException(409, "UI_UPDATE_VERSION_NOT_NEWER")
    }
    versions.mkdirs()
    val target = versionDirectory(verified.manifest.version)
    if (target.exists()) {
      if (requireNewer) throw DomainException(409, "UI_UPDATE_VERSION_ALREADY_INSTALLED")
      target.deleteRecursively()
    }
    val staging = File(versions, ".staging-${verified.manifest.version}-${UUID.randomUUID()}")
    return try {
      if (!staging.mkdirs()) throw DomainException(500, "UI_UPDATE_STAGING_FAILED")
      verified.files.forEach { (path, bytes) ->
        val output = File(staging, path)
        output.parentFile?.mkdirs()
        if (!output.canonicalPath.startsWith(staging.canonicalPath + File.separator)) {
          throw DomainException(400, "UI_UPDATE_PATH_INVALID")
        }
        FileOutputStream(output).use { stream -> stream.write(bytes); stream.fd.sync() }
      }
      FileOutputStream(File(staging, MANIFEST_FILE)).use { stream ->
        stream.write(request.manifestJson.toByteArray(Charsets.UTF_8)); stream.fd.sync()
      }
      FileOutputStream(File(staging, SIGNATURE_FILE)).use { stream ->
        stream.write(request.signature.toByteArray(Charsets.US_ASCII)); stream.fd.sync()
      }
      if (!staging.renameTo(target)) throw DomainException(500, "UI_UPDATE_ACTIVATION_FAILED")
      val previous = activeVersion()
      if (!preferences.edit().putString(KEY_ACTIVE, verified.manifest.version).putString(KEY_PREVIOUS, previous).commit()) {
        target.deleteRecursively()
        throw DomainException(500, "UI_UPDATE_ACTIVATION_FAILED")
      }
      prune(keep = setOfNotNull(verified.manifest.version, previous))
      notifyActivated()
      status()
    } finally {
      staging.deleteRecursively()
    }
  }

  override fun rollback(): UiUpdateStatusDto = synchronized(LOCK) {
    val current = activeVersion()
    val previous = preferences.getString(KEY_PREVIOUS, null)?.takeIf { versionDirectory(it).resolve("index.html").isFile }
    val editor = preferences.edit()
    if (previous != null) editor.putString(KEY_ACTIVE, previous) else editor.remove(KEY_ACTIVE)
    editor.remove(KEY_PREVIOUS)
    if (!editor.commit()) throw DomainException(500, "UI_UPDATE_ROLLBACK_FAILED")
    current?.let { versionDirectory(it).deleteRecursively() }
    notifyActivated()
    status()
  }

  private fun clearToBundled(): UiUpdateStatusDto {
    if (!preferences.edit().remove(KEY_ACTIVE).remove(KEY_PREVIOUS).commit()) {
      throw DomainException(500, "UI_UPDATE_ROLLBACK_FAILED")
    }
    versions.deleteRecursively()
    notifyActivated()
    return status()
  }

  private fun activeVersion() = preferences.getString(KEY_ACTIVE, null)
  private fun versionDirectory(version: String) = File(versions, version)
  private fun prune(keep: Set<String>) {
    versions.listFiles().orEmpty().filter { it.isDirectory && it.name !in keep }.forEach(File::deleteRecursively)
  }
  private fun notifyActivated() = appContext.sendBroadcast(Intent(ACTION_ACTIVATED).setPackage(appContext.packageName))

  companion object {
    const val ACTION_ACTIVATED = "cn.zhijing.smartlab.action.UI_UPDATE_ACTIVATED"
    private const val PREFERENCES = "smart-lab-ui-updates"
    private const val KEY_ACTIVE = "active-version"
    private const val KEY_PREVIOUS = "previous-version"
    private const val MANIFEST_FILE = "manifest.signed.json"
    private const val SIGNATURE_FILE = "manifest.ed25519"
    private val LOCK = Any()

    fun activeDirectory(context: Context): File? {
      val version = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY_ACTIVE, null) ?: return null
      return File(context.filesDir, "panel-ui-updates/versions/$version").takeIf { File(it, "index.html").isFile }
    }
  }
}
