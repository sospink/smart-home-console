# 智慧家居双屏动效与交互调研方案

日期：2026-07-22  
适用环境：Vue 3、Android 11/12 WebView、RK3568、2GB 内存、1920×1080 主屏、1024×600 副屏。

## 结论

本项目不适合把全屏粒子、持续扫描线、复杂 WebGL 背景当作常态。最佳方向是：

> 设备有生命、命令有能量流、场景有执行轨迹、双屏有同步反馈。

视觉可以炫，但每个动效必须对应 `pending / confirmed / failed / timeout`、设备状态或场景执行进度。推荐优先使用 CSS + Web Animations API；需要复杂编排时引入 Motion for Vue；Rive 仅用于一个核心视觉锚点；不建议首版引入 Three.js/Pixi.js。

## 推荐的 10 个效果

| #   | 效果                | 触发时机                 | 状态语义               | 技术建议                                    | 性能  |
| --- | ------------------- | ------------------------ | ---------------------- | ------------------------------------------- | ----- |
| 1   | 触控能量涟漪        | 按下设备/场景            | 已接收触控             | CSS 伪元素 + `transform/opacity`            | 低    |
| 2   | 命令能量束          | pending                  | 请求从卡片流向右侧详情 | SVG path + WAAPI；仅执行时播放              | 低-中 |
| 3   | 状态确认波          | confirmed                | 设备已真实确认         | 卡片中心向外扩散一圈绿色软光                | 低    |
| 4   | 失败回弹与红色断流  | failed/timeout           | 控制未完成             | 2–3 px 横向回弹 + 能量束中断                | 低    |
| 5   | 场景执行时间线      | 场景运行                 | 第 N/总动作、逐项结果  | SVG 路径描边 + 节点依次点亮                 | 低    |
| 6   | 设备卡→详情共享转场 | 选择设备                 | 保持对象连续性         | Motion `layoutId` / FLIP                    | 中    |
| 7   | 数字滚轮            | 亮度、音量、窗帘变化     | 实时状态变化           | 等宽数字 + 纵向 translate                   | 低    |
| 8   | 设备物理反馈        | 开灯、开帘、音乐         | 设备类型特有状态       | 灯具亮度光晕；窗帘布片位移；音乐频谱 3 秒   | 低    |
| 9   | 双屏同步闪签        | WebSocket 收到另一屏更新 | 状态来自另一终端       | 更新值旁出现“主屏/副屏同步”光点，900ms 消退 | 低    |
| 10  | 告警雷达聚焦        | 水浸/门磁/离线           | 引导注意问题设备       | 背景轻压暗，目标卡红色双脉冲后停止          | 低    |

## 三套可选方案

### A. 稳妥交付版（推荐先做）

不增加第三方依赖，全部使用 CSS、SVG 与 Web Animations API。

- 触控涟漪；
- pending 能量束；
- confirmed 确认波；
- failed/timeout 回弹；
- 场景执行时间线；
- 数字滚轮；
- 双屏同步闪签；
- 告警聚焦。

优点：离线、包体小、兼容 Android WebView、容易降级。预计即使 15 张设备卡同时显示，也只让当前操作对象运动。

### B. 高级产品版（最适合本项目）

在 A 的基础上增加 Motion for Vue，专门负责：

- 设备卡到详情面板的共享元素转场；
- 房间筛选、分页、场景切换的 FLIP 布局动画；
- 触控 press spring；
- 右侧详情能力控件的分批入场。

Motion 官方支持 Vue、spring、手势、`layout` 和 `layoutId`。当前 npm 包为 MIT；解包体积约 0.68 MB。只使用 DOM/SVG 动画，不需要 WebGL。

### C. 展厅演示版

在 B 的基础上只加一个 Rive 视觉锚点：右侧场景状态核心或副屏系统状态盾牌。

- 状态机输入：`idle / running / success / partial / failure / alert`；
- running 显示能量环汇聚；success 收束成绿色确认；failure 出现红色裂隙；
- 不在每张设备卡放 Rive；最多同时运行 1 个实例；
- 静止时必须暂停或让状态机 settle。

Rive Web 提供 Canvas 与 WebGL2 渲染器、WASM、状态机和暂停/停止；其文档说明 settled 状态会停止逐帧推进。Canvas 包较小，WebGL2 画质/性能更好，但必须在 RK3568 真机上 A/B 测试后选定。

## 页面级组合

### 场景页

1. 点击场景卡：卡片下压 0.97，图片轻微推进；
2. 右侧核心从 idle 进入 running；
3. 一条青色能量线依次连接 5 个联动对象；
4. 每个动作 confirmed 后节点转绿；partial 保持金色；failed 转红并在失败节点停止；
5. 全部结束后只播放一次 450ms 的确认波，不持续发光。

### 设备页

