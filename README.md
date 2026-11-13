# 知境 · 智慧家居实训台双屏控制系统

本项目面向智慧家居实训台，提供 Android 主屏、副屏和工程管理界面，支持设备控制、场景编排、自动联动、告警、终端配对、审计和配置备份。仓库包含完整软件工程、已构建 APK、合同采购资料及技术调研报告。

主副屏使用同一个 APK，通过首次配置选择终端角色。主屏承载 Kotlin EdgeCore 控制服务和 Room 数据库；副屏通过主屏 API 获取状态并发起操作。

```text
主屏 / 副屏 / 工程管理界面
        ↓ REST + WebSocket
Android 主屏 EdgeCore + Room 数据库
        ↓ HomeAssistantGatewayAdapter
Home Assistant → Xiaomi Home → 小米云 → 网关与设备
```

当前 DMWG03LM 接入方案依赖 HA 与小米云，不属于网关局域网直连。两套实训台应分别配置各自的控制域、设备实体和终端凭据。

## 1. 安装包下载

以下为仓库保留的既有构建产物，点击文件名可下载。版本和 Android 要求已从 APK Manifest 核对；这些文件未在本次文档更新中重新编译，不保证与仓库最新源码逐字对应。

| 安装包                                                                                                | versionCode | 大小      | 用途                                     |
| ----------------------------------------------------------------------------------------------------- | ----------- | --------- | ---------------------------------------- |
| [0.1.5 Debug](smart-home-console/output/apk/smart-lab-0.1.5-debug.apk?raw=true)                       | 8           | 19.73 MiB | 当前保留的最高版本调试包，可用于平板测试 |
| [0.1.4 Debug](smart-home-console/output/apk/smart-lab-0.1.4-debug.apk?raw=true)                       | 7           | 20.01 MiB | 历史调试包                               |
| [0.1.4 Release · 未签名](smart-home-console/output/apk/smart-lab-0.1.4-release-unsigned.apk?raw=true) | 7           | 5.92 MiB  | 历史优化构建候选，不能直接安装           |

- 最低运行系统：Android 11（API 30）；目标 SDK：Android 15（API 35）。
- Debug 应用 ID：`cn.zhijing.smartlab.debug`；Release 应用 ID：`cn.zhijing.smartlab`。
- 两个 Debug 包包含 APK 签名块；正式生产部署应使用组织保管的 Release 签名证书。
- 覆盖更新要求应用 ID、签名证书一致，且版本号满足 Android 升级要求。不同开发机的默认 Debug 证书可能不同。
- APK 不包含现场 HA 配置；首次安装后需设置角色、工程 PIN、HA 地址及终端配对信息。

校验文件见 [SHA256SUMS](smart-home-console/output/apk/SHA256SUMS)。在仓库根目录执行：

```bash
cd smart-home-console/output/apk
shasum -a 256 -c SHA256SUMS
```

Linux 可使用 `sha256sum -c SHA256SUMS`。

## 2. 仓库结构

```text
.
├── README.md
├── .github/workflows/ci.yml       Web 检查、构建与端到端测试
├── smart-home-console/           软件工程目录
│   ├── apps/panel-ui/            Vue 主屏、副屏与工程管理界面
│   ├── apps/mock-edge/           隔离自动测试服务，不进入正式 APK
│   ├── android/                 Android 多模块工程
│   │   ├── app/                 WebView、Kiosk、自启动与原生桥
│   │   ├── edgecore/            Ktor 控制服务与业务状态机
│   │   ├── data/                Room 数据库与 Keystore
│   │   ├── gateway-api/         设备接入接口
│   │   └── gateway-home-assistant/  HA 适配器
│   ├── packages/contracts/      共享类型与接口契约
│   ├── openapi/                 OpenAPI 定义
│   ├── scripts/                 构建、调试、安装与更新工具
│   ├── tests/                   浏览器端到端测试
│   ├── docs/                    架构、交付手册与合同台账
│   └── output/apk/              已发布安装包及校验文件
└── 项目资料/
    ├── 合同与采购/
    ├── 技术方案/
    └── 调研报告/
```

前端采用 Vue 3、TypeScript、Vite、Pinia 和 Naive UI；Android 采用 Kotlin、Ktor、Room 和 Android Keystore。HA 为外部配套服务，现场账户、Token、配置备份及签名私钥不在本仓库中。

## 3. 开发环境

| 工具                  | 版本或要求                                                          |
| --------------------- | ------------------------------------------------------------------- |
| Node.js               | 22.13 或以上的 22.x 版本，与当前 CI 保持一致                        |
| pnpm                  | 11.9.0，与 `package.json` 的 `packageManager` 一致                  |
| JDK                   | 建议 17；Gradle JVM 与 `JAVA_HOME` 保持一致                         |
| Android SDK           | Platform 35、Build Tools 35.0.0、Platform Tools、Command-line Tools |
| Gradle                | 使用仓库 Wrapper 8.10.2，无需另装全局 Gradle                        |
| Android Gradle Plugin | 8.8.2，由工程统一管理                                               |
| 测试设备              | Android 11 或以上；ADB 安装需启用 USB 调试                          |

