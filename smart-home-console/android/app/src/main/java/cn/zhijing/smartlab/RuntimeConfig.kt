package cn.zhijing.smartlab

import android.content.Context

enum class TerminalRole { PRIMARY, SECONDARY }

enum class TerminalSurface(val route: String) {
  PRIMARY("/primary"),
  SECONDARY("/secondary"),
  ADMIN("/admin");

  companion object {
    fun fromWire(value: String) = entries.firstOrNull { it.name.equals(value.trim(), ignoreCase = true) }
    fun defaultFor(role: TerminalRole) = if (role == TerminalRole.PRIMARY) PRIMARY else SECONDARY
  }
}

class RuntimeConfig(context: Context) {
  private val preferences = context.getSharedPreferences("smart-lab-runtime", Context.MODE_PRIVATE)

  var role: TerminalRole?
    get() = preferences.getString("role", null)?.let(TerminalRole::valueOf)
    set(value) { preferences.edit().putString("role", value?.name).apply() }

  var surface: TerminalSurface?
    get() = preferences.getString("surface", null)?.let { stored -> TerminalSurface.entries.firstOrNull { it.name == stored } }
    set(value) {
      preferences.edit().apply {
        if (value == null) remove("surface") else putString("surface", value.name)
      }.apply()
    }

  var edgeBaseUrl: String
    get() = runCatching { EdgeAddress.normalize(preferences.getString("edge_base_url", "http://127.0.0.1:8787").orEmpty()) }
      .getOrDefault("http://127.0.0.1:8787")
    set(value) { preferences.edit().putString("edge_base_url", EdgeAddress.normalize(value)).apply() }

  var screenBrightness: Float
    get() = preferences.getFloat("screen_brightness", 0.85f)
    set(value) { preferences.edit().putFloat("screen_brightness", value.coerceIn(0.1f, 1f)).apply() }

  fun clearPairing() {
    preferences.edit().remove("edge_base_url").apply()
  }
}
