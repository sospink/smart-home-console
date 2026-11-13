package cn.zhijing.smartlab

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Bundle
import android.os.SystemClock
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewAssetLoader
import cn.zhijing.smartlab.data.PersistentSecretStore
import java.util.concurrent.Executors
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class KioskActivity : ComponentActivity() {
  private lateinit var config: RuntimeConfig
  private lateinit var root: FrameLayout
  private var webView: WebView? = null
  private var currentSurface: TerminalSurface? = null
  private var statusOverlay: View? = null
  private var discovery: EdgeDiscovery? = null
  private var lastLoadedAt = 0L
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var updateReceiver: BroadcastReceiver? = null
  private val io = Executors.newSingleThreadExecutor()
  private lateinit var pairing: TerminalPairingClient
  private lateinit var secrets: PersistentSecretStore
  private lateinit var uiUpdates: AndroidUiUpdateCoordinator
  @Volatile private var uiUpdateSyncInProgress = false
  @Volatile private var pairingRecoveryInProgress = false
  @Volatile private var pairingIdentityCheckInProgress = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    config = RuntimeConfig(this)
    pairing = TerminalPairingClient(this)
    secrets = PersistentSecretStore(this)
    uiUpdates = AndroidUiUpdateCoordinator(this, BuildConfig.UI_UPDATE_PUBLIC_KEY, BuildConfig.VERSION_NAME)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    window.attributes = window.attributes.apply { screenBrightness = config.screenBrightness }
    root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(245, 246, 247)) }
    setContentView(root)
    enterKioskMode()
    observeNetwork()
    observeUiUpdates()
    when (config.role) {
      // 兼容早期安装：角色已保存但尚未建立 Keystore PIN 时，回到安全初始化而不是启动一个必然退出的服务。
      TerminalRole.PRIMARY -> if (secrets.get("admin-pin") == null) configurePrimary() else startPrimary()
      TerminalRole.SECONDARY -> startSecondary()
      null -> showRoleSetup()
    }
  }

  override fun onResume() {
    super.onResume()
    enterKioskMode()
    webView?.onResume()
  }

  override fun onPause() {
    webView?.onPause()
    super.onPause()
  }

  override fun onDestroy() {
    discovery?.stop()
    networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
    updateReceiver?.let { runCatching { unregisterReceiver(it) } }
    destroyWebView()
    io.shutdownNow()
    super.onDestroy()
  }

  private fun showRoleSetup() {
    destroyWebView()
    root.removeAllViews()
    root.addView(
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(72, 48, 72, 48)
        addView(TextView(context).apply {
          text = "知境"
          textSize = 32f
          setTextColor(Color.rgb(30, 32, 35))
          gravity = Gravity.CENTER
        })
        addView(TextView(context).apply {
          text = "为本终端选择一个角色。后续可在工程设置中重新配置。"
          textSize = 14f
          setTextColor(Color.rgb(120, 126, 133))
          gravity = Gravity.CENTER
          setPadding(0, 14, 0, 32)
        })
        addView(roleButton("主屏·本地中枢", "运行 EdgeCore，承担权威状态与工程管理", TerminalRole.PRIMARY))
        addView(roleButton("副屏·快捷控制", "通过局域网发现并连接主屏", TerminalRole.SECONDARY))
      },
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  private fun roleButton(title: String, subtitle: String, role: TerminalRole) = Button(this).apply {
    text = "$title\n$subtitle"
    textSize = 15f
    isAllCaps = false
    gravity = Gravity.CENTER_VERTICAL
    setPadding(28, 12, 28, 12)
    setTextColor(Color.rgb(40, 44, 48))
    backgroundTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
    setOnClickListener {
      if (role == TerminalRole.PRIMARY) configurePrimary() else {
        config.role = role
        config.surface = TerminalSurface.SECONDARY
        startSecondary()
      }
    }
  }.also {
    it.layoutParams = LinearLayout.LayoutParams(720, 112).apply { bottomMargin = 16 }
  }

  private fun configurePrimary() {
    if (secrets.get("admin-pin") != null) {
      config.role = TerminalRole.PRIMARY
      config.surface = TerminalSurface.PRIMARY
      startPrimary()
      return
    }
    val pin = EditText(this).apply {
      hint = "6–12 位数字 PIN"
      inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
      isSingleLine = true
    }
    val confirmation = EditText(this).apply {
      hint = "再次输入 PIN"
      inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
      isSingleLine = true
    }
    val form = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(48, 8, 48, 0)
      addView(pin)
      addView(confirmation)
    }
    AlertDialog.Builder(this)
      .setTitle("设置工程管理 PIN")
      .setMessage("该 PIN 用于进入主屏工程后台，仅加密保存在本机。")
      .setView(form)
      .setNegativeButton("取消", null)
      .setPositiveButton("完成", null)
      .create()
      .also { dialog ->
        dialog.setOnShowListener {
          dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val value = pin.text.toString()
            when {
              !value.matches(Regex("\\d{6,12}")) -> pin.error = "请输入 6–12 位数字"
              value != confirmation.text.toString() -> confirmation.error = "两次输入不一致"
              else -> {
                secrets.put("admin-pin", value)
                config.role = TerminalRole.PRIMARY
                config.surface = TerminalSurface.PRIMARY
                dialog.dismiss()
                startPrimary()
              }
            }
          }
        }
        dialog.show()
      }
  }

  private fun startPrimary() {
    config.edgeBaseUrl = "http://127.0.0.1:${EdgeForegroundService.EDGE_PORT}"
    ContextCompat.startForegroundService(this, Intent(this, EdgeForegroundService::class.java))
    showStatus("正在启动本地中枢", "初始化数据库与控制服务…")
    awaitEdgeCoreReady(config.edgeBaseUrl)
  }

  private fun awaitEdgeCoreReady(edgeBase: String) {
    io.execute {
      var ready = false
      repeat(40) {
        if (!ready) {
          ready = runCatching {
            (URL("$edgeBase/api/v1/health").openConnection() as HttpURLConnection).run {
              connectTimeout = 400
              readTimeout = 400
              requestMethod = "GET"
              useCaches = false
              try {
                responseCode in 200..299 && inputStream.bufferedReader().use { reader ->
                  JSONObject(reader.readText()).getJSONObject("data").optString("version") == BuildConfig.VERSION_NAME
                }
              } finally { disconnect() }
            }
          }.getOrDefault(false)
          if (!ready) Thread.sleep(150)
        }
      }
      runOnUiThread {
        if (ready) loadPanel(TerminalRole.PRIMARY, edgeBase, requestedSurface(TerminalRole.PRIMARY))
        else showStatus("本地中枢启动超时", "请进入工程维护检查数据库与服务日志", true)
      }
    }
  }

  private fun startSecondary() {
    val saved = config.edgeBaseUrl.takeUnless { it.contains("127.0.0.1") }
    if (saved != null) {
      ensurePaired(saved, rediscoverOnFailure = true)
      return
    }
    discoverPrimary()
  }

  private fun discoverPrimary(detail: String = "确保两块屏幕位于同一局域网") {
    val expectedControlDomainId = pairing.boundControlDomainId()
    showStatus(
      "正在寻找主屏",
      if (expectedControlDomainId == null) detail else "$detail；自动发现只会连接原已配对实训台",
      true,
    )
    discovery = EdgeDiscovery(this).also { finder ->
      finder.start(
        expectedControlDomainId = expectedControlDomainId,
        onResolved = { address -> runOnUiThread { config.edgeBaseUrl = address; ensurePaired(address) } },
        onError = { message -> runOnUiThread { showStatus("自动发现未完成", message, true) } },
      )
    }
  }

  private fun ensurePaired(edgeBase: String, rediscoverOnFailure: Boolean = false) {
    if (pairingIdentityCheckInProgress) return
    pairingIdentityCheckInProgress = true
    // 核验期间先销毁旧控制页面，避免手工换台或网络切换与 Web 请求重试形成竞态。
    destroyWebView()
    showStatus("正在核验主屏", "确认当前地址属于已配对的实训台控制域")
    io.execute {
      val prepared = runCatching { pairing.prepare(edgeBase) }
      pairingIdentityCheckInProgress = false
      runOnUiThread {
        prepared.onSuccess { matched ->
          if (matched) {
            pairingRecoveryInProgress = false
            loadPairedSecondary(edgeBase)
          } else if (rediscoverOnFailure && pairing.boundControlDomainId() != null) {
            discoverPrimary("已保存地址不再属于原实训台，正在寻找原已配对主屏")
          } else showPairingDialog(edgeBase)
        }.onFailure { error ->
          if (rediscoverOnFailure) discoverPrimary("已保存主屏地址不可达，正在寻找原已配对实训台")
          else showStatus("主屏身份核验失败", error.message ?: "无法确认这台主屏的控制域身份", true)
        }
      }
    }
  }

  private fun showPairingDialog(edgeBase: String) {
    hideStatus()
    val input = EditText(this).apply {
      hint = "6 位配对码"
      inputType = InputType.TYPE_CLASS_NUMBER
      isSingleLine = true
      gravity = Gravity.CENTER
      letterSpacing = 0.2f
    }
    AlertDialog.Builder(this)
      .setTitle("配对副屏")
      .setMessage("请在主屏工程后台的“终端管理”中查看配对码。")
      .setView(input)
      .setCancelable(false)
      .setNegativeButton("重新选择地址") { _, _ -> promptForAddress() }
      .setPositiveButton("配对", null)
      .create()
      .also { dialog ->
        dialog.setOnShowListener {
          dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            showStatus("正在安全配对", "主屏将登记本副屏，令牌仅加密保存在本机")
            io.execute {
              val result = runCatching { pairing.pair(edgeBase, input.text.toString().trim()) }
              runOnUiThread {
                result.onSuccess {
                  pairingRecoveryInProgress = false
                  dialog.dismiss()
                  loadPairedSecondary(edgeBase)
                }
                  .onFailure { error -> hideStatus(); input.error = error.message ?: "配对失败" }
              }
            }
          }
        }
        dialog.show()
      }
  }

  private fun loadPairedSecondary(edgeBase: String) {
    if (uiUpdateSyncInProgress) return
    uiUpdateSyncInProgress = true
    showStatus("正在同步副屏", "正在核对主屏签名界面版本与控制状态")
    io.execute {
      val synchronized = runCatching { pairing.synchronizeUi(edgeBase, uiUpdates) }
        .onFailure { Log.w(TAG, "Secondary UI synchronization failed", it) }
      uiUpdateSyncInProgress = false
      runOnUiThread {
        synchronized.onSuccess { loadPanel(TerminalRole.SECONDARY, edgeBase, requestedSurface(TerminalRole.SECONDARY)) }
          .onFailure {
            if (pairing.token(edgeBase) == null) ensurePaired(edgeBase)
            else discoverPrimary("原主屏地址不可达，正在通过 mDNS 重新发现")
          }
      }
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun requestedSurface(role: TerminalRole) = config.surface ?: TerminalSurface.defaultFor(role)

  private fun loadPanel(role: TerminalRole, edgeBase: String, surface: TerminalSurface = requestedSurface(role)) {
    destroyWebView()
    root.removeAllViews()
    currentSurface = surface
    config.surface = surface
    val assetLoader = WebViewAssetLoader.Builder()
      .setHttpAllowed(true)
      .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
      .let { builder ->
        AndroidUiUpdateCoordinator.activeDirectory(this)?.let { active ->
          builder.addPathHandler("/updates/", WebViewAssetLoader.InternalStoragePathHandler(this, active))
        }
        builder.build()
      }
    webView = WebView(this).apply {
      setBackgroundColor(Color.rgb(245, 246, 247))
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      settings.textZoom = 100
      settings.useWideViewPort = true
      settings.loadWithOverviewMode = false
      settings.setSupportZoom(false)
      settings.builtInZoomControls = false
      settings.displayZoomControls = false
      settings.mediaPlaybackRequiresUserGesture = true
      settings.allowFileAccess = false
      settings.allowContentAccess = false
      settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
      settings.userAgentString = "${settings.userAgentString} SmartLab/${BuildConfig.VERSION_NAME} role/${role.name.lowercase()}"
      addJavascriptInterface(
        NativeRuntimeBridge(
          context = this@KioskActivity,
          role = role,
          edgeBase = edgeBase,
          tokenProvider = {
            if (role == TerminalRole.SECONDARY) pairing.token(edgeBase) else secrets.get("primary-terminal-token")
          },
          terminalAuthenticationInvalid = terminalAuthenticationInvalid@{
            if (role != TerminalRole.SECONDARY || pairingRecoveryInProgress) return@terminalAuthenticationInvalid
            pairingRecoveryInProgress = true
            runOnUiThread {
              pairing.clear(edgeBase)
              destroyWebView()
              showStatus("副屏配对已失效", "主屏已撤销本终端凭据，请使用新的一次性配对码", false)
              ensurePaired(edgeBase)
            }
          },
          surfaceChanged = { selected ->
            config.surface = selected
            currentSurface = selected
          },
          terminalReconfigurationRequested = {
            runOnUiThread { showTerminalReconfigurationDialog() }
          },
        ),
        "SmartLabNative",
      )
      webChromeClient = WebChromeClient()
      webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
          val uri = request.url
          return uri.host != "appassets.androidplatform.net" || uri.scheme != "http"
        }
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = assetLoader.shouldInterceptRequest(request.url)
        override fun onPageFinished(view: WebView, url: String) {
          lastLoadedAt = SystemClock.elapsedRealtime()
          hideStatus()
        }
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
          if (request.isForMainFrame) showStatus("控制服务暂时不可用", "${error.description}，网络恢复后会自动重连", true)
        }
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
          showStatus("界面进程已恢复", "正在重新加载本地控制界面…")
          root.postDelayed({ loadPanel(role, edgeBase, currentSurface ?: surface) }, 450)
          return true
        }
      }
      val page = if (AndroidUiUpdateCoordinator.activeDirectory(this@KioskActivity) != null) {
        "http://appassets.androidplatform.net/updates/index.html"
      } else {
        "http://appassets.androidplatform.net/assets/panel-ui/index.html"
      }
      loadUrl("$page#${surface.route}")
    }
    root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  private fun showTerminalReconfigurationDialog() {
    val role = config.role ?: return
    val detail = if (role == TerminalRole.PRIMARY) {
      "日常切换主屏、副屏或工程管理无需退出身份。继续后将停止本机 EdgeCore 并返回角色设置；每台实训台必须只保留一台主屏。业务数据和管理 PIN 不会被删除。"
    } else {
      "日常切换主屏、副屏或工程管理无需退出身份。继续后将返回角色设置；现有配对凭据暂时保留，业务数据不会被删除。"
    }
    AlertDialog.Builder(this)
      .setTitle("重新配置本机身份？")
      .setMessage(detail)
      .setNegativeButton("取消", null)
      .setPositiveButton("确认退出身份") { _, _ ->
        if (role == TerminalRole.PRIMARY) stopService(Intent(this, EdgeForegroundService::class.java))
        discovery?.stop()
        destroyWebView()
        currentSurface = null
        config.surface = null
        config.role = null
        showRoleSetup()
      }
      .show()
  }

  private fun showStatus(title: String, detail: String, showManualAddress: Boolean = false) {
    statusOverlay?.let(root::removeView)
    statusOverlay = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(64, 40, 64, 40)
      setBackgroundColor(Color.argb(246, 245, 246, 247))
      addView(ProgressBar(context).apply { isIndeterminate = true })
      addView(TextView(context).apply { text = title; textSize = 22f; setTextColor(Color.rgb(30, 32, 35)); setPadding(0, 20, 0, 8); gravity = Gravity.CENTER })
      addView(TextView(context).apply { text = detail; textSize = 13f; setTextColor(Color.rgb(115, 122, 130)); gravity = Gravity.CENTER })
      if (showManualAddress) {
        addView(Button(context).apply {
          text = "输入主屏 IP"
          isAllCaps = false
          setOnClickListener { promptForAddress() }
        }, LinearLayout.LayoutParams(260, 58).apply { topMargin = 22 })
      }
    }.also { root.addView(it, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)) }
  }

  private fun hideStatus() {
    statusOverlay?.let(root::removeView)
    statusOverlay = null
  }

  private fun promptForAddress() {
    val input = EditText(this).apply { hint = "例如 192.168.10.8:8787"; setSingleLine() }
    AlertDialog.Builder(this)
      .setTitle("主屏 EdgeCore 地址")
      .setView(input)
      .setNegativeButton("取消", null)
      .setPositiveButton("连接", null)
      .create()
      .also { dialog ->
        dialog.setOnShowListener {
          dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            runCatching {
              config.edgeBaseUrl = input.text.toString()
              config.edgeBaseUrl
            }.onSuccess { address ->
              dialog.dismiss()
              ensurePaired(address)
            }.onFailure { input.error = it.message ?: "请输入局域网私有地址" }
          }
        }
        dialog.show()
      }
  }

  private fun observeNetwork() {
    val manager = getSystemService(ConnectivityManager::class.java)
    networkCallback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        if (SystemClock.elapsedRealtime() - lastLoadedAt <= 2_000) return
        if (config.role == TerminalRole.SECONDARY) {
          // 网络切换后原 IP 可能已经属于另一台实训台，必须重新核验控制域才能再次解封 Bearer。
          runOnUiThread { ensurePaired(config.edgeBaseUrl) }
        } else {
          runOnUiThread { webView?.reload() }
        }
      }
      override fun onLost(network: Network) {
        if (config.role == TerminalRole.SECONDARY) {
          runOnUiThread { showStatus("网络已断开", "已保留最后画面，恢复后将重新同步", true) }
        }
      }
    }.also { manager.registerNetworkCallback(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(), it) }
  }

  private fun observeUiUpdates() {
    updateReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (uiUpdateSyncInProgress) return
        when (config.role) {
          TerminalRole.PRIMARY -> loadPanel(TerminalRole.PRIMARY, config.edgeBaseUrl, currentSurface ?: requestedSurface(TerminalRole.PRIMARY))
          TerminalRole.SECONDARY -> loadPanel(TerminalRole.SECONDARY, config.edgeBaseUrl, currentSurface ?: requestedSurface(TerminalRole.SECONDARY))
          null -> Unit
        }
      }
    }.also { receiver ->
      ContextCompat.registerReceiver(
        this,
        receiver,
        IntentFilter(AndroidUiUpdateCoordinator.ACTION_ACTIVATED),
        ContextCompat.RECEIVER_NOT_EXPORTED,
      )
    }
  }

  private fun enterKioskMode() {
    window.insetsController?.apply {
      hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
      systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
  }

  /** 仅供同模块平台测试确认 APK 内嵌页面已经完成真实 DOM 渲染。 */
  internal fun panelWebViewForTest(): WebView? = webView
  internal fun currentSurfaceForTest(): TerminalSurface? = currentSurface

  private fun destroyWebView() {
    webView?.apply { stopLoading(); loadUrl("about:blank"); clearHistory(); removeAllViews(); destroy() }
    webView = null
  }

  companion object {
    private const val TAG = "SmartLabKiosk"
  }
}
