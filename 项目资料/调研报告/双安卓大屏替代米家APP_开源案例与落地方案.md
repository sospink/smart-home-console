# 双安卓大屏替代米家 APP：开源案例、技术路线与无新增硬件落地方案

> 调研日期：2026-07-21  
> 适用范围：`步入式实训台0610(1)`、`副本步入式实训硬件0610修改版2(1)`中已经采购/验收的设备  
> 约束：不新增服务器、网关或其他硬件；项目方两块安卓工控屏不安装米家 APP；开发方需要交付可体现实际软件开发量的双屏控制系统。

## 一、先给结论

有可行方案，也有比较成熟的开源参考，但不存在一个“下载 APK 就能完整替代米家 APP、正式支持 DMWG03LM、还能无风险商用”的现成项目。

最现实的方案是：

1. 保留两个 `DMWG03LM` 作为 Zigbee、蓝牙 Mesh/蓝牙设备的实际协议网关；
2. 在主安卓工控屏中运行自研的轻量控制核心，不新增独立服务器；
3. 主副屏使用同一个 APK/代码库，通过“主屏/副屏角色”和响应式布局呈现两个不同界面；
4. 控制核心通过 DMWG03LM 的非官方局域网通道读写网关子设备；
5. 主屏内置场景、联动、设备映射、日志、权限和管理页面；副屏承担快捷控制和告警显示；
6. 米家 APP 只保留在工程人员手机上，用于首次绑定、设备配网、固件维护和极少数安全设备配置，不安装到交付的两个屏幕上；
7. 正式开发前必须完成 DMWG03LM 固件、Token/Key、实际设备 model 和许可证四项 PoC。

推荐把产品命名为“智慧家居实训台双屏控制系统”，不要宣传为“米家替代版”或使用未授权的小米/米家商标。

## 二、为什么“自研系统控制网关，再由网关控制设备”是成立的

采购清单中的设备不是同一种接入方式：

| 类型 | 清单中的典型设备 | 实际路径 | 自研系统的接入点 |
|---|---|---|---|
| Zigbee | Aqara C3 窗帘电机 | 子设备 → DMWG03LM Zigbee 协调器 | 控制 DMWG03LM 内部 Zigbee 服务 |
| 蓝牙 Mesh | 开关 Pro、筒灯、灯带、清单标注的人体/门磁/水浸 | Mesh 设备 → DMWG03LM Mesh 代理 | 控制 DMWG03LM 内部 BLE/Mesh 服务 |
| 普通蓝牙广播 | 部分传感器、门锁事件 | 设备广播 → 网关扫描 → 上报 | 从网关读取广播和事件；未必支持写控制 |
| Wi-Fi | 部分吸顶灯、音乐主机、家庭屏 | 设备直接连接路由器/小米云 | 优先尝试设备本地 MIoT/miIO；否则只能云端或厂商接口 |

所以，DMWG03LM 不是没用；它是现有 BLE Mesh 和 Zigbee 设备不可替代的无线协议桥。问题只是小米没有把它开放成任意第三方 APP 都能调用的正式通用 PLC API。

采购表还包含一个 USB Zigbee 3.0 模块，但它不能替代 DMWG03LM：现有大量灯具、开关和传感器是蓝牙 Mesh；即使将窗帘迁到 Zigbee2MQTT，BLE Mesh 设备依然要经过 DMWG03LM。迁移 Zigbee 还会导致原米家 Zigbee 网络停止工作并需要重新配对，验收完成后不应轻易这样改。

## 三、真正值得参考的开源项目

### 3.1 设备接入核心

#### A. AlexxIT/XiaomiGateway3：最重要的协议参考

