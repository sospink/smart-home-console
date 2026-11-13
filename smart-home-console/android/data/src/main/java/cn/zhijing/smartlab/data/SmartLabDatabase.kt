package cn.zhijing.smartlab.data

import android.content.Context
import androidx.room.AutoMigration
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
  entities = [
    GatewayEntity::class,
    RoomEntity::class,
    DeviceEntity::class,
    CapabilityEntity::class,
    DeviceStateEntity::class,
    SceneEntity::class,
    SceneActionEntity::class,
    AutomationEntity::class,
    CommandEntity::class,
    SceneExecutionEntity::class,
    AlertEntity::class,
    AuditEntity::class,
    HandoverRecordEntity::class,
    TerminalEntity::class,
    TrainingExerciseEntity::class,
    ConfigurationMetaEntity::class,
  ],
  version = 15,
  autoMigrations = [
    AutoMigration(from = 1, to = 2),
    AutoMigration(from = 2, to = 3),
    AutoMigration(from = 3, to = 4),
    AutoMigration(from = 4, to = 5),
    AutoMigration(from = 5, to = 6),
    AutoMigration(from = 6, to = 7),
    AutoMigration(from = 7, to = 8),
    AutoMigration(from = 8, to = 9),
    AutoMigration(from = 9, to = 10),
    AutoMigration(from = 10, to = 11),
    AutoMigration(from = 11, to = 12),
    AutoMigration(from = 12, to = 13),
    AutoMigration(from = 13, to = 14),
    AutoMigration(from = 14, to = 15),
  ],
  exportSchema = true,
)
abstract class SmartLabDatabase : RoomDatabase() {
  abstract fun edgeDao(): EdgeDao

  companion object {
    @Volatile private var instance: SmartLabDatabase? = null

    fun open(context: Context): SmartLabDatabase =
      instance
        ?: synchronized(this) {
          instance
            ?: Room.databaseBuilder(context.applicationContext, SmartLabDatabase::class.java, "smart-lab.db")
              .build()
              .also { instance = it }
        }
  }
}
