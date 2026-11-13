import type { AlertRecord, Device, Scene } from "@smart-lab/contracts";

const now = () => new Date().toISOString();

export function createSeedDevices(): Device[] {
  const devices: Device[] = [
    {
      id: "gateway-main",
      name: "1 号实训台网关",
      room: "系统",
      kind: "gateway",
      health: "online",
      updatedAt: now(),
      state: { connectedDevices: 6, firmware: "待实机读取", latencyMs: 18 },
      capabilities: [],
      integration: {
        adapter: "mock",
        marketModel: "DMWG03LM",
        internalModel: "lumi.gateway.mcn001",
        protocol: "wifi",
        verificationStatus: "hardware-pending",
        note: "当前模拟；到货后验证 Token、Key、固件和本地链路。"
      }
    },
    {
      id: "living-main-light",
      name: "米家客厅吸顶灯",
      room: "客厅",
      kind: "light",
      health: "online",
      updatedAt: now(),
      state: { power: true, brightness: 68, colorTemperature: 4200 },
      capabilities: [
        { property: "power", label: "电源", type: "boolean", writable: true },
        { property: "brightness", label: "亮度", type: "number", min: 1, max: 100, step: 1, unit: "%", writable: true },
        { property: "colorTemperature", label: "色温", type: "number", min: 2700, max: 6500, step: 100, unit: "K", writable: true }
      ],
      integration: {
        adapter: "mock",
        marketModel: "米家吸顶灯",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending",
        note: "具体内部 model 待实机读取。"
      }
    },
    {
      id: "bedroom-light",
      name: "米家吸顶灯 350",
      room: "卧室",
      kind: "light",
      health: "online",
      updatedAt: now(),
      state: { power: false, brightness: 32, colorTemperature: 3100 },
      capabilities: [
        { property: "power", label: "电源", type: "boolean", writable: true },
        { property: "brightness", label: "亮度", type: "number", min: 1, max: 100, step: 1, unit: "%", writable: true },
        { property: "colorTemperature", label: "色温", type: "number", min: 2700, max: 6500, step: 100, unit: "K", writable: true }
      ],
      integration: {
        adapter: "mock",
        marketModel: "米家吸顶灯350",
        protocol: "wifi",
        verificationStatus: "hardware-pending",
        note: "需确定实际 MIoT model 和本地/云控制路径。"
      }
    },
    {
      id: "downlight-a",
      name: "米家筒灯 A",
      room: "客厅",
      kind: "light",
      health: "online",
      updatedAt: now(),
      state: { power: true, brightness: 76, colorTemperature: 4000 },
      capabilities: [
        { property: "power", label: "电源", type: "boolean", writable: true },
        { property: "brightness", label: "亮度", type: "number", min: 1, max: 100, step: 1, unit: "%", writable: true },
        { property: "colorTemperature", label: "色温", type: "number", min: 2700, max: 6500, step: 100, unit: "K", writable: true }
      ],
      integration: {
        adapter: "mock",
        marketModel: "米家筒灯 / MJTS003 待到货核对",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending"
      }
    },
    {
      id: "downlight-b",
      name: "米家筒灯 B",
      room: "卧室",
      kind: "light",
      health: "online",
      updatedAt: now(),
      state: { power: false, brightness: 45, colorTemperature: 3500 },
      capabilities: [
        { property: "power", label: "电源", type: "boolean", writable: true },
        { property: "brightness", label: "亮度", type: "number", min: 1, max: 100, step: 1, unit: "%", writable: true },
        { property: "colorTemperature", label: "色温", type: "number", min: 2700, max: 6500, step: 100, unit: "K", writable: true }
      ],
      integration: {
        adapter: "mock",
        marketModel: "米家筒灯 / MJTS003 待到货核对",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending"
      }
    },
    {
      id: "ambient-strip",
      name: "追光氛围灯带",
      room: "客厅",
      kind: "light",
      health: "online",
      updatedAt: now(),
      state: { power: true, brightness: 42, colorTemperature: 3600 },
      capabilities: [
        { property: "power", label: "电源", type: "boolean", writable: true },
        { property: "brightness", label: "亮度", type: "number", min: 1, max: 100, step: 1, unit: "%", writable: true }
      ],
      integration: {
        adapter: "mock",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending",
        note: "高级灯效在实机 PoC 后决定是否纳入。"
      }
    },
    {
      id: "curtain-c3",
      name: "Aqara C3 窗帘",
      room: "客厅",
      kind: "cover",
      health: "online",
      updatedAt: now(),
      state: { position: 72, motor: "stopped" },
      capabilities: [
        { property: "position", label: "开合位置", type: "number", min: 0, max: 100, step: 1, unit: "%", writable: true },
        {
          property: "motor",
          label: "电机",
          type: "enum",
          writable: true,
          options: [
            { label: "打开", value: "open" },
            { label: "停止", value: "stop" },
            { label: "关闭", value: "close" }
          ]
        }
      ],
      integration: {
        adapter: "mock",
        marketModel: "ZNCLDJ01LM",
        internalModel: "lumi.curtain.acn04",
        protocol: "zigbee",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending"
      }
    },
    {
      id: "home-panel",
      name: "小米智能家庭面板",
      room: "玄关",
      kind: "panel",
      health: "online",
      updatedAt: now(),
      state: { screen: "online", temperature: 26, connectedDevices: 18 },
      capabilities: [
        { property: "screen", label: "面板状态", type: "readonly", writable: false },
        { property: "connectedDevices", label: "关联设备", type: "readonly", unit: "个", writable: false }
      ],
      integration: {
        adapter: "mock",
        marketModel: "智能家庭面板",
        protocol: "wifi",
        verificationStatus: "hardware-pending",
        note: "采购清单墙面中控，当前仅模拟在线和关联状态。"
      }
    },
    {
      id: "switch-pro-3",
      name: "智能开关 Pro 三开",
      room: "客厅",
      kind: "switch",
      health: "online",
      updatedAt: now(),
      state: { power: true, channels: 3 },
      capabilities: [{ property: "power", label: "总电源", type: "boolean", writable: true }],
      integration: {
        adapter: "mock",
        marketModel: "三开Mesh2.0",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending"
      }
    },
    {
      id: "switch-pro-2",
      name: "智能开关 Pro 双开",
      room: "卧室",
      kind: "switch",
      health: "online",
      updatedAt: now(),
      state: { power: true, channels: 2 },
      capabilities: [{ property: "power", label: "总电源", type: "boolean", writable: true }],
      integration: {
        adapter: "mock",
        marketModel: "双开Mesh2.0",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending"
      }
    },
    {
      id: "switch-pro-1",
      name: "智能开关 Pro 单开",
      room: "设备区",
      kind: "switch",
      health: "online",
      updatedAt: now(),
      state: { power: false, channels: 1 },
      capabilities: [{ property: "power", label: "电源", type: "boolean", writable: true }],
      integration: {
        adapter: "mock",
        marketModel: "单开Mesh2.0",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending"
      }
    },
    {
      id: "motion-sensor",
      name: "人体传感器",
      room: "客厅",
      kind: "sensor",
      health: "online",
      updatedAt: now(),
      state: { motion: false, illuminance: 186, battery: 91 },
      capabilities: [
        { property: "motion", label: "有人移动", type: "readonly", writable: false },
        { property: "illuminance", label: "照度", type: "readonly", unit: "lx", writable: false }
      ],
      integration: {
        adapter: "mock",
        marketModel: "RTCGQ13LM",
        internalModel: "待实机核对",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending",
        note: "采购名称与开源数据库存在冲突。"
      }
    },
    {
      id: "door-sensor",
      name: "门窗传感器 A",
      room: "玄关",
      kind: "sensor",
      health: "online",
      updatedAt: now(),
      state: { contact: "closed", battery: 88 },
      capabilities: [{ property: "contact", label: "门窗状态", type: "readonly", writable: false }],
      integration: {
        adapter: "mock",
        marketModel: "MCCGQ11LM",
        internalModel: "待实机核对",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending",
        note: "采购协议与型号数据库存在冲突。"
      }
    },
    {
      id: "door-sensor-b",
      name: "门窗传感器 B",
      room: "卧室",
      kind: "sensor",
      health: "online",
      updatedAt: now(),
      state: { contact: "closed", battery: 93 },
      capabilities: [{ property: "contact", label: "门窗状态", type: "readonly", writable: false }],
      integration: {
        adapter: "mock",
        marketModel: "MCCGQ11LM",
        internalModel: "待实机核对",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending",
        note: "采购数量为 2，第二只独立模拟。"
      }
    },
    {
      id: "water-sensor",
      name: "水浸卫士 A",
      room: "设备区",
      kind: "sensor",
      health: "online",
      updatedAt: now(),
      state: { waterLeak: false, battery: 96 },
      capabilities: [{ property: "waterLeak", label: "水浸", type: "readonly", writable: false }],
      integration: {
        adapter: "mock",
        marketModel: "SJWS01LM",
        internalModel: "lumi.flood.bmcn01",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending"
      }
    },
    {
      id: "water-sensor-b",
      name: "水浸卫士 B",
      room: "设备区",
      kind: "sensor",
      health: "online",
      updatedAt: now(),
      state: { waterLeak: false, battery: 94 },
      capabilities: [{ property: "waterLeak", label: "水浸", type: "readonly", writable: false }],
      integration: {
        adapter: "mock",
        marketModel: "SJWS01LM",
        internalModel: "lumi.flood.bmcn01",
        protocol: "ble-mesh",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending",
        note: "采购数量为 2，第二只独立模拟。"
      }
    },
    {
      id: "smart-lock",
      name: "智能门锁 2 Pro",
      room: "玄关",
      kind: "lock",
      health: "online",
      updatedAt: now(),
      state: { locked: true, lastEvent: "指纹开门 · 08:42", battery: 82 },
      capabilities: [
        { property: "locked", label: "锁定状态", type: "readonly", writable: false },
        { property: "lastEvent", label: "最近事件", type: "readonly", writable: false }
      ],
      integration: {
        adapter: "mock",
        marketModel: "XMZNMST09LK",
        internalModel: "待实机读取",
        protocol: "ble",
        gatewayId: "gateway-main",
        verificationStatus: "hardware-pending",
        note: "默认只读事件；不模拟主动开锁。"
      }
    },
    {
      id: "music-r11",
      name: "背景音乐主机",
      room: "客厅",
      kind: "media",
      health: "degraded",
      updatedAt: now(),
      state: { power: true, volume: 36, source: "蓝牙", playing: true, track: "实训环境音乐" },
      capabilities: [
        { property: "power", label: "电源", type: "boolean", writable: true },
        { property: "volume", label: "音量", type: "number", min: 0, max: 100, step: 1, unit: "%", writable: true }
      ],
      integration: {
        adapter: "mock",
        marketModel: "R11",
        internalModel: "待实机读取",
        protocol: "wifi",
        verificationStatus: "blocked",
        note: "本地接口未确认，模拟仅用于前端流程。"
      }
    },
    {
      id: "voice-mini",
      name: "小米智能家庭屏 Mini",
      room: "设备区",
      kind: "panel",
      health: "online",
      updatedAt: now(),
      state: { screen: "online", voice: "ready", volume: 42 },
      capabilities: [
        { property: "screen", label: "屏幕状态", type: "readonly", writable: false },
        { property: "voice", label: "语音服务", type: "readonly", writable: false }
      ],
      integration: {
        adapter: "mock",
        marketModel: "家庭屏Mini",
        protocol: "wifi",
        verificationStatus: "hardware-pending",
        note: "语音控制白名单与联网依赖待实机验证。"
      }
    }
  ];
  const defaultFavorites = new Set(["living-main-light", "curtain-c3", "downlight-a", "ambient-strip", "music-r11"]);
  const defaultOrder = new Map(
    ["living-main-light", "curtain-c3", "downlight-a", "ambient-strip", "music-r11", "bedroom-light", "downlight-b"].map((id, index) => [
      id,
      index
    ])
  );
  const secondarySlots = new Map<string, "light" | "curtain" | "music">([
    ["living-main-light", "light"],
    ["curtain-c3", "curtain"],
    ["music-r11", "music"]
  ]);
  devices.forEach((device, order) => {
    device.display = {
      order: defaultOrder.get(device.id) ?? order + 20,
      hidden: false,
      favorite: defaultFavorites.has(device.id),
      secondarySlot: secondarySlots.get(device.id)
    };
  });
  return devices;
}