- 项目地址：https://github.com/AlexxIT/XiaomiGateway3
- 规模/状态：约 2.7k Stars；2026 年仍有提交；MIT。
- 明确支持：中国版米家多模网关 2 `DMWG03LM`，内部 model 为 `lumi.gateway.mcn001`。
- 支持范围：默认米家固件下的 Zigbee、BLE、BLE Mesh 子设备；可以在保留米家网络的同时让第三方系统读取和控制。
- 固件范围：DMWG03LM `1.0.3–1.0.6` 通常需要 Token；`1.0.7` 通常需要 Token + Key；某些从未接入过的新固件可能需要 UART。
- 工作机制：用 Token/Key 启用 Telnet，在网关 `/data` 下运行 `openmiio_agent`，把网关内部 miIO、Zigbee、BLE/Mesh 数据转换为局域网 MQTT；外部控制器订阅状态并向 MQTT 写入命令。
- 局限：它是 Home Assistant 自定义组件，不是最终大屏 APP；网关重启后外部控制器需要自动重新启用 Telnet并启动 agent。

它已经证明以下链路真实存在：

```text
自研控制器
  ├─ Token/Key + Telnet：维护网关本地通道
  ├─ MQTT miio/report、central/report：接收 BLE/Mesh/MIoT 状态
  ├─ MQTT zigbee/send：接收 Zigbee 状态
  ├─ MQTT miio/command：写 MIoT/Mesh 属性和动作
  └─ MQTT zigbee/recv：写 Zigbee 属性和动作
          ↓
       DMWG03LM
          ↓
  Zigbee / BLE Mesh / BLE 子设备
```

结论：最适合作为 PoC 基线和安卓适配层的协议/转换器参考，不适合把 HA 页面直接作为最终产品。

#### B. sergey-brutsky/mi-home：独立 API 形态的重要参考

- 项目地址：https://github.com/sergey-brutsky/mi-home
- 规模/状态：约 155 Stars；2025 年仍有提交；MIT。
- 形态：不是 Home Assistant UI，而是可供自动化系统调用的 C# 库。
- 明确支持：`DMWG03LM / lumi.gateway.mcn001`，提供网关发现、子设备发现、属性和动作 API 示例。
- 价值：证明可以把 DMWG03LM 封装成独立领域 API，而不必把 Home Assistant UI 暴露给用户；其设备类和事件模型可作为 Kotlin 适配器设计参考。
- 局限：它仍然依赖 `openmiio_agent` 暴露网关内部 MQTT；换成这个库并不能消除固件与 agent 许可证问题。

#### C. AlexxIT/openmiio_agent：链路关键，但存在许可证红线

- 项目地址：https://github.com/AlexxIT/openmiio_agent
- 明确支持 DMWG03LM；可以在保留原米家固件功能时暴露 MQTT，实现断公网后的 miIO、BLE 事件和部分设备控制。
- 重大问题：仓库根目录没有许可证文件，GitHub 也未识别开源许可证。没有许可证不等于自由商用、修改或再分发。

因此：

- 内部研究、验证其工作机制可以进行；
- 不能默认把其二进制打包进商业 APK 或预装到交付网关；
- 正式交付前应联系作者取得书面商用/再分发许可；
- 若无法取得许可，应采用 clean-room 方式重写最小网关桥接程序，并由不接触原实现代码的开发人员依据实机抓包、公开协议和自有测试编写。

这是当前方案最大的非技术风险。

#### D. hass-xiaomi-miot：云端/本地 MIoT 兜底参考

- 项目地址：https://github.com/al-one/hass-xiaomi-miot
- 规模/状态：约 6k Stars；Apache-2.0；2026 年仍活跃。
- 能力：基于 MIoT Spec 映射大量 Wi-Fi、BLE、Zigbee 品类；支持本地 host/token 和小米云两种路径。
- 局限：其说明明确建议 miIO、BLE、Zigbee 设备使用云模式；轮询方式无法实时监听部分人体、门磁和无线开关事件。
- 适用：用于 PoC 判断 R11、Wi-Fi 吸顶灯、门锁等是否暴露 MIoT 属性；不宜把非官方小米云登录作为最终系统的唯一控制链路。

#### E. 小米官方 Home Assistant 集成：不能移植为商业 APP

- 项目地址：https://github.com/XiaoMi/ha_xiaomi_home
- 官方本地控制依赖受支持的“小米中枢网关”；DMWG03LM `lumi.gateway.mcn001` 不是官方中枢网关 `xiaomi.gateway.hub1`。
- 官方文档说明：普通局域网控制只覆盖同局域网 IP 设备，不能由此控制 Zigbee、BLE Mesh 子设备。
- 许可证明确只允许非商业地在 Home Assistant 内使用，不允许拿授权作品开发 APP、Web 服务等软件；法律声明还限制小米云接口在非 HA 或商业场景下使用。

