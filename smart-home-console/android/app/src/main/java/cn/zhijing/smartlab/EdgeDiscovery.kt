package cn.zhijing.smartlab

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import java.net.InetAddress

class EdgeDiscovery(context: Context) {
  private val nsd = context.getSystemService(NsdManager::class.java)
  private val handler = Handler(Looper.getMainLooper())
  private var listener: NsdManager.DiscoveryListener? = null
  private val generations = DiscoveryGenerationGate()
  private var timeout: Runnable? = null

  fun start(expectedControlDomainId: String?, onResolved: (String) -> Unit, onError: (String) -> Unit) {
    stop()
    val attempt = generations.begin()
    val progress = DiscoveryAttemptProgress(expectedControlDomainId != null)
    fun active() = generations.isActive(attempt)
    fun fail(message: String) {
      if (!active()) return
      stop()
      onError(message)
    }
    timeout = Runnable { fail(progress.timeoutMessage()) }.also { handler.postDelayed(it, DISCOVERY_TIMEOUT_MS) }
    listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) = Unit
      override fun onServiceFound(serviceInfo: NsdServiceInfo) {
        if (!active() || serviceInfo.serviceType != EdgeForegroundService.SERVICE_TYPE) return
        progress.recordFound()
        nsd.resolveService(serviceInfo, object : NsdManager.ResolveListener {
          override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
            if (active()) progress.recordResolveFailure()
          }
          override fun onServiceResolved(info: NsdServiceInfo) {
            if (!active()) return
            val observedControlDomainId = info.attributes[CONTROL_DOMAIN_ATTRIBUTE]?.toString(Charsets.UTF_8)
            if (!ControlDomainDiscoveryPolicy.accepts(expectedControlDomainId, observedControlDomainId)) {
              progress.recordRejected()
              return
            }
            val host: InetAddress = info.host ?: return
            val address = runCatching { EdgeAddress.fromDiscoveredHost(host.hostAddress.orEmpty(), info.port) }
              .getOrElse { progress.recordResolveFailure(); return }
            stop()
            onResolved(address)
          }
        })
      }
      override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
      override fun onDiscoveryStopped(serviceType: String) = Unit
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = fail("自动发现启动失败（代码 $errorCode），请检查 WLAN/有线网络或直接输入主屏 IP")
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
    }.also { nsd.discoverServices(EdgeForegroundService.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, it) }
  }

  fun stop() {
    generations.invalidate()
    timeout?.let(handler::removeCallbacks)
    timeout = null
    listener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
    listener = null
  }

  companion object {
    private const val CONTROL_DOMAIN_ATTRIBUTE = "domainId"
    private const val DISCOVERY_TIMEOUT_MS = 12_000L
  }
}

/** 绑定后自动发现只能回到原控制域；首次安装尚无绑定时允许选择首个合法主屏。 */
internal object ControlDomainDiscoveryPolicy {
  fun accepts(expected: String?, observed: String?) = expected == null || expected == observed
}

/** 将发现超时转换成现场可执行诊断，不把“其他实训台”误报成“网络里什么都没有”。 */
internal class DiscoveryAttemptProgress(private val bound: Boolean) {
  private var found = 0
  private var rejected = 0
  private var resolveFailures = 0

  fun recordFound() { found += 1 }
  fun recordRejected() { rejected += 1 }
  fun recordResolveFailure() { resolveFailures += 1 }

  fun timeoutMessage() = when {
    bound && rejected > 0 -> "发现了 $rejected 台其他或旧版实训台，但未发现原已配对主屏；请检查原主屏电源/网络，换台请手工输入目标 IP 并重新配对"
    found == 0 -> "12 秒内未发现主屏；请确认主屏已启动且位于同一局域网，若网络禁用组播请直接输入主屏 IP"
    resolveFailures > 0 -> "发现了主屏广播但地址解析失败；请检查路由器 mDNS/组播设置，或直接输入主屏 IP"
    else -> "发现的主屏没有可用地址；请检查主屏网络，或直接输入主屏 IP"
  }
}

/** mDNS 解析回调可能晚于 stop/new start；只有当前代次可以改变连接和错误 UI。 */
internal class DiscoveryGenerationGate {
  private var generation = 0L
  fun begin(): Long = ++generation
  fun invalidate() { generation += 1 }
  fun isActive(candidate: Long) = candidate == generation
}
