package cn.zhijing.smartlab

import java.net.URI

/** EdgeCore 只允许位于本机、链路本地或 RFC1918/ULA 私网，避免配对凭据被发往公网。 */
object EdgeAddress {
  fun normalize(value: String): String {
    val candidate = value.trim().trimEnd('/').let {
      if (it.startsWith("http://", true) || it.startsWith("https://", true)) it else "http://$it"
    }
    val uri = runCatching { URI(candidate) }.getOrElse { throw IllegalArgumentException("主屏地址格式无效") }
    require(uri.scheme.equals("http", true) || uri.scheme.equals("https", true)) { "只支持 HTTP/HTTPS 地址" }
    require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) { "地址不能包含账号、参数或片段" }
    require(uri.path.isNullOrBlank() || uri.path == "/") { "请输入主屏根地址，不要附加路径" }
    val host = uri.host?.lowercase()?.removePrefix("[")?.removeSuffix("]")
      ?: throw IllegalArgumentException("缺少有效主机地址")
    require(isPrivateHost(host)) { "仅允许本机或局域网私有地址" }
    val port = if (uri.port == -1) 8787 else uri.port
    require(port in 1..65535) { "端口必须在 1–65535 之间" }
    val renderedHost = if (':' in host) "[$host]" else host
    return "${uri.scheme.lowercase()}://$renderedHost:$port"
  }

  fun fromDiscoveredHost(hostAddress: String, port: Int): String = normalize(
    "http://${if (':' in hostAddress) "[$hostAddress]" else hostAddress}:$port"
  )

  internal fun isPrivateHost(host: String): Boolean {
    if (host == "localhost" || host.endsWith(".local")) return true
    if (':' in host) {
      val normalized = host.lowercase()
      return normalized == "::1" || normalized == "0:0:0:0:0:0:0:1" || normalized.startsWith("fe80:") ||
        normalized.startsWith("fc") || normalized.startsWith("fd")
    }
    val parts = host.split('.').mapNotNull(String::toIntOrNull)
    if (parts.size != 4 || parts.any { it !in 0..255 }) return false
    return parts[0] == 10 || parts[0] == 127 ||
      (parts[0] == 172 && parts[1] in 16..31) ||
      (parts[0] == 192 && parts[1] == 168) ||
      (parts[0] == 169 && parts[1] == 254)
  }
}