结论：不能把官方集成里的 OAuth/云 API 代码抽出来塞进商业双屏系统。

### 3.2 双屏界面和安卓 Kiosk 工程参考

| 项目 | 主要价值 | 许可证/状态 | 对本项目的使用方式 |
|---|---|---|---|
| Home Assistant Core | 设备状态、场景、自动化领域模型 | Apache-2.0，约 89k Stars | PoC 和领域模型参考，不作为安卓最终运行时 |
| Mushroom | 灯、帘、锁、媒体等触控卡片 | Apache-2.0，约 5k Stars | 参考卡片信息层级和交互 |
| ha-floorplan | SVG 平面图映射实体、状态和动作 | Apache-2.0，约 1.5k Stars | 可用于实训台示意图/点位控制页的设计参考 |
| UI-Lovelace-Minimalist | 平板智慧家居视觉体系 | MIT，约 2k Stars；项目招募维护者 | 只借鉴视觉，不建议作为长期底座 |
| Dwains Dashboard | 自动生成桌面/平板/手机看板 | 许可证未明确识别 | 只借鉴信息架构，不直接复制代码 |
| ha-paneld | 针对低功耗 Android 墙屏；开机、恢复、WebSocket、MQTT、Ktor、远程配置 | Apache-2.0；活跃；支持 RK3566/Android 11 等墙屏 | 最有价值的安卓工程架构参考 |
| WallPanel | 全屏 Web 看板、开机、屏保、摄像头、MQTT/HTTP 控屏 | Apache-2.0；2025 已归档 | 参考成熟功能清单，不作为新项目底座 |
| KioskZen | GeckoView/WebView Kiosk、自动恢复和隐藏管理入口 | GPL-3.0 | 若闭源交付只借鉴思想；复制/修改需履行 GPL |
| superdash | 安卓 HA 墙屏、语音、屏保、摄像头 | GPL-3.0 | 同上；且要求已有 HA |
| Kiosk Satellite | 低性能平板、状态流过滤、远程管理 | CC BY-NC-ND；非商用且禁止衍生 | 只能观察产品思路，不能用于商业代码 |

这些项目共同证明，安卓墙屏应该具备：

- 开机自启和默认 Launcher/Kiosk 模式；
- 沉浸式全屏、隐藏系统导航；
- WebView/渲染器异常自动恢复；
- WebSocket 断线重连、快照补偿和离线提示；
- 隐藏管理员入口、PIN、远程日志；
- 屏幕亮度、休眠、接近唤醒；
- 设备配置备份/恢复和批量部署；
- 只订阅当前页面需要的设备状态，避免 2GB 屏卡顿。

但它们几乎都假设已经有一台 Home Assistant 服务器，只解决“显示层”，没有解决 DMWG03LM 接入。因此不能把它们直接当成最终方案。

## 四、三条路线的深度比较

| 路线 | 做法 | 是否新增服务器 | 优点 | 致命问题 | 结论 |
|---|---|---:|---|---|---|
| A. 主屏跑 HA Core + 两屏 Lovelace | Android Termux/PRoot 跑 Python/HA；两屏 WebView | 否 | PoC 快，现成生态多 | Android 12 会限制后台/phantom 进程；HA 并无面向 Android 的正式生产部署；2GB 内存和升级维护风险；仍有 openmiio/许可证问题 | 只做实验验证，不建议验收交付 |
| B. 主屏自研轻量控制核心 + 同一 APK 双角色 | Kotlin 前台服务、Room、Ktor、MQTT、WebSocket；副屏客户端 | 否 | 资源可控、开机可靠、界面和管理完全自主、能体现软件开发量 | 需要移植固定设备转换器；必须解决 openmiio 商用许可和逐型号适配 | **推荐最终路线** |
| C. 两屏只调用非官方小米云 | 自研 UI + 小米账号登录/云 API | 否 | 初期开发快、设备覆盖可能多 | 非官方接口、账号风控、网络依赖、延迟、授权和商业合规风险；接口可能随时改变 | 只能对少数 Wi-Fi 设备做有边界的兜底，不做主链路 |
| D. USB Zigbee + Zigbee2MQTT | 把 Zigbee 设备迁出米家 | 否 | Zigbee 开放性较强 | 大量 BLE Mesh 设备未解决；重新配对；破坏现有米家网络；安卓仍要承载 broker/z2m | 不符合当前已验收硬件和保留米家维护的目标 |

