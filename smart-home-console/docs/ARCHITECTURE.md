# 正式架构与部署边界

## 架构结论

每套实训台采用“一个系统、一个 APK、两个屏幕角色、一个权威状态源”。两套实训台各自拥有主屏 EdgeCore、DMWG03LM、终端凭据和稳定 `controlDomainId`，不能共享状态库或串台控制。

```text
主屏 UI ─┐
副屏 UI ─┼─ REST + WebSocket ─ Android 主屏 EdgeCore ─ HomeAssistantGatewayAdapter
管理 UI ─┘                         ├─ Room / SQLite             │
                                  ├─ Command / Scene / Automation
                                  ├─ Alert / Audit / Backup    └─ HA 官方 Xiaomi Home ─ 小米云 ─ DMWG03LM ─ BLE Mesh 灯
                                  └─ Terminal / Security
```

当前真机 MVP 是 HA 官方 Xiaomi Home 云链路，不是 DMWG03LM 局域网直连。断公网时即使网关和主屏仍在同一局域网，也不能假定控制可用。

Node `mock-edge` 只用于隔离自动测试，不属于部署拓扑，不进入正式 APK。

## Android 组成

- `KioskActivity`：同一 APK 的主屏/副屏角色、沉浸 WebView、异常恢复和 HOME/Kiosk；
- `EdgeForegroundService`：只在主屏角色启动本地 Ktor EdgeCore；
- `BootReceiver`：开机恢复服务，正式界面仍需默认 HOME/MDM；
- `NetworkMonitor`：地址变化、断线恢复与 mDNS；
- `PersistentSecretStore`：Android Keystore 保存管理 PIN、HA Token 和终端凭据；
- `AssetVersionManager`：内置 UI、签名更新、回滚与副屏版本同步；
- `RoomDatabase`：设备、能力、状态、场景、联动、命令、告警、终端、审计和备份元数据。

## EdgeCore 服务

- `GatewaySupervisor` 维护本台唯一适配器健康；
- `GatewayAdapter` 隔离 HA 云链路与未来合法本地适配器；
- `DeviceRegistry` 将外部实体/model 映射为稳定设备 ID；
- `CapabilityRegistry` 暴露类型、范围、步进、枚举和可写性；
- `CommandService` 完成校验、幂等、下发、超时与可信确认；
- `StateStore` 将期望值与已确认值分离并拒绝乱序事件；
- `SceneEngine` 汇总逐动作结果；
- `AutomationEngine` 处理条件、冷却、去重与复位抑制；
- `AlertService` 管理发生、确认与恢复；
- `AuditService` 记录关键控制、配置、安全和运维动作；
- `ControlApi` 提供同一份 REST/WebSocket 契约。

前端禁止构造 MQTT、miIO、Zigbee 或 HA 原始服务调用。接入方式变化只能影响 Adapter，不能绕过 EdgeCore 状态机。

## 主副屏发现与身份

1. 主屏发布 `_smartlab-edge._tcp.local`、版本和非敏感控制域 ID；
2. 副屏首次使用六位一次性码配对，并将令牌与证明密钥写入本机 Keystore；
3. mDNS/固定 IP 只负责发现候选，连接前必须完成控制域 HMAC 挑战；
4. 副屏加载 snapshot，再用一次性 ticket 订阅 events；
5. sequence 跳号重新加载 snapshot；
6. 主屏不可达时只显示最后可信缓存，禁用控制，不显示假成功；
7. 界面可在主屏/副屏/管理之间切换，但物理终端 Bearer 和审计来源保持不变。

HMAC 证明不能防同 VLAN 实时中继。交付网络必须是受信 VLAN/受控 Wi-Fi，并限制 8787 访问来源。

## 命令与状态

```text
created → validated → dispatched → acknowledged → confirmed
                 └→ rejected       └→ timeout      └→ failed
```

页面点击只能形成 pending。只有真实状态达到目标或适配器的可信确认才能完成；失败和超时不得修改最后权威状态。场景结果允许 completed、partial 和 failed。

## 数据与历史兼容

正式运行数据包括 gateway、device、capability、device_state、scene、automation、command、alert、audit_log、terminal、handover 和 backup metadata。

旧数据库中的 `training_exercises` 表及旧审计 training 列只为 Room schema/迁移兼容保留：

- 不进入正式 DTO、快照、配置、查询、备份恢复或 UI；
- 不参与正式审计搜索和数据生命周期统计；
- 旧 `scene-training` 仅在一次性迁移时转成 `scene-movie`；
- 新运行逻辑不得再次写入这些历史列。

## 安全与凭据

- Token、Key、终端令牌和明文网关凭据不进入前端包、日志、配置备份或诊断包；
- 主屏 WebView 也必须携带 Keystore 终端身份，不使用 loopback 免鉴权；
- 管理入口使用 PIN 换取短期会话，轮换 PIN 会吊销旧管理会话；
- 门锁主动开锁默认不在 capability 表；
- 副屏撤销必须同时吊销 Bearer、未用 ticket、事件流和证明密钥；
- UI 更新必须通过内置 Ed25519 公钥验签并逐文件校验 SHA-256。

## 部署

1. `pnpm --filter @smart-lab/panel-ui build` 生成离线 UI；
2. Gradle 将构建同步到 `android/app/src/main/assets/panel-ui`；
3. 主屏选择 PRIMARY，运行 EdgeCore 并加载 `/primary`；
4. 副屏选择 SECONDARY，配对后加载 `/secondary`；
5. `/admin` 仅允许主屏本机或受控工程终端使用；
6. 两套实训台分别配置自己的 HA 地址、Token、网关实体和设备实体。

## 当前验证边界

已验证：本台 DMWG03LM 固件 `1.0.8_0013`、`xiaomi.light.btlm2` 的 HA 云控制和回传。

待验证：第二套控制域、其他采购 SKU、断公网、采购 Android 屏 Kiosk/重启/触控、真实 mDNS 并存时序、RS-485 八子网、R11、门锁和语音。