export function createSeedScenes(): Scene[] {
  return [
    {
      id: "scene-home",
      name: "回家",
      description: "玄关唤醒，客厅渐亮，窗帘打开",
      tone: "cyan",
      actions: [
        { id: "home-1", deviceId: "living-main-light", property: "power", value: true, label: "打开客厅主灯" },
        { id: "home-2", deviceId: "living-main-light", property: "brightness", value: 72, label: "主灯调至 72%" },
        { id: "home-3", deviceId: "curtain-c3", property: "position", value: 85, label: "窗帘打开至 85%" },
        { id: "home-4", deviceId: "downlight-a", property: "power", value: true, label: "打开客厅筒灯" },
        { id: "home-5", deviceId: "ambient-strip", property: "power", value: true, label: "开启追光灯带" },
        { id: "home-6", deviceId: "music-r11", property: "power", value: true, label: "启动背景音乐" }
      ]
    },
    {
      id: "scene-away",
      name: "离家",
      description: "关闭照明与音乐，进入安防状态",
      tone: "gold",
      actions: [
        { id: "away-1", deviceId: "living-main-light", property: "power", value: false, label: "关闭客厅主灯" },
        { id: "away-2", deviceId: "ambient-strip", property: "power", value: false, label: "关闭氛围灯带" },
        { id: "away-3", deviceId: "music-r11", property: "power", value: false, label: "关闭背景音乐" },
        { id: "away-4", deviceId: "curtain-c3", property: "position", value: 0, label: "关闭窗帘" }
      ]
    },
    {
      id: "scene-movie",
      name: "观影",
      description: "窗帘闭合，主灯熄灭，灯带与音乐营造观影氛围",
      tone: "violet",
      actions: [
        { id: "movie-1", deviceId: "living-main-light", property: "power", value: false, label: "关闭客厅主灯" },
        { id: "movie-2", deviceId: "ambient-strip", property: "power", value: true, label: "打开氛围灯带" },
        { id: "movie-3", deviceId: "curtain-c3", property: "position", value: 0, label: "关闭窗帘" },
        { id: "movie-4", deviceId: "music-r11", property: "power", value: true, label: "启动背景音乐" }
      ]
    },
    {
      id: "scene-sleep",
      name: "夜间",
      description: "暖光低亮，窗帘闭合，音乐停止",
      tone: "green",
      actions: [
        { id: "sleep-1", deviceId: "bedroom-light", property: "power", value: true, label: "打开卧室灯" },
        { id: "sleep-2", deviceId: "bedroom-light", property: "brightness", value: 18, label: "卧室灯调至 18%" },
        { id: "sleep-3", deviceId: "curtain-c3", property: "position", value: 0, label: "关闭窗帘" },
        { id: "sleep-4", deviceId: "music-r11", property: "power", value: false, label: "停止背景音乐" }
      ]
    }
  ];
}

export function createSeedAlerts(): AlertRecord[] {
  return [
    {
      id: "alert-model-review",
      deviceId: "motion-sensor",
      level: "info",
      title: "型号待核对",
      message: "RTCGQ13LM 的采购名称与开源设备数据库不一致，硬件到货后读取内部 model。",
      occurredAt: now()
    }
  ];
}