1. 选择设备：产品图从卡片共享转场到详情区；
2. 开关触控：涟漪 → pending 蓝色行波 → confirmed 绿色收束；
3. 亮度变化：数字滚轮过渡，灯具光晕与亮度数值同步；
4. 窗帘：布片位置对应开合百分比，不做无意义旋转；
5. 传感器：平时静止，事件发生时只脉冲两次。

### 副屏

- 场景按钮按压回弹；
- 三个快捷控制采用数字滚动和确认波；
- 主屏更新时出现 900ms 同步闪签；
- 系统状态盾牌只有连接/告警变化时动作，平时静止。

### 管理端

- 网关拓扑连线在状态变化时流动 1.2 秒；
- 告警状态使用明确的发生 → 确认 → 恢复转场；
- 审计新增记录从顶部滑入，不闪烁整个表格。

## 不推荐的效果

- 全屏常驻粒子、星空、Matrix 字符雨；
- 大面积 backdrop-filter blur 动画；
- 持续扫描线、持续噪点、持续旋转光环；
- 每张卡片都播放 Lottie/Rive；
- Three.js 3D 房屋作为日常控制主页；
- 鼠标跟随和只对 hover 生效的交互；
- 动画结束前锁死触控；
- 先显示成功动画、后等待真实设备确认。

这些效果要么与业务无关，要么在 RK3568 WebView 上增加 GPU、内存和掉帧风险，也会弱化告警的视觉优先级。

## 技术选型

| 技术                   | 推荐度 | 适合                                    | 不适合             | 当前信息                                           |
| ---------------------- | -----: | --------------------------------------- | ------------------ | -------------------------------------------------- |
| CSS transforms/opacity |  ★★★★★ | press、入场、确认波、数字滚动           | 复杂跨组件编排     | 零依赖；官方性能指南推荐优先动画 transform/opacity |
| Web Animations API     |  ★★★★★ | 可取消的命令时序、SVG 路径、同步控制    | 复杂共享布局       | 原生 API，可统一播放/暂停/取消                     |
| Motion for Vue         |  ★★★★☆ | spring、gesture、stagger、layoutId/FLIP | 复杂矢量角色动画   | MIT；Vue 官方用法完整；约 0.68 MB 解包             |
| Rive                   |  ★★★☆☆ | 单个状态核心、互动状态机                | 大量并发实例       | MIT runtime；Canvas/WebGL2/WASM；包约 5–6 MB 解包  |
| Lottie Web             |  ★★☆☆☆ | 一次性插画动画、启动页                  | 与实时状态深度绑定 | MIT；AE JSON；包较大，当前解包约 25 MB             |
| Anime.js               |  ★★★☆☆ | SVG path、timeline、轻量编排            | 共享布局           | MIT；约 2.1 MB 解包                                |
| GSAP                   |  ★★☆☆☆ | 复杂时间线和路径                        | 当前需求与授权简化 | 功能强但当前 npm 标示专用标准许可，非首选          |
| Three.js/Pixi.js       |  ★☆☆☆☆ | 独立展厅/屏保                           | 日常控制台         | 包体、GPU 与工程复杂度均不划算                     |

## 性能与验收边界

- 日常界面同时活跃动画对象不超过 6 个；
- 持续动画只允许 1 个，并在页面隐藏、应用后台或静止状态暂停；
- 优先动画 `transform` 与 `opacity`；避免动画 blur、box-shadow、width、height、top、left；
- 点击到视觉反馈小于 80ms；命令 pending 动画不得伪装 confirmed；
- 主屏目标 50–60 FPS，副屏最低 45 FPS；长任务单次不超过 50ms；
- Android WebView 真机记录 GPU/CPU/内存，至少持续运行 30 分钟；
- 支持 `prefers-reduced-motion`，并在设置中提供“动效：完整/精简/关闭”；
- 页面隐藏时通过 `visibilitychange` 暂停动画；
- 所有动效必须可被新命令取消，不能堆积播放队列。

## 推荐实施顺序

1. **P0 动效状态控制器**：从 command/execution/WebSocket 事件派生 motion state，杜绝固定成功；
2. **P0 触控涟漪 + pending/confirmed/failed 三态反馈**；
3. **P0 场景执行时间线**；
4. **P1 数字滚轮 + 灯/帘/音乐物理反馈**；
5. **P1 双屏同步闪签**；
6. **P1 Motion 共享元素转场**；
7. **P2 真机性能通过后，再评估单个 Rive 状态核心**；
8. **P3 仅在屏保/展厅模式评估 WebGL 粒子或 3D 户型**。

## 参考资料

- Motion for Vue animation、gesture、layout 官方文档：`motion.dev/docs/vue-*`
- Rive Web runtime、state machine、Canvas vs WebGL2 官方文档：`rive.app/docs/runtimes/web/*`
- MDN Web Animations API 与 `prefers-reduced-motion`
- web.dev 高性能 CSS 动画指南
- Lottie Web 官方站与 GitHub
