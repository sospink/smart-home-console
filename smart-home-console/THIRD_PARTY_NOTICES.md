# 第三方软件与许可说明

生成日期：2026-07-24。锁定版本以 `pnpm-lock.yaml` 和 `android/gradle/libs.versions.toml` 为准。

## APK 运行时直接依赖

| 组件                                          | 版本                             | 许可       |
| --------------------------------------------- | -------------------------------- | ---------- |
| Vue / Vue Router                              | 3.5.40 / 5.2.0                   | MIT        |
| Pinia                                         | 4.0.2                            | MIT        |
| VueUse                                        | 14.2.1                           | MIT        |
| Naive UI                                      | 2.44.1                           | MIT        |
| Lucide Vue Next                               | 1.0.0                            | ISC        |
| AndroidX Core / Activity / WebKit / Lifecycle | 1.15.0 / 1.10.1 / 1.13.0 / 2.8.7 | Apache-2.0 |
| AndroidX Room                                 | 2.7.0                            | Apache-2.0 |
| Ktor Server                                   | 3.1.1                            | Apache-2.0 |
| Kotlinx Coroutines / Serialization            | 1.10.1 / 1.8.0                   | Apache-2.0 |
| Google Tink Android                           | 1.23.0                           | Apache-2.0 |

Web 端传递生产依赖的已批准许可集为 MIT、Apache-2.0、ISC、BSD-2-Clause、BSD-3-Clause 和 MPL-2.0。执行 `pnpm license:check` 会根据当前锁文件重新扫描；出现未审核许可时构建门禁失败。

## 交付边界

- 项目代码和 APK 中未包含小米官方私有 SDK、网关 Token/Key、小米账号数据或 `openmiio_agent` 二进制。
- Playwright、TypeScript、Vite、ESLint 等仅用于开发/测试，不随生产 APK 交付。
- 各依赖的完整许可文本以锁定包和 Gradle/Maven 产物内的 LICENSE/NOTICE 为准；发布时应随安装包或交付介质保留本文件。
