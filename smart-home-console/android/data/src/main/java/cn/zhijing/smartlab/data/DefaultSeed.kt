package cn.zhijing.smartlab.data

import java.time.Instant

object DefaultSeed {
  fun create(at: String = Instant.now().toString()): DatabaseSeed {
    val gateways = listOf(
      GatewayEntity("gateway-main", "1 号实训台网关", "0.0.0.0", 23, "DMWG03LM", "待实机读取", "keystore://gateway-main", "local", "offline", at),
    )
    val rooms = listOf(
      RoomEntity("all", "全部", 0, true),
      RoomEntity("living", "客厅", 1, true),
      RoomEntity("bedroom", "卧室", 2, true),
      RoomEntity("entry", "玄关", 3, true),
      RoomEntity("equipment", "设备区", 4, true),
      RoomEntity("system", "系统", 5, true),
    )
    val devices = listOf(
      device("gateway-main", "gateway-main", "1 号实训台网关", "system", "系统", "gateway", "wifi", null, "DMWG03LM", "lumi.gateway.mcn001", at),
      device("living-main-light", "pending-living-main-light", "米家客厅吸顶灯", "living", "客厅", "light", "ble-mesh", "gateway-main", "米家吸顶灯", null, at),
      device("bedroom-light", "pending-bedroom-light", "米家吸顶灯 350", "bedroom", "卧室", "light", "wifi", null, "米家吸顶灯350", null, at),
      device("downlight-a", "pending-downlight-a", "米家筒灯 A", "living", "客厅", "light", "ble-mesh", "gateway-main", "MJTS003 待核对", null, at),
      device("downlight-b", "pending-downlight-b", "米家筒灯 B", "bedroom", "卧室", "light", "ble-mesh", "gateway-main", "MJTS003 待核对", null, at),
      device("ambient-strip", "pending-ambient-strip", "追光氛围灯带", "living", "客厅", "light", "ble-mesh", "gateway-main", null, null, at),
      device("curtain-c3", "pending-curtain-c3", "Aqara C3 窗帘", "living", "客厅", "cover", "zigbee", "gateway-main", "ZNCLDJ01LM", "lumi.curtain.acn04", at),
      device("home-panel", "pending-home-panel", "小米智能家庭面板", "entry", "玄关", "panel", "wifi", null, "智能家庭面板", null, at),
      device("switch-pro-3", "pending-switch-pro-3", "智能开关 Pro 三开", "living", "客厅", "switch", "ble-mesh", "gateway-main", "三开Mesh2.0", null, at),
      device("switch-pro-2", "pending-switch-pro-2", "智能开关 Pro 双开", "bedroom", "卧室", "switch", "ble-mesh", "gateway-main", "双开Mesh2.0", null, at),
      device("switch-pro-1", "pending-switch-pro-1", "智能开关 Pro 单开", "equipment", "设备区", "switch", "ble-mesh", "gateway-main", "单开Mesh2.0", null, at),
      device("motion-sensor", "pending-motion-sensor", "人体传感器", "living", "客厅", "sensor", "ble-mesh", "gateway-main", "RTCGQ13LM", "待实机核对", at),
      device("door-sensor", "pending-door-sensor", "门窗传感器 A", "entry", "玄关", "sensor", "ble-mesh", "gateway-main", "MCCGQ11LM", "待实机核对", at),
      device("door-sensor-b", "pending-door-sensor-b", "门窗传感器 B", "bedroom", "卧室", "sensor", "ble-mesh", "gateway-main", "MCCGQ11LM", "待实机核对", at),
      device("water-sensor", "pending-water-sensor", "水浸卫士 A", "equipment", "设备区", "sensor", "ble-mesh", "gateway-main", "SJWS01LM", "lumi.flood.bmcn01", at),
      device("water-sensor-b", "pending-water-sensor-b", "水浸卫士 B", "equipment", "设备区", "sensor", "ble-mesh", "gateway-main", "SJWS01LM", "lumi.flood.bmcn01", at),
      device("smart-lock", "pending-smart-lock", "智能门锁 2 Pro", "entry", "玄关", "lock", "ble", "gateway-main", "XMZNMST09LK", "待实机读取", at),
      device("music-r11", "pending-music-r11", "背景音乐主机", "living", "客厅", "media", "wifi", null, "R11", "待实机读取", at, "blocked", "本地接口未确认"),
      device("voice-mini", "pending-voice-mini", "小米智能家庭屏 Mini", "equipment", "设备区", "panel", "wifi", null, "家庭屏Mini", null, at),
    )
    val capabilities = buildList {
      listOf("living-main-light", "bedroom-light", "downlight-a", "downlight-b").forEach { id ->
        add(CapabilityEntity(id, "power", "电源", "boolean", null, null, null, null, true, null))
        add(CapabilityEntity(id, "brightness", "亮度", "number", 1.0, 100.0, 1.0, "%", true, null))
        add(CapabilityEntity(id, "colorTemperature", "色温", "number", 2700.0, 6500.0, 100.0, "K", true, null))
      }
      add(CapabilityEntity("ambient-strip", "power", "电源", "boolean", null, null, null, null, true, null))
      add(CapabilityEntity("ambient-strip", "brightness", "亮度", "number", 1.0, 100.0, 1.0, "%", true, null))
      add(CapabilityEntity("curtain-c3", "position", "开合位置", "number", 0.0, 100.0, 1.0, "%", true, null))
      add(CapabilityEntity("curtain-c3", "motor", "电机", "enum", null, null, null, null, true, "[\"open\",\"stop\",\"close\"]"))
      listOf("switch-pro-3", "switch-pro-2", "switch-pro-1").forEach { add(CapabilityEntity(it, "power", "电源", "boolean", null, null, null, null, true, null)) }
      add(CapabilityEntity("motion-sensor", "motion", "有人移动", "readonly", null, null, null, null, false, null))
      add(CapabilityEntity("motion-sensor", "illuminance", "照度", "readonly", null, null, null, "lx", false, null))
      listOf("door-sensor", "door-sensor-b").forEach { add(CapabilityEntity(it, "contact", "门窗状态", "readonly", null, null, null, null, false, null)) }
      listOf("water-sensor", "water-sensor-b").forEach { add(CapabilityEntity(it, "waterLeak", "水浸", "readonly", null, null, null, null, false, null)) }
      add(CapabilityEntity("smart-lock", "locked", "锁定状态", "readonly", null, null, null, null, false, null))
      add(CapabilityEntity("smart-lock", "lastEvent", "最近事件", "readonly", null, null, null, null, false, null))
      add(CapabilityEntity("music-r11", "power", "电源", "boolean", null, null, null, null, true, null))
      add(CapabilityEntity("music-r11", "volume", "音量", "number", 0.0, 100.0, 1.0, "%", true, null))
    }
    val states = listOf(
      state("living-main-light", "power", "false", at), state("living-main-light", "brightness", "68", at), state("living-main-light", "colorTemperature", "4200", at),
      state("bedroom-light", "power", "false", at), state("bedroom-light", "brightness", "32", at), state("bedroom-light", "colorTemperature", "3100", at),
      state("downlight-a", "power", "false", at), state("downlight-a", "brightness", "76", at), state("downlight-a", "colorTemperature", "4000", at),
      state("downlight-b", "power", "false", at), state("downlight-b", "brightness", "45", at), state("downlight-b", "colorTemperature", "3500", at),
      state("ambient-strip", "power", "false", at), state("ambient-strip", "brightness", "42", at),
      state("curtain-c3", "position", "0", at), state("curtain-c3", "motor", "\"stopped\"", at),
      state("motion-sensor", "motion", "false", at), state("motion-sensor", "illuminance", "0", at),
      state("door-sensor", "contact", "\"unknown\"", at), state("door-sensor-b", "contact", "\"unknown\"", at),
      state("water-sensor", "waterLeak", "false", at), state("water-sensor-b", "waterLeak", "false", at),
      state("smart-lock", "locked", "true", at), state("smart-lock", "lastEvent", "\"待实机事件\"", at),
      state("music-r11", "power", "false", at), state("music-r11", "volume", "36", at),
    )
    val scenes = listOf(
      SceneEntity("scene-home", "回家", "客厅灯光与窗帘联动", "cyan", true, "serial", null),
      SceneEntity("scene-away", "离家", "关闭灯光、音乐与窗帘", "gold", true, "serial", null),
      SceneEntity("scene-movie", "观影", "窗帘闭合，灯带与音乐营造观影氛围", "violet", true, "serial", null),
      SceneEntity("scene-sleep", "夜间", "低亮度与遮光状态", "green", true, "serial", null),
    )
    val sceneActions = listOf(
      action("home-1", "scene-home", 1, "living-main-light", "power", "true", "打开客厅主灯"),
      action("home-2", "scene-home", 2, "living-main-light", "brightness", "72", "主灯调至 72%"),
      action("home-3", "scene-home", 3, "curtain-c3", "position", "85", "窗帘打开至 85%"),
      action("away-1", "scene-away", 1, "living-main-light", "power", "false", "关闭客厅主灯"),
      action("away-2", "scene-away", 2, "ambient-strip", "power", "false", "关闭氛围灯带"),
      action("away-3", "scene-away", 3, "curtain-c3", "position", "0", "关闭窗帘"),
      action("movie-1", "scene-movie", 1, "living-main-light", "power", "false", "关闭客厅主灯"),
      action("movie-2", "scene-movie", 2, "ambient-strip", "power", "true", "打开氛围灯带"),
      action("movie-3", "scene-movie", 3, "curtain-c3", "position", "0", "关闭窗帘"),
      action("movie-4", "scene-movie", 4, "music-r11", "power", "true", "启动背景音乐"),
      action("sleep-1", "scene-sleep", 1, "bedroom-light", "power", "true", "打开卧室灯"),
      action("sleep-2", "scene-sleep", 2, "bedroom-light", "brightness", "18", "卧室灯调至 18%"),
      action("sleep-3", "scene-sleep", 3, "curtain-c3", "position", "0", "关闭窗帘"),
    )
    return DatabaseSeed(at, gateways, rooms, devices, capabilities, states, scenes, sceneActions)
  }

