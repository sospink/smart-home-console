package cn.zhijing.smartlab

import android.content.Intent
import android.content.pm.ActivityInfo
import android.view.WindowInsets
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewCompat
import cn.zhijing.smartlab.data.PersistentSecretStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class KioskLaunchTest {
  @Test
  fun coldLaunchShowsRoleSetupWithoutCrashing() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    context.getSharedPreferences("smart-lab-runtime", android.content.Context.MODE_PRIVATE).edit().clear().commit()
    val intent = Intent(context, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    ActivityScenario.launch<KioskActivity>(intent).use { scenario ->
      scenario.onActivity { activity ->
        assertFalse(activity.isFinishing)
        assertFalse(activity.isDestroyed)
      }
    }
  }

  @Test
  fun primaryLoadsBundledPanelAndRecoversAfterRendererTermination() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    context.getSharedPreferences("smart-lab-runtime", android.content.Context.MODE_PRIVATE).edit().clear().commit()
    PersistentSecretStore(context).apply {
      remove("admin-pin")
      put("admin-pin", "246824")
    }
    RuntimeConfig(context).role = TerminalRole.PRIMARY
    val intent = Intent(context, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    ActivityScenario.launch<KioskActivity>(intent).use { scenario ->
      assertEquals("true", awaitJavaScript(scenario, "Boolean(document.querySelector('[data-testid=overview-panel]'))"))
      assertEquals(
        "true",
        awaitJavaScript(scenario, "document.querySelectorAll('.overview-devices article').length === 6"),
      )
      assertEquals(
        "true",
        awaitJavaScript(
          scenario,
          """(function () {
            if (!window.__audioAssetProbe) {
              window.__audioAssetProbe = true;
              fetch('./audio/morning-light.mp3')
                .then(function (response) { return response.arrayBuffer(); })
                .then(function (body) { window.__audioAssetReady = body.byteLength > 100000; })
                .catch(function () { window.__audioAssetReady = false; });
            }
            return Boolean(window.__audioAssetReady);
          })()""".trimIndent(),
        ),
      )

      scenario.onActivity { activity ->
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE, activity.requestedOrientation)
        assertEquals(0.85f, activity.window.attributes.screenBrightness, 0.001f)
        activity.window.decorView.rootWindowInsets?.let { insets ->
          assertFalse(insets.isVisible(WindowInsets.Type.statusBars()))
          assertFalse(insets.isVisible(WindowInsets.Type.navigationBars()))
        }
        val displayHeight = activity.windowManager.currentWindowMetrics.bounds.height()
        assertEquals(displayHeight, activity.window.decorView.height)
        val webView = requireNotNull(activity.panelWebViewForTest())
        assertNotNull(webView)
        assertEquals(100, webView.settings.textZoom)
        val renderer = WebViewCompat.getWebViewRenderProcess(webView)
        assertNotNull(renderer)
        assertTrue(renderer!!.terminate())
      }

      assertEquals("true", awaitJavaScript(scenario, "Boolean(document.querySelector('[data-testid=overview-panel]'))"))
    }
  }

  @Test
  fun primaryCanBrowseSecondaryAndAdminWithoutChangingPhysicalRole() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    context.getSharedPreferences("smart-lab-runtime", android.content.Context.MODE_PRIVATE).edit().clear().commit()
    PersistentSecretStore(context).apply {
      remove("admin-pin")
      put("admin-pin", "246824")
    }
    RuntimeConfig(context).role = TerminalRole.PRIMARY
    val intent = Intent(context, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    ActivityScenario.launch<KioskActivity>(intent).use { scenario ->
      assertEquals("true", awaitJavaScript(scenario, "Boolean(document.querySelector('[data-testid=overview-panel]'))"))
      assertEquals(
        "true",
        awaitJavaScript(
          scenario,
          "SmartLabNative.rememberSurface('secondary') && (location.hash = '#/secondary', true)",
        ),
      )
      assertEquals("true", awaitJavaScript(scenario, "Boolean(document.querySelector('.secondary-shell'))"))
      scenario.onActivity { activity ->
        assertEquals(TerminalRole.PRIMARY, RuntimeConfig(activity).role)
        assertEquals(TerminalSurface.SECONDARY, activity.currentSurfaceForTest())
        assertEquals(100, activity.panelWebViewForTest()?.settings?.textZoom)
      }

      assertEquals(
        "true",
        awaitJavaScript(
          scenario,
          "SmartLabNative.rememberSurface('admin') && (location.hash = '#/admin', true)",
        ),
      )
      assertEquals("true", awaitJavaScript(scenario, "Boolean(document.querySelector('input[placeholder=\"输入管理员 PIN\"]'))"))
      scenario.onActivity { activity ->
        assertEquals(TerminalRole.PRIMARY, RuntimeConfig(activity).role)
        assertEquals(TerminalSurface.ADMIN, activity.currentSurfaceForTest())
      }
    }
  }

  private fun awaitJavaScript(
    scenario: ActivityScenario<KioskActivity>,
    expression: String,
    timeoutMillis: Long = 15_000,
  ): String? {
    val deadline = System.currentTimeMillis() + timeoutMillis
    var latest: String? = null
    while (System.currentTimeMillis() < deadline) {
      val latch = CountDownLatch(1)
      scenario.onActivity { activity ->
        activity.panelWebViewForTest()?.evaluateJavascript(expression) { result ->
          latest = result
          latch.countDown()
        } ?: latch.countDown()
      }
      latch.await(2, TimeUnit.SECONDS)
      if (latest == "true") return latest
      Thread.sleep(250)
    }
    return latest
  }
}
