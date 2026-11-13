package cn.zhijing.smartlab.data

import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SmartLabMigrationTest {
  @get:Rule
  val helper = MigrationTestHelper(
    InstrumentationRegistry.getInstrumentation(),
    SmartLabDatabase::class.java,
    emptyList(),
    FrameworkSQLiteOpenHelperFactory(),
  )

  @Test
  fun migrateVersion1To15PreservesExistingDataAndCreatesNewColumnsAuditIndexesAndHandoverTable() {
    helper.createDatabase(TEST_DB, 1).apply {
      execSQL(
        """
        INSERT INTO gateways(id,name,host,port,model,firmware,credentialRef,mode,health,updatedAt)
        VALUES('gateway-legacy','旧版网关','192.168.10.2',1883,'DMWG03LM','legacy','keystore://legacy','local','online','2026-07-24T00:00:00Z')
        """.trimIndent(),
      )
      execSQL("INSERT INTO rooms(id,name,sortOrder,enabled) VALUES('room-legacy','旧版实训区',1,1)")
      close()
    }

    val database = Room.databaseBuilder(
      ApplicationProvider.getApplicationContext(),
      SmartLabDatabase::class.java,
      TEST_DB,
    ).build()
    database.openHelper.writableDatabase

    database.query(SimpleSQLiteQuery("SELECT name,lastTestOk,lastTestMessage,lastTestAt FROM gateways WHERE id='gateway-legacy'")).use { cursor ->
      assertTrue(cursor.moveToFirst())
      assertEquals("旧版网关", cursor.getString(0))
      assertTrue(cursor.isNull(1))
      assertTrue(cursor.isNull(2))
      assertTrue(cursor.isNull(3))
    }
    database.query(SimpleSQLiteQuery("SELECT name FROM rooms WHERE id='room-legacy'")).use { cursor ->
      assertTrue(cursor.moveToFirst())
      assertEquals("旧版实训区", cursor.getString(0))
    }
    database.query(SimpleSQLiteQuery("PRAGMA table_info(audit_logs)")).use { cursor ->
      val nameIndex = cursor.getColumnIndexOrThrow("name")
      val columns = buildSet { while (cursor.moveToNext()) add(cursor.getString(nameIndex)) }
      assertTrue("trainingId" in columns)
      assertTrue("trainingEvidence" in columns)
    }
    database.query(SimpleSQLiteQuery("PRAGMA index_list(audit_logs)")).use { cursor ->
      val nameIndex = cursor.getColumnIndexOrThrow("name")
      val indexes = buildSet { while (cursor.moveToNext()) add(cursor.getString(nameIndex)) }
      assertTrue("index_audit_logs_trainingId" in indexes)
      assertTrue("index_audit_logs_trainingEvidence" in indexes)
      assertTrue("index_audit_logs_result" in indexes)
    }
    database.query(SimpleSQLiteQuery("PRAGMA table_info(devices)")).use { cursor ->
      val nameIndex = cursor.getColumnIndexOrThrow("name")
      val columns = buildSet { while (cursor.moveToNext()) add(cursor.getString(nameIndex)) }
      assertTrue("displayIcon" in columns)
      assertTrue("displayOrder" in columns)
      assertTrue("displayHidden" in columns)
      assertTrue("displayFavorite" in columns)
      assertTrue("secondarySlot" in columns)
    }
    database.query(SimpleSQLiteQuery("PRAGMA table_info(training_exercises)")).use { cursor ->
      val nameIndex = cursor.getColumnIndexOrThrow("name")
      val columns = buildSet { while (cursor.moveToNext()) add(cursor.getString(nameIndex)) }
      assertTrue("cancelReason" in columns)
      assertTrue("participant" in columns)
      assertTrue("scoreCorrectionReason" in columns)
      assertTrue("scoreCorrectedAt" in columns)
      assertTrue("scoreRevisionCount" in columns)
      assertTrue("startReadinessCheckedAt" in columns)
      assertTrue("startTargetHealth" in columns)
      assertTrue("startPairedTerminals" in columns)
      assertTrue("startOnlineTerminals" in columns)
      assertTrue("startAcknowledgedWarnings" in columns)
      assertTrue("operationEvidenceVersion" in columns)
    }
    database.query(SimpleSQLiteQuery("SELECT eventSequence FROM configuration_meta LIMIT 1")).use { cursor ->
      // 旧数据库可以没有 meta 行，但 v2 新列必须可查询且 schema 校验已通过。
      if (cursor.moveToFirst()) assertEquals(0L, cursor.getLong(0))
    }
    database.query(SimpleSQLiteQuery("PRAGMA table_info(configuration_meta)")).use { cursor ->
      val nameIndex = cursor.getColumnIndexOrThrow("name")
      val columns = buildSet { while (cursor.moveToNext()) add(cursor.getString(nameIndex)) }
      assertTrue("benchResetPower" in columns)
      assertTrue("benchResetCover" in columns)
      assertTrue("benchResetSuppressionSeconds" in columns)
      assertTrue("automationSuppressedUntil" in columns)
    }
    database.query(SimpleSQLiteQuery("PRAGMA table_info(handover_records)")).use { cursor ->
      val nameIndex = cursor.getColumnIndexOrThrow("name")
      val columns = buildSet { while (cursor.moveToNext()) add(cursor.getString(nameIndex)) }
      assertTrue(setOf("id", "completedAt", "completedBy", "stateToken", "acknowledgedWarningsJson", "note", "summaryJson").all { it in columns })
    }
    database.close()
  }

  @Test
  fun persistentSecretStoreEncryptsAtRestAndSurvivesRecreation() {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    val reference = "terminal-token-test"
    val secret = "terminal-secret-that-must-not-appear-in-xml"
    val first = PersistentSecretStore(context)
    first.put(reference, secret)

    assertEquals(secret, PersistentSecretStore(context).get(reference))
    val preferencesFile = File(context.applicationInfo.dataDir, "shared_prefs/smart-lab-secrets.xml")
    val persisted = preferencesFile.readText()
    assertTrue(persisted.contains(reference))
    assertTrue(!persisted.contains(secret))
    assertTrue(persisted.contains("."))

    PersistentSecretStore(context).remove(reference)
    assertEquals(null, PersistentSecretStore(context).get(reference))
  }

  @Test
  fun deviceDisplayPreferencesPersistInRoom() = runBlocking {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    context.deleteDatabase(DISPLAY_DB)
    val database = Room.databaseBuilder(context, SmartLabDatabase::class.java, DISPLAY_DB).build()
    try {
      val dao = database.edgeDao()
      dao.seedIfEmpty(DefaultSeed.create("2026-07-24T00:00:00Z"))
      val initial = dao.devices().first { it.id == "living-main-light" }
      assertTrue(initial.displayFavorite)

      dao.putDevice(
        initial.copy(
          displayIcon = "ceiling",
          displayOrder = 42,
          displayHidden = true,
          displayFavorite = false,
          secondarySlot = "light",
        )
      )
      val restored = dao.devices().first { it.id == initial.id }
      assertEquals("ceiling", restored.displayIcon)
      assertEquals(42, restored.displayOrder)
      assertTrue(restored.displayHidden)
      assertTrue(!restored.displayFavorite)
      assertEquals("light", restored.secondarySlot)
    } finally {
      database.close()
      context.deleteDatabase(DISPLAY_DB)
    }
  }

  @Test
  fun interruptedRuntimeIsClosedAtomicallyBeforeServingTraffic() = runBlocking {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    context.deleteDatabase(RUNTIME_DB)
    val database = Room.databaseBuilder(context, SmartLabDatabase::class.java, RUNTIME_DB).build()
    try {
      val dao = database.edgeDao()
      dao.seedIfEmpty(DefaultSeed.create("2026-07-25T00:00:00Z"))
      dao.putCommand(
        CommandEntity(
          "cmd-1", "request-1", "living-main-light", "power", "true", "primary", "pending",
          "2026-07-25T00:00:00Z", null, null,
        )
      )
      dao.putExecution(
        SceneExecutionEntity(
          "execution-1", "scene-home", "primary", "running", 1, 2,
          "2026-07-25T00:00:01Z", null,
        )
      )
      dao.putTerminal(
        TerminalEntity(
          "secondary", "android-secondary", "副屏", "secondary", "hash", true, true, "0.1.0",
          "192.168.1.20", "2026-07-25T00:00:02Z",
        )
      )
      val light = dao.devices().first { it.id == "living-main-light" }
      dao.putDevice(light.copy(health = "online"))
      val gateway = dao.gateways().single()
      dao.putGateway(gateway.copy(health = "online"))

      val result = dao.recoverInterruptedRuntime(
        "2026-07-25T00:10:00Z",
        "EdgeCore 重启，命令最终状态未知，请核对设备",
      )

      assertEquals(1, result.timedOutCommands)
      assertEquals("timeout", dao.commands().single().status)
      assertEquals(null, dao.commands().single().confirmedAt)
      assertEquals("partial", dao.executions().single().status)
      assertEquals("2026-07-25T00:10:00Z", dao.executions().single().finishedAt)
      assertTrue(!dao.terminals().single().online)
      assertEquals(1, result.invalidatedGateways)
      assertEquals(1, result.invalidatedDevices)
      assertTrue(dao.gateways().all { it.health == "offline" })
      assertTrue(dao.devices().all { it.health == "offline" })
    } finally {
      database.close()
      context.deleteDatabase(RUNTIME_DB)
    }
  }

  @Test
  fun terminalContactDoesNotClaimOnlineUntilEventStreamConnects() = runBlocking {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    context.deleteDatabase(TERMINAL_DB)
    val database = Room.databaseBuilder(context, SmartLabDatabase::class.java, TERMINAL_DB).build()
    try {
      val dao = database.edgeDao()
      dao.seedIfEmpty(DefaultSeed.create("2026-07-25T00:00:00Z"))
      dao.putTerminal(
        TerminalEntity(
          "secondary", "android-secondary", "副屏", "secondary", "hash", true, false, "0.1.0",
          "192.168.1.20", "2026-07-25T00:00:00Z",
        )
      )

      dao.updateTerminalContact("secondary", "192.168.1.21", "0.1.1", "2026-07-25T00:01:00Z")
      assertTrue(!dao.terminals().single().online)
      assertEquals("192.168.1.21", dao.terminals().single().address)

      dao.touchTerminal("secondary", true, "192.168.1.21", "0.1.1", "2026-07-25T00:02:00Z")
      assertTrue(dao.terminals().single().online)
      dao.setTerminalOnline("secondary", false)
      assertTrue(!dao.terminals().single().online)
    } finally {
      database.close()
      context.deleteDatabase(TERMINAL_DB)
    }
  }

  @Test
  fun auditPaginationSearchesTheCompleteHistoryBeyondTheRecentSnapshotLimit() = runBlocking {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    context.deleteDatabase(AUDIT_DB)
    val database = Room.databaseBuilder(context, SmartLabDatabase::class.java, AUDIT_DB).build()
    try {
      val dao = database.edgeDao()
      repeat(620) { index ->
        dao.putAudit(
          AuditEntity(
            "audit-$index", "command", if (index == 0) "最早设备关键操作" else "普通操作 $index",
            "第 $index 条过程证据", if (index % 2 == 0) "primary" else "secondary", "success",
            "2026-07-25T00:${(index / 60).toString().padStart(2, '0')}:${(index % 60).toString().padStart(2, '0')}Z",
            if (index == 0) "legacy-record" else null,
          )
        )
      }

      assertEquals(620, dao.auditQueryCount("", "all"))
      assertEquals(100, dao.auditQuery("", "all", 100, 500).size)
      val oldest = dao.auditQuery("最早设备关键操作", "all", 10, 0)
      assertEquals(1, oldest.size)
      assertEquals("最早设备关键操作", oldest.single().action)
      assertEquals(0, dao.auditQueryCount("legacy-record", "all"))
      assertEquals(310, dao.auditQueryCount("", "primary"))
    } finally {
      database.close()
      context.deleteDatabase(AUDIT_DB)
    }
  }

  @Test
  fun handoverRecordsPersistAndCanBeReadByIdAndLatest() = runBlocking {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    context.deleteDatabase(HANDOVER_DB)
    val database = Room.databaseBuilder(context, SmartLabDatabase::class.java, HANDOVER_DB).build()
    try {
      val dao = database.edgeDao()
      dao.putHandover(
        HandoverRecordEntity(
          "handover-001", "2026-07-26T01:00:00Z", "张老师", "state-token", "[\"OFFLINE_DEVICES\"]",
          "卧室灯待维修", "{\"pendingOperations\":0}",
        )
      )
      assertEquals("张老师", dao.latestHandover()?.completedBy)
      assertEquals("卧室灯待维修", dao.handoverById("handover-001")?.note)
    } finally {
      database.close()
      context.deleteDatabase(HANDOVER_DB)
    }
  }

  companion object {
    private const val TEST_DB = "smart-lab-migration-test"
    private const val DISPLAY_DB = "smart-lab-display-test"
    private const val RUNTIME_DB = "smart-lab-runtime-test"
    private const val TERMINAL_DB = "smart-lab-terminal-test"
    private const val AUDIT_DB = "smart-lab-audit-test"
    private const val HANDOVER_DB = "smart-lab-handover-test"
  }
}