  private fun device(id: String, externalId: String, name: String, roomId: String, room: String, kind: String, protocol: String, gatewayId: String?, marketModel: String?, internalModel: String?, at: String, verification: String = "hardware-pending", note: String? = null) =
    DeviceEntity(
      id, externalId, name, roomId, room, kind, "offline", marketModel, internalModel, protocol, gatewayId, verification, note, at,
      displayOrder = defaultDeviceOrder[id] ?: 99,
      displayFavorite = id in defaultFavorites,
      secondarySlot = defaultSecondarySlots[id],
    )
  private fun state(deviceId: String, property: String, value: String, at: String) = DeviceStateEntity(deviceId, property, value, at, 0)
  private fun action(id: String, sceneId: String, order: Int, deviceId: String, property: String, value: String, label: String) = SceneActionEntity(id, sceneId, order, deviceId, property, value, label)

  private val defaultFavorites = setOf("living-main-light", "curtain-c3", "downlight-a", "ambient-strip", "music-r11")
  private val defaultDeviceOrder = listOf(
    "living-main-light", "curtain-c3", "downlight-a", "ambient-strip", "music-r11", "bedroom-light", "downlight-b",
  ).withIndex().associate { (index, id) -> id to index }
  private val defaultSecondarySlots = mapOf(
    "living-main-light" to "light",
    "curtain-c3" to "curtain",
    "music-r11" to "music",
  )
}