推荐采用 B，A 只作为第一阶段 PoC 工具。

## 五、推荐的最终架构

### 5.1 一个系统、一个代码库、两个屏幕角色

不建议写两套互不相关的软件。应交付一个 Android APK，首次安装时选择角色：

```text
同一 APK / 同一版本
├── 主屏模式（1920×1080）
│   ├── 总览、房间、设备详情、安防、能耗/日志
│   ├── EdgeCore 前台服务
│   ├── 场景与联动引擎
│   ├── Room/SQLite 数据库
│   ├── 内置管理后台
│   └── 向副屏发布 WebSocket 状态流
└── 副屏模式（1024×600）
    ├── 常用场景和灯光快捷键
    ├── 窗帘、音乐、告警快捷控制
    ├── 缓存最近状态
    └── 连接主屏 API/WebSocket
```

所谓“管理后台”不需要部署成第三套服务器软件。它可以是主屏 APK 内的管理模块：长按 Logo 5 秒 + 管理员 PIN 后进入，或者由主屏内置 Ktor HTTP 服务向同一局域网工程电脑提供 `/admin` 页面。

### 5.2 主屏 EdgeCore 模块

建议技术栈：Kotlin + Android Foreground Service + Coroutines + Room + Ktor + HiveMQ/Paho MQTT。

核心模块：

1. `GatewaySupervisor`：管理两个 DMWG03LM 的 IP、Token、Key、固件、Telnet、agent 心跳和重启恢复；
2. `GatewayMqttClient`：订阅两个网关的状态主题并发送命令；
3. `DeviceRegistry`：将网关 DID、mac/model、设备能力映射成系统设备；
4. `DeviceAdapter`：按 model 把原始属性转换为 `Light/Cover/Sensor/Lock/Media`；
5. `StateStore`：保存期望值、确认值、时间戳、在线状态和故障原因；
6. `SceneEngine`：回家、离家、全开、全关、观影、警戒等场景；
7. `AutomationEngine`：人体/门磁/水浸/门锁事件触发灯、帘、音乐和告警；
8. `ControlApi`：REST 写命令，WebSocket 发布状态；
9. `AdminModule`：设备映射、房间、场景、权限、日志、备份恢复；
10. `AuditLog`：记录哪个屏、何时、对哪个设备执行什么动作、是否确认成功。

控制动作必须使用“命令—确认”模型：屏幕点击后先显示下发中，只有网关回报目标状态才显示成功；超时则显示失败或状态未知，不能固定显示成功。

### 5.3 双屏容错

基础版：主屏是唯一控制核心，副屏断线时显示离线和最近状态。该方案最简单可靠。

增强版：两个屏都保存只读的网关凭据和设备映射；平时仅主屏负责启用 Telnet/agent，副屏可直接订阅网关 MQTT。在主屏故障但网关 agent 仍运行时，副屏可继续执行基础灯光/窗帘命令。若要实现网关重启后的完整接管，需要增加主从租约/选主，避免两个屏同时修改网关运行环境。

合同只要求双屏分别控制并实时同步时，基础版已经满足核心功能；是否做完整故障接管，应单独列为增强验收项。

### 5.4 大屏前端采用“原生壳 + 本地 Web UI”，不是浏览器套网址

推荐把稳定性要求高的部分放在 Kotlin 原生层，把迭代频繁的大屏视觉放在本地 Web UI：

```text
Android APK
├── Kotlin 原生层
│   ├── Foreground Service / Boot Receiver
│   ├── 网关连接、Room、场景、审计
│   ├── Ktor REST + WebSocket
│   └── Kiosk、网络、屏幕和异常恢复
└── 本地前端资源（Vue 3 + Vite + Pinia 或同类技术）
    ├── /main       主屏 1920×1080
    ├── /secondary  副屏 1024×600
    └── /admin      管理界面
```