本文命令以 macOS/Linux 的 Bash 或 Zsh 为例。现有 Web 真机配对工具使用 macOS 钥匙串，完整真机 Web 调试流程以 macOS 为基准。Windows 下 Android 构建可使用 Android Studio 或 `gradlew.bat`，环境变量与 Shell 命令需按平台调整。

### 获取源码与安装依赖

```bash
git clone https://github.com/sospink/smart-home-console.git smart-home-training
cd smart-home-training/smart-home-console

npm install --global pnpm@11.9.0
node --version
pnpm --version
pnpm install --frozen-lockfile
```

后续 Web 命令均在软件工程目录 `smart-home-training/smart-home-console/` 执行，Android 命令另有说明。安装时保留锁文件；依赖构建授权在 `pnpm-workspace.yaml` 中维护。

## 4. Web 调试与构建

### 真机调试

先在 Android 主屏启动 PRIMARY 角色，确保开发机能够访问该主屏的 EdgeCore 服务。设置实际主屏地址后启动：

```bash
export EDGE_TARGET="http://192.168.0.100:8787"
pnpm dev
```

`192.168.0.100` 仅为示例，必须替换为 Android 主屏 IP；`EDGE_TARGET` 不是 HA 地址。脚本在启动前核验目标为正式硬件 EdgeCore，主屏不可达时会停止，不会自动切换为测试数据。

| 页面     | 本机地址                          |
| -------- | --------------------------------- |
| 主屏     | <http://localhost:8083/primary>   |
| 副屏     | <http://localhost:8083/secondary> |
| 工程管理 | <http://localhost:8083/admin>     |

首次访问按启动门禁提示输入主屏设置的工程 PIN；也可先在主屏“终端管理”生成一次性配对码，再执行 `pnpm hardware:pair` 交互配对。两种方式均使用同一 `EDGE_TARGET`，调试凭据保存在 macOS 钥匙串中。真机 Web 调试服务仅监听本机回环地址。

### 无硬件环境的界面测试

```bash
pnpm dev:test
```

此入口启动隔离测试服务，用于界面和业务流程验证；测试管理 PIN 为 `2468`，不能用于现场硬件验收。停止开发服务使用 `Ctrl+C`。

### 生产构建

```bash
# 构建前端及工作区其他包
pnpm build

# 仅构建 APK 所需的前端资源
pnpm --filter @smart-lab/panel-ui build
```

前端产物位于 `apps/panel-ui/dist/`。该目录是静态 UI 资源，不包含 EdgeCore、Room 或 HA 服务；不能仅部署静态资源就替代完整控制系统。正式 Android 构建会自动将其打包到 APK。

## 5. Android 编译与 APK 打包

### 配置 JDK 和 SDK

可通过 Android Studio 的 SDK Manager 安装 Android SDK。以下示例使用 macOS 默认 SDK 路径：

```bash
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
sdkmanager --licenses
```

Linux 将 `JAVA_HOME` 和 `ANDROID_HOME` 改为实际安装目录。也可在 `android/local.properties` 中配置 `sdk.dir`；该文件包含本机路径，不提交 Git。Android 构建前必须先完成 Web 依赖安装，并确保 Gradle 可以调用 `pnpm`。

### 构建 Debug APK

从软件工程目录进入 Android 子目录：

```bash
cd android
./gradlew :app:assembleDebug \
  -PSMART_LAB_VERSION_CODE=9 \
  -PSMART_LAB_VERSION_NAME=0.1.6
```

`0.1.6 / 9` 是下一次构建的示例值，并非本仓库已有安装包。实际升级时应使用团队分配且大于已安装版本的 `versionCode`。未传版本参数时，工程默认值为 `0.1.0 / 1`。

构建顺序由 Gradle 自动完成：前端生产构建 → 同步离线 UI → Kotlin/Android 编译 → Debug 签名与 APK 打包。无需手工复制前端资源。

产物相对软件工程目录的位置：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

### 构建正式签名 Release APK

正式交付应使用固定签名证书。已有证书时继续使用原证书，避免覆盖升级失败；首次建立签名体系可在工程目录外生成密钥：

```bash
mkdir -p "$HOME/.local/share/smart-lab-signing"
keytool -genkeypair -v -storetype JKS \
  -keystore "$HOME/.local/share/smart-lab-signing/smart-lab-release.jks" \
  -alias smart-lab -keyalg RSA -keysize 3072 -validity 10000
```

该命令交互输入密码，不要覆盖已有密钥。将签名配置写入本机 `~/.gradle/gradle.properties`，或通过受控 CI 密钥注入；下列为配置格式，必须替换占位值：

```properties
SMART_LAB_KEYSTORE_FILE=/absolute/path/to/smart-lab-release.jks
SMART_LAB_KEYSTORE_PASSWORD=REPLACE_WITH_STORE_PASSWORD
SMART_LAB_KEY_ALIAS=smart-lab
SMART_LAB_KEY_PASSWORD=REPLACE_WITH_KEY_PASSWORD
```

在 `android/` 目录执行：

