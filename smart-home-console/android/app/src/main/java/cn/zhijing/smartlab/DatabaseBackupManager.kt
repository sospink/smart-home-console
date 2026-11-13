package cn.zhijing.smartlab

import android.content.Context
import cn.zhijing.smartlab.data.SmartLabDatabase
import cn.zhijing.smartlab.edgecore.DatabaseBackupArtifactDto
import cn.zhijing.smartlab.edgecore.DatabaseBackupCoordinator
import cn.zhijing.smartlab.edgecore.DatabaseBackupStorageDto
import cn.zhijing.smartlab.edgecore.DatabaseBackupUnavailableException
import cn.zhijing.smartlab.edgecore.DataDomainFootprintDto
import cn.zhijing.smartlab.edgecore.DataLifecycleReportDto
import cn.zhijing.smartlab.edgecore.validDatabaseBackupFilename
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.time.Instant
import java.time.Duration
import java.security.MessageDigest
import java.io.InputStream
import java.util.Properties
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** 备份只包含 Room 数据库；Keystore 密钥与密文 SharedPreferences 明确排除。 */
class DatabaseBackupManager(private val context: Context, private val database: SmartLabDatabase) : DatabaseBackupCoordinator {
  private val directory = File(context.filesDir, "database-backups").apply { mkdirs() }
  private val creationMutex = Mutex()
  private val verificationMutex = Mutex()

  suspend fun createFile(): File = creationMutex.withLock { verificationMutex.withLock { createFileLocked() } }

  private fun createFileLocked(): File {
    val storage = storageSnapshot(directory, context.getDatabasePath("smart-lab.db").length())
    if (!storage.canCreate) throw DatabaseBackupUnavailableException("数据库快照创建已暂停：${storage.message}")
    val target = uniqueBackupTarget(directory, Instant.now())
    return try {
      database.openHelper.writableDatabase.execSQL("VACUUM INTO ?", arrayOf(target.absolutePath))
      require(target.isFile && target.length() > 0) { "数据库备份产物无效" }
      val verification = verifyDatabaseBackup(target)
      require(verification.integrityStatus == "ok") { "数据库备份完整性校验失败" }
      writeManifest(target, verification)
      prune()
      target
    } catch (error: Throwable) {
      target.delete()
      manifestFile(target).delete()
      throw error
    }
  }

  suspend fun createIfDue(now: Instant = Instant.now()): File? = creationMutex.withLock {
    verificationMutex.withLock verification@{
      val newest = listFiles().firstOrNull() ?: return@verification createFileLocked()
      if (backupIsDue(Instant.ofEpochMilli(newest.lastModified()), now)) createFileLocked() else null
    }
  }

  override suspend fun create(): DatabaseBackupArtifactDto {
    val file = createFile()
    return verificationMutex.withLock { artifact(file) }
  }

  override suspend fun list(): List<DatabaseBackupArtifactDto> = verificationMutex.withLock { listFiles().map(::artifact) }

  override suspend fun storage(): DatabaseBackupStorageDto =
    storageSnapshot(directory, context.getDatabasePath("smart-lab.db").length())