HTML/CSS/JavaScript 随 APK 一起打包，由应用自己的 WebView 加载，不访问远程网站；设备状态通过应用内部 REST/WebSocket 获取。这样既保留“大屏开发”的响应式布局、动画和组件效率，又把开机守护、网关凭据、数据库和硬件权限留在受控的原生层。

如果工控屏的系统 WebView 版本过旧或厂商禁止升级，则改用纯 Jetpack Compose UI；必须在立项 PoC 中先验证 WebView Chromium 版本、WebSocket、全屏触控、GPU 渲染和连续 24 小时内存曲线。

建议的最小接口边界：

| 接口 | 用途 |
|---|---|
| `GET /api/v1/snapshot` | 屏幕首次连接或断线恢复后的设备/场景全量快照 |
| `GET /api/v1/devices` | 按房间和能力读取设备 |
| `POST /api/v1/devices/{id}/commands` | 下发带请求 ID 的设备命令 |
| `POST /api/v1/scenes/{id}/execute` | 执行场景并返回逐动作结果 |
| `WS /api/v1/events` | 状态、告警、命令确认、网关在线状态实时同步 |
| `GET /api/v1/health` | 主屏、两个网关、数据库和事件流健康状态 |
| `GET /api/v1/admin/logs` | 管理员查看控制/异常日志 |

屏幕不直接拼装网关 MQTT 命令，所有控制都经过 EdgeCore 的能力校验、超时、确认和审计，避免主副屏各自维护一套协议逻辑。

## 六、现有清单的兼容性判断

以下是代码库静态证据，不能替代实机测试：

| 清单名称/型号 | 清单协议 | 开源证据 | 可承诺边界 | 当前结论 |
|---|---|---|---|---|
| 多模网关2 `DMWG03LM` | Wi-Fi/BLE Mesh/Zigbee | XiaomiGateway3 明确列出；内部 model `lumi.gateway.mcn001` | 取决于固件、Token、Key、Telnet | 高可行，PoC 第一优先级 |
| Aqara C3 `ZNCLDJ01LM` | Zigbee 3.0 | 对应 `lumi.curtain.acn04`，支持 motor | 开、关、停、位置需逐项测试 | 高可行 |
| `MCCGQ11LM` | 表中写蓝牙 Mesh | 开源表对应 Aqara Zigbee 门磁 `lumi.sensor_magnet.aq2` | 开/合、电量、低电量 | **名称/协议疑似填错，必须看铭牌和网关 model** |
| `RTCGQ13LM` | 表中写小米人体 2S/蓝牙 Mesh | 开源表对应 Aqara Precision Motion Sensor EU `lumi.motion.agl04`；真正“小米人体传感器2S”另有 `XMPIRO25XS/xiaomi.motion.pir1` | 移动、照度、盲区时间等取决于实物 | **型号冲突，不能按采购名称开发** |
| `SJWS01LM` | 蓝牙 Mesh | XiaomiGateway3 列为 `lumi.flood.bmcn01` | 水浸、恢复、电量、动作 | 中高可行 |
| 开关 Pro、筒灯、灯带 | BLE Mesh 2.0/未给内部 model | 没有足够精确 SKU/model | 开关、亮度、色温、场景需逐型号取证 | 有路径但暂不能承诺覆盖 |
| 米家吸顶灯 | 清单未明确 Wi-Fi/Mesh model | MIoT 项目覆盖灯品类，但不是逐 SKU 证据 | 本地或云取决于内部 model/token | 必须实机识别 |
| 小米智能门锁 2 Pro `XMZNMST09LK` | 未写底层路径 | 通用项目支持部分 BLE 锁事件，但未找到该 SKU 的明确写控制证据 | 门锁状态/开门事件可测试；主动开锁和凭证管理不应预先承诺 | 高风险，优先按只读事件设计 |
| 浪歌 R11 | Wi-Fi/米家接入 | 未找到可信的本地控制适配证据 | 可能只有米家云/厂商私有接口 | 高风险；需抓取实际 MIoT model/spec |
| 小米智能家庭屏 Mini | 独立终端/Mesh 网关 | 不是通用 API 服务器 | 保留其小爱语音和原生功能 | 不作为自研系统后台 |

