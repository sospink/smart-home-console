# 智慧家居实训台项目

此目录汇总完整软件工程、安装产物、合同采购资料和调研报告。目录归类日期：2026-11-13。

## 项目导航

| 内容 | 位置 | 用途 |
| --- | --- | --- |
| 完整源码工程 | [smart-home-console](smart-home-console/) | Web 主屏/副屏/管理端、Android APK、EdgeCore、数据库、HA 适配器和测试 |
| APK 安装产物 | [output/apk](smart-home-console/output/apk/) | 已生成的调试安装包与未签名 Release 候选 |
| 开发与部署文档 | [工程文档](smart-home-console/docs/) | 架构、UI 规范、功能模型、合同台账、TODO 和交付手册 |
| 界面验证截图 | [output/playwright](smart-home-console/output/playwright/) | 不同页面、主题和分辨率的历史验证截图 |
| 自动化测试报告 | [playwright-report](smart-home-console/playwright-report/) | 历史测试输出，不代表当前代码已重新验收 |
| 合同与采购清单 | [合同与采购](项目资料/合同与采购/) | 原始需求和硬件清单 |
| 技术方案 | [技术方案](项目资料/技术方案/) | V2.3 技术方案 PDF |
| 调研报告 | [调研报告](项目资料/调研报告/) | 合同硬件软件分析、HA 可行性、兼容清单、双屏落地方案 |

## 开发与运行

在 `smart-home-console/` 内执行开发、测试、打包命令。具体环境要求和操作见[工程 README](smart-home-console/README.md)与[交付手册](smart-home-console/docs/DELIVERY_MANUAL.md)。

```bash
cd smart-home-console
pnpm install
pnpm dev
```

Web 调试入口为 `http://localhost:8083/primary`、`/secondary`、`/admin`。当前工程的 `pnpm dev` 连接配置的主屏 EdgeCore，需先完成真机调试配对；隔离自动测试使用 `pnpm dev:test`。

主屏和副屏共用一个 APK，按终端角色运行；工程管理 UI 同样包含在该 APK 中。正式业务服务及 Room 数据库由主屏 EdgeCore 承载，Home Assistant 是外部配套服务。

## 安装产物说明

Git 仓库保存源码、配置、测试和项目资料；`output/`、测试报告、编译缓存、安装包及运行凭据不提交。上方 APK、截图和测试报告入口用于本机已有产物，首次克隆后需自行构建或运行测试生成。

目录整理时 `output/apk/` 中保留了 `0.1.4-debug`、`0.1.5-debug` 和 `0.1.4-release-unsigned`。Debug 包用于调试；未签名 Release 不能直接安装，也不能视作正式签名交付包。目录整理未重新构建 APK，不保证这些历史包与当前源码完全一致。

软件完成状态以 [TODO](smart-home-console/docs/TODO.md) 和 [合同台账](smart-home-console/docs/CONTRACT_LEDGER.md) 为准，截图、测试夹具不替代实机验收。

## 本机 Home Assistant

此前迁移的 HA 配套部署位于 `~/.local/share/smart-lab-home-assistant/`，含配置、备份、Compose 和 `smart-lab-ha` 启停脚本。它在项目目录之外，本次整理没有移动或检查该服务的运行状态。该目录含认证信息，不应随源码包直接分发。

## 目录维护说明

- 原始合同、采购表和报告保留原文件名及内容。
- 工程内部的源码、构建配置、APK、截图及测试报告保留原路径。
- 历史调研过程材料与浏览器调试记录已于 2026-11-13 按用户要求移至 macOS 废纸篓，不参与构建或运行。
- 软件工程、APK、正式报告和合同资料保留；未清理构建缓存或更新运行凭据。