  override suspend fun lifecycle(): DataLifecycleReportDto {
    val databaseFile = context.getDatabasePath("smart-lab.db")
    val databaseBytes = databaseFile.length() + File("${databaseFile.absolutePath}-wal").length() + File("${databaseFile.absolutePath}-shm").length()
    val storage = storageSnapshot(directory, databaseBytes)
    val artifacts = list().filter { it.integrityStatus == "ok" }.sortedBy { Instant.parse(it.createdAt) }
    val trend = estimateDailyGrowth(artifacts.map { Instant.parse(it.createdAt) to it.sizeBytes })
    val days = trend.bytesPerDay?.takeIf { it > 0 }?.let {
      ((storage.usableBytes - storage.reserveBytes).coerceAtLeast(0) / it).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }
    val level = when {
      !storage.canCreate || days != null && days <= 30 -> "critical"
      storage.level == "warning" || days != null && days <= 90 -> "warning"
      trend.samples < 2 -> "unknown"
      else -> "healthy"
    }
    val message = when (level) {
      "critical" -> "长期数据容量已进入高风险区，请立即完成离机备份并清理非业务文件"
      "warning" -> "按当前增长趋势，存储余量需要安排近期运维"
      "unknown" -> "快照样本不足，至少积累 2 个有效日快照后才能预测增长"
      else -> "长期数据增长与当前存储余量正常"
    }
    val dao = database.edgeDao()
    return DataLifecycleReportDto(
      generatedAt = Instant.now().toString(),
      databaseBytes = databaseBytes,
      usableBytes = storage.usableBytes,
      reserveBytes = storage.reserveBytes,
      growthBytesPerDay = trend.bytesPerDay,
      estimatedDaysToReserve = days,
      trendSamples = trend.samples,
      level = level,
      message = message,
      domains = listOf(
        DataDomainFootprintDto("audits", "审计记录", dao.auditCount(), dao.oldestAuditAt(), "authoritative", guidance = "承担设备控制与管理追溯，不允许按条数截断"),
        DataDomainFootprintDto("alerts", "告警历史", dao.alertCount(), dao.oldestAlertAt(), "safety", guidance = "安全事件应按学校档案策略归档后再处置"),
        DataDomainFootprintDto("commands", "设备命令", dao.commandCount(), dao.oldestCommandAt(), "operational", guidance = "当前仅监测增长；建立签名归档前不自动清理"),
        DataDomainFootprintDto("executions", "场景执行", dao.executionCount(), dao.oldestExecutionAt(), "operational", guidance = "当前仅监测增长；建立签名归档前不自动清理"),
      ),
    )
  }

  override suspend fun open(filename: String): InputStream? {
    if (!validDatabaseBackupFilename(filename)) return null
    val file = File(directory, filename)
    if (!file.isFile || file.parentFile?.canonicalFile != directory.canonicalFile) return null
    if (verificationMutex.withLock { artifact(file).integrityStatus != "ok" }) return null
    return file.inputStream().buffered()
  }

  fun listFiles(): List<File> = directory.listFiles { file -> file.isFile && validDatabaseBackupFilename(file.name) }
    ?.sortedByDescending(File::lastModified)
    .orEmpty()

  private fun artifact(file: File): DatabaseBackupArtifactDto {
    val manifest = readManifest(file)
    if (
      manifest != null &&
      manifest.sizeBytes == file.length() &&
      manifest.createdAt == Instant.ofEpochMilli(file.lastModified()).toString()
    ) return manifest
    return verifyDatabaseBackup(file).also { writeManifest(file, it) }
  }

