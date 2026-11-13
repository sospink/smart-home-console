# Android 正式运行时

同一 APK 在首次启动时选择主屏或副屏角色：

- 主屏：启动 `EdgeForegroundService` 和本地 Ktor EdgeCore，从 APK 内加载 `/primary` UI；
- 副屏：通过 mDNS `_smartlab-edge._tcp` 或固定 IP 连接主屏，从同一 APK 加载 `/secondary` UI。

## 构建

需要 JDK 17+ 和 Android SDK 35。`app:preBuild` 会自动运行 panel-ui 生产构建并复制离线资源。

```bash
export JAVA_HOME="/path/to/jdk-17-or-newer"
export ANDROID_HOME="/path/to/android-sdk"
./gradlew :app:assembleDebug
```

Debug APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

## Home Assistant 真机适配

正式 APK 内置 `gateway-home-assistant`，通过 HA 官方 Xiaomi Home 控制本台 DMWG03LM 下的已映射设备。管理员在主屏工程后台填写 HA 地址、长期令牌、网关实体和灯实体；原生桥验证管理会话后把 JSON 凭据以 `gateway-main` 引用写入 `PersistentSecretStore`，令牌不进入 Room、前端草稿、备份、日志或诊断包。EdgeCore 重启后注入该适配器，并将 `living-main-light` 绑定为副屏灯光槽位。

该路线是 HA/小米云依赖，不是网关局域网控制。适配器启动时从实体读取可写能力：开关、亮度、`supported_color_modes`、真实色温上下限及 `effect_list`，并写入 EdgeCore capability 表；主副屏据此组合通用控件，不按型号硬编码。服务调用成功后仍会轮询实体，只有开关/亮度/色温/灯效达到目标才发可信确认；超时和 HTTP 错误失败关闭。HA 提供的派生 RGB 值不代表设备支持 RGB 控制。第二台主屏必须单独配置本台实体。

## 工控屏 Kiosk 安装

Android 10+ 会限制普通应用从 `BOOT_COMPLETED` 直接拉起界面，因此正式部署必须把同一 APK 设为默认 HOME/Kiosk 启动器；`BootReceiver` 仍负责主屏 EdgeCore 服务自启。连接 ADB 后在仓库根目录执行：

```bash
ADB=/path/to/adb ./scripts/install-android-kiosk.sh
```

脚本会安装 APK、设置默认 HOME 并验证默认启动器。若设备厂商禁用 `cmd package set-home-activity`，须在屏幕的系统设置或厂商 MDM 中手工选择“知境”为默认桌面。禁止仅依靠后台广播拉起 Activity。

Release 签名参数不得进入仓库，通过开发机 `~/.gradle/gradle.properties` 或 CI 密钥注入：

```properties
SMART_LAB_KEYSTORE_FILE=/secure/path/smart-lab-release.jks
SMART_LAB_KEYSTORE_PASSWORD=...
SMART_LAB_KEY_ALIAS=smart-lab
SMART_LAB_KEY_PASSWORD=...
SMART_LAB_UI_UPDATE_PUBLIC_KEY=MCowBQYDK2VwAyEA...  # Ed25519 X.509 公钥的 Base64；不得放私钥
SMART_LAB_VERSION_CODE=2                        # 每次升级必须递增
SMART_LAB_VERSION_NAME=0.1.1
```

同签名基线/升级 APK 可在 API 31+ 设备上验证安装、升级、降级回滚和再升级：

```bash
ADB=/path/to/adb ./scripts/verify-android-apk-lifecycle.sh app-v1.apk app-v2.apk
```

## 签名 UI 资源更新

正式 APK 只信任构建时注入的 Ed25519 公钥。私钥必须留在离线交付机或 CI 密钥库，禁止进入仓库和 APK。生成更新包：

```bash
pnpm --filter @smart-lab/panel-ui build
pnpm ui-update:build -- 0.1.1 /secure/path/ui-update-private.pem output/panel-ui-0.1.1.signed.json
```

管理员在“配置备份 → 签名资源更新”粘贴该 JSON；系统先验签，再逐文件校验 SHA-256、大小和安全相对路径，全部成功后才原子激活。已配对副屏会用终端令牌查询主屏版本，仅在版本不一致时下载同一签名包，并在本机再次验签后激活；主屏回滚到旧签名版本或 APK 内置资源时副屏随下次连接同步。未注入公钥时入口明确禁用，不能以仅哈希校验替代签名。

## 双屏时间、版本与备份

- 两屏顶部时钟用主屏 `/health.serverTime` 计算偏移，网络中断时按最后偏移继续走时；采购屏仍需验证系统时区/NTP 策略。
- 主屏启动时登记自身 `BuildConfig.VERSION_NAME`，副屏在配对及后续鉴权请求中上报版本、地址和最后在线时间。
- 主屏 EdgeCore 使用 SQLite `VACUUM INTO` 每 24 小时创建一致性数据库快照并保留最近 7 份；新快照须由独立只读连接通过 `PRAGMA quick_check`，记录 schema/验证时间/SHA-256 后才可导出，文件变化会重新验证。创建前预留当前数据库 2 倍（最低 16 MB）的产物空间和额外 256 MB 运行空间，后台显示容量风险，空间不足返回 507。管理员可手工创建，并由 APK 进程流式导出、通过 `MediaStore` 原子写入 `Download/SmartLab`。Keystore 密钥与密文凭据不进入数据库备份，运行中不提供数据库覆盖恢复。
- 管理员可查看数据库/WAL 实际占用、审计/告警/命令/场景执行四类记录总数与最早时间，并依据有效快照正增长中位速率获得日增长和 256 MB 保留线预测。该 API 只读；所有正式数据域默认禁止自动删除，样本不足时不输出虚假趋势。

## 当前边界

- 正式 EdgeCore 默认不包含模拟接口；
- 没有真机 Adapter 时，设备写操作明确失败，不固定返回成功；
- Token/Key 和终端配对令牌只能通过 `SecretStore` 写入 Android Keystore；
- 管理员可在后台验证当前 PIN 后轮换为 6–12 位数字；服务先写 Keystore，再切换 PBKDF2 哈希并吊销全部旧管理会话，失败不改变当前凭据；
- `gateway-home-assistant` 已用于当前最小真机闭环；`gateway-dmwg03lm` 本地模块仍需合法、稳定的本地接口与单独实机验证后再建立，不能用 HA 云链路冒充。
