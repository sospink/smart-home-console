package cn.zhijing.smartlab.edgecore

import java.io.InputStream

interface DatabaseBackupCoordinator {
  suspend fun list(): List<DatabaseBackupArtifactDto>
  suspend fun storage(): DatabaseBackupStorageDto
  suspend fun lifecycle(): DataLifecycleReportDto
  suspend fun create(): DatabaseBackupArtifactDto
  suspend fun open(filename: String): InputStream?
}

class DatabaseBackupUnavailableException(message: String) : RuntimeException(message)

fun validDatabaseBackupFilename(value: String): Boolean =
  value.matches(Regex("^smart-lab-[0-9T.\\-]+Z\\.db$")) && !value.contains("..")