逐设备验证时必须采集：商品名、铭牌型号、米家内部 `model`、DID/MAC、网关归属、固件、MIoT URN、可读属性、可写属性、动作、事件、断公网结果、重启恢复结果。

## 七、米家 APP 应保留到什么程度

“替代米家 APP”应定义为替代项目方的日常操作界面，而不是冒险重做小米全套设备生命周期：

| 功能 | 项目方双屏 | 工程人员米家 APP |
|---|---:|---:|
| 日常看状态、开灯、调光、窗帘、场景 | 主入口 | 不需要 |
| 双屏实时同步、告警、实训演示 | 主入口 | 不具备项目定制能力 |
| 设备分房间、场景配置、日志 | 自研管理模块 | 仅作为底层家庭配置参考 |
| 首次把设备加入小米账号/网关 | 不建议重做 | 保留 |
| 网关/设备固件升级 | 不建议重做 | 保留，但升级前必须回归测试 |
| 门锁指纹、人脸、密码/NFC 管理 | 只做授权范围内展示和审计 | 使用门锁本机/米家安全流程 |
| 故障时底层排查 | 自研运维页提供日志 | 工程维护兜底 |

项目方两块屏不安装米家 APP，工程维护手机也不计入交付硬件，因此没有违背“不新增设备”的运行约束。

## 八、分阶段开发与验收门槛

### 阶段 0：固件和许可证准入

在写 UI 前完成：

1. 记录两个 DMWG03LM 的 `model/firmware/IP/MAC/DID`；
2. 验证 Token、Key 能否取得；
3. 验证 Telnet 能否无拆机启用；
4. 验证网关重启后控制器能自动恢复；
5. 联系 openmiio_agent 作者取得商业分发/使用书面许可，或决定 clean-room 重写；
6. 暂停网关自动升级，须由项目管理方确认变更和安全责任，不能私自锁固件。

任一网关必须拆机 UART 才能接入时，应立即把它列为交付风险，不能等 UI 完成后再处理。

### 阶段 1：协议 PoC（建议 2–3 周）

允许在开发电脑上临时使用 Home Assistant + XiaomiGateway3，加速验证；开发电脑不是最终交付设备。

必须一次验证：

- 两个 DMWG03LM 同时连接；
- 一盏 BLE Mesh 灯的开关、亮度、色温和状态确认；
- C3 窗帘开、关、停、位置；
- 人体、门磁、水浸的实时事件；
- 门锁事件和允许的属性；
- R11 的 model/spec 和实际可控动作；
- 断公网 30 分钟仍可局域网控制的设备清单；
- 重启两个网关和主屏后自动恢复；
- 连续 24–72 小时事件和命令稳定性。

PoC 输出不是一张截图，而是逐 SKU 的兼容性矩阵和原始日志。

### 阶段 2：安卓 EdgeCore MVP（建议 4–6 周）

- 把固定设备转换器移植到 Kotlin；
- 实现网关监督、双网关 MQTT、统一设备模型、Room、REST/WebSocket；
- 实现灯、窗帘、三类安防、基础场景；
- 实现开机自启、前台服务、掉线恢复和日志导出。

### 阶段 3：双屏和管理（建议 4–6 周）

- 主屏 1920×1080 总览/设备/场景/安防；
- 副屏 1024×600 快捷控制；
- 双屏状态同步和冲突处理；
- 隐藏管理入口、房间/设备映射、场景编辑、权限和审计；
- Kiosk、亮度、屏保、远程诊断。

### 阶段 4：实机封版（建议 2–4 周）

- 72 小时以上稳定性；
- 断公网、断路由、重启网关、重启屏幕、IP 变化、设备离线；
- 触控误操作、命令超时、重复点击、双屏并发；
- APK 签名、版本回滚、备份恢复、安装手册、运维手册；
- 形成合同条款—功能—测试—截图/录像证据台账。

在型号和许可证顺利的前提下，完整正式版本通常是 10–16 个日历周的量级，而不是几天套一个大屏。若 R11、门锁或新固件需要逆向，工期需单独增加。