```bash
./gradlew :app:assembleRelease \
  -PSMART_LAB_VERSION_CODE=9 \
  -PSMART_LAB_VERSION_NAME=0.1.6
```

配置签名后产物为 `app/build/outputs/apk/release/app-release.apk`。未配置签名时生成 `app-release-unsigned.apk`，不能直接安装。Release 构建启用代码压缩和资源收缩。

对正式安装包进行签名验证：

```bash
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

APK 签名证书与 UI 更新包签名是两套机制。如需独立更新前端资源，构建 APK 时还需注入 `SMART_LAB_UI_UPDATE_PUBLIC_KEY`（Ed25519 X.509 公钥 Base64）；私钥不得进入仓库或 APK，具体流程见 [Android 运行时说明](smart-home-console/android/README.md)。

## 6. 安装、升级与现场配置

从软件工程目录安装仓库中的既有调试包：

```bash
adb devices
adb install -r output/apk/smart-lab-0.1.5-debug.apk
```

安装自行构建的 Debug APK：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Release 则使用 `android/app/build/outputs/apk/release/app-release.apk`。设备提示签名不一致时，应核对原签名证书；不要为覆盖安装而直接卸载带有现场配置的应用。正式部署前备份数据，升级与回滚流程见交付手册。

需要设置工控屏默认 HOME/Kiosk 时，在软件工程目录执行：

```bash
# Debug 包
./scripts/install-android-kiosk.sh output/apk/smart-lab-0.1.5-debug.apk

# 正式签名 Release 包
SMART_LAB_PACKAGE=cn.zhijing.smartlab \
  ./scripts/install-android-kiosk.sh android/app/build/outputs/apk/release/app-release.apk
```

Kiosk 安装会更改设备默认桌面。厂商限制系统命令时，应在设备设置或 MDM 中选择默认 HOME。连接多台设备时，通过 `ANDROID_SERIAL` 指定目标序列号。

首次运行依次完成：

1. 主屏选择 PRIMARY，设置 6–12 位工程 PIN。
2. 在工程管理中填写 HA 地址、长期访问令牌、网关状态实体及灯实体。HA 地址必须能从主屏访问，不能使用开发机的 `localhost` 代替。
3. 运行网关与灯联检，核对实体能力、在线状态和命令回传。
4. 副屏选择 SECONDARY，使用主屏生成的一次性码完成配对。
5. 验证开关、亮度、色温、灯效及两屏状态同步；按设备实际支持能力验收。

主副屏应处于可互通的受信局域网。当前小米云控制链路还依赖公网连接；界面出现状态缓存不代表设备可控。

## 7. 检查与测试

在软件工程目录执行：

```bash
pnpm check
pnpm exec playwright install chromium
pnpm e2e
```

`pnpm check` 包括静态检查、格式检查、契约与许可证校验、交付边界检查、类型检查、单元测试、生产构建和包体检查。E2E 使用隔离测试服务；运行前关闭占用测试端口的真机调试服务，避免复用错误的服务。Linux CI 使用 `pnpm exec playwright install --with-deps chromium`。

Android 测试在 `android/` 目录执行：

```bash
./gradlew testDebugUnitTest
./gradlew connectedDebugAndroidTest
```

第二条需要已连接的 Android 真机或模拟器。仓库 CI 当前覆盖 Web 检查、构建和 E2E，不自动生成正式签名 APK。自动测试及截图不能代替网关、灯具和采购屏的实机验收。

## 8. 资料与维护

| 文档                                                         | 内容                                      |
| ------------------------------------------------------------ | ----------------------------------------- |
| [工程说明](smart-home-console/README.md)                     | 工程入口与功能概览                        |
| [Android 运行时](smart-home-console/android/README.md)       | APK、HA 适配、Kiosk、资源更新与数据库备份 |
| [架构说明](smart-home-console/docs/ARCHITECTURE.md)          | 控制域、服务、接入和安全边界              |
| [交付与运维手册](smart-home-console/docs/DELIVERY_MANUAL.md) | 现场安装、工程管理、升级和回滚            |
| [合同台账](smart-home-console/docs/CONTRACT_LEDGER.md)       | 合同条款与验证状态                        |
| [开发任务](smart-home-console/docs/TODO.md)                  | 待办事项和完成定义                        |
| [合同与采购](项目资料/合同与采购/)                           | 原始需求及硬件采购表                      |
| [技术方案](项目资料/技术方案/)                               | 技术方案 PDF                              |
| [调研报告](项目资料/调研报告/)                               | HA 可行性、设备兼容与双屏落地分析         |

Git 仅纳入明确发布的三个 APK 和校验文件；其他构建缓存、测试截图、日志及本机运行凭据保持忽略。新增安装包时，应核对版本、签名、能力与校验值，再更新 APK 白名单、校验文件及本 README。

Home Assistant 需单独部署并配置 Xiaomi Home 集成。此前的 Mac 部署位于 `~/.local/share/smart-lab-home-assistant/`，含运行凭据和备份，不随本仓库分发，也不是克隆项目后自动创建的服务。现场 HA 地址、管理员账户、Token、签名私钥和备份应由部署方独立保管。
