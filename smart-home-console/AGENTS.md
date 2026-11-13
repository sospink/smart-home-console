# 项目开发约束

## 范围

本目录是“智慧家居实训台双屏控制系统”，合同和上级调研报告是需求依据。正式目标是两套独立实训台，每套使用 Android 主屏 EdgeCore、同一 APK 的主副屏角色和一个 DMWG03LM。本台 DMWG03LM + `xiaomi.light.btlm2` 已通过 HA 官方 Xiaomi Home 云链路完成真机控制；这不是 DMWG03LM 本地直连，第二台和其余 SKU 仍待验证。

## 硬规则

- 使用 UTF-8；用户界面、日志和运维错误默认中文。
- 禁止提交 Token、Key、小米账号、DID/MAC 对照表等敏感信息。
- 主副屏不得直接构造 MQTT/miIO/Zigbee 命令，只调用 EdgeCore 领域 API。
- 所有写控制必须经过 pending/confirmed/failed/timeout，不允许前端固定成功。
- 门锁主动开锁默认不在能力表；没有实机和安全授权不得添加。
- 正式代码、OpenAPI 和 APK 不得注册 `/training/*` 或 `/simulator/*`；测试夹具只允许显式 `/api/v1/_test/*`，不得进入用户界面。
- 不得添加需要新增交付硬件的架构依赖。
- 不得未经许可分发 `openmiio_agent` 或小米官方 HA 云接口代码。

## 合同与状态

- 功能变化先定位 `docs/CONTRACT_LEDGER.md` 条款映射。
- 状态只使用：未开始、平台闭环、硬件待验证、硬件已验证、阻塞、已验收。
- Mock、浏览器截图和自动测试只能证明平台闭环，不能把硬件状态升级为已验证。
- `RTCGQ13LM`、`MCCGQ11LM` 型号冲突和 R11 接口阻塞必须保留，直到实机证据推翻。
- RS-485、八子网、副屏合同分辨率和门锁容量是已知硬件缺口，软件不得伪造满足。

## 前端

- 视觉系统以 `docs/UI_SYSTEM.md` 和 `styles/tokens.css` 为准。
- 目标视口至少测试 1920×1080、1920×720、1024×600；1424×280 仅做软件适配验证。
- 触控靶不小于 44×44 CSS px；关键操作不能依赖 hover。
- 素材必须离线打包并登记到 `src/assets/ASSET_MANIFEST.md`；禁止电商图和互联网热链。
- 动效必须表达命令确认、场景进度或共享状态，不增加装饰性持续动画。
- 所有设备控件必须由 capability 决定，不按商品名硬编码控制能力。

## 服务与数据

- 契约以 `packages/contracts` 为准；Mock 和 Kotlin EdgeCore 必须通过同一契约测试。
- 关键写操作必须产生 audit/execution/alert 记录。
- WebSocket 事件含单调 sequence；客户端跳号必须重新加载 snapshot。
- 持久化、权限、凭据、配置备份在正式 EdgeCore 服务端实现，不放前端 localStorage。

## 测试与文档

- 变更共享契约、状态机或 UI 公共层后运行 `pnpm check`。
- 场景/命令测试必须覆盖成功、失败、部分成功、离线和恢复。
- 主副屏变更需在目标视口做视觉检查；关键联动需跑真实浏览器 E2E。
- 任务状态只更新 `docs/TODO.md` 和 `docs/CONTRACT_LEDGER.md`，避免重复进度文档。
- 完成前搜索 mock/demo/固定成功/硬编码指标，明确残余硬件风险。
