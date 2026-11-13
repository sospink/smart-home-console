# 知境 · 智慧家居实训台双屏控制系统

完整项目资料与产物入口见[上级项目导航](../README.md)。原始合同和采购清单位于[项目资料/合同与采购](../项目资料/合同与采购/)。本工程的开发和构建路径保持不变。

这是智慧家居实训台的双屏控制与工程管理系统。当前本机开发入口默认连接采购主屏 EdgeCore，并通过 HA 官方 Xiaomi Home 云链路控制已接入的 DMWG03LM 与筒灯。

当前实现：

- 主屏 `/primary`：1920×1080 总览、场景、设备状态与控制确认；
- 副屏 `/secondary`：1024×600 高频场景、灯光、窗帘、音乐和告警；
- 工程管理 `/admin`：PIN 鉴权、房间/设备、场景、联动、告警、网关诊断、备份、终端和审计；
- UI 架构：主副屏使用自研“知境”浅色住宅控制设计系统；工程端使用同主题的 Naive UI 类型化组件，并作为独立路由包加载；
- 米家 UI 调研：依据官方多端控制、家庭屏与 IoT 平台资料，采用浅灰画布、白色设备卡、房间优先、高频品类聚合、单设备聚焦控制与生活场景导航；证据及版权边界见 `docs/MIJIA_UI_RESEARCH.md`；
- 隔离测试 EdgeCore：REST + WebSocket，仅供自动化验证设备状态、命令确认/失败、场景逐动作执行和告警，不属于正式产品；
- 共享契约：硬件到货后 Kotlin EdgeCore 和 DMWG03LM Adapter 必须实现同一份接口。

## 快速启动

要求 Node.js 22、pnpm 11。

```bash
pnpm install
pnpm dev
```

打开：

- `http://localhost:8083/primary`
- `http://localhost:8083/secondary`
- `http://localhost:8083/admin`

`pnpm dev` 与 `pnpm dev:hardware` 均启动真机 Web 调试：只监听 `127.0.0.1:8083`，核验目标明确返回 `hardware`，并将 `/api` 代理到采购主屏 EdgeCore。首次无调试凭据时，页面会在启动门禁中要求输入主屏首次设置的 6–12 位工程 PIN；本机代理据此签发调试终端令牌并保存到 macOS 钥匙串，PIN、Bearer 均不进入前端资源、URL 或浏览器存储。成功后页面右上角必须显示“正式”，真实筒灯控制以 EdgeCore/HA 权威回传为准。

只有运行隔离自动化测试时才使用 `pnpm dev:test`。该命令启动测试夹具，不占用现场真机链路，也不属于正式部署入口；测试管理 PIN 默认为 `2468`。

## 验证

```bash
pnpm check
pnpm e2e
```

目前自动检查覆盖：

- ESLint、Prettier、OpenAPI 3.1/JSON Schema 校验；
- TypeScript/Vue 类型检查；
- Mock EdgeCore 命令确认；
- 网关离线导致子设备命令失败；
- 场景部分失败不会固定显示成功；
- 水浸事件创建紧急告警；
- 命令去重、超时、序号缺口恢复、备份迁移和告警恢复；
- Playwright 主→副、副→主、管理告警→双屏、Naive UI 后台编辑器、空状态以及四种目标视口；
- 生产构建。

Android 安装、工程管理、运维、APK 升级/回滚和残余安全风险见 `docs/DELIVERY_MANUAL.md`。

## 目录

```text
apps/
├── mock-edge/       隔离测试服务；不进入正式 APK
└── panel-ui/        主屏、副屏、管理端本地 Web UI
packages/
└── contracts/       设备、场景、命令、告警和事件契约
docs/
├── ARCHITECTURE.md  整体架构和硬件替换边界
├── UI_SYSTEM.md     视觉、动效和素材方案
├── FUNCTION_MODEL.md 功能/数据/API 模型
├── CONTRACT_LEDGER.md 合同软件台账
├── DELIVERY_MANUAL.md 安装、工程管理、运维与残余风险
└── TODO.md          完整开发任务和完成定义
```

## 状态口径

- `平台闭环`：正式 Kotlin EdgeCore/API/持久化闭环；
- `硬件待验证`：没有实机证据；
- `硬件已验证`：已按 SKU、固件和断网/重启测试验证；
- `已验收`：形成合同验收证据并由项目方确认。

当前本台 DMWG03LM 与单筒灯的 HA 云链路为“硬件已验证”；第二套、其他 SKU 与采购屏现场链路仍为“硬件待验证”，R11 接口为“阻塞”。
