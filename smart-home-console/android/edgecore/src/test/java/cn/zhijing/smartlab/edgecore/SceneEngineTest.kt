package cn.zhijing.smartlab.edgecore

import cn.zhijing.smartlab.gateway.RawCommand
import cn.zhijing.smartlab.gateway.RawCommandAck
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SceneEngineTest {
  @Test
  fun `legacy enabled scene without actions cannot report zero of zero success`() = runBlocking {
    val base = FakeRepository()
    val repository = object : EdgeRepository by base {
      override suspend fun scene(id: String) = base.scenes().first().copy(id = id, name = "旧版空场景", actions = emptyList())
    }
    val engine = SceneEngine(repository, CommandService(repository, { TrustedSceneAdapter }, EdgeEventBus(repository)), EdgeEventBus(repository))

    val error = runCatching { engine.execute("legacy-empty-scene", "primary") }.exceptionOrNull() as DomainException

    assertEquals(409, error.status)
    assertEquals("SCENE_ACTION_REQUIRED", error.message)
    assertTrue(base.executions().isEmpty())
  }

  @Test
  fun `a rejected scene action is aggregated as partial and later actions still run`() = runBlocking {
    val repository = FakeRepository()
    val events = EdgeEventBus(repository)
    val commands = CommandService(repository, { TrustedSceneAdapter }, events)
    val engine = SceneEngine(repository, commands, events)

    val execution = engine.execute("scene-test", "primary")

    assertEquals("partial", execution.status)
    assertEquals(1, execution.completedActions)
    assertEquals(2, execution.totalActions)
    assertTrue(repository.audits().any { it.category == "scene" && it.result == "failed" })
  }

  @Test
  fun `a second scene is rejected while the first scene is still running`() = runBlocking {
    val repository = FakeRepository()
    val entered = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    val adapter = object : cn.zhijing.smartlab.gateway.GatewayAdapter by TrustedSceneAdapter {
      override suspend fun send(command: RawCommand): RawCommandAck {
        entered.complete(Unit)
        release.await()
        return RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
      }
    }
    val events = EdgeEventBus(repository)
    val coordinator = OperationCoordinator()
    val commands = CommandService(repository, { adapter }, events, coordinator = coordinator)
    val engine = SceneEngine(repository, commands, events, coordinator)

    val first = async { engine.execute("scene-test", "primary") }
    entered.await()
    val error = runCatching { engine.execute("scene-test", "secondary") }.exceptionOrNull() as DomainException
    release.complete(Unit)
    first.await()

    assertEquals(409, error.status)
    assertTrue(error.message!!.contains("主屏"))
    assertEquals(1, repository.executions().size)
    assertTrue(repository.audits().any { it.category == "scene" && it.source == "secondary" && it.result == "failed" })
  }

  @Test
  fun `manual command cannot overwrite a property leased by a running scene`() = runBlocking {
    val repository = FakeRepository()
    val entered = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    var sends = 0
    val adapter = object : cn.zhijing.smartlab.gateway.GatewayAdapter by TrustedSceneAdapter {
      override suspend fun send(command: RawCommand): RawCommandAck {
        sends += 1
        entered.complete(Unit)
        release.await()
        return RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
      }
    }
    val events = EdgeEventBus(repository)
    val coordinator = OperationCoordinator()
    val commands = CommandService(repository, { adapter }, events, coordinator = coordinator)
    val engine = SceneEngine(repository, commands, events, coordinator)

    val scene = async { engine.execute("scene-test", "primary") }
    entered.await()
    val error = runCatching {
      commands.execute("light-1", CommandRequestDto("manual-conflict", "power", kotlinx.serialization.json.JsonPrimitive(false), "secondary"))
    }.exceptionOrNull() as DomainException
    release.complete(Unit)
    scene.await()

    assertEquals(409, error.status)
    assertTrue(error.message!!.contains("其他操作"))
    assertEquals(1, sends)
    assertTrue(repository.commands().none { it.requestId == "manual-conflict" })
    assertTrue(repository.audits().any { it.category == "command" && it.source == "secondary" && it.result == "failed" })
  }

  @Test
  fun `scene waits for no one and can retry after a conflicting manual command releases its lease`() = runBlocking {
    val repository = FakeRepository()
    val entered = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    val adapter = object : cn.zhijing.smartlab.gateway.GatewayAdapter by TrustedSceneAdapter {
      override suspend fun send(command: RawCommand): RawCommandAck {
        if (command.requestId == "manual-first") {
          entered.complete(Unit)
          release.await()
        }
        return RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
      }
    }
    val events = EdgeEventBus(repository)
    val coordinator = OperationCoordinator()
    val commands = CommandService(repository, { adapter }, events, coordinator = coordinator)
    val engine = SceneEngine(repository, commands, events, coordinator)

    val manual = async {
      commands.execute("light-1", CommandRequestDto("manual-first", "power", JsonPrimitive(false), "secondary"))
    }
    entered.await()
    val conflict = runCatching { engine.execute("scene-test", "primary") }.exceptionOrNull() as DomainException

    assertEquals(409, conflict.status)
    assertTrue(conflict.message!!.contains("场景涉及的设备"))
    assertTrue(repository.executions().isEmpty())
    assertTrue(repository.audits().any { it.category == "scene" && it.source == "primary" && it.result == "failed" })

    release.complete(Unit)
    assertEquals("confirmed", manual.await().status)
    val retried = engine.execute("scene-test", "primary")
    assertEquals("partial", retried.status)
    assertEquals(1, repository.executions().size)
  }
}

private object TrustedSceneAdapter : cn.zhijing.smartlab.gateway.GatewayAdapter {
  override suspend fun start(config: cn.zhijing.smartlab.gateway.GatewayConfig) = Unit
  override suspend fun stop() = Unit
  override suspend fun discover(): List<cn.zhijing.smartlab.gateway.RawDevice> = emptyList()
  override fun events(): kotlinx.coroutines.flow.Flow<cn.zhijing.smartlab.gateway.RawGatewayEvent> = kotlinx.coroutines.flow.emptyFlow()
  override suspend fun send(command: cn.zhijing.smartlab.gateway.RawCommand) =
    cn.zhijing.smartlab.gateway.RawCommandAck(command.requestId, accepted = true, trustedConfirmation = true)
  override suspend fun health() = cn.zhijing.smartlab.gateway.GatewayHealth("gateway", true, 1)
}
