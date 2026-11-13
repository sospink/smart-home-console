package cn.zhijing.smartlab.edgecore

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AdminConfigurationValidationTest {
  private fun validationError(configuration: AdminConfigurationDto) =
    runCatching { validateConfiguration(configuration) }.exceptionOrNull() as DomainException

  private suspend fun validSource(): AdminConfigurationDto {
    val source = FakeRepository().adminConfiguration()
    return source.copy(
      rooms = listOf(RoomConfigDto("living", "客厅", 0, true), RoomConfigDto("equipment", "设备区", 1, true)),
      scenes = source.scenes.map { scene -> scene.copy(actions = scene.actions.filter { it.deviceId == "light-1" }) },
      gateways = listOf(GatewayConfigDto("gateway", "1 号实训台网关", "192.168.31.30", 23, "keystore://gateway", "local")),
    )
  }

  @Test
  fun `safety devices cannot be hidden from the primary screen`() = runBlocking {
    val source = FakeRepository().adminConfiguration()
    val configuration = source.copy(
      rooms = listOf(RoomConfigDto("living", "客厅", 0, true), RoomConfigDto("equipment", "设备区", 1, true)),
      devices = source.devices.map { device ->
        if (device.kind == "sensor") device.copy(display = device.display.copy(hidden = true)) else device
      },
    )

    val error = runCatching { validateConfiguration(configuration) }.exceptionOrNull()

    assertTrue(error is DomainException)
    assertEquals(400, (error as DomainException).status)
    assertEquals("SAFETY_DEVICE_CANNOT_BE_HIDDEN", error.message)
  }

  @Test
  fun `blank scene and gateway address are rejected with actionable codes`() = runBlocking {
    val source = validSource()
    val scene = source.scenes.first()
    val sceneError = validationError(source.copy(scenes = source.scenes.mapIndexed { index, scene -> if (index == 0) scene.copy(name = " ") else scene }))
    assertEquals("INVALID_SCENE_NAME", sceneError.message)

    val gateway = GatewayConfigDto("gateway", "网关", "", 23, "keystore://gateway", "local")
    val gatewayError = validationError(source.copy(scenes = emptyList(), gateways = listOf(gateway)))
    assertEquals("INVALID_GATEWAY_ADDRESS", gatewayError.message)

    val emptyScene = scene.copy(id = "empty-scene", name = "空场景", enabled = true, actions = emptyList())
    assertEquals("SCENE_ACTION_REQUIRED:empty-scene", validationError(source.copy(scenes = listOf(emptyScene))).message)

    val emptyAutomation = AutomationDto(
      "empty-automation", "空联动", true,
      AutomationConditionDto("light-1", "power", "eq", kotlinx.serialization.json.JsonPrimitive(true)),
      emptyList(), 5,
    )
    assertEquals("AUTOMATION_ACTION_REQUIRED:empty-automation", validationError(source.copy(automations = listOf(emptyAutomation))).message)
  }

  @Test
  fun `duplicate rooms and orphaned device room references are rejected`() = runBlocking {
    val source = validSource()
    val duplicate = source.copy(rooms = listOf(RoomConfigDto("living", "客厅", 0, true), RoomConfigDto("other", "客厅", 1, true)))
    assertEquals("DUPLICATE_ROOM_NAME", validationError(duplicate).message)

    val orphaned = source.copy(devices = source.devices.mapIndexed { index, device ->
      if (index == 0) device.copy(room = "不存在的房间") else device
    })
    assertEquals("DEVICE_ROOM_NOT_FOUND", validationError(orphaned).message)
  }

  @Test
  fun `gateway topology requires one configured gateway and valid device references`() = runBlocking {
    val source = validSource()

    assertEquals("GATEWAY_REQUIRED", validationError(source.copy(gateways = emptyList())).message)

    val gateway = GatewayConfigDto("gateway-main", "1 号实训台网关", "192.168.31.30", 23, "keystore://gateway-main", "local")
    val duplicate = source.copy(gateways = listOf(gateway, gateway))
    assertEquals("DUPLICATE_GATEWAY_ID", validationError(duplicate).message)

    val referenced = source.copy(
      gateways = listOf(gateway),
      devices = source.devices.mapIndexed { index, device ->
        if (index == 0) device.copy(integration = device.integration.copy(gatewayId = "missing-gateway")) else device
      },
    )
    assertEquals("DEVICE_GATEWAY_NOT_FOUND", validationError(referenced).message)
  }

  @Test
  fun `secondary slots reject duplicate incompatible and unknown mappings`() = runBlocking {
    val source = validSource()
    val light = source.devices.first { it.id == "light-1" }
    val secondLight = light.copy(
      id = "light-2",
      integration = light.integration.copy(externalId = "light-2"),
      display = light.display.copy(secondarySlot = "light"),
    )
    val duplicate = source.copy(
      devices = (source.devices + secondLight).map {
        if (it.id == "light-1") it.copy(display = it.display.copy(secondarySlot = "light")) else it
      },
    )
    assertEquals("DUPLICATE_SECONDARY_SLOT", validationError(duplicate).message)

    val incompatible = source.copy(
      devices = source.devices.map { if (it.id == "sensor-1") it.copy(display = it.display.copy(secondarySlot = "light")) else it },
    )
    assertEquals("SECONDARY_SLOT_CAPABILITY_MISMATCH:light:sensor-1", validationError(incompatible).message)

    val invalid = source.copy(
      devices = source.devices.map { if (it.id == "light-1") it.copy(display = it.display.copy(secondarySlot = "unsupported")) else it },
    )
    assertEquals("INVALID_SECONDARY_SLOT", validationError(invalid).message)
  }

  @Test
  fun `scene and automation references require existing compatible capabilities`() = runBlocking {
    val source = validSource()
    val scene = source.scenes.first()
    assertEquals(
      "SCENE_DEVICE_NOT_FOUND:missing-scene-device",
      validationError(source.copy(scenes = listOf(scene.copy(actions = listOf(scene.actions.first().copy(deviceId = "missing-scene-device")))))).message,
    )
    assertEquals(
      "SCENE_CAPABILITY_NOT_WRITABLE:water-1.waterLeak",
      validationError(source.copy(scenes = listOf(scene.copy(actions = listOf(scene.actions.first().copy(deviceId = "water-1", property = "waterLeak")))))).message,
    )

    val condition = AutomationConditionDto("missing-condition-device", "power", "eq", kotlinx.serialization.json.JsonPrimitive(true))
    val automation = AutomationDto("invalid", "无效联动", true, condition, emptyList(), 5)
    assertEquals("AUTOMATION_DEVICE_NOT_FOUND:missing-condition-device", validationError(source.copy(automations = listOf(automation))).message)

    val missingProperty = automation.copy(condition = condition.copy(deviceId = "light-1", property = "missing"))
    assertEquals("AUTOMATION_CONDITION_NOT_FOUND:missing", validationError(source.copy(automations = listOf(missingProperty))).message)

    val invalidAction = scene.actions.first().copy(deviceId = "missing-action-device")
    val unknownAction = automation.copy(condition = condition.copy(deviceId = "light-1"), actions = listOf(invalidAction))
    assertEquals("AUTOMATION_ACTION_DEVICE_NOT_FOUND:missing-action-device", validationError(source.copy(automations = listOf(unknownAction))).message)

    val readonlyAction = automation.copy(
      condition = condition.copy(deviceId = "light-1"),
      actions = listOf(scene.actions.first().copy(deviceId = "water-1", property = "waterLeak")),
    )
    assertEquals("AUTOMATION_CAPABILITY_NOT_WRITABLE:water-1.waterLeak", validationError(source.copy(automations = listOf(readonlyAction))).message)

    val invalidSceneValue = scene.copy(actions = listOf(scene.actions.first().copy(value = kotlinx.serialization.json.JsonPrimitive("true"))))
    assertEquals("SCENE_VALUE_INVALID:light-1.power:TYPE", validationError(source.copy(scenes = listOf(invalidSceneValue))).message)

    val invalidOperator = automation.copy(
      condition = AutomationConditionDto("light-1", "power", "gt", kotlinx.serialization.json.JsonPrimitive(true)),
      actions = listOf(scene.actions.first()),
    )
    assertEquals("AUTOMATION_OPERATOR_INVALID:light-1.power", validationError(source.copy(automations = listOf(invalidOperator))).message)

    val invalidConditionValue = automation.copy(
      condition = AutomationConditionDto("light-1", "brightness", "gte", kotlinx.serialization.json.JsonPrimitive(101)),
      actions = listOf(scene.actions.first()),
    )
    assertEquals(
      "AUTOMATION_CONDITION_VALUE_INVALID:light-1.brightness:MAX",
      validationError(source.copy(automations = listOf(invalidConditionValue))).message,
    )
  }
}
