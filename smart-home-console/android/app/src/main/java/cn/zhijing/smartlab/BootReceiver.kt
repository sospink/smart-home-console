package cn.zhijing.smartlab

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val config = RuntimeConfig(context)
    if (config.role == TerminalRole.PRIMARY) {
      ContextCompat.startForegroundService(context, Intent(context, EdgeForegroundService::class.java))
    }
    context.startActivity(
      Intent(context, KioskActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    )
  }
}