## 九、必须提前写进方案的风险

1. **官方授权风险**：小米开放平台不能让普通开发者随意控制已接入小米平台的其他厂商产品；官方 HA 云接口也不能移植成商业 APP。
2. **openmiio_agent 许可证风险**：当前无明确许可证，是正式商用前置事项。
3. **固件风险**：DMWG03LM 新固件可能改变 Token/Key/Telnet 获取方式；升级必须有回归和回滚策略。
4. **型号错配风险**：采购表的 `MCCGQ11LM`、`RTCGQ13LM` 名称/协议与开源数据库不一致，必须以实物内部 model 为准。
5. **安全风险**：Telnet 和无鉴权 MQTT 不能暴露到校园办公网；两个网关和两块屏应放在隔离 VLAN/专用路由 LAN，并限制 23/1883 端口来源 IP。
6. **门锁风险**：主动开锁、临时密码、指纹/NFC 管理不能按普通开关处理；默认只做状态、事件和联动。
7. **音乐主机风险**：R11“接入米家”不等于存在公开本地控制接口。
8. **安卓后台风险**：不能把 Termux/PRoot 当成生产守护进程；应用需使用正规的 Android Foreground Service、开机接收器和厂商白名单。

## 十、最终决策建议

### 推荐决策

立项采用：

> `DMWG03LM 局域网适配 + 主屏内置 Kotlin EdgeCore + 单 APK 双角色 + 内置管理模块`

开发顺序：

> 先用 HA/XiaomiGateway3 验证硬件 → 冻结型号和命令 → 取得 agent 许可或 clean-room 重写 → 开发安卓控制核心 → 开发双屏 → 完成稳定性和合同验收。

### 不推荐决策

- 两块屏直接安装米家 APP：没有软件开发交付价值，也无法满足定制双屏同步和实训管理；
- 把 Home Assistant Lovelace 换皮当最终产品：技术债和安卓部署不可靠，且无法体现完整自主系统；
- 纯小米云逆向：网络、账号风控和商业授权风险最高；
- 只用 USB Zigbee/Zigbee2MQTT：覆盖不了现有大量 BLE Mesh 设备；
- 在副屏、家庭屏 Mini 或 R11 上再找“服务器”：它们不是采购意义上的通用服务端。

## 十一、主要证据链接

- XiaomiGateway3：https://github.com/AlexxIT/XiaomiGateway3
- XiaomiGateway3 固件与工作机制：https://github.com/AlexxIT/XiaomiGateway3#supported-firmwares
- XiaomiGateway3 支持设备表：https://github.com/AlexxIT/XiaomiGateway3/blob/master/DEVICES.md
- DMWG03LM 1.0.7 实际问题讨论：https://github.com/AlexxIT/XiaomiGateway3/issues/1166
- openmiio_agent：https://github.com/AlexxIT/openmiio_agent
- C# Mi Home Library：https://github.com/sergey-brutsky/mi-home
- Xiaomi Miot for Home Assistant：https://github.com/al-one/hass-xiaomi-miot
- 小米官方 Home Assistant 集成：https://github.com/XiaoMi/ha_xiaomi_home
- 小米官方集成许可证：https://github.com/XiaoMi/ha_xiaomi_home/blob/main/LICENSE.md
- 小米官方集成法律声明：https://github.com/XiaoMi/ha_xiaomi_home/blob/main/LegalNotice.md
- 小米 IoT 接入模式：https://iot.mi.com/v2/new/doc/introduction/preparation/access_mode
- Home Assistant Core：https://github.com/home-assistant/core
- Mushroom：https://github.com/piitaya/lovelace-mushroom
- ha-floorplan：https://github.com/ExperienceLovelace/ha-floorplan
- ha-paneld：https://github.com/maxlyth/ha-paneld
- WallPanel：https://github.com/TheTimeWalker/wallpanel-android
- KioskZen：https://github.com/exraaaa/KioskZen
- superdash：https://github.com/supergillis/superdash
- Kiosk Satellite：https://github.com/jxlarrea/kiosk-satellite
- Termux Android 12 后台限制说明：https://github.com/termux/termux-app#readme
