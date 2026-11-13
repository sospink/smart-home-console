package cn.zhijing.smartlab

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import cn.zhijing.smartlab.data.SmartLabDatabase
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DatabaseBackupManagerInstrumentedTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private lateinit var database: SmartLabDatabase

  @Before
  fun setUp() {
    clearArtifacts()
    database = Room.databaseBuilder(context, SmartLabDatabase::class.java, TEST_DATABASE).build()
    database.openHelper.writableDatabase.execSQL("PRAGMA user_version = 14")
  }

  @After
  fun tearDown() {
    database.close()
    context.deleteDatabase(TEST_DATABASE)
    clearArtifacts()
  }

  @Test
  fun realVacuumSnapshotMustPassQuickCheckBeforeItCanBeListedAndOpened() = runBlocking {
    val manager = DatabaseBackupManager(context, database)
    val created = manager.create()

    assertEquals("ok", created.integrityStatus)
    assertEquals(11, created.schemaVersion)
    assertTrue(created.sha256.matches(Regex("[0-9a-f]{64}")))
    assertTrue(created.sizeBytes > 0)
    assertEquals(created, manager.list().single())
    manager.open(created.filename).use { input -> assertTrue(input != null && input.read() >= 0) }

    val file = manager.listFiles().single()
    file.outputStream().use { it.write("not-sqlite".encodeToByteArray()) }
    val corrupted = manager.list().single()
    assertEquals("failed", corrupted.integrityStatus)
  }

  private fun clearArtifacts() = File(context.filesDir, "database-backups").deleteRecursively()

  companion object {
    private const val TEST_DATABASE = "smart-lab-backup-instrumented.db"
  }
}
