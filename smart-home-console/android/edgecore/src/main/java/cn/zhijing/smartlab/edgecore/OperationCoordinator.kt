package cn.zhijing.smartlab.edgecore

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class ActiveSceneLease(
  val owner: String,
  val sceneName: String,
  val source: String,
)

class OperationCoordinator {
  private val mutex = Mutex()
  private val propertyOwners = mutableMapOf<String, String>()
  private var activeScene: ActiveSceneLease? = null

  private fun key(deviceId: String, property: String) = "$deviceId.$property"

  suspend fun <T> withCommandLease(deviceId: String, property: String, owner: String, block: suspend () -> T): T {
    val propertyKey = key(deviceId, property)
    val acquired = mutex.withLock {
      val current = propertyOwners[propertyKey]
      if (current != null && current != owner) throw DomainException(409, "该设备属性正在执行其他操作")
      if (current == null) propertyOwners[propertyKey] = owner
      current == null
    }
    return try {
      block()
    } finally {
      if (acquired) mutex.withLock { if (propertyOwners[propertyKey] == owner) propertyOwners.remove(propertyKey) }
    }
  }

  suspend fun reserveScene(owner: String, sceneName: String, source: String, actions: List<SceneActionDto>) {
    mutex.withLock {
      activeScene?.let { throw DomainException(409, "${it.sceneName}场景正由${sourceLabel(it.source)}执行") }
      val keys = actions.map { key(it.deviceId, it.property) }.distinct()
      if (keys.any { propertyOwners[it] != null && propertyOwners[it] != owner }) {
        throw DomainException(409, "场景涉及的设备正在执行其他操作")
      }
      activeScene = ActiveSceneLease(owner, sceneName, source)
      keys.forEach { propertyOwners[it] = owner }
    }
  }

  suspend fun releaseScene(owner: String) {
    mutex.withLock {
      propertyOwners.entries.removeAll { it.value == owner }
      if (activeScene?.owner == owner) activeScene = null
    }
  }

  private fun sourceLabel(source: String) = when (source) {
    "primary" -> "主屏"
    "secondary" -> "副屏"
    "admin" -> "后台"
    "automation" -> "自动联动"
    else -> source
  }
}
