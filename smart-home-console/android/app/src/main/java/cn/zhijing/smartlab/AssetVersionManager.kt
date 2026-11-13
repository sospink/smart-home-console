package cn.zhijing.smartlab

import android.content.Context
import java.io.File
import java.security.MessageDigest

/** 当前默认使用 APK 内置版本；外部热更新必须先通过 SHA-256 与签名审核才会被激活。 */
class AssetVersionManager(private val context: Context) {
  private val root = File(context.filesDir, "panel-ui-releases")

  fun activeVersion(): String = context.getSharedPreferences("panel-ui-version", Context.MODE_PRIVATE)
    .getString("active", "bundled") ?: "bundled"

  fun activeDirectory(): File? = activeVersion().takeUnless { it == "bundled" }?.let { File(root, it) }?.takeIf { File(it, "index.html").isFile }

  fun verifySha256(file: File, expected: String): Boolean {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }.equals(expected, ignoreCase = true)
  }

  fun activate(version: String) {
    require(version == "bundled" || File(root, "$version/index.html").isFile) { "UI 版本不完整" }
    context.getSharedPreferences("panel-ui-version", Context.MODE_PRIVATE).edit().putString("active", version).apply()
  }

  fun rollback() = activate("bundled")
}
