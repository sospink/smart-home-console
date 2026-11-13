package cn.zhijing.smartlab

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.IBinder
import android.provider.Settings
import androidx.core.app.NotificationCompat
import cn.zhijing.smartlab.data.DefaultSeed
import cn.zhijing.smartlab.data.CapabilityEntity
import cn.zhijing.smartlab.data.PersistentSecretStore
import cn.zhijing.smartlab.data.SmartLabDatabase
import cn.zhijing.smartlab.edgecore.EdgeCoreServer
import cn.zhijing.smartlab.edgecore.RoomEdgeRepository
import cn.zhijing.smartlab.edgecore.TerminalDto
import cn.zhijing.smartlab.gateway.GatewayAdapter
import cn.zhijing.smartlab.gateway.GatewayConfig
import cn.zhijing.smartlab.gateway.GatewayHealth
import cn.zhijing.smartlab.gateway.ha.HomeAssistantCredential
import cn.zhijing.smartlab.gateway.ha.HomeAssistantGatewayAdapter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.SecureRandom
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference

class EdgeForegroundService : Service() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var server: EdgeCoreServer? = null
  private var registration: NsdManager.RegistrationListener? = null
  private var gatewayAdapter: GatewayAdapter? = null

  override fun onCreate() {
    super.onCreate()
    val log = OperationalLog(applicationContext)
    log.write("info", "service.start", "version=${BuildConfig.VERSION_NAME}")
    createNotificationChannel()
    startForeground(NOTIFICATION_ID, notification())
    scope.launch {
      val database = SmartLabDatabase.open(applicationContext)
      database.edgeDao().seedIfEmpty(DefaultSeed.create())
      database.edgeDao().migrateLegacyTrainingScene()
      val backups = DatabaseBackupManager(applicationContext, database)
      val secrets = PersistentSecretStore(applicationContext)
      val haCredential = secrets.get(HA_CREDENTIAL_REFERENCE)?.let { encoded ->
        runCatching { Json { ignoreUnknownKeys = true }.decodeFromString(HomeAssistantCredential.serializer(), encoded) }
          .onFailure { log.write("error", "gateway.ha.credential.invalid", it.message.orEmpty()) }
          .getOrNull()
      }
      if (haCredential != null) {
        database.edgeDao().activateHomeAssistantMvp(
          haCredential.baseUrl,
          haCredential.gatewayEntityId,
          haCredential.lightEntityId,
          java.time.Instant.now().toString(),
        )
      }
      val adminPin = secrets.get("admin-pin") ?: run {
        log.write("error", "security.admin-pin.missing")
        stopSelf()
        return@launch
      }
      val pairingCode = AtomicReference(secrets.getOrCreate("terminal-pairing-code") {
        SecureRandom().nextInt(1_000_000).toString().padStart(6, '0')
      })
      val primaryToken = secrets.getOrCreate("primary-terminal-token") {
        ByteArray(32).also(SecureRandom()::nextBytes).let { java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
      }
      val controlDomainId = secrets.getOrCreate("control-domain-id") { java.util.UUID.randomUUID().toString() }
      val controlDomainProofKey = secrets.getOrCreate("control-domain-proof-key") {
        ByteArray(32).also(SecureRandom()::nextBytes).let { java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
      }
      val repository = RoomEdgeRepository(database.edgeDao(), appVersion = BuildConfig.VERSION_NAME, controlDomainId = controlDomainId)
      val gatewayHealthEvents = MutableSharedFlow<GatewayHealth>(replay = 1, extraBufferCapacity = 4)
      val recoveredAt = java.time.Instant.now().toString()
      val adapter = runCatching {
        startGatewayAfterRuntimeRecovery(
          recover = {
            val result = repository.recoverInterruptedRuntime(recoveredAt)
            if (result.changed) {
              log.write(
                "warn", "runtime.recovered",
                "commands=${result.timedOutCommands} scenes=${result.failedExecutions + result.partialExecutions} terminals=${result.offlineTerminals} gateways=${result.invalidatedGateways} devices=${result.invalidatedDevices}",
              )
            }
          },
          startGateway = {
            haCredential?.let { credential ->
              HomeAssistantGatewayAdapter(credential).also { candidate ->
                val port = runCatching { java.net.URI(credential.baseUrl).port }.getOrDefault(-1).takeIf { it > 0 }
                  ?: if (credential.baseUrl.startsWith("https://")) 443 else 80
                runCatching {
                  // 恢复流程已经先把上一运行周期的在线状态失效；从这里开始产生的
                  // HA 首帧才属于本次运行，可通过 replay 在 EdgeCore 启动后恢复灯在线。
                  candidate.start(GatewayConfig("gateway-main", credential.baseUrl, port, "keystore://gateway-main"))
                  val discoveredLight = candidate.discover().firstOrNull { it.externalId == credential.lightEntityId }
                    ?: error("HA_LIGHT_ENTITY_NOT_DISCOVERED")
                  database.edgeDao().replaceDeviceCapabilities(
                    "living-main-light",
                    discoveredLight.capabilities.map { capability ->
                      CapabilityEntity(
                        "living-main-light",
                        capability.property,
                        capability.label,
                        capability.type,
                        capability.minimum,
                        capability.maximum,
                        capability.step,
                        capability.unit,
                        capability.writable,
                        capability.options?.let { options ->
                          JsonArray(options.map { option ->
                            JsonObject(mapOf("label" to JsonPrimitive(option.label), "value" to option.value))
                          }).toString()
                        },
                      )
                    },
                  )
                  gatewayHealthEvents.emit(candidate.health())
                }.onFailure {
                  log.write("error", "gateway.ha.start.failed", it.message.orEmpty())
                  gatewayHealthEvents.emit(GatewayHealth("gateway-main", false, 0, "1.0.8_0013", it.message))
                }
              }
            }
          },
        )
      }.getOrElse {
        // 如果无法收口旧瞬时状态，就不能启动网关或对外提供可能失真的在线状态。
        log.write("error", "runtime.recovery.failed", it.message.orEmpty())
        stopSelf()
        return@launch
      }
      gatewayAdapter = adapter
      // 备份必须发生在瞬时状态收口之后，避免把幽灵 pending/running/online 保存为最新恢复点。
      runCatching { backups.createIfDue() }
        .onSuccess { it?.let { file -> log.write("info", "database.backup", file.name) } }
        .onFailure { log.write("error", "database.backup.failed", it.message.orEmpty()) }
      val primaryDeviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID).orEmpty().ifBlank { "unknown-primary" }
      repository.saveTerminal(
        TerminalDto(
          id = "terminal-primary",
          deviceId = "android-$primaryDeviceId",
          name = "实训台主屏",
          role = "primary",
          paired = true,
          online = false,
          version = BuildConfig.VERSION_NAME,
          address = "127.0.0.1:$EDGE_PORT",
          lastSeenAt = java.time.Instant.now().toString(),
        ),
        tokenHash = "",
      )
      val candidate = EdgeCoreServer(
        repository = repository,
        adapterForDevice = { device -> if (device.integration.adapter == "home-assistant") adapter else null },
        gatewayEvents = adapter?.events() ?: kotlinx.coroutines.flow.emptyFlow(),
        gatewayHealthEvents = gatewayHealthEvents,
        gatewayTester = { id -> if (id == "gateway-main") adapter?.health() else null },
        adminPin = adminPin,
        pairingCodeProvider = pairingCode::get,
        controlDomainId = controlDomainId,
        controlDomainProofKey = controlDomainProofKey,
        primaryToken = primaryToken,
        adminPinUpdater = { next -> secrets.put("admin-pin", next) },
        pairingCodeRotator = {
          val next = SecureRandom().nextInt(1_000_000).toString().padStart(6, '0')
          pairingCode.set(next)
          secrets.put("terminal-pairing-code", next)
        },
        diagnosticProvider = { repository ->
          cn.zhijing.smartlab.edgecore.DiagnosticBundleDto(
            generatedAt = java.time.Instant.now().toString(),
            appVersion = BuildConfig.VERSION_NAME,
            databaseVersion = database.openHelper.readableDatabase.version,
            eventSequence = repository.sequence(),
            health = repository.health(),
            logs = log.exportLines(),
            databaseBackups = backups.listFiles().map { it.name },
          )
        },
        databaseBackupCoordinator = backups,
        uiUpdateCoordinator = AndroidUiUpdateCoordinator(applicationContext, BuildConfig.UI_UPDATE_PUBLIC_KEY, BuildConfig.VERSION_NAME),
        operationalLogger = log::write,
      )
      if (!edgePortAvailable()) {
        log.write("error", "edgecore.port.unavailable", "port=$EDGE_PORT")
        stopSelf()
        return@launch
      }
      runCatching { candidate.start() }
        .onFailure {
          log.write("error", "edgecore.start.failed", it.message.orEmpty())
          candidate.stop()
          stopSelf()
          return@launch
        }
      server = candidate
      log.write("info", "edgecore.ready", "port=$EDGE_PORT")
      if (adapter != null) launch {
        while (isActive) {
          delay(5_000)
          gatewayHealthEvents.emit(adapter.health())
        }
      }
      launch {
        while (isActive) {
          delay(60L * 60L * 1000L)
          runCatching { backups.createIfDue() }
            .onSuccess { it?.let { file -> log.write("info", "database.backup.daily", file.name) } }
            .onFailure { log.write("error", "database.backup.failed", it.message.orEmpty()) }
        }
      }
      publishService(controlDomainId)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    registration?.let { runCatching { getSystemService(NsdManager::class.java).unregisterService(it) } }
    server?.stop()
    kotlinx.coroutines.runBlocking { gatewayAdapter?.stop() }
    scope.cancel()
    super.onDestroy()
  }

  private fun publishService(controlDomainId: String) {
    val info = NsdServiceInfo().apply {
      serviceName = "知境-${android.os.Build.MODEL.replace(' ', '-')}"
      serviceType = SERVICE_TYPE
      port = EDGE_PORT
      setAttribute("version", BuildConfig.VERSION_NAME)
      setAttribute("role", "primary")
      // TXT 只用于从多台广播中筛选候选；真正解封令牌仍以 HTTP health 身份核验为准。
      setAttribute("domainId", controlDomainId)
    }
    registration = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(serviceInfo: NsdServiceInfo) = Unit
      override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
      override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) = Unit
      override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
    }.also { getSystemService(NsdManager::class.java).registerService(info, NsdManager.PROTOCOL_DNS_SD, it) }
  }

  private fun edgePortAvailable(): Boolean = runCatching {
    ServerSocket().use { socket ->
      socket.reuseAddress = true
      socket.bind(InetSocketAddress("0.0.0.0", EDGE_PORT))
    }
    true
  }.getOrDefault(false)

  private fun createNotificationChannel() {
    val channel = NotificationChannel(CHANNEL_ID, getString(R.string.edge_channel_name), NotificationManager.IMPORTANCE_LOW).apply {
      description = "为主副屏提供本地设备状态和控制服务"
      setShowBadge(false)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun notification() = NotificationCompat.Builder(this, CHANNEL_ID)
    .setSmallIcon(android.R.drawable.stat_notify_sync)
    .setContentTitle(getString(R.string.edge_notification_title))
    .setContentText("本地 API 与双屏状态同步已启动")
    .setOngoing(true)
    .setContentIntent(
      PendingIntent.getActivity(
        this,
        0,
        Intent(this, KioskActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    )
    .build()

  companion object {
    const val EDGE_PORT = 8787
    const val SERVICE_TYPE = "_smartlab-edge._tcp."
    const val HA_CREDENTIAL_REFERENCE = "gateway-main"
    private const val CHANNEL_ID = "smart-lab-edge"
    private const val NOTIFICATION_ID = 8701
  }
}
