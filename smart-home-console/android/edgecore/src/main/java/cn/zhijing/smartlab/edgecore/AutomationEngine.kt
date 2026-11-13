package cn.zhijing.smartlab.edgecore

import java.time.Duration
import java.time.Instant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

class AutomationEngine(
  private val repository: EdgeRepository,
  private val commands: CommandService,
  private val clock: () -> Instant = Instant::now,
) {
  suspend fun evaluate(device: DeviceDto, changedProperty: String, actual: JsonElement, occurredAt: String) {
    if (repository.automationsSuppressed(occurredAt)) {
      repository.saveAudit("system", "复位期间联动抑制", "${device.id}.$changedProperty", "edgecore", "ignored")
      return
    }
    repository.automations().asSequence()
      .filter { it.enabled && it.actions.isNotEmpty() && it.condition.deviceId == device.id && it.condition.property == changedProperty }
      .filter { outsideCooldown(it) }
      .filter { compare(it.condition, actual) }
      .forEach { automation ->
        val triggeredAt = runCatching { Instant.parse(occurredAt) }.getOrElse { clock() }.toString()
        repository.markAutomationTriggered(automation.id, triggeredAt)
        var confirmed = 0
        automation.actions.forEachIndexed { index, action ->
          val result = runCatching {
            commands.execute(
              action.deviceId,
              CommandRequestDto("automation:${automation.id}:$triggeredAt:$index", action.property, action.value, "automation"),
            )
          }.getOrNull()
          if (result?.status == "confirmed") confirmed += 1
        }
        repository.saveAudit(
          "system", "自动联动", "${automation.name}: $confirmed/${automation.actions.size} 项已确认",
          "automation", if (confirmed == automation.actions.size) "success" else "failed",
        )
      }
  }

  private fun outsideCooldown(automation: AutomationDto): Boolean {
    val previous = automation.lastTriggeredAt?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return true
    return Duration.between(previous, clock()).seconds >= automation.cooldownSeconds
  }

  private fun compare(condition: AutomationConditionDto, actual: JsonElement): Boolean {
    if (condition.operator == "eq") return actual == condition.value
    if (condition.operator == "neq") return actual != condition.value
    val actualNumber = (actual as? JsonPrimitive)?.content?.toDoubleOrNull() ?: return false
    val expectedNumber = (condition.value as? JsonPrimitive)?.content?.toDoubleOrNull() ?: return false
    return when (condition.operator) {
      "gt" -> actualNumber > expectedNumber
      "gte" -> actualNumber >= expectedNumber
      "lt" -> actualNumber < expectedNumber
      "lte" -> actualNumber <= expectedNumber
      else -> false
    }
  }
}
