package cn.zhijing.smartlab.edgecore

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.JsonPrimitive

class SceneEngine(
  private val repository: EdgeRepository,
  private val commands: CommandService,
  private val events: EdgeEventBus,
  private val coordinator: OperationCoordinator = commands.coordinator,
) {
  suspend fun execute(sceneId: String, source: String): SceneExecutionDto {
    val scene = repository.scene(sceneId) ?: throw DomainException(404, "场景不存在")
    if (!scene.enabled) throw DomainException(409, "场景已停用")
    if (scene.actions.isEmpty()) throw DomainException(409, "SCENE_ACTION_REQUIRED")
    val startedAt = Instant.now().toString()
    val executionId = "execution-${UUID.randomUUID()}"
    try {
      coordinator.reserveScene(executionId, scene.name, source, scene.actions)
    } catch (error: DomainException) {
      repository.saveAudit("scene", scene.name, error.message, source, "failed")
      throw error
    }
    try {
      var execution = SceneExecutionDto(
        id = executionId,
        sceneId = sceneId,
        source = source,
        status = "running",
        completedActions = 0,
        totalActions = scene.actions.size,
        startedAt = startedAt,
      )
      repository.saveExecution(execution)
      events.publish("scene.execution", execution)
      var confirmed = 0
      for ((index, action) in scene.actions.withIndex()) {
        val result = runCatching {
          commands.execute(
            action.deviceId,
            CommandRequestDto("${execution.id}-${index + 1}", action.property, action.value, source), execution.id,
          )
        }
        result.onSuccess { if (it.status == "confirmed") confirmed += 1 }
          .onFailure { error ->
            // 单设备的能力拒绝/离线不应吞掉整个场景执行记录；继续后续动作并由场景汇总为 partial/failed。
            repository.saveAudit(
              "scene",
              "${scene.name} / ${action.label}",
              error.message ?: "动作执行失败",
              source,
              "failed",
            )
          }
        // completedActions 只记录设备可信确认，不能用“已尝试动作数”冒充完成数。
        // 进程若在场景中途退出，启动恢复将据此决定 partial / failed。
        execution = execution.copy(completedActions = confirmed)
        repository.saveExecution(execution)
        events.publish("scene.execution", execution)
      }
      val status = when {
        confirmed == scene.actions.size -> "completed"
        confirmed > 0 -> "partial"
        else -> "failed"
      }
      execution = execution.copy(status = status, completedActions = confirmed, finishedAt = Instant.now().toString())
      repository.saveExecution(execution)
      repository.saveAudit("scene", scene.name, "完成 $confirmed/${scene.actions.size} 项动作", source, if (status == "completed") "success" else "failed")
      events.publish("scene.execution", execution)
      return execution
    } finally {
      coordinator.releaseScene(executionId)
    }
  }
}
