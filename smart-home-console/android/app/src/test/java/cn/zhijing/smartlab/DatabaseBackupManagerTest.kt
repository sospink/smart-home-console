package cn.zhijing.smartlab

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.nio.file.Files

class DatabaseBackupManagerTest {
  @Test
  fun `backup retention keeps the seven newest entries`() {
    val ordered = (1..10).map { "backup-$it.db" }
    assertEquals(ordered.take(7), retainedDatabaseBackups(ordered))
  }

  @Test
  fun `daily backup is due only after twenty four hours`() {
    val latest = Instant.parse("2026-07-24T08:00:00Z")
    assertFalse(backupIsDue(latest, Instant.parse("2026-07-25T07:59:59Z")))
    assertTrue(backupIsDue(latest, Instant.parse("2026-07-25T08:00:00Z")))
  }

  @Test
  fun `backup target remains allowlisted and unique when timestamps collide`() {
    val directory = Files.createTempDirectory("smart-lab-backup-test").toFile()
    val now = Instant.parse("2026-07-25T03:00:00Z")
    val first = uniqueBackupTarget(directory, now)
    assertTrue(first.createNewFile())
    val second = uniqueBackupTarget(directory, now)
    assertFalse(first.name == second.name)
    assertTrue(cn.zhijing.smartlab.edgecore.validDatabaseBackupFilename(first.name))
    assertTrue(cn.zhijing.smartlab.edgecore.validDatabaseBackupFilename(second.name))
    directory.deleteRecursively()
  }

  @Test
  fun `storage gate preserves runtime headroom beyond the next backup`() {
    val databaseSize = 40L * 1024 * 1024
    val critical = classifyStorage(8L * 1024 * 1024 * 1024, 300L * 1024 * 1024, databaseSize)
    assertFalse(critical.canCreate)
    assertEquals("critical", critical.level)
    val warning = classifyStorage(8L * 1024 * 1024 * 1024, 500L * 1024 * 1024, databaseSize)
    assertTrue(warning.canCreate)
    assertEquals("warning", warning.level)
    val healthy = classifyStorage(8L * 1024 * 1024 * 1024, 2L * 1024 * 1024 * 1024, databaseSize)
    assertTrue(healthy.canCreate)
    assertEquals("healthy", healthy.level)
    assertEquals(80L * 1024 * 1024, healthy.estimatedNextBackupBytes)
  }

  @Test
  fun `daily growth uses median positive rate and does not invent a trend from one sample`() {
    val start = Instant.parse("2026-07-20T00:00:00Z")
    assertEquals(null, estimateDailyGrowth(listOf(start to 10L)).bytesPerDay)
    val estimate = estimateDailyGrowth(
      listOf(start to 10L, start.plusSeconds(86_400) to 110L, start.plusSeconds(172_800) to 310L),
    )
    assertEquals(200L, estimate.bytesPerDay)
    assertEquals(3, estimate.samples)
    assertEquals(0L, estimateDailyGrowth(listOf(start to 100L, start.plusSeconds(86_400) to 90L)).bytesPerDay)
  }
}