  private fun verifyDatabaseBackup(file: File): DatabaseBackupArtifactDto {
    val verifiedAt = Instant.now().toString()
    val digest = sha256(file)
    var schemaVersion: Int? = null
    val status = try {
      SQLiteDatabase.openDatabase(file.absolutePath, null, SQLiteDatabase.OPEN_READONLY).use { sqlite ->
        sqlite.rawQuery("PRAGMA quick_check", null).use { cursor ->
          require(cursor.moveToFirst() && cursor.getString(0) == "ok") { "quick_check failed" }
        }
        sqlite.rawQuery("PRAGMA user_version", null).use { cursor ->
          require(cursor.moveToFirst()) { "user_version missing" }
          schemaVersion = cursor.getInt(0)
        }
      }
      "ok"
    } catch (_: Throwable) {
      "failed"
    }
    return DatabaseBackupArtifactDto(
      filename = file.name,
      createdAt = Instant.ofEpochMilli(file.lastModified()).toString(),
      sizeBytes = file.length(),
      sha256 = digest,
      integrityStatus = status,
      schemaVersion = schemaVersion,
      verifiedAt = verifiedAt,
    )
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun prune() {
    val keep = retainedDatabaseBackups(listFiles().map { it.absolutePath }).toSet()
    listFiles().filter { it.absolutePath !in keep }.forEach {
      it.delete()
      manifestFile(it).delete()
    }
  }

  private fun manifestFile(file: File) = File(file.parentFile, "${file.name}.meta")

  private fun writeManifest(file: File, artifact: DatabaseBackupArtifactDto) {
    val target = manifestFile(file)
    val temporary = File(target.parentFile, "${target.name}.tmp")
    val properties = Properties().apply {
      setProperty("createdAt", artifact.createdAt)
      setProperty("sizeBytes", artifact.sizeBytes.toString())
      setProperty("sha256", artifact.sha256)
      setProperty("integrityStatus", artifact.integrityStatus)
      setProperty("schemaVersion", artifact.schemaVersion?.toString().orEmpty())
      setProperty("verifiedAt", artifact.verifiedAt)
    }
    temporary.outputStream().buffered().use { properties.store(it, "SmartLab database backup verification") }
    try {
      Files.move(
        temporary.toPath(), target.toPath(),
        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING,
      )
    } catch (error: Throwable) {
      temporary.delete()
      throw IllegalStateException("数据库快照校验清单写入失败", error)
    }
  }

  private fun readManifest(file: File): DatabaseBackupArtifactDto? {
    return try {
      val properties = Properties().apply { manifestFile(file).inputStream().buffered().use(::load) }
      val status = properties.getProperty("integrityStatus")
      if (status != "ok" && status != "failed") return null
      DatabaseBackupArtifactDto(
        filename = file.name,
        createdAt = properties.getProperty("createdAt") ?: return null,
        sizeBytes = properties.getProperty("sizeBytes")?.toLongOrNull() ?: return null,
        sha256 = properties.getProperty("sha256")?.takeIf { it.matches(Regex("[0-9a-f]{64}")) } ?: return null,
        integrityStatus = status,
        schemaVersion = properties.getProperty("schemaVersion")?.toIntOrNull(),
        verifiedAt = properties.getProperty("verifiedAt") ?: return null,
      )
    } catch (_: Throwable) {
      null
    }
  }
}

internal const val DATABASE_BACKUP_RESERVE_BYTES = 256L * 1024 * 1024

internal fun storageSnapshot(directory: File, databaseSizeBytes: Long): DatabaseBackupStorageDto {
  return classifyStorage(directory.totalSpace.coerceAtLeast(0), directory.usableSpace.coerceAtLeast(0), databaseSizeBytes)
}

internal fun classifyStorage(total: Long, usable: Long, databaseSizeBytes: Long): DatabaseBackupStorageDto {
  val estimated = maxOf(databaseSizeBytes * 2, 16L * 1024 * 1024)
  val required = DATABASE_BACKUP_RESERVE_BYTES + estimated
  val canCreate = usable >= required
  val level = when {
    !canCreate -> "critical"
    usable < required + DATABASE_BACKUP_RESERVE_BYTES -> "warning"
    else -> "healthy"
  }
  val message = when (level) {
    "critical" -> "剩余空间不足，需至少保留 256 MB 运行余量并容纳下一份快照"
    "warning" -> "剩余空间偏低，请尽快导出并清理非业务文件"
    else -> "存储余量满足下一次数据库快照"
  }
  return DatabaseBackupStorageDto(total, usable, DATABASE_BACKUP_RESERVE_BYTES, estimated, canCreate, level, message)
}

internal fun <T> retainedDatabaseBackups(newestFirst: List<T>, limit: Int = 7) = newestFirst.take(limit)
internal fun backupIsDue(latest: Instant, now: Instant, interval: Duration = Duration.ofHours(24)): Boolean =
  !now.isBefore(latest.plus(interval))
internal fun uniqueBackupTarget(directory: File, now: Instant): File {
  val timestamp = now.toString().removeSuffix("Z").replace(':', '-')
  var suffix = 0
  while (true) {
    val candidate = File(directory, "smart-lab-$timestamp${if (suffix == 0) "" else "-$suffix"}Z.db")
    if (!candidate.exists()) return candidate
    suffix += 1
  }
}

internal data class DatabaseGrowthEstimate(val bytesPerDay: Long?, val samples: Int)

internal fun estimateDailyGrowth(samples: List<Pair<Instant, Long>>): DatabaseGrowthEstimate {
  if (samples.size < 2) return DatabaseGrowthEstimate(null, samples.size)
  val rates = samples.zipWithNext().mapNotNull { (older, newer) ->
    val seconds = Duration.between(older.first, newer.first).seconds
    val bytes = newer.second - older.second
    if (seconds <= 0 || bytes <= 0) null else (bytes * 86_400.0 / seconds).toLong()
  }.sorted()
  if (rates.isEmpty()) return DatabaseGrowthEstimate(0, samples.size)
  return DatabaseGrowthEstimate(rates[rates.size / 2], samples.size)
}
