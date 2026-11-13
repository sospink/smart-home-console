package cn.zhijing.smartlab

import android.content.Context
import java.io.File
import java.time.Instant

class OperationalLog(context: Context) {
  private val directory = File(context.filesDir, "operational-logs").apply { mkdirs() }
  private val current = File(directory, "edgecore.log")

  @Synchronized
  fun write(level: String, event: String, detail: String = "") {
    rotateIfNeeded()
    val safe = redactOperationalDetail(detail).replace('\n', ' ').replace('\r', ' ').take(2_000)
    current.appendText("${Instant.now()} ${level.uppercase()} ${event.take(120)}${if (safe.isBlank()) "" else " | $safe"}\n")
  }

  @Synchronized
  fun exportLines(maxLines: Int = 2_000): List<String> = filesNewestFirst()
    .flatMap { file -> runCatching { file.readLines() }.getOrDefault(emptyList()) }
    .takeLast(maxLines)
    .map(::redactOperationalDetail)

  private fun rotateIfNeeded() {
    if (!current.exists() || current.length() < MAX_BYTES) return
    for (index in MAX_FILES - 1 downTo 1) {
      val source = File(directory, "edgecore.log.$index")
      val target = File(directory, "edgecore.log.${index + 1}")
      if (source.exists()) {
        if (index + 1 >= MAX_FILES) source.delete() else source.renameTo(target)
      }
    }
    current.renameTo(File(directory, "edgecore.log.1"))
  }

  private fun filesNewestFirst() = buildList {
    for (index in MAX_FILES - 1 downTo 1) File(directory, "edgecore.log.$index").takeIf(File::isFile)?.let(::add)
    current.takeIf(File::isFile)?.let(::add)
  }

  companion object {
    private const val MAX_BYTES = 1_048_576L
    private const val MAX_FILES = 5
  }
}

/** 保持为纯函数，便于在不依赖 Android Context 的 JVM 测试中验证脱敏边界。 */
internal fun redactOperationalDetail(value: String) = value
  .replace(Regex("(?i)(token|key|secret|password|pin|authorization)\\s*[:=]\\s*[^\\s,;]+"), "$1=[REDACTED]")
  .replace(Regex("(?i)bearer\\s+[a-z0-9._~+/-]+=*"), "Bearer [REDACTED]")
