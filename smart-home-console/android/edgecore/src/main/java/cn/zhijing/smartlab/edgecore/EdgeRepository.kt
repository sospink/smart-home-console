package cn.zhijing.smartlab.edgecore

interface EdgeRepository {
  suspend fun sequence(): Long
  suspend fun nextSequence(): Long
  suspend fun devices(): List<DeviceDto>
  suspend fun device(id: String): DeviceDto?
  suspend fun deviceByExternalId(gatewayId: String, externalId: String): DeviceDto?
  suspend fun propertyConfirmedAt(deviceId: String, property: String): String?
  suspend fun scenes(): List<SceneDto>
  suspend fun scene(id: String): SceneDto?
  suspend fun alerts(): List<AlertDto>
  suspend fun audits(): List<AuditDto>
  suspend fun latestHandover(): HandoverCompletionDto?
  suspend fun handoverById(id: String): HandoverCompletionDto?
  suspend fun auditPage(page: Int, pageSize: Int, q: String, status: String): AuditPageDto
  suspend fun terminals(): List<TerminalDto>
  suspend fun adminConfiguration(exportedAt: String? = null): AdminConfigurationDto
  suspend fun saveAdminConfiguration(
    configuration: AdminConfigurationDto,
    enforceVersion: Boolean = true,
    auditAction: String = "更新配置",
  ): AdminConfigurationDto
  suspend fun commands(): List<CommandDto>
  suspend fun commandByRequest(requestId: String): CommandDto?
  suspend fun executions(): List<SceneExecutionDto>
  suspend fun health(): SystemHealthDto
  suspend fun saveCommand(command: CommandDto)
  suspend fun saveExecution(execution: SceneExecutionDto)
  suspend fun saveDevice(device: DeviceDto)
  suspend fun saveConfirmedProperty(device: DeviceDto, property: String, value: kotlinx.serialization.json.JsonElement)
  suspend fun saveAlert(alert: AlertDto)
  suspend fun recoverAlert(id: String, at: String): AlertDto?
  suspend fun openAlert(deviceId: String, title: String): AlertDto?
  suspend fun saveTerminal(terminal: TerminalDto, tokenHash: String)
  /** 仅对当前已配对终端返回不可逆令牌摘要，用作每次配对的证明密钥派生材料。 */
  suspend fun terminalProofReference(deviceId: String): String?
  suspend fun revokeTerminal(id: String): TerminalDto?
  suspend fun terminalByTokenHash(tokenHash: String): TerminalDto?
  suspend fun touchTerminal(id: String, address: String, version: String, at: String)
  suspend fun updateTerminalContact(id: String, address: String, version: String, at: String)
  suspend fun setTerminalOnline(id: String, online: Boolean)
  suspend fun saveGatewayTest(id: String, result: GatewayTestDto)
  suspend fun automations(): List<AutomationDto>
  suspend fun markAutomationTriggered(id: String, at: String)
  suspend fun suppressAutomationsUntil(until: String)
  suspend fun automationsSuppressed(at: String): Boolean
  suspend fun saveAudit(category: String, action: String, detail: String, source: String, result: String)
  suspend fun saveHandover(completion: HandoverCompletionDto, auditDetail: String)
  suspend fun acknowledgeAlert(id: String, at: String): AlertDto?
  suspend fun recoverInterruptedRuntime(at: String): RuntimeRecoveryResult
  suspend fun updateGatewayConnectivity(gatewayId: String, online: Boolean, at: String): List<DeviceDto>
}
