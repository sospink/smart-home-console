package cn.zhijing.smartlab

/**
 * 网关启动会立即产生权威状态首帧，因此恢复旧运行状态必须严格先于网关启动。
 * 把这个顺序收口为单一入口，避免后续重构再次把新首帧覆盖成离线。
 */
internal suspend fun <T> startGatewayAfterRuntimeRecovery(
  recover: suspend () -> Unit,
  startGateway: suspend () -> T,
): T {
  recover()
  return startGateway()
}
