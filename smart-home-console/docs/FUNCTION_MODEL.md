# 正式功能模型、业务流程与 API

## 角色与入口

| 角色         | 入口                               | 能力                                                                   |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------- |
| 操作员       | 主屏 `/primary`、副屏 `/secondary` | 查看权威状态，控制 capability 允许的设备，执行场景，查看并确认告警     |
| 管理员       | 受 PIN 保护的 `/admin`             | 配置房间、设备、场景、联动、网关和终端；管理告警、备份、审计和运行交接 |
| 交付工程人员 | 主屏本机或受控局域网工程终端       | 写入 HA/网关凭据、诊断、数据库快照、签名 UI 更新和 APK 运维            |

教师开课、学生/小组、题目、评分、成绩和故障注入不属于合同正式功能。工程管理是为了完成设备映射、诊断、审计和可维护交付，不是另一套智慧家居系统。

## 正式领域对象

### Device

设备由 `kind + capabilities + state + integration` 描述。UI 只按 capability 生成控件，不按商品名硬编码。

- `kind`：gateway、light、cover、sensor、lock、media、switch、panel；
- `capabilities`：属性类型、范围、步进、枚举、单位和可写性；
- `state`：最后一次权威确认值；
- `integration`：适配器、外部实体、市场型号、内部 model、协议、网关与验证状态。

### Command

每个写操作包含幂等 `requestId`、目标设备、属性和值。服务端从 Bearer 身份推导来源，客户端 `source` 只作兼容字段。状态只能是 `pending / confirmed / failed / timeout`。

### Scene

场景是有序设备动作集合，支持串行或并行。正式默认场景为回家、离家、夜间、观影；管理员可按本台真实设备编辑。执行汇总为 `running / completed / partial / failed`。

### Automation

联动模型为 `condition + actions + cooldown + enabled`。条件与动作都必须引用存在的设备 capability；冷却和事件去重避免传感器抖动反复执行。

### Alert

告警生命周期为发生 → 确认 → 恢复。确认只代表人员已知悉；恢复必须由可信设备状态或满足恢复条件的服务端操作证明。

### Terminal

一套实训台的主屏与副屏属于同一 `controlDomainId`。副屏通过一次性配对码获取本机 Keystore 保存的令牌；事件流票据一次性、短期有效且绑定物理角色。界面切换不改变终端身份。

### AdminConfiguration

只包含房间、设备、场景、联动、网关、终端和复位策略。配置保存采用版本控制；冲突必须加载三方差异并明确选择，不能静默覆盖。

### Audit / Handover / Backup

- 审计记录关键控制、场景、告警、配置、安全与运维结果；
- 运行交接记录当前告警、离线设备、在途操作、基线和终端状态；
- 配置备份用于迁移可编辑配置；SQLite 快照用于权威运行数据灾备，两者不能互相冒充。

## 关键业务流

### 单设备控制

1. UI 读取设备 capability 并显示允许的控件；
2. 用户操作后创建幂等 requestId，界面进入 pending；
3. EdgeCore 校验终端身份、设备健康、类型、范围、步进和枚举；
4. GatewayAdapter 下发真实命令；
5. 只有设备状态达到目标或适配器给出可信确认才转 confirmed；
6. 命令终态通过 WebSocket 同步两屏并写入审计；
7. 超时或失败保持最后确认状态，页面显示可理解原因。

### 场景执行

1. EdgeCore 创建 execution 并锁定冲突场景；
2. 每个动作复用 CommandService；
3. 逐步广播进度和动作结果；
4. 汇总 completed、partial 或 failed；
5. 两屏显示同一权威执行结果，审计保留来源和失败链路。

### 自动联动

1. 适配器上报可信属性事件；
2. StateStore 按设备属性拒绝乱序/重复事件；
3. AutomationEngine 校验条件、启用状态、冷却和复位抑制窗口；
4. 动作复用命令状态机并形成审计；
5. 联动失败不终止 EdgeCore，也不固定显示成功。

### 告警

1. 可信异常状态创建或更新告警；
2. 主副屏同步显示优先级和设备位置；
3. 操作员确认后告警仍保持活动，直到恢复条件成立；
4. 恢复后保留完整时间线和审计。

### 运行复位与交接

设备安全复位只操作策略允许的灯光、音乐、开关和窗帘；门锁、只读安防和离线设备不被强制控制。严重告警或在途操作会阻断，离线项转人工核对。完成后可留存运行交接记录，供下一位值班人员判断现场是否安全。

## 正式 API v1

| 方法与路径                                          | 用途                                   | 鉴权                |
| --------------------------------------------------- | -------------------------------------- | ------------------- |
| `GET /health`                                       | EdgeCore、网关、模式、版本与控制域健康 | 公开最小信息        |
| `POST /control-domain/challenge`                    | 主副屏控制域双向证明                   | 已配对设备证明      |
| `POST /terminals/pair`                              | 副屏一次性配对                         | 六位配对码          |
| `POST /terminals/event-ticket`                      | 换取一次性事件票据                     | 终端 Bearer         |
| `GET /snapshot`                                     | 首次加载和事件跳号恢复                 | 终端 Bearer         |
| `GET /devices`                                      | 设备、能力与权威状态                   | 终端 Bearer         |
| `POST /devices/{id}/commands`                       | 写设备属性                             | 终端或管理员 Bearer |
| `GET /scenes`                                       | 场景列表                               | 终端 Bearer         |
| `POST /scenes/{id}/execute`                         | 执行场景                               | 终端或管理员 Bearer |
| `GET /alerts`                                       | 告警列表                               | 终端 Bearer         |
| `POST /alerts/{id}/acknowledge`                     | 确认告警                               | 终端或管理员 Bearer |
| `GET /events`                                       | WebSocket 权威事件流                   | 一次性 ticket       |
| `POST /admin/login`、`logout`、`change-pin`         | 管理会话                               | PIN / 管理 Bearer   |
| `GET/PUT /admin/config`                             | 读取和保存配置                         | 管理 Bearer         |
| `GET/POST /admin/backup`                            | 脱敏配置导出/恢复                      | 管理 Bearer         |
| `GET /admin/resources/{resource}`                   | 正式资源分页查询                       | 管理 Bearer         |
| `GET /admin/audits`                                 | 审计查询                               | 管理 Bearer         |
| `GET/POST /admin/bench-reset*`                      | 安全复位预览与执行                     | 管理 Bearer         |
| `GET/POST /admin/handover*`                         | 运行检查与交接留档                     | 管理 Bearer         |
| `GET /admin/diagnostics`                            | 脱敏诊断                               | 管理 Bearer         |
| `/admin/database-backups*`、`/admin/data-lifecycle` | 数据库快照与容量健康                   | 管理 Bearer         |
| `/admin/ui-update*`                                 | 签名 UI 更新与回滚                     | 管理 Bearer         |
| `/admin/terminals*`                                 | 配对码和终端撤销                       | 管理 Bearer         |
| `/admin/gateways/{id}/test`                         | 网关及目标实体联检                     | 管理 Bearer         |

正式 API 不包含 `/training/*` 或 `/simulator/*`。Mock 的 `/api/v1/_test/*` 仅在显式测试开关下存在，不进入 OpenAPI、APK 或用户手册。

## WebSocket 规则

事件类型包括 snapshot、heartbeat、device.updated、command.updated、scene.updated、scene.execution、alert.created、alert.updated、health.updated、terminal.updated 和 audit.created。每个事件携带单调 sequence；客户端发现跳号时必须重新加载 snapshot。
