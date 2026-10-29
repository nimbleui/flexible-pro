# 企业级低代码插件平台设计文档

> 版本：v2.1 Enterprise · 2026-10-28  
> 技术栈：Vue 3 + TypeScript + pnpm Monorepo + Vite  
> 核心思想：借鉴 cordis（Koishi 生态的插件内核）的 Context 树、服务注入、依赖驱动生命周期、effect 自动回收、isolate / intercept。  
> 文档结构：Part I 内核与插件机制；Part II 画布插件化；Part III 企业级平台能力；Part IV 实现基线、交付与验收。  
> v2 主要变化：① 增加控制面/数据面、租户、权限、审计、供应链、隔离、SLO、合规与私有化；② 增加画布微内核，缩放/平移/节点缩放/节点旋转/吸附/辅助线/网格/标尺等全部拆为独立画布插件；③ 明确“画布能力是插件，不是普通 Vue 组件”，覆盖层组件只是插件的一部分。  
> v2.1 修正：① 认证等级与执行位置拆成两个维度，增加 Verified Inline UI；② 拆分 App/Editor/Canvas Context，Realm 一等化；③ 内部事件隔离、ServiceGrant、服务 apiVersion；④ 画布 keyboard/contextmenu、图层命中、canvasFeatures 激活、设置桥、错误熔断；⑤ 控制面后端栈、服务端执行、协作边界与路线图校准。

---

## 目录

### Part I 内核与插件机制

- [0. 结论先行](#0-结论先行)
- [1. 目标、非目标与企业级质量属性](#1-目标非目标与企业级质量属性)
- [2. 从 cordis 借什么，调整什么](#2-从-cordis-借什么调整什么)
- [3. 总体架构](#3-总体架构)
- [4. 内核设计](#4-内核设计)
- [5. 装载器与贡献点](#5-装载器与贡献点实现装即用)
- [6. 契约层与核心服务](#6-契约层与核心服务)
- [7. 共享什么，不共享什么](#7-共享什么不共享什么)
- [8. Vue 3 宿主集成](#8-vue-3-宿主集成)
- [9. Monorepo 工程结构](#9-monorepo-工程结构)

### Part II 画布插件化

- [10. 画布微内核：为什么画布能力也要插件化](#10-画布微内核为什么画布能力也要插件化)
- [11. 画布内核设计](#11-画布内核设计)
- [12. 画布插件契约](#12-画布插件契约)
- [13. 画布功能拆解：节点缩放、节点旋转、画布缩放、吸附、辅助线](#13-画布功能拆解节点缩放节点旋转画布缩放吸附辅助线)
- [14. 画布插件示例、冲突与性能](#14-画布插件示例冲突与性能)

### Part III 企业级平台能力

- [15. 企业级总体架构与部署拓扑](#15-企业级总体架构与部署拓扑)
- [16. 租户、身份、权限与审计](#16-租户身份权限与审计)
- [17. 配置、环境与发布治理](#17-配置环境与发布治理)
- [18. 插件供应链与市场治理](#18-插件供应链与市场治理)
- [19. 运行时隔离与安全加固](#19-运行时隔离与安全加固)
- [20. 可观测性、SLO 与运维](#20-可观测性slo-与运维)
- [21. 数据治理、合规与灾备](#21-数据治理合规与灾备)
- [22. 企业工程体系、认证与支持](#22-企业工程体系认证与支持)

### Part IV 实现基线、交付与验收

- [23. 安全与权限实现基线](#23-安全与权限实现基线)
- [24. 性能预算与容量基线](#24-性能预算与容量基线)
- [25. 版本、兼容与 LTS](#25-版本兼容与-lts)
- [26. 关键流程时序](#26-关键流程时序)
- [27. 交付路线](#27-交付路线)
- [28. 架构决策记录（ADR）](#28-架构决策记录adr-摘要)
- [29. 附录：从零写一个插件](#29-附录从零写一个插件)
- [30. 企业级验收清单](#30-企业级验收清单)

### 规范来源

文档很长，以下主题以标注章节为准，其他章节是解释或实现基线，不再各自定义一套口径：

| 主题                  | 权威章节     | 其他章节             |
| --------------------- | ------------ | -------------------- |
| 内核生命周期/服务模型 | §4           | §5-§9 是上层用法     |
| 画布插件契约          | §11、§12     | §13/§14 是拆解与示例 |
| 认证等级 × 执行位置   | §18.5、§19.2 | §23 是代码实现基线   |
| SLO                   | §20.5        | §24 是代码级性能预算 |
| 版本与 LTS            | §25.4        | §22.5 是发布流程     |
| 企业 Manifest         | §5.8         | §18 是治理流程       |

---

## 0. 结论先行

企业级不是把内核做大，而是把“租户、权限、供应链、隔离、可观测、合规”放到内核之上。内核保持小而稳定，企业能力通过控制面、服务包装和治理流程实现。

这个平台由三层插件化共同实现：

1. **应用插件内核**：Context 树、服务表、依赖调度、副作用回收、类型化事件、配置解析。决定“一个功能包如何安全地装卸”。
2. **画布微内核**：视口、场景、交互管线、图层、事务。缩放、平移、节点缩放/旋转、吸附、辅助线、网格、标尺、选择、拖拽、小地图各自是独立画布插件。
3. **企业控制面**：租户、SSO/RBAC、策略、审计、插件注册表、签名、灰度、配额、可观测。决定“谁能在哪个环境装哪个插件、能看到什么、能做什么”。

```
应用插件 = manifest（声明式贡献） + 可选 apply(ctx) + 懒加载模块
画布插件 = 交互处理器 + 覆盖层 + 命令 + 吸附提供者 + 设置项
内核     = Context 树 + Service 表 + 依赖调度 + EffectScope + EventBus + Config
控制面   = 租户/身份/策略/审计/注册表/发布/配额
```

企业级的“装即用”是**受治理的装即用**：签名验证、认证等级、租户白名单、权限交集、审计留痕全部通过后，插件入口才出现。未经批准的代码不会因为“装上了”就获得能力。

术语约定：

- **插件包**：一个 npm 包，对应一份 manifest。
- **插件实例**：`apply()` 的一次运行，拥有唯一 `PluginRecord.id`；同一个插件包可以有多实例。
- **服务**：挂在 Context 上的能力对象，如 `material`、`http`。
- **Realm**：文档级子 Context，拥有独立 service scope。
- **CanvasRealm**：文档 Realm 下的画布微内核，拥有独立的画布服务与插件树。
- **贡献点**：manifest 中声明的 UI / 运行时入口，如物料、面板、数据源。
- **激活**：加载插件代码并执行 `apply()`；声明式贡献不需要激活即可展示。
- **认证等级**：Platform / Verified / Community，决定插件能运行在哪个隔离层。

---

## 1. 目标、非目标与企业级质量属性

### 1.1 目标

1. **零宿主改动**：新增一个物料包、一个数据源、一个面板、一个画布能力，只新增包和清单，不修改设计器/运行时源码。
2. **生命周期可预测**：插件在依赖满足时启动，依赖消失时自动停用，卸载时所有副作用自动回收。
3. **故障隔离**：单个插件启动失败、UI 崩溃、物料加载失败、画布手势异常，不拖垮整个设计器。
4. **设计时与运行时统一**：同一套物料、数据源、动作、画布能力描述，既能给设计器配置，也能给运行时执行。
5. **类型安全**：服务、事件、配置都有 TypeScript 契约；运行时通过声明式清单发现，编译期通过 declaration merging 校验。
6. **多文档 / 多租户**：应用、文档、画布三层 Realm，配合租户/工作区/环境层级做状态与权限隔离。
7. **可分发**：支持构建期内置、私有注册表、运行时安装、离线包四种分发方式。
8. **受治理的扩展**：安装 ≠ 启用；签名、认证等级、租户白名单、策略审批、权限交集全部通过后，贡献才可见。
9. **可观测、可回滚、可禁用**：每个插件有健康度、错误率、激活耗时；支持灰度、N-1 回滚、Kill Switch。
10. **供应链可信**：制品不可变、签名、SBOM、构建来源、漏洞与许可证扫描缺一不可。
11. **数据可治理**：租户隔离、加密、数据驻留、保留与删除、审计留痕默认内建。

### 1.2 非目标

- **不是微前端框架**：只有 Platform 与通过 UI 评审的 Verified Inline 插件与宿主同 realm；其余 Verified/Community 默认沙箱。追求的是能力组合，不是跨团队构建隔离。
- **不承诺同 realm 的强安全隔离**：同 realm 的 JS 可以访问全局对象；Verified Inline 是受信任代码，不是沙箱。其他插件必须进 iframe/Worker/独立容器，这一点不能含糊。
- **不是通用 iPaaS**：平台聚焦“界面低代码 + 插件化扩展”，不承担企业所有系统集成、ETL、消息编排。
- **不是业务逻辑框架**：插件写业务，但业务状态不应塞进内核。
- **不追求插件之间完全解耦**：插件可以通过契约服务、事件协作，但不能直接 `import` 另一个插件。
- **不把安全责任全部转嫁给插件作者**：平台提供隔离、权限网关、审计与供应链控制；认证等级决定插件必须满足的基线。

### 1.3 企业级质量属性

下表中的数值是产品目标，不是当前实现承诺；最终以商业 SLA 与容量测试报告为准。

| 维度     | 目标                                                            | 主要设计手段                                   |
| -------- | --------------------------------------------------------------- | ---------------------------------------------- |
| 可用性   | 标准版 99.9%，企业版 99.95%                                     | 无状态数据面、多 AZ、外部会话、灰度与快速回滚  |
| 恢复目标 | 文档数据 RPO ≤ 5 min、RTO ≤ 1 h；插件配置 RPO = 0               | Postgres PITR、对象存储版本化、配置中心多副本  |
| 安全     | 默认拒绝、最小权限、全链路审计                                  | SSO、RBAC/ABAC、策略即代码、权限网关、隔离层   |
| 合规     | SOC 2 Type II、ISO 27001、GDPR 可审计                           | 控制映射、审计留痕、数据驻留、DSAR、供应商管理 |
| 扩展性   | 万级租户、十万级文档、千级插件制品                              | 控制面/数据面分离、分区、缓存、CDN、配额       |
| 可运维性 | 变更可灰度、可回滚、可禁用；MTTR < 30 min                       | Kill Switch、N-1 制品、Runbook、SLO 告警       |
| 性能     | 打开文档到可编辑 p95 < 2 s；画布常规 60 fps，5000 节点 ≥ 55 fps | 画布微内核、单事件管线、rAF 批处理、懒加载     |
| 兼容性   | 内核 LTS 18 个月；破坏性变更提前 12 个月公告                    | 契约测试、兼容矩阵、能力标志、Codemod          |
| 成本     | 可按租户/插件归因                                               | 资源计量、配额、预算告警、成本分摊             |
| 数据隔离 | 跨租户零泄露                                                    | 行级安全、存储前缀、缓存命名空间、隔离测试     |

---

## 2. 从 cordis 借什么，调整什么

cordis 是本设计最重要的参照。它把“插件系统”收敛成了很少的几个概念：Context 树、Service、inject/provide、effect 自动回收、isolate/intercept、类型化事件。

| cordis 机制      | 本平台的用法                              | 本平台的调整                                      |
| ---------------- | ----------------------------------------- | ------------------------------------------------- |
| Context 树       | 插件作用域、事件归属、副作用归属          | 增加 Realm（文档）与 CanvasRealm（画布）          |
| Service 注入     | 能力发现与依赖声明                        | **显式 inject**，不做隐式响应式追踪               |
| 依赖驱动生命周期 | 服务缺失 → `pending`；服务移除 → 自动停用 | 增加 `failed`、`unload`、`restart`、重试与诊断    |
| effect 自动回收  | 事件、定时器、注册表、UI 贡献统一回收     | 增加 `AbortSignal`，覆盖异步任务                  |
| isolate          | 预览 mock、租户覆盖、文档 Realm           | 增加带过滤器的隔离层                              |
| intercept        | 子树级配置覆盖                            | 用于插件配置与测试环境覆盖                        |
| 事件             | 命令、钩子、schema 转换管线               | 增加 `waterfall` / `bail` / `serial` / `parallel` |

### 2.1 为什么用显式 inject，而不是 cordis 的响应式追踪

cordis 2 会通过响应式系统追踪插件实际访问了哪些服务，从而实现更细粒度的依赖重载。本平台选择显式 `inject`，原因：

- 低代码平台插件数量可能上百，隐式依赖会让“为什么这个插件被重启”难以排查；
- 显式声明可以直接生成依赖图、安装提示、循环依赖检测；
- 显式依赖更容易做权限与能力审计；
- 运行时行为更确定，跨 Vue / Worker / Node 都不依赖响应式运行时。

代价是插件作者要写 `inject`。这个成本可控，而且可以用 ESLint 规则约束。

---

## 3. 总体架构

### 3.1 分层与依赖方向

```
控制面（服务端）
  @lc/control-plane：租户 / 身份 / 策略 / 注册表 / 审计 / 发布 / 配额
        │ 签名 manifest、策略包、配置、灰度指令
        ▼
数据面（浏览器 / 边缘 / 客户 VPC）
  apps/designer、apps/player、apps/admin
        │
        ├── @lc/vue          宿主适配：ctx → Vue、Slot、错误边界
        ├── @lc/loader       清单扫描、贡献注册、激活、签名校验、权限、远程安装
        ├── @lc/canvas       画布微内核：视口、交互管线、图层、事务
        │
        ├── @lc/plugin-*       应用功能插件 / 物料插件
        ├── @lc/canvas-plugin-* 画布能力插件（缩放、旋转、吸附、辅助线……）
        │
        ├── @lc/service-*    核心能力插件（物料、数据源、历史……）
        │
        └── @lc/contracts    纯类型契约 + 常量（无运行时副作用）
                 │
                 └── @lc/kernel   内核（无 Vue、无 DOM、无 Node API）
```

强制规则：

- `@lc/kernel` 不依赖任何业务包，甚至不依赖 Vue。
- `@lc/contracts` 只放类型、事件名、插槽名、权限字符串，尽量零运行时代码。
- **插件不能 import 另一个插件**，只能通过 `ctx.get('service')` / `ctx.on('event')` 协作。
- **应用不能直接 import 具体插件**（测试和内置预设除外），只能通过 loader 的清单发现。
- **控制面不进入浏览器**：数据面只消费签名后的 manifest、策略包和配置；新安装/提权操作必须回源控制面。
- **画布微内核不认识业务**：它只提供坐标、事件、图层、事务；缩放、旋转、吸附、辅助线都是画布插件。
- `@lc/ui` 只服务设计器外壳，不进入运行时包；物料组件自带样式，不依赖设计器 UI。

### 3.2 四类插件

| 类型     | 典型例子                                          | 形态                                         | 是否需要 apply |
| -------- | ------------------------------------------------- | -------------------------------------------- | -------------- |
| 能力插件 | http、storage、material registry、history         | 提供 Service                                 | 是             |
| 功能插件 | 大纲面板、快捷键、导出 Vue、schema 校验           | apply 中注册命令/事件/贡献                   | 是             |
| 物料插件 | Button、Chart、StatCard、业务组件包               | manifest 声明 + 懒加载组件模块               | 通常不需要     |
| 画布插件 | 视口缩放、节点缩放/旋转、吸附、辅助线、网格、标尺 | 向 CanvasRealm 注册交互/图层/命令/吸附提供者 | 是             |

纯物料插件可以完全没有 `main`，只有 manifest 和一个 ESM 组件模块。这是“装即用”的关键：装载器注册元数据，渲染器按需加载组件。

常见功能与插件形态的映射：

| 新功能                | 插件形态   | 安装后自动出现的位置 |
| --------------------- | ---------- | -------------------- |
| 新增一个按钮/卡片物料 | 物料插件   | 物料面板、画布       |
| 接入一整个图表库      | 物料插件包 | 物料面板             |
| 接入 GraphQL          | 数据源插件 | 数据源类型选择器     |
| “一键美化”            | 命令插件   | 工具栏、命令面板     |
| AI 助手面板           | 功能插件   | 右侧面板插槽         |
| 导出 React            | 导出器插件 | 导出菜单             |
| 企业主题              | 主题插件   | 主题切换             |
| 新的登录方式          | 平台插件   | 登录页               |
| 一套快捷键            | 命令插件   | 全局快捷键           |

### 3.3 Realm：应用级与文档级

低代码平台天然存在两种状态：

- **应用级**：物料库、主题、i18n、HTTP、存储、数据源类型。所有文档共享。
- **文档级**：当前 schema、选中节点、撤销栈、画布拖拽、校验标记。每个打开的文档独立。

因此 Context 树分三层：

```
AppContext（应用根）
├── 全局服务：material / setter / dataSource / http / i18n / theme / storage / telemetry
├── EditorRealm #1（文档 A，独立 service scope）
│     ├── 文档服务：history / selection / document / designer
│     ├── CanvasRealm（画布微内核，独立 service scope）
│     │     ├── 画布服务：viewport / interaction / layers / measure / snap / transaction
│     │     ├── canvas-zoom、canvas-pan、canvas-resize、canvas-rotate
│     │     └── canvas-snap、canvas-guides、canvas-grid、canvas-rulers
│     └── 文档级应用插件
├── EditorRealm #2（文档 B）
└── PlayerRealm（预览/发布运行时，独立 mock 与数据源缓存）
```

Realm 由 `workspace.createEditorRealm()` 创建：底层创建一个子 Context 和**新的 service scope**，但拥有自己的生命周期记录，不是裸 `fork()`。Realm 内提供的 `history` 会遮蔽应用级同名服务，仅对 Realm 子树可见；Realm 的 `dispose` 由 workspace effect 托管，关闭文档或卸载父插件都会级联销毁。

CanvasRealm 是 EditorRealm 内再 `fork()` 的一层，隔离视口、交互管线、图层和事务。关键区分：

- **视口状态**是服务（`ctx.canvas.viewport`），必须长期存在，缩放/旋转/吸附插件只是它的操作者。
- **缩放交互**是插件（`canvas-zoom`），负责滚轮、快捷键、按钮、fit 命令；卸载它不会丢失当前视口状态。
- **节点缩放/旋转**是插件（`canvas-resize` / `canvas-rotate`），负责手柄、手势与事务提交；卸载后节点变换能力消失，但文档数据仍可正常渲染。
- **吸附**是服务 + 提供者插件：`canvas-snap` 提供吸附引擎和设置，`snap-grid`、`snap-elements`、`snap-guides` 提供候选点；`canvas-guides` 只负责把吸附结果画成辅助线。

这样每个画布能力都能独立装卸，而不会各自创建一张 canvas、各自监听指针事件、各自维护一套坐标变换。

### 3.4 一次启动的时序

```
createLowcodeApp()
  ├─ 控制面客户端：拉取租户/环境配置、签名策略包、插件允许清单（带缓存）
  ├─ 安装平台预设（schema / material / setter / dataSource / action / command / history...）
  ├─ loader.scanManifests()
  │    ├─ 校验 manifest / engine / 签名 / 认证等级
  │    ├─ 策略检查（租户、环境、白名单、配额）
  │    ├─ 把已批准的声明式贡献分发给注册表（不执行插件代码）
  │    └─ 写入审计
  ├─ loader.activate('onStartup')
  │    ├─ import(plugin.main)
  │    ├─ runtime.load(ctx, plugin, config)
  │    └─ apply() 注册服务/命令/事件
  ├─ app.mount(DesignerShell)
  ├─ 打开文档 → EditorRealm
  │    └─ CanvasRealm + 画布预设 + 画布插件
  └─ <Slot name="designer.leftPanel" />
        └─ 用户打开面板 → loader.ensureModule() → 加载面板组件
```

对应代码大致是：

```ts
const lc = createLowcodeApp({ tenantId, workspaceId, environment: 'production' })
lc.plugin(presetDesigner) // 普通插件：内部按序挂载核心服务

const control = lc.require<ControlPlaneClient>('controlPlane')
// 拉取签名策略、允许清单、配置；读操作可 fail-static，安装/提权必须回源
await control.sync()

const loader = lc.require<LoaderService>('loader')
await loader.loadManifests(manifests) // 只注册通过策略与签名校验的元数据/贡献
await loader.activateStartup() // 执行 onStartup 插件

createVueApp(Designer).use(createLowcodePlugin(lc)).mount('#app')
```

宿主只认识 `presetDesigner`、`manifests` 和插槽；具体功能插件不在宿主的 import 图里。

---

## 4. 内核设计

内核的目标不是“大而全”，而是**把插件的生死、依赖、副作用讲清楚**。建议控制在 1500～2500 行 TypeScript，零第三方运行时依赖。

### 4.1 最小概念模型

| 概念             | 职责                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `Context`        | 插件运行上下文：读服务、注册服务、监听事件、创建子插件、持有 effect scope |
| `PluginRecord`   | 一个插件实例的元数据：id、状态、配置、依赖、父子关系、错误                |
| `Service`        | 可被其他插件注入的能力对象，注册在 service scope 中                       |
| `EffectScope`    | 逆序回收副作用：事件、定时器、注册表项、服务、UI 贡献                     |
| `EventBus`       | 类型化事件，支持 emit / serial / parallel / bail / waterfall              |
| `PluginRuntime`  | 依赖检查、激活、停用、卸载、重启、调度                                    |
| `ServiceScope`   | 服务解析链，支持 Realm 与 isolate 的遮蔽                                  |
| `ConfigResolver` | schema 默认值 → 实例配置 → intercept → 校验                               |

### 4.2 内核包结构

```
packages/kernel/src/
├── types.ts        # PluginDefinition / PluginRecord / Events / Disposable
├── effect.ts       # EffectScope
├── events.ts       # EventBus
├── context.ts      # Context / ServiceScope / provide / isolate / intercept
├── service.ts      # Service 基类
├── config.ts       # 配置合并与校验
├── runtime.ts      # PluginRuntime 状态机与调度
└── index.ts
```

### 4.3 Context 与服务解析

Context 的核心不变量：

1. **一个插件一个 Context**，但默认与父插件共享 service scope，所以服务对兄弟插件可见。
2. **`fork()` 创建新 scope**，用于 Realm 和 isolate；子 scope 只在自身提供过服务时遮蔽父级。
3. **`get()` 沿 scope 链向上查找**，找不到返回 `undefined`；`inject` 保证启动时一定存在。
4. **`provide()` 只检查当前 scope 是否冲突**，跨层同名是合法的“遮蔽”，不是错误。
5. **所有监听、服务、定时器都挂在当前 Context 的 EffectScope 上**，Context 销毁即全部回收。

```ts
// packages/kernel/src/context.ts
export interface Disposable {
  dispose(): void
}

interface ServiceEntry {
  /** 服务实例 */
  value: unknown
  /** 提供者，用于冲突提示和依赖图 */
  owner: PluginRecord
  /** 服务契约版本，如 1.0；loader 激活前校验 */
  apiVersion: string
}

interface ServiceScope {
  /** 上层作用域；Realm 与 isolate 通过它形成遮蔽链 */
  parent?: ServiceScope
  /** 本层注册的服务 */
  services: Map<string, ServiceEntry>
  /** null 表示不过滤；Set 表示本层只对列出的服务生效 */
  filter: Set<string> | null
}

export interface ServiceGrant {
  /** 被授权的插件 id；必须与 provider 的 record.name 一致 */
  pluginId: string
  /** 允许提供的服务名 */
  names: readonly string[]
  /** 是否允许覆盖同层现有提供者 */
  override?: boolean
}

export interface ProvideOptions {
  /** 是否覆盖同层现有提供者；需要 grant.override */
  replace?: boolean
  /** loader 签发的服务授权；核心插件由 createApp 签发 */
  grant?: ServiceGrant
  /** 服务契约版本，如 1.0；保留服务必填，loader 校验兼容性 */
  apiVersion?: string
}

/** 平台保留服务名：只能由平台核心或认证实现提供 */
export const RESERVED_SERVICES = new Set([
  'material',
  'setter',
  'renderer',
  'dataSource',
  'command',
  'action',
  'document',
  'history',
  'selection',
  'designer',
  'canvas',
  'snap',
  'http',
  'storage',
  'audit',
  'policy',
  'quota',
  'secrets',
  'flags',
  'telemetry',
  'loader',
  'contribution',
  'modules',
  'workspace',
])

export class Context {
  readonly root: Context
  readonly effects: EffectScope
  readonly signal: AbortSignal
  readonly intercepts = new Map<string, object>()
  /** 由 createApp 注入；只有 root 持有实际实例 */
  runtime!: PluginRuntime
  /** 只读服务观察；插件查询可选依赖用 */
  readonly services!: ServiceObserver
  /** 诊断接口；host/devtools 用，不能伪造生命周期 */
  readonly diagnostics!: Diagnostics
  /** 内核私有事件总线；root 创建，子 Context 继承，公共 API 不暴露 */
  private readonly internal: InternalEventBus
  /** 直接挂载在本 Context 下的子插件；Realm 靠它精确卸载子树 */
  readonly children = new Set<PluginRecord>()

  constructor(
    readonly parent: Context | null,
    readonly record: PluginRecord,
    readonly scope: ServiceScope,
    private readonly abort: AbortController,
    readonly bus: EventBus,
  ) {
    this.root = parent?.root ?? this
    // 子 Context 继承 root 的内部总线；插件拿不到
    this.internal = parent?.internal ?? new EventBus()
    this.signal = abort.signal
    this.effects = new EffectScope()
  }

  get<T>(name: string): T | undefined {
    for (let scope: ServiceScope | undefined = this.scope; scope; scope = scope.parent) {
      if (scope.filter && !scope.filter.has(name)) continue
      const entry = scope.services.get(name)
      if (entry) return entry.value as T
    }
    return undefined
  }

  require<T>(name: string): T {
    const value = this.get<T>(name)
    if (value === undefined) throw new Error(`[lowcode] 缺少服务 "${name}"`)
    return value
  }

  provide<T>(name: string, value: T, options: ProvideOptions = {}): Disposable {
    // 平台保留服务名：必须有 loader/平台签发的 grant
    if (RESERVED_SERVICES.has(name) && !options.grant?.names.includes(name)) {
      throw new Error(`[lowcode] 服务 "${name}" 为平台保留，需要 ServiceGrant`)
    }
    if (RESERVED_SERVICES.has(name) && !options.apiVersion) {
      throw new Error(`[lowcode] 保留服务 "${name}" 必须声明 apiVersion`)
    }
    if (options.grant && options.grant.pluginId !== this.record.name) {
      throw new Error(`[lowcode] ServiceGrant 不属于插件 "${this.record.name}"`)
    }
    // 隔离层内不允许提供未被隔离的服务，避免意外写穿到外层
    if (this.scope.filter && !this.scope.filter.has(name)) {
      throw new Error(`[lowcode] 服务 "${name}" 不允许在隔离层内提供`)
    }
    const existing = this.scope.services.get(name)
    if (existing && !options.replace) {
      throw new Error(`[lowcode] 服务 "${name}" 已被插件 "${existing.owner.name}" 提供`)
    }
    if (existing && options.replace && !options.grant?.override) {
      throw new Error(`[lowcode] 覆盖服务 "${name}" 需要 override grant`)
    }
    // 生产实现由 runtime 维护 service → dependent 边；有 active 消费者时拒绝 replace
    const entry: ServiceEntry = {
      value,
      owner: this.record,
      apiVersion: options.apiVersion ?? '0.0',
    }
    this.scope.services.set(name, entry)
    // internal 是内核私有总线，插件无法 emit；见 4.7.1
    this.internal.emit('internal/service', name, value, this.record)

    return this.effects.add(() => {
      // 只删除自己注册的那一条，避免覆盖场景误删后来者
      if (this.scope.services.get(name) !== entry) return
      this.scope.services.delete(name)
      this.internal.emit('internal/service', name, undefined, this.record)
    })
  }

  effect<T extends Disposable>(factory: () => T): T {
    return this.effects.effect(factory)
  }

  /** 可选依赖晚绑定；依赖齐全时执行 callback，消失时回收子 scope */
  inject(names: string[], callback: (ctx: Context) => void): Disposable {
    return this.root.runtime.inject(this, names, callback)
  }

  on<K extends keyof Events>(name: K, listener: Events[K], options?: EventOptions): Disposable {
    return this.effects.effect(() => this.bus.add(name, listener, options))
  }

  emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void {
    this.bus.emit(name, ...args)
  }

  plugin(definition: PluginDefinition, config?: unknown, options?: LoadOptions): PluginRecord {
    return this.root.runtime.load(this, definition, config, options)
  }

  /** 新建 service scope：用于文档 Realm、预览隔离等 */
  fork(options: ForkOptions = {}): Context {
    return new Context(
      this,
      this.record,
      {
        parent: this.scope,
        services: new Map(),
        filter: options.filter ?? null,
      },
      new AbortController(),
      this.bus,
    )
  }

  /** 只隔离指定服务；overrides 会预先放入隔离层 */
  isolate(names: string[], overrides: Record<string, unknown> = {}): Context {
    const fork = this.fork({ filter: new Set(names) })
    for (const [name, value] of Object.entries(overrides)) {
      fork.provide(name, value)
    }
    return fork
  }

  /** 子树级配置覆盖；对 ctx 及其后代挂载的插件生效 */
  intercept(key: string, patch: object): Disposable {
    const previous = this.intercepts.get(key)
    this.intercepts.set(key, deepMerge(previous ?? {}, patch))
    return this.effects.add(() => {
      if (previous) this.intercepts.set(key, previous)
      else this.intercepts.delete(key)
    })
  }

  dispose(): void {
    if (this.signal.aborted) return
    this.abort.abort()
    // 先卸载子插件，再回收本层副作用；Realm 也靠这一句清空自己的子树
    for (const child of [...this.children].reverse()) {
      this.root.runtime?.unload(child.id)
    }
    this.children.clear()
    this.effects.dispose()
  }
}
```

> 说明：`PluginRuntime` 与 `Context` 互相引用，类型用 `import type` 即可；实际实例在 `createApp()` 时挂到 root，供 `ctx.plugin()` 转发。

#### 服务可见性示例

```ts
const app = createLowcodeApp()

// 全局能力：所有 realm 都能读到
app.plugin(materialPlugin)
app.plugin(workspacePlugin)

// 文档 A：Workspace 创建一等 Realm
const editorA = app.workspace.createEditorRealm({ documentId: 'doc-a' })
const canvasA = editorA.createCanvasRealm()
canvasA.context.plugin(presetCanvas)
editorA.context.plugin(documentOutlinePlugin)

// 文档 B：独立 history/selection/canvas，与 A 完全隔离
const editorB = app.workspace.createEditorRealm({ documentId: 'doc-b' })

// 预览：只把 http 换成 mock，其余服务正常向上解析
const preview = app.isolate(['http'], { http: createMockHttp() })
preview.plugin(playerPlugin)

editorA.dispose() // 文档 + 画布 + 文档级插件全部回收
```

Realm 不是裸 `fork()`：

- `createEditorRealm()` 为 Realm 建立自己的生命周期记录和 service scope；
- Realm 内 `provide` 的服务 owner 是 Realm，不是父插件；
- Realm 的 `dispose` 由 workspace 的 effect 托管，关闭文档或卸载父插件都会级联销毁；
- 审计、遥测、服务冲突提示都带 `realmId`，不会把文档级服务算到应用级插件头上。

### 4.4 插件定义与实例记录

插件定义是纯数据 + 一个 `apply`。`apply` 只在依赖满足时调用，且只调用一次（每次激活一次）。

```ts
// packages/kernel/src/types.ts
export type PluginState =
  | 'loading' // 已注册，等待首次调度
  | 'pending' // 依赖未满足，尚未执行 apply
  | 'applying' // apply 执行中（可能异步）
  | 'active' // 正常运行
  | 'failed' // 启动失败，保留错误与配置
  | 'disposing' // 正在回收副作用
  | 'disposed' // 已卸载

export interface Inject {
  /** 必需依赖：全部存在才会启动 */
  required: string[]
  /** 可选依赖：缺失不阻塞启动，但移除时仍会触发停用 */
  optional: string[]
}

export interface ConfigSchema<S> {
  /** 校验并返回带默认值的配置；zod schema 天然满足该接口 */
  parse(input: unknown): S
  /** 供 devtools / 低代码配置面板展示的 JSON Schema */
  toJSONSchema?(): unknown
}

export interface PluginDefinition<S = unknown, C extends Context = Context> {
  /** 插件逻辑名，必须与 manifest.name 一致，用于冲突提示和调试 */
  name: string
  /** 服务依赖；可用字符串数组简写 */
  inject?: string[] | Inject
  /** 声明会提供的服务名，仅用于静态依赖图与构建期校验 */
  provides?: string[]
  /** 配置 schema；只需实现 parse，zod 天然满足 */
  schema?: ConfigSchema<S>
  /** 插件主体；依赖满足时执行；C 可收窄为 EditorContext/CanvasContext */
  apply(ctx: C, config: S): void | Promise<void>
}

export interface PluginRecord<S = unknown> {
  /** 实例 id；同一个插件可以多实例，因此不能用 name 当唯一键 */
  id: string
  /** 插件名 */
  name: string
  /** 当前状态 */
  state: PluginState
  /** 用户传入的原始配置，重启/热重载时复用 */
  rawConfig: unknown
  /** 校验并合并后的配置，仅在激活期间存在 */
  config?: S
  /** 当前实例上下文；停用后置空 */
  context: Context | null
  /** 父实例；根插件为 null */
  parent: PluginRecord | null
  /** 解析后的依赖 */
  inject: Inject
  /** 声明的服务名 */
  provides: string[]
  /** 启动失败的错误 */
  error?: unknown
  /** 启动尝试次数，用于诊断与退避 */
  attempts: number
}

/** 恒等函数：统一插件入口，负责配置类型推断 */
export function definePlugin<S>(definition: PluginDefinition<S>): PluginDefinition<S> {
  return definition
}

/** 可选糖：类形式服务继承它即可自动 provide / 回收 */
export abstract class Service {
  protected constructor(ctx: Context, name: string, options?: ProvideOptions) {
    // 保留服务必须声明 apiVersion；普通服务默认 1.0
    ctx.effect(() => ctx.provide(name, this, { apiVersion: '1.0', ...options }))
  }
}
```

插件作者通常只写：

```ts
export default definePlugin({
  name: 'datasource-http',
  inject: ['http'],
  schema: z.object({
    /** 默认超时，毫秒 */
    timeout: z.number().int().positive().default(10_000),
  }),
  apply(ctx, config) {
    ctx.effect(() => ctx.dataSource.register(createHttpSource(config)))
  },
})
```

平台预设 `@lc/preset-default` 本身也是一个普通插件：它的 `apply` 里按依赖顺序 `ctx.plugin(schemaPlugin)`、`ctx.plugin(materialPlugin)`…… 宿主只安装预设，不需要逐个 import 核心服务。预设可以拆成 `preset-designer`、`preset-player`，分别对应设计时和运行时的最小能力集。

### 4.5 依赖驱动的生命周期

状态机：

```
                 ┌──────────── 依赖满足 ────────────┐
                 ▼                                   │
loading ──▶ pending ──▶ applying ──成功──▶ active ──┘
                 │           │                 │
                 │           └──失败──▶ failed │
                 │                             │
                 └──────── unload ─────────────┴──▶ disposed
active ──依赖消失/卸载──▶ disposing ──▶ pending（依赖恢复可重启）或 disposed
```

关键规则：

1. **依赖检查读父上下文**，不读自己上次激活残留的服务，避免“自己给自己提供依赖”。
2. **依赖缺失不报错，只进入 `pending`**，等服务出现后自动重启。
3. **必需服务消失时，依赖它的插件立即停用**；保留 `PluginRecord` 和配置，等服务回来后重试。
4. **父插件停用会连带卸载子插件**；父插件重新激活时，`apply` 会重新创建子插件，避免悬挂实例。
5. **`apply` 异步执行期间被停用**，恢复后不能再产生副作用：`ctx.signal` 已 abort，EffectScope 已关闭，新注册的 effect 会被立即回收。
6. **启动失败进入 `failed`，不自动重试**；由配置变更或手动重试触发，避免依赖抖动导致无限重启。

#### 运行时实现（核心节选）

```ts
// packages/kernel/src/runtime.ts
interface InternalRecord extends PluginRecord {
  definition: PluginDefinition
  parentCtx: Context
  abort: AbortController | null
  /** 激活时解析到的依赖实例，用于判断服务身份是否变化 */
  resolved: Map<string, unknown>
}

export class PluginRuntime {
  private seq = 0
  private records = new Map<string, InternalRecord>()
  private queue = new Set<string>()

  private readonly internal: InternalEventBus

  constructor(private app: Context) {
    this.internal = getInternalBus(app)
    // 服务出生/消失是驱动整个生命周期的唯一信号
    this.internal.on('internal/service', (name, value) => this.onServiceChange(name, value))
  }

  load(
    parent: Context,
    definition: PluginDefinition,
    rawConfig?: unknown,
    options: LoadOptions = {},
  ): PluginRecord {
    const id = options.id ?? `${definition.name}#${++this.seq}`
    if (this.records.has(id)) {
      throw new Error(`[lowcode] 插件实例 id 重复: ${id}`)
    }
    const record: InternalRecord = {
      id,
      name: definition.name,
      state: 'loading',
      definition,
      rawConfig,
      config: undefined,
      context: null,
      parent: parent.record,
      inject: normalizeInject(definition.inject),
      provides: definition.provides ?? [],
      error: undefined,
      attempts: 0,
      parentCtx: parent,
      abort: null,
      resolved: new Map(),
    }

    parent.children.add(record)
    this.records.set(id, record)
    this.schedule(id)
    return record
  }

  /** 微任务批处理：避免 apply 内创建插件导致同步递归 */
  private schedule(id: string): void {
    this.queue.add(id)
    if (this.queue.size > 1) return
    queueMicrotask(() => {
      const ids = [...this.queue]
      this.queue.clear()
      for (const id of ids) void this.activate(id)
    })
  }

  private async activate(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    if (
      record.state === 'active' ||
      record.state === 'applying' ||
      record.state === 'disposed'
    ) {
      return
    }

    const missing = record.inject.required.filter((name) => !record.parentCtx.get(name))
    if (missing.length > 0) {
      record.state = 'pending'
      return
    }

    // 记录本次激活实际解析到的服务实例，后续按身份判断依赖是否变化
    record.resolved = new Map(
      [...record.inject.required, ...record.inject.optional].map((name) => [
        name,
        record.parentCtx.get(name),
      ]),
    )

    const abort = new AbortController()
    const context = new Context(
      record.parentCtx,
      record,
      record.parentCtx.scope,
      abort,
      record.parentCtx.bus,
    )
    record.abort = abort
    record.context = context

    let config: unknown
    try {
      config = resolveConfig(record, context)
    } catch (error) {
      this.fail(record, error, 'config')
      return
    }

    record.state = 'applying'
    record.attempts += 1
    try {
      await record.definition.apply(context, config)
      // apply 期间可能已被停用或卸载
      if (record.state !== 'applying' || abort.signal.aborted) return
      record.config = config
      record.state = 'active'
      this.internal.emit('internal/plugin', record)
    } catch (error) {
      this.fail(record, error, 'apply')
    }
  }

  private onServiceChange(name: string, value: unknown): void {
    // 服务出现：唤醒所有依赖已满足的 pending 实例
    if (value !== undefined) {
      for (const record of [...this.records.values()]) {
        if (record.state === 'pending' && this.dependenciesReady(record)) {
          this.schedule(record.id)
        }
      }
      return
    }

    // 服务消失：停用所有依赖它的实例，但保留实例记录以便恢复
    for (const record of [...this.records.values()]) {
      if (record.state !== 'active' && record.state !== 'applying') continue
      // 可选依赖也视为依赖：避免插件继续持有已失效的服务引用
      const dependsOn =
        record.inject.required.includes(name) || record.inject.optional.includes(name)
      if (!dependsOn) continue

      // 同名服务可能来自其他 Realm；依赖者当前解析结果没变就不重启
      if (record.parentCtx.get(name) === record.resolved.get(name)) continue
      this.deactivate(record, 'pending')
    }
  }

  private dependenciesReady(record: InternalRecord): boolean {
    return record.inject.required.every((name) => !!record.parentCtx.get(name))
  }

  private fail(record: InternalRecord, error: unknown, phase: 'config' | 'apply'): void {
    record.error = error
    this.internal.emit('internal/error', {
      cause: error,
      pluginId: record.id,
      pluginName: record.name,
      phase,
    })
    // 复用 deactivate：abort 异步任务、卸载子插件、逆序回收 effect
    this.deactivate(record, 'failed')
  }

  private deactivate(record: InternalRecord, next: 'pending' | 'failed', emit = true): void {
    if (record.state === 'disposed' || record.state === 'disposing') return
    record.state = 'disposing'
    record.abort?.abort()

    // Context.dispose 会先逆序卸载子插件，再回收本插件的副作用
    record.context?.dispose()
    record.context = null
    record.config = undefined
    record.resolved.clear()
    record.state = next
    if (emit) this.internal.emit('internal/plugin', record)
  }

  unload(id: string): void {
    const record = this.records.get(id)
    if (!record) return
    if (record.state === 'disposed') return

    // 卸载只发一次 disposed，避免 pending → disposed 双事件
    this.deactivate(record, 'pending', false)
    record.state = 'disposed'
    record.parentCtx.children.delete(record)
    this.records.delete(id)
    this.internal.emit('internal/plugin', record)
  }
}
```

> 服务事件只带名字是不够的：Realm 内移除同名 `history` 时，外层可能还有可解析的 `history`。运行时必须记录每个依赖的解析实例，只有身份变化才停用，否则会把外层插件误停。

> 实现提示：生产代码里还要加“停用中”重入保护、服务移除的批量延迟、异步 `apply` 的 `ctx.signal` 检查，避免 A 停用引发 B 停用再反过来访问 A 的中间态。示例保留了主干逻辑。

#### 可选依赖与晚绑定

`inject.optional` 只在激活时解析；服务晚到不会自动重启插件。需要动态绑定可选服务时，用 `ctx.inject`：

```ts
export default definePlugin({
  name: 'canvas-resize',
  inject: { required: ['canvas'], optional: ['snap'] },
  apply(ctx) {
    // snap 存在时执行；消失时自动 dispose；再次出现时重新执行
    ctx.inject(['snap'], (ctx) => {
      ctx.effect(() => ctx.require<SnapService>('snap').registerProvider(resizeSnapProvider))
    })
  },
})
```

`ctx.inject(names, callback)` 的语义：

- 所有依赖出现时执行 callback，callback 拥有独立的子 EffectScope；
- 任一依赖消失时销毁该子 scope，不重启父插件；
- 依赖再次齐全时重新执行 callback；
- 不会让插件进入 pending，也不影响其他能力。

`PluginRuntime.inject` 的实现基于 `ctx.services.onDidChange` + 子 EffectScope：依赖齐全时创建子 Context，任一缺失时 dispose，再次齐全时重建；代码示例省略这部分调度细节。

#### 循环依赖

两个插件互相声明必需依赖时，双方都会停在 `pending`。处理策略：

- **构建期**：loader 用 manifest 的 `requires` / `provides` 生成静态依赖图，发现环直接报错；
- **运行期**：devtools 展示 pending 依赖链；`ctx.diagnostics` 给出诊断，不静默等待；
- 不把“循环依赖”设计成可运行的特性。

### 4.6 EffectScope 与卸载语义

这是内核最重要的基础设施。没有它，插件卸载必然泄漏。

```ts
// packages/kernel/src/effect.ts
export class EffectScope {
  private items: Disposable[] = []
  private closed = false

  add(fn: () => void): Disposable {
    const item = { dispose: fn }
    if (this.closed) {
      // 已卸载后才注册的副作用立即回收，避免异步 apply 泄漏
      item.dispose()
      return item
    }
    this.items.push(item)
    return item
  }

  effect<T extends Disposable>(factory: () => T): T {
    // 关闭后不再执行 factory，避免卸载后发起请求/定时器
    if (this.closed) {
      return { dispose() {} } as T
    }
    const item = factory()
    this.items.push(item)
    return item
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    // 后注册先释放，符合依赖关系
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i].dispose()
      } catch (error) {
        reportError(error)
      }
    }
    this.items.length = 0
  }
}
```

`ctx` 上所有资源都必须走 effect：

```ts
// 事件
ctx.effect(() => ctx.on('schema:beforeSave', onBeforeSave))

// 注册表
ctx.effect(() => ctx.material.register(material))

// 定时器
ctx.effect(() => {
  const timer = setInterval(tick, 1000)
  return { dispose: () => clearInterval(timer) }
})

// 异步任务
ctx.effect(() => {
  const controller = new AbortController()
  void fetchData(controller.signal)
  return { dispose: () => controller.abort() }
})
```

**硬性约定：插件里不允许出现没有通过 `ctx.effect` 托管的全局副作用。** 包括 `addEventListener`、`setTimeout`、`window` 上的属性、第三方库的订阅。可以用 ESLint 自定义规则检查常见 API。

scope 已关闭时，`effect` 返回 no-op，不再执行 factory；异步 `apply` 仍必须检查 `ctx.signal.aborted`，避免卸载后继续计算或写状态。

### 4.7 事件系统

事件既是插件协作方式，也是低代码平台的扩展管线。内核提供 5 种分发模式：

| 模式        | 语义                                          | 低代码用例                          |
| ----------- | --------------------------------------------- | ----------------------------------- |
| `emit`      | 同步广播，错误隔离                            | 通知、日志、刷新                    |
| `parallel`  | 全部执行，等待全部完成                        | 保存后并行上传                      |
| `serial`    | 顺序执行，前一个完成再执行下一个              | 启动钩子、迁移                      |
| `bail`      | 顺序执行，第一个返回非 `undefined` 的结果生效 | 画布 drop、快捷键处理、自定义渲染   |
| `waterfall` | 前一个监听器的返回值作为下一个的输入          | schema 转换、请求参数改写、导出管线 |

```ts
// packages/kernel/src/events.ts
export class EventBus {
  private listeners = new Map<string, ListenerEntry[]>()

  add(name: string, listener: Function, options: EventOptions = {}): Disposable {
    const list = this.listeners.get(name) ?? []
    const entry = { listener, options }
    list.push(entry)
    // prepend 优先于普通监听器；同类按 priority 从高到低
    list.sort((a, b) => {
      const prependDiff = Number(!!b.options.prepend) - Number(!!a.options.prepend)
      if (prependDiff) return prependDiff
      return (b.options.priority ?? 0) - (a.options.priority ?? 0)
    })
    this.listeners.set(name, list)
    return {
      dispose: () => {
        const index = list.indexOf(entry)
        if (index >= 0) list.splice(index, 1)
      },
    }
  }

  emit(name: string, ...args: unknown[]): void {
    for (const { listener } of [...(this.listeners.get(name) ?? [])]) {
      try {
        listener(...args)
      } catch (error) {
        reportError(error)
      }
    }
  }

  async waterfall<T>(name: string, input: T, ...args: unknown[]): Promise<T> {
    let value = input
    for (const { listener } of [...(this.listeners.get(name) ?? [])]) {
      value = await listener(value, ...args)
    }
    return value
  }
}
```

事件类型通过 declaration merging 扩展：

```ts
// packages/contracts/src/events.ts
declare module '@lc/kernel' {
  interface Events {
    /** schema 保存前，插件可补充元数据；返回值继续传递 */
    'schema:beforeSave': (doc: DocumentModel) => DocumentModel
    /** 页面 schema 编译，按注册顺序转换 */
    'schema:transform': (schema: NodeSchema) => NodeSchema
    /** 画布 drop；返回 true 表示已被插件接管 */
    'canvas:drop': (payload: DropPayload) => boolean | void
  }
}
```

内部事件（`internal/*`）只给 devtools 和 loader 用，不属于插件公开 API：

| 事件               | 参数                   | 用途                        |
| ------------------ | ---------------------- | --------------------------- |
| `internal/service` | `(name, value, owner)` | 服务出现/消失，驱动生命周期 |
| `internal/plugin`  | `(record)`             | 插件状态变化，devtools 刷新 |
| `internal/error`   | `(error, record?)`     | 统一错误上报                |
| `internal/config`  | `(record, config)`     | 配置变更追踪                |

#### 4.7.1 内部事件不可伪造

`internal/*` 不能挂在公共 `EventBus` 上，否则任何插件都能 `ctx.emit('internal/service', ...)` 伪造生命周期，触发其他插件重启或停用。

隔离方式：

- `Events` 只放公开事件；`InternalEvents` 独立类型。
- 内部总线由 `createApp()` 创建，只有 runtime/loader/devtools 通过 kernel 包内符号获取；公共 `Context` 不暴露。
- `ctx.emit` 类型上不接受 `internal/*`；公共 `EventBus` 也没有内部事件的监听器。
- 宿主/devtools 想看状态，走只读诊断接口，而不是监听内部事件：

```ts
export interface ServiceObserver {
  /** 服务当前是否可用 */
  has(name: string): boolean
  /** 服务出现/消失/替换；插件可用于可选依赖 */
  onDidChange(name: string, listener: (value: unknown) => void): Disposable
}

export interface Diagnostics {
  /** 插件状态变化；devtools/host 用 */
  onPluginState(listener: (record: PluginRecord) => void): Disposable
  /** 错误上报；不要再 emit internal/error */
  onError(listener: (error: PluginError) => void): Disposable
  /** 主动上报错误；自动附带 pluginId/phase */
  report(error: unknown, context?: Partial<PluginError>): void
}
```

`ctx.services` 提供 `ServiceObserver`，`ctx.diagnostics` 提供 `Diagnostics`。插件需要感知可选服务变化时用 `ctx.services.onDidChange`，不要依赖 `internal/service`。

### 4.8 配置流水线

配置分两层，必须区分清楚：

1. **插件配置**：部署级，安装时确定，决定插件整体行为（如允许的域名、默认超时）。由 loader / 部署平台管理。
2. **实例配置**：运行时数据，一个插件可以创建多个实例（两个 HTTP 数据源、三个图表），由用户在设计器里配置，存在 schema 里。

内核只负责插件配置，不负责实例配置。

#### 合并顺序

```
schema 默认值
  → manifest 中的默认配置
  → 部署/租户覆盖
  → 传给 ctx.plugin() 的实例配置
  → 祖先 Context 的 intercept（越近优先级越高）
  → schema.parse 校验
```

```ts
function resolveConfig(record: InternalRecord, ctx: Context): unknown {
  const intercepts = collectIntercepts(ctx, record.name)
  const merged = deepMerge(
    {},
    schemaDefaults(record.definition.schema),
    record.rawConfig ?? {},
    ...intercepts,
  )
  // 校验失败直接抛出，插件进入 failed，不执行 apply
  return record.definition.schema?.parse(merged) ?? merged
}

function collectIntercepts(ctx: Context, key: string): object[] {
  const chain: Context[] = []
  for (let current: Context | null = ctx; current; current = current.parent) {
    chain.unshift(current) // 外层在前，内层覆盖外层
  }
  return chain.map((item) => item.intercepts.get(key)).filter((item): item is object => !!item)
}
```

#### 配置变更语义

**插件配置不可变。** 修改配置 = 停用旧实例 + 用新配置重新激活。理由：

- 避免插件内部出现“半新半旧”状态；
- 让 `apply` 成为唯一的初始化入口；
- 配置校验失败时可以完整回滚；
- 低代码插件通常不需要“热改配置不重启”。

需要运行时动态调整的东西（如数据源单次请求参数），属于实例配置或服务方法参数，不进插件配置。

### 4.9 隔离、覆盖与多实例

| 能力     | API                                                  | 典型场景                       |
| -------- | ---------------------------------------------------- | ------------------------------ |
| 新作用域 | `ctx.fork()`                                         | 每个打开的文档一个 Realm       |
| 服务隔离 | `ctx.isolate(['http'], { http: mock })`              | 预览环境 mock 数据源           |
| 服务遮蔽 | 在子 scope `provide(name, value, { replace: true })` | 租户定制 storage               |
| 配置覆盖 | `ctx.intercept('datasource-http', { timeout: 100 })` | 测试环境缩短超时、企业默认配置 |
| 多实例   | `ctx.plugin(HttpSource, configA)` / `configB`        | 多个数据源、多个画布           |

多实例的注意点：

- `PluginRecord.id` 必须唯一，不能拿 `name` 当 key；
- 物料注册表默认按名字唯一，多实例插件不要重复注册同名物料；
- 服务名是全局的（同一 scope 内），需要“每个实例一份服务”时，用 Realm 隔离，或把服务设计成无状态 + 实例对象由调用方持有；
- `isolate` 层只允许提供被隔离的服务名，适合“只消费能力”的预览/测试插件；需要在隔离层内提供新服务的插件应挂在隔离层外，或把该服务加入 `names`。

### 4.10 错误处理与可观测性

| 失败点                        | 行为                                            |
| ----------------------------- | ----------------------------------------------- |
| `apply` 抛错 / Promise reject | 插件 `failed`，记录错误，UI 继续运行            |
| 配置校验失败                  | 不执行 `apply`，`failed`，devtools 展示字段错误 |
| 事件监听器抛错                | 捕获并上报，不中断其他监听器                    |
| 物料组件加载失败              | 渲染 fallback，画布不白屏                       |
| 物料组件运行时报错            | Vue 错误边界捕获，替换为错误占位节点            |
| 面板组件报错                  | 面板级边界，其他面板不受影响                    |
| 插件死循环                    | 同 realm 无法防护，只能靠 code review / 沙箱    |

错误对象统一携带插件上下文：

```ts
export interface PluginError {
  /** 原始错误 */
  cause: unknown
  /** 插件实例 id */
  pluginId?: string
  /** 插件名 */
  pluginName?: string
  /** 生命周期阶段 */
  phase: 'load' | 'config' | 'apply' | 'runtime' | 'dispose'
  /** 插件版本，便于定位兼容性问题 */
  version?: string
}
```

devtools 必备面板：

- 插件树：状态、依赖、错误、启动耗时；
- 服务表：当前 realm 的提供者、遮蔽链；
- 依赖图：谁在等谁、为什么 pending；
- 事件日志：事件名、监听器所在插件、耗时；
- 配置查看：合并后的配置与来源；
- 一键重试 / 停用 / 卸载。

### 4.11 服务冲突与命名

- 服务名用扁平 camelCase：`material`、`dataSource`、`history`，不要用 `designer.history` 这种多级 key。
- 服务接口定义在 `@lc/contracts`，实现放在 `@lc/service-*`。
- 平台保留服务名（`material`、`http`、`storage`、`audit`、`canvas` 等）只能由平台核心或认证实现提供；`provide` 必须携带 loader 签发的 `ServiceGrant`，`manifest.provides` 只是声明，不是授权。
- `ServiceGrant` 由 `createApp()` / loader 签发，插件作者不能自行构造；平台核心服务在预设启动时获得 grant，认证实现由 loader 在激活前注入。
- 保留服务必须声明 `apiVersion`；loader 在激活前校验插件期望的 contract 版本与 provider 版本，不兼容直接拒绝，不做运行时猜测。
- 同一 scope 内重复 provide 默认报错；`{ replace: true }` 需要 `grant.override`，并且当前 scope 没有 active 消费者。否则先卸载提供者与依赖者，再重新 provide。
- `replace: true` 只建议在消费者挂载前使用（Realm 初始化、测试覆盖）。已经 active 的插件持有旧引用，内核不会因同层替换自动重启它们。
- 跨 scope 同名是遮蔽，不是冲突；devtools 必须展示遮蔽来源。
- 物料、命令、动作、数据源类型等“注册表条目”也需要命名空间，推荐 `<plugin-name>.<item>`，例如 `lc.button`、`acme.chart`。
- 同名条目策略由各注册表决定，默认“先注册者胜出 + dev 警告”；需要覆盖时显式声明 `priority` 或 `override`。

### 4.12 内核不做什么

- 不认识 manifest、contributes、slot；
- 不认识材料、数据源、schema；
- 不做权限判断；
- 不做持久化；
- 不依赖 Vue、DOM、Node API。

这样内核可以在浏览器、Worker、Node（SSR / 代码生成）中复用，也方便单测。

### 4.13 内核不变量与测试矩阵

| #   | 不变量                              | 测试方式                                              |
| --- | ----------------------------------- | ----------------------------------------------------- |
| 1   | 必需依赖缺失时绝不调用 apply        | fake service + pending 断言                           |
| 2   | 服务移除先于依赖者停用完成          | 监听 dispose 顺序                                     |
| 3   | 服务恢复后依赖者只重启一次          | 计数 apply 次数                                       |
| 4   | 卸载幂等                            | 连续 dispose 两次无异常                               |
| 5   | 副作用逆序释放                      | 记录释放顺序                                          |
| 6   | 异步 apply 在卸载后不产生副作用     | 延迟 resolve + 检查注册表为空                         |
| 7   | 配置非法时 apply 不执行             | 抛错 schema                                           |
| 8   | 监听器抛错不影响其他监听器          | 多监听器计数                                          |
| 9   | 隔离层不写穿外层                    | 在 isolate 内 provide 非隔离服务应报错                |
| 10  | 重复服务默认冲突                    | 两个 provider 断言异常                                |
| 11  | 循环依赖不会死锁宿主                | 双方 pending + 诊断事件                               |
| 12  | 事件监听器随插件卸载移除            | 卸载后 emit 不触发                                    |
| 13  | 未授权 provide 保留服务名必须拒绝   | 无 grant 的插件 provide('http') 断言异常              |
| 14  | 插件不能伪造内部生命周期事件        | 公共 emit('internal/service') 编译失败/不触发 runtime |
| 15  | 有 active 消费者时 replace 必须拒绝 | 提供者 + 消费者激活后断言 replace 抛错                |
| 16  | 保留服务无 apiVersion 必须拒绝      | provide('http') 不带 apiVersion 断言异常              |

### 4.14 企业级能力如何挂在内核上

内核保持小而稳定，企业能力不写进 `Context.get/provide`，而是作为服务、包装器和控制面能力挂在外围。否则内核会变成不可测试、不可替换的单体。

Context 只携带**归属信息**，不做鉴权：

```ts
export interface ContextDescriptor {
  /** 租户 id；仅用于归属、审计和遥测维度 */
  tenantId: string
  /** 工作区 id */
  workspaceId: string
  /** 环境：dev / staging / prod */
  environment: string
  /** 文档 id；应用级服务为 undefined */
  documentId?: string
  /** Realm id；应用级为 undefined */
  realmId?: string
  /** Realm 类型，用于归属与遥测 */
  realmKind?: 'editor' | 'canvas' | 'preview'
  /** 插件 id（manifest 名） */
  pluginId?: string
  /** 认证等级，用于审计与遥测，不参与运行时鉴权 */
  certification?: 'platform' | 'verified' | 'community'
  /** 执行位置，用于审计与遥测 */
  executionProfile?: 'inline' | 'iframe' | 'worker' | 'server'
}
```

| 企业关注点            | 实现层                                     | 不放进内核的原因                                  |
| --------------------- | ------------------------------------------ | ------------------------------------------------- |
| 租户隔离              | 数据面存储、RLS、缓存命名空间 + descriptor | 内核无法阻止 SQL/对象存储越权                     |
| 身份与 RBAC/ABAC      | 控制面 + 服务包装 + 策略引擎               | 内核不认识用户、角色、资源                        |
| 审计                  | 生命周期事件 + 权限网关 + 控制面           | 内核只负责发事件，不负责不可篡改存储              |
| 配额与限流            | API 网关、Worker、容器、服务包装           | JS 内核无法抢占 CPU/内存                          |
| 供应链                | loader + 控制面 + 注册表                   | 内核只执行已解析模块                              |
| 灰度/回滚/Kill Switch | 控制面 + loader                            | 内核不保存发布状态                                |
| 可观测性              | OpenTelemetry SDK + 外部后端               | 内核不做聚合与告警                                |
| 画布能力              | CanvasRealm 微内核                         | 复用同一套 Context/Effect/Service，不特殊化主内核 |

权限网关的形态是“同接口、不同实现”：插件拿到的 `ctx.http`、`ctx.storage`、`ctx.document` 都是包装后的代理，调用时做用户权限 × 插件权限交集、租户边界、限流、审计。对 T2/T3 沙箱插件，网关是强制入口；对 T0/T1 inline 插件，网关提供统一入口与审计，但无法阻止受信任代码直接访问全局对象——这正是 inline 必须评审的原因。

---

## 5. 装载器与贡献点：实现“装即用”

内核只解决“插件怎么活”。真正让“装一个包功能就出现”的，是 **manifest + 声明式贡献 + 通用插槽**。

### 5.1 Manifest 规范

manifest 建议直接放在 `package.json` 的 `lowcode` 字段，构建时复制为 `dist/plugin.json`，避免多一份手写文件。

```ts
export interface PluginManifest {
  /** 插件逻辑名，全局唯一；必须与运行时 definition.name 一致 */
  name: string
  /** 展示名，缺省取 name */
  displayName?: string
  /** 插件版本，semver */
  version: string
  /** 兼容的内核 API 版本范围，例如 "^1.2.0" */
  engines: {
    /** 低代码内核版本范围 */
    lowcode: string
  }
  /** 入口模块（相对包根）；纯声明式插件可省略 */
  main?: string
  /** 静态依赖，用于安装提示与依赖图；运行时以 inject 为准 */
  requires?: string[]
  /** 激活事件；为空表示只加载贡献元数据，不执行插件代码 */
  activationEvents?: string[]
  /** 声明的服务名，构建期与运行时 provide 校验 */
  provides?: string[]
  /** 申请的能力，安装时展示并由宿主强制执行 */
  permissions?: Permission[]
  /** 声明式贡献，不执行插件代码即可渲染入口 */
  contributes?: Contributions
}
```

`version` 不在 `lowcode` 字段里重复，构建时从 `package.json` 合并进 `dist/plugin.json`；`engines.lowcode` 才是插件与内核的兼容边界。

`lowcode.name` 缺省取 npm 包名；建议使用短名（如 `datasource-http`），构建期校验它与入口导出的 `definition.name` 一致。`package.json.name` 只负责 npm 包身份。

`requires` 指的是服务能力（如 `http`），不是 npm 包依赖；插件之间不建立包级依赖，避免插件版本地狱。若某个实现插件必须先存在，由平台预设或部署约束保证，而不是写进依赖图。

`package.json` 示例：

```json
{
  "name": "@lc/plugin-datasource-http",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "peerDependencies": {
    "@lc/kernel": "^1.0.0",
    "@lc/contracts": "^1.0.0",
    "vue": "^3.5.0"
  },
  "lowcode": {
    "name": "datasource-http",
    "displayName": "HTTP 数据源",
    "certification": "verified",
    "executionProfile": "worker",
    "engines": { "lowcode": "^1.0.0" },
    "main": "./dist/index.js",
    "activationEvents": ["onDataSource:http"],
    "requires": ["http"],
    "provides": [],
    "permissions": [{ "type": "network", "hosts": ["api.example.com"] }],
    "contributes": {
      "dataSources": [
        {
          "type": "http",
          "title": "HTTP 请求",
          "module": "./dist/index.js"
        }
      ]
    }
  }
}
```

### 5.2 两种安装模式

| 模式       | 发现方式                                                        | 优点                           | 限制                                   |
| ---------- | --------------------------------------------------------------- | ------------------------------ | -------------------------------------- |
| 构建期内置 | pnpm 安装后，Vite 插件扫描 `package.json.lowcode`，生成静态清单 | 类型好、构建优化、无运行时网络 | 新增插件要重新构建                     |
| 运行时远程 | 上传/市场安装，读取远端 manifest + ESM 地址                     | 无需发版、可做市场             | 需要 import map、CSP、签名、缓存、权限 |

推荐 **混合模式**：官方/核心插件构建期内置；企业/第三方插件运行时安装。两条路径共用同一套 manifest 和 loader。

构建期生成的模块长这样：

```ts
// virtual:lowcode-plugins（由 Vite 插件生成）
export const manifests = [
  { manifest: httpManifest, load: () => import('@lc/plugin-datasource-http') },
  { manifest: statManifest, load: () => import('@lc/plugin-material-stat') },
]
```

Vite 会为每个 `import()` 自动切 chunk，只有激活时才下载执行。

### 5.3 声明式贡献：不执行代码也能出现入口

`contributes` 是纯数据，loader 在安装时就能注册：

- 物料面板能立刻列出“统计卡片”，即使组件代码还没下载；
- 工具栏能立刻出现“导出 Vue”按钮，点击时才加载插件代码；
- 属性面板能根据 manifest 里的 props schema 生成基础表单，即使自定义 setter 还没加载。

这就是“装即用”的核心：**元数据先行，代码懒加载**。

安装与启用是两件事：安装只落盘并记录 manifest；启用才注册贡献、允许激活。企业环境可以预装一批插件但默认禁用，避免首屏和权限面扩大。

物料贡献的类型：

```ts
export interface MaterialContribution {
  /** 物料唯一名，建议加命名空间，如 lc.stat */
  name: string
  /** 展示名，支持 i18n key */
  title: string
  /** 物料面板分组 */
  category: string
  /** 图标名，来自共享图标注册表 */
  icon?: string
  /** 属性 schema；未加载组件时也能生成属性面板 */
  props: JsonSchema
  /** 组件 ESM 模块，首次拖入/渲染时加载 */
  module: string
  /** 拖入画布时生成的默认节点；缺省由 props 默认值生成 */
  snippet?: NodeSchema
  /** 是否可作为容器接收子节点 */
  container?: boolean
  /** 渲染模式；SSR/导出不支持时走 headless browser */
  renderMode?: 'client' | 'ssr' | 'both'
  /** 允许的父物料；空表示不限制 */
  allowedParents?: string[]
  /** 冲突时的优先级，默认先注册者胜出 */
  priority?: number
}
```

面板贡献：

```ts
export interface PanelContribution {
  /** 面板 id，用于布局持久化与命令打开 */
  id: string
  /** 展示名 */
  title: string
  /** 宿主插槽名，必须是共享常量中声明的值 */
  slot: SlotName
  /** 图标 */
  icon?: string
  /** 排序，越小越靠前 */
  order?: number
  /** 面板组件模块，打开面板时才加载 */
  module: string
  /** 显示条件，可访问 document/selection 等只读上下文 */
  when?: string
}
```

### 5.4 贡献点清单

#### 设计时

| 贡献点           | 作用                       | 宿主位置                                |
| ---------------- | -------------------------- | --------------------------------------- |
| `materials`      | 组件/物料                  | 物料面板、画布                          |
| `setters`        | 属性编辑器                 | 右侧属性面板                            |
| `panels`         | 功能面板                   | 左/右/底部插槽                          |
| `toolbar`        | 工具栏按钮                 | 顶部工具栏                              |
| `commands`       | 可执行命令                 | 菜单、快捷键、命令面板                  |
| `contextMenu`    | 右键菜单项                 | 画布/大纲节点                           |
| `canvasOverlays` | 画布覆盖层                 | 标尺、辅助线、批注                      |
| `canvasFeatures` | 画布能力插件               | 缩放、平移、节点缩放/旋转、吸附、小地图 |
| `canvasProfiles` | 画布预设（启用/排序/配置） | 不同设计器形态                          |
| `nodeAdornments` | 节点角标/操作              | 画布节点                                |
| `validators`     | schema 校验器              | 保存/发布前                             |
| `exporters`      | 导出目标                   | 导出菜单                                |

#### 运行时

| 贡献点                | 作用                         |
| --------------------- | ---------------------------- |
| `materials`           | 页面渲染的组件               |
| `dataSources`         | 数据源类型                   |
| `actions`             | 事件动作（跳转、请求、脚本） |
| `expressionFunctions` | 表达式函数                   |
| `rendererHooks`       | 渲染前后钩子                 |
| `errorFallbacks`      | 物料错误占位组件             |
| `pageSlots`           | 生成应用的全局插槽           |

#### 平台

| 贡献点            | 作用          |
| ----------------- | ------------- |
| `authProviders`   | 登录/鉴权     |
| `storageAdapters` | 文档/资源存储 |
| `previewServers`  | 预览服务      |
| `themes`          | 主题包        |
| `locales`         | 语言包        |
| `icons`           | 图标包        |

新增贡献点时，必须遵守：**先加契约常量，再加宿主插槽，再允许插件声明**。不允许插件自定义一个宿主不认识的 slot 字符串。

因此，“不改代码”的准确含义是：不改宿主、不改已有插件。新增一种平台从未提供过的交互形态，仍需要先由平台增加插槽；插槽就是平台的产品边界。

### 5.5 激活事件

| 事件                   | 触发时机                                                                        |
| ---------------------- | ------------------------------------------------------------------------------- |
| `onStartup`            | 应用启动即激活（核心插件）                                                      |
| `onCommand:<id>`       | 命令首次执行                                                                    |
| `onPanel:<id>`         | 面板首次打开                                                                    |
| `onMaterial:<name>`    | 物料首次拖入/渲染                                                               |
| `onCanvasFeature:<id>` | 打开文档创建 CanvasRealm 时；CanvasHost 只加载模块，实例挂到画布上（见 §12.10） |
| `onDataSource:<type>`  | 数据源首次配置/执行                                                             |
| `onAction:<id>`        | 动作首次执行                                                                    |
| `onExport:<target>`    | 导出目标首次使用                                                                |
| `onLanguage:<locale>`  | 切换到某语言                                                                    |
| `onStartupFinished`    | 首屏渲染完成后空闲激活（低优先级插件）                                          |

宿主交互点必须调用 `loader.ensureActivated(event)`，例如打开面板：

```ts
async function openPanel(id: string) {
  await loader.ensureActivated(`onPanel:${id}`)
  layout.show(id)
}
```

物料渲染不能无限等待插件激活：manifest 已经提供了元数据和模块地址，渲染器可以并行做两件事：加载组件模块 + 激活插件行为。组件加载不依赖 `apply`。

### 5.6 安装 / 卸载时序

```
install(request)
  ├─ 控制面：验证发布者、签名、SBOM、认证等级、许可证
  ├─ 策略：租户/环境/白名单/配额/数据分级
  ├─ 下载制品到隔离缓存，校验 digest + signature（fail-closed）
  ├─ 必要时进入审批流（生产环境、特权插件、跨租户插件）
  ├─ 注册已批准的声明式贡献与配置
  ├─ 审计 install.requested / approved / rejected / activated
  └─ 按 activationEvents 激活（或等待首次使用）

uninstall(pkg)
  ├─ 策略与审批（生产环境禁止直接卸载平台关键插件）
  ├─ loader.removeContributions(pkg)
  ├─ runtime.unload(该插件的所有实例)
  │    ├─ abort 异步任务
  │    ├─ 卸载子插件
  │    ├─ 逆序释放 effect
  │    ├─ 移除服务 → 依赖者自动停用
  │    └─ 移除事件监听
  ├─ 清除模块缓存 / 远程包缓存
  ├─ 按 dataPolicy 保留或清除用户数据
  └─ 审计 uninstall / data.purged
```

验收标准：卸载后 devtools 中该插件的服务、监听器、注册表条目、DOM、定时器全部为 0；审计中有完整的安装、启用、停用、卸载记录。

### 5.7 插槽渲染、排序与冲突

宿主只实现一个通用组件：

```vue
<LcSlot name="designer.leftPanel" :context="{ documentId }" />
```

渲染规则：

1. 从贡献注册表取该 slot 的所有条目；
2. 按 `order` 升序、`priority` 降序、插件名兜底排序；
3. `when` 为 false 的条目不渲染；
4. 每个条目包裹插件级错误边界；
5. 组件模块懒加载，加载中显示骨架，失败显示降级 UI 并上报；
6. 插件卸载时条目自动消失（disposable 驱动）。

冲突策略：

- 同一 slot 允许多个条目，这是常态；
- 同一 id 重复注册 → dev 环境报错，生产保留优先级最高者；
- 物料同名 → 默认先注册者胜出，可通过 `priority` 显式覆盖；
- 命令 id 重复 → 报错，不允许静默覆盖。

### 5.8 企业级 Manifest 扩展

以下字段并入 5.1 的 `PluginManifest`。Manifest 是安全与治理的第一道契约，以下字段都进入签名范围，安装后不可变；没有执行点的字段不要加，避免“写了但没人执行”的假治理。

```ts
export interface EnterpriseManifest {
  /** 发布者身份；跨租户市场必须验证 */
  publisher: {
    /** 发布者唯一 id */
    id: string
    /** 展示名 */
    name: string
    /** 是否通过平台实名/安全认证 */
    verified: boolean
    /** 安全事件联系人 */
    securityContact: string
  }
  /** SPDX 许可证标识 */
  license: string
  /** 认证等级，决定可见范围与默认信任级别 */
  certification: 'platform' | 'verified' | 'community'
  /** 执行位置；inline 仅 platform 或通过 UI 评审的 verified 可用 */
  executionProfile: 'inline' | 'iframe' | 'worker' | 'server'
  /** UI 评审结论；executionProfile 为 inline 时必填 */
  uiReview?: 'inline' | 'sandboxed'
  /** 服务端入口；executionProfile 为 server 时必填 */
  serverMain?: string
  /** 兼容性；宿主与浏览器矩阵在发布前校验 */
  compatibility: {
    kernel: string
    hosts: string[]
    vue?: string
    browsers?: string
  }
  /** 资源预算；由 Worker/容器/网关执行，不依赖内核抢占 */
  resources: {
    maxMemoryMb?: number
    maxCpuMs?: number
    maxNetworkRpm?: number
    maxStorageMb?: number
  }
  /** 出站访问策略；默认全部拒绝 */
  egress: {
    allowedHosts: string[]
    sameOrigin: boolean
    proxyRequired: boolean
  }
  /** 数据分级与生命周期 */
  dataPolicy: {
    classification: 'public' | 'internal' | 'confidential' | 'restricted'
    residency?: string[]
    retentionDays?: number
    purgeOnUninstall: boolean
    pii: boolean
  }
  /** 供应链证据；loader 验证失败即拒绝加载 */
  security: {
    signature: string
    sbom: string
    provenance?: string
    scanReport: string
  }
  /** 支持等级与生命周期 */
  support: {
    tier: 'platinum' | 'gold' | 'standard' | 'community'
    sla?: string
    eolAt?: string
  }
  /** 发布通道与自动更新策略 */
  release: {
    channels: Array<'stable' | 'beta' | 'canary'>
    autoUpdate: 'none' | 'patch' | 'minor'
    pinnedMajor: boolean
  }
}
```

安装范围：

| 范围        | 谁可以安装        | 默认策略                                       |
| ----------- | ----------------- | ---------------------------------------------- |
| Platform    | 平台工程/安全团队 | 所有租户可用；inline 仅 platform / verified-ui |
| Tenant      | 租户管理员        | 需在租户允许清单内，默认隔离层运行             |
| Workspace   | 工作区管理员      | 租户允许清单 + 工作区 opt-in                   |
| Environment | 环境管理员        | prod 需审批，dev/staging 可放宽                |
| User        | 开发者            | 仅限本地/沙箱，不进生产                        |

硬性规则：

- 只有 `platform`，以及 `certification === 'verified' && uiReview === 'inline'` 的插件，才允许 `executionProfile: 'inline'`；`community` 不允许 inline。
- `inline` 用于物料和画布插件，运行在宿主同 realm；前提是 UI 安全评审、无 ambient 网络/密钥、严格 CSP、可审计网关调用。它是“受信任代码”，不是沙箱。
- `iframe`/`worker` 用于面板与无头逻辑；`server` 用于容器扩展。三者都属于非 inline 执行位置，不能贡献需要内联渲染的物料或画布插件。
- `egress` 默认拒绝；`allowedHosts` 由出站代理执行，不靠插件自觉。
- `resources` 由 Worker/容器/网关执行；内核不承诺抢占 JS。
- `dataPolicy.classification` 决定存储加密、审计级别、导出审批与数据驻留。
- 签名覆盖 manifest + 制品；manifest 篡改视为供应链攻击，直接 fail-closed。
- 构建期校验 `manifest.name === definition.name`、`provides` 与实际 `provide` 一致、`executionProfile` 与贡献类型匹配（物料/画布插件必须 inline）。

---

## 6. 契约层与核心服务

### 6.1 契约层原则

- **只放类型、常量、纯函数**，不放状态和单例；
- 所有服务接口定义在这里，实现放在 `@lc/service-*`；
- 所有事件名、slot 名、权限字符串定义在这里，禁止魔法字符串；
- 通过 declaration merging 把服务挂到 `Context` 上；
- 契约包不依赖 Vue，UI 相关类型用泛型或 `unknown` 隔离。

```ts
// packages/contracts/src/services.ts
declare module '@lc/kernel' {
  interface Context {
    /** schema 解析、校验、迁移；应用级 */
    schema: SchemaService
    /** 物料注册表；应用级 */
    material: MaterialService
    /** 属性设置器注册表；应用级 */
    setter: SetterService
    /** schema → 组件树；由 Vue 适配器提供 */
    renderer: RendererService
    /** 插件装载器 */
    loader: LoaderService
    /** 声明式贡献查询 */
    contribution: ContributionService
    /** 模块懒加载 */
    modules: ModuleService
    /** 带权限与超时的 HTTP 请求 */
    http: HttpService
    /** 命名空间存储 */
    storage: StorageService
    /** 文案与语言包 */
    i18n: I18nService
    /** 主题与设计令牌 */
    theme: ThemeService
    /** 审计写入 */
    audit: AuditService
    /** 策略决策 */
    policy: PolicyService
    /** 配额与限流 */
    quota: QuotaService
    /** 凭据代理 */
    secrets: SecretsService
    /** 功能开关与 Kill Switch */
    flags: FeatureFlagService
    /** 控制面客户端 */
    controlPlane: ControlPlaneClient
    /** 数据源类型与执行 */
    dataSource: DataSourceService
    /** 设计时命令 */
    command: CommandService
    /** 运行时动作 */
    action: ActionService
    /** 工作区 / Realm 管理 */
    workspace: WorkspaceService

    // ---- Realm 服务：基类可选，避免 AppContext 谎报 ----
    /** 文档服务；EditorContext 中必选 */
    document?: DocumentService
    /** 撤销/重做；EditorContext 中必选 */
    history?: HistoryService
    /** 选中/悬停；EditorContext 中必选 */
    selection?: SelectionService
    /** 设计器画布操作；EditorContext 中必选 */
    designer?: DesignerService
    /** 画布微内核；CanvasContext 中必选 */
    canvas?: CanvasService
    /** 吸附服务；仅安装 canvas-snap 后存在 */
    snap?: SnapService
  }
}

/** 应用级上下文：只有全局服务 */
export interface AppContext extends Context {}

/** 文档级上下文：Realm 内文档服务必选 */
export interface EditorContext extends Context {
  document: DocumentService
  history: HistoryService
  selection: SelectionService
  designer: DesignerService
}

/** 画布级上下文：CanvasRealm 内画布服务必选 */
export interface CanvasContext extends EditorContext {
  canvas: CanvasService
}

export interface RealmOptions {
  /** 文档 id */
  documentId: string
  /** 编辑或只读预览 */
  mode?: 'edit' | 'preview'
}

export interface EditorRealm extends Disposable {
  /** Realm 唯一 id；审计/遥测/服务归属都用它 */
  readonly id: string
  /** 文档级上下文 */
  readonly context: EditorContext
  /** 当前主画布；打开文档时创建 */
  readonly canvas: CanvasRealm
  /** 创建画布 Realm；每个文档一个主画布 */
  createCanvasRealm(): CanvasRealm
}

export interface CanvasRealm extends Disposable {
  /** 画布 Realm 唯一 id */
  readonly id: string
  /** 画布级上下文 */
  readonly context: CanvasContext
}

export interface WorkspaceService {
  /** 创建文档 Realm；生命周期由 workspace 的 effect 托管 */
  createEditorRealm(options: RealmOptions): EditorRealm
  /** 当前活动文档 Realm */
  readonly activeEditor: EditorRealm | undefined
  /** 按文档 id 查找 */
  getEditor(documentId: string): EditorRealm | undefined
}
```

为避免把基类 `Context` 变成 `any`，内核的 `PluginDefinition` 增加 `C extends Context` 泛型；contracts 提供 `defineEditorPlugin` / `defineCanvasPlugin` 类型糖，把 `apply` 的 `ctx` 收窄为 `EditorContext` / `CanvasContext`。应用级插件继续用 `definePlugin`。

### 6.2 contracts 包内有什么

`@lc/contracts` 是内核、服务、插件、宿主、控制面之间的**唯一共享语言层**。它只放类型、常量、纯类型工具；不放实现、状态、单例、Vue 组件，也不 import 任何 service/plugin/app。

```
packages/contracts/
├── src/
│   ├── services/
│   │   ├── material.ts
│   │   ├── setter.ts
│   │   ├── renderer.ts
│   │   ├── dataSource.ts
│   │   ├── action.ts
│   │   ├── command.ts
│   │   ├── workspace.ts
│   │   ├── document.ts
│   │   ├── history.ts
│   │   ├── canvas.ts
│   │   ├── loader.ts
│   │   ├── contribution.ts
│   │   ├── modules.ts
│   │   ├── i18n.ts
│   │   ├── theme.ts
│   │   ├── storage.ts
│   │   ├── http.ts
│   │   ├── audit.ts
│   │   ├── policy.ts
│   │   ├── quota.ts
│   │   ├── secrets.ts
│   │   ├── flags.ts
│   │   ├── telemetry.ts
│   │   ├── permission.ts
│   │   └── index.ts
│   ├── events.ts
│   ├── slots.ts
│   ├── manifest.ts
│   ├── permissions.ts
│   ├── canvas-contributions.ts
│   └── index.ts
```

#### 顶层文件

| 文件                      | 内容                                                                                                                           | 作用                                                                | 主要消费者                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------- |
| `manifest.ts`             | `PluginManifest`、`Contributions`、`EnterpriseManifest`、`ActivationEvent`、`InstallScope`、兼容/资源/出站/数据策略类型        | 插件清单的编译期契约；构建期校验、loader 安装、控制面审核共用       | loader、build、control-plane、插件作者 |
| `events.ts`               | 类型化事件表 `Events`、事件名常量、各事件 payload                                                                              | 插件通过 `ctx.on/emit/waterfall` 协作；统一事件命名，避免魔法字符串 | kernel、所有插件                       |
| `slots.ts`                | `SLOT` 常量、`SlotName` 联合类型、插槽条目类型、`when`/`order` 元数据                                                          | 宿主通用 `<LcSlot>` 与 manifest 贡献共用同一套插槽名                | vue 宿主、loader、UI 插件              |
| `permissions.ts`          | 静态权限声明 `Permission` 联合类型、权限字符串常量、风险等级/说明                                                              | manifest 申请能力、安装时展示、构建期校验；不负责运行时决策         | manifest、loader、控制面、安装 UI      |
| `canvas-contributions.ts` | `CanvasFeatureContribution`、`CanvasProfileContribution`、`InteractionHandler`、`CanvasLayer`、`SnapProvider`、`CanvasSetting` | 画布插件的注册面；CanvasHost 与画布插件共用                         | canvas 核心、canvas 插件、build        |
| `index.ts`                | 只做 re-export；可集中放 `declare module '@lc/kernel'` 的 Context 扩展                                                         | 插件只依赖一个入口，避免深层 import                                 | 所有包                                 |

#### services 目录

每个服务一个文件，文件内只有接口、类型、枚举、纯类型工具；实现分别在 `packages/services/*`。

| 文件              | 核心接口/类型                                                                                                                                                                                             | 作用                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `material.ts`     | `MaterialService`、`MaterialEntry`、`MaterialContribution`、`ResolvedMaterial`                                                                                                                            | 物料元数据、懒加载、注册表、冲突策略                                          |
| `setter.ts`       | `SetterService`、`SetterDefinition`                                                                                                                                                                       | 属性编辑器匹配（精确/format/match/类型兜底）                                  |
| `renderer.ts`     | `RendererService`、`RenderContext`、`ResolvedNode`                                                                                                                                                        | schema → 组件树解析、物料加载、渲染钩子                                       |
| `dataSource.ts`   | `DataSourceService`、`DataSourceType`、`DataSourceInstance`                                                                                                                                               | 数据源类型注册、实例创建、执行与取消                                          |
| `action.ts`       | `ActionService`、`Action`、`ActionContext`                                                                                                                                                                | 运行时动作（跳转、请求、脚本）注册与执行                                      |
| `command.ts`      | `CommandService`、`Command`、`CommandContext`                                                                                                                                                             | 设计时命令、菜单、快捷键、命令面板                                            |
| `workspace.ts`    | `WorkspaceService`、`EditorRealm`、`CanvasRealm`、`RealmOptions`                                                                                                                                          | 创建/查找文档 Realm、活动编辑器、Realm 生命周期                               |
| `document.ts`     | `DocumentService`、`DocumentModel`、`SchemaPatch`、`ValidationIssue`                                                                                                                                      | 文档读写、patch、校验、迁移、变更通知                                         |
| `history.ts`      | `HistoryService`、`HistoryEntry`                                                                                                                                                                          | 撤销/重做、事务提交后的历史记录                                               |
| `canvas.ts`       | `CanvasService`、`ViewportService`、`SceneService`、`HitTestService`、`MeasureService`、`SelectionService`、`InteractionService`、`LayerService`、`SnapService`、`TransactionService`、`SchedulerService` | 画布微内核全部服务契约；画布插件只依赖这里                                    |
| `loader.ts`       | `LoaderService`、`InstallRequest`、`ActivationEvent`、`PluginState`                                                                                                                                       | 安装/卸载/启用/停用/激活、签名与允许清单校验                                  |
| `contribution.ts` | `ContributionService`、`ContributionEntry`、`ContributionQuery`                                                                                                                                           | 声明式贡献注册、查询、启停、slot 列表、变化通知                               |
| `modules.ts`      | `ModuleService`、`ModuleLoadOptions`                                                                                                                                                                      | ESM 模块懒加载、并发去重、缓存、卸载清理、完整性校验                          |
| `i18n.ts`         | `I18nService`、`LocalePack`、`TranslateParams`                                                                                                                                                            | 文案、语言包、命名空间、回退语言                                              |
| `theme.ts`        | `ThemeService`、`ThemePack`、`ThemeTokens`                                                                                                                                                                | 设计令牌、主题包、明暗模式、租户品牌                                          |
| `storage.ts`      | `StorageService`、`StorageNamespace`、`StorageQuota`                                                                                                                                                      | 插件命名空间存储、文档级存储、配额、版本元信息                                |
| `http.ts`         | `HttpService`、`HttpRequestOptions`                                                                                                                                                                       | 带权限网关、超时、取消、审计的请求                                            |
| `audit.ts`        | `AuditService`、`AuditEvent`、`AuditQuery`                                                                                                                                                                | 审计事件写入/查询；高风险操作必须走它                                         |
| `policy.ts`       | `PolicyService`、`PolicyDecision`、`PolicyContext`                                                                                                                                                        | 策略决策、义务（审批/水印/只读）、策略版本                                    |
| `quota.ts`        | `QuotaService`、`QuotaLimit`、`QuotaUsage`                                                                                                                                                                | 租户/插件资源计量、配额检查与消费                                             |
| `secrets.ts`      | `SecretsService`、`SecretHandle`、`ShortLivedCredential`                                                                                                                                                  | 凭据句柄、短期凭据代换、轮换与吊销                                            |
| `flags.ts`        | `FeatureFlagService`、`FlagContext`、`KillSwitch`                                                                                                                                                         | 功能开关、Kill Switch、灰度变体                                               |
| `telemetry.ts`    | `TelemetryService`、`SpanHandle`、`MetricAttributes`                                                                                                                                                      | 插件维度 span/metric/log，租户/插件/文档属性                                  |
| `permission.ts`   | `PermissionService`、`PermissionCheck`                                                                                                                                                                    | 运行时权限检查（用户 ∩ 插件 ∩ 策略）；与静态的 `permissions.ts` 区分          |
| `index.ts`        | re-export + Context 模块扩展                                                                                                                                                                              | 聚合所有服务类型，插件 `import type { MaterialService } from '@lc/contracts'` |

#### 三个容易混淆的边界

1. **`permissions.ts` vs `services/permission.ts`**
   - `permissions.ts`：manifest 里“申请什么能力”的静态声明。
   - `services/permission.ts`：运行时“当前用户 + 当前插件 + 当前环境”能不能做某动作。
   - 两者都不等于策略中心；最终决策还要经过 `policy`。

2. **`manifest.ts` vs `contribution.ts`**
   - `manifest.ts`：插件包声明的静态结构与构建期规则。
   - `contribution.ts`：安装后注册到运行时的贡献条目、启停状态与查询。
   - manifest 是“声明”，contribution 是“已安装后的运行时视图”。

3. **`canvas.ts` vs `canvas-contributions.ts`**
   - `canvas.ts`：画布内核提供的服务接口（viewport、interaction、layers、snap……）。
   - `canvas-contributions.ts`：画布插件注册的扩展点结构（handler、layer、snap provider、setting、canvasFeatures/profile）。
   - 前者是“内核能做什么”，后者是“插件如何挂进来”。

> 命名建议：如果团队觉得 `permissions.ts` 与 `services/permission.ts` 容易混，可把后者改名为 `services/authorization.ts`，语义不变；本文保留现名以便与代码草案对应。

#### contracts 的硬性规则

- 只放类型、常量、纯函数；禁止实现、状态、单例、Vue 组件、DOM 访问。
- 只允许 `import type` 依赖 `@lc/kernel`、`@lc/schema`；禁止依赖 services/plugins/apps。
- 所有 `Context` 服务扩展集中在 contracts，插件不得各自 `declare module '@lc/kernel'`。
- 常量与类型同源：`SLOT` → `SlotName`，`Events` → 事件名，`Permission` → 权限字符串；禁止两处手写。
- 运行时校验不放在 contracts：manifest 校验在 loader/build，schema 校验在 `@lc/schema`。
- 版本策略：新增字段/服务是 minor，删除/改签名是 major；破坏性变更提前 12 个月公告（见 §25.4）。
- 契约测试必须覆盖：类型测试、常量快照、旧插件在新内核上的兼容性。

为什么值得单独一个包：

- 插件只依赖契约，不依赖其他插件，避免插件网状耦合；
- 宿主、插件、控制面、构建工具对同一个 manifest/事件/插槽有唯一解释；
- 类型即文档，IDE 能直接提示服务能力；
- 契约稳定后，内核和实现可以独立重构；
- 供应链审核可以只看 contracts + manifest，快速判断插件申请了什么能力。

### 6.3 核心服务清单

| 服务           | 作用域     | 是否平台必备 | 说明                                                                 |
| -------------- | ---------- | ------------ | -------------------------------------------------------------------- |
| `schema`       | 全局       | 是           | schema 解析、校验、迁移、patch                                       |
| `material`     | 全局       | 是           | 物料元数据、懒加载、冲突策略                                         |
| `setter`       | 全局       | 是           | 属性编辑器映射                                                       |
| `renderer`     | 全局/Realm | 是           | schema → 组件树、物料解析、错误降级                                  |
| `canvas`       | Realm      | 是           | 画布微内核入口：viewport / interaction / layers / snap / transaction |
| `loader`       | 全局       | 是           | 清单、贡献、激活、签名校验、权限                                     |
| `dataSource`   | 全局       | 是           | 数据源类型注册与执行                                                 |
| `action`       | 全局       | 是           | 运行时动作注册与执行                                                 |
| `command`      | 全局       | 是           | 设计时命令、快捷键、菜单                                             |
| `workspace`    | 全局       | 是           | 创建/查找 EditorRealm/CanvasRealm，维护活动编辑器                    |
| `contribution` | 全局       | 是           | 声明式贡献存储与查询                                                 |
| `modules`      | 全局       | 是           | 插件模块/物料模块懒加载与缓存                                        |
| `document`     | Realm      | 是           | 当前文档 schema、脏状态                                              |
| `history`      | Realm      | 是           | 撤销/重做                                                            |
| `selection`    | Realm      | 是           | 选中、悬停、拖拽                                                     |
| `designer`     | Realm      | 是           | 画布操作、插入/移动/删除                                             |
| `persistence`  | 全局/Realm | 否           | 保存、加载、自动保存                                                 |
| `i18n`         | 全局       | 是           | 文案、语言包                                                         |
| `theme`        | 全局       | 是           | 设计令牌、主题包                                                     |
| `storage`      | 全局       | 是           | 命名空间存储                                                         |
| `http`         | 全局       | 是           | 带权限与超时的请求                                                   |
| `telemetry`    | 全局       | 否           | 埋点、性能                                                           |
| `permission`   | 全局       | 是           | 能力校验                                                             |
| `audit`        | 全局       | 是           | 结构化审计写入，覆盖安装/配置/发布/执行                              |
| `policy`       | 全局       | 是           | 策略决策：租户、环境、资源、数据分级                                 |
| `quota`        | 全局       | 是           | 资源计量与配额                                                       |
| `secrets`      | 全局       | 是           | 插件凭据代理与轮换                                                   |
| `flags`        | 全局       | 是           | 功能开关、Kill Switch、灰度                                          |
| `controlPlane` | 全局       | 是           | 控制面客户端：配置/策略/注册表同步                                   |

企业级服务由平台预设插件提供，部署形态可以替换实现（SaaS 远程控制面、专属控制面、离线本地控制面）。内核不认识这些服务，只负责生命周期。

### 6.4 注册表通用模型

物料、setter、数据源、动作、命令都符合同一个模式，避免每个服务重新发明一套。

```ts
export interface Registry<T> {
  /** 注册条目；返回 disposable，插件卸载时自动注销 */
  register(item: T): Disposable
  /** 按 key 查找 */
  get(key: string): T | undefined
  /** 列出全部，已按优先级排序 */
  list(): readonly T[]
  /** 版本号；Vue 适配层用它触发重渲染，不深度代理条目 */
  readonly version: number
  /** 条目变化通知 */
  onDidChange(listener: () => void): Disposable
}
```

```ts
export class SimpleRegistry<T extends { name: string }> implements Registry<T> {
  private items = new Map<string, T>()
  private listeners = new Set<() => void>()
  version = 0

  register(item: T): Disposable {
    if (!this.items.has(item.name)) {
      this.items.set(item.name, item)
      this.bump()
    }
    return {
      dispose: () => {
        if (this.items.get(item.name) !== item) return
        this.items.delete(item.name)
        this.bump()
      },
    }
  }

  get(name: string): T | undefined {
    return this.items.get(name)
  }

  list(): readonly T[] {
    return [...this.items.values()]
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  private bump(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}
```

> 示例用 `name` 作为 key；命令注册表以 `id` 为 key 时，把 key 取值换成对应字段即可，注册、注销、版本通知逻辑不变。

### 6.5 关键服务接口

#### 模块加载

```ts
export interface ModuleService {
  /** 加载并缓存 ESM 模块；同一 URL 的并发请求共享同一个 Promise */
  load<T = unknown>(url: string): Promise<T>
  /** 预加载一组模块；失败只上报，不阻塞主流程 */
  preload(urls: string[]): Promise<void>
  /** 插件卸载时清除其模块缓存，避免内存只增不减 */
  evict(plugin: string): void
}
```

#### 物料

```ts
export interface MaterialService extends Registry<MaterialEntry> {
  /** 解析并加载物料组件；并发调用共享同一个 Promise */
  ensure(name: string): Promise<ResolvedMaterial>
  /** 注册声明式贡献，由 loader 调用 */
  registerContribution(plugin: PluginManifest, item: MaterialContribution): Disposable
}

export interface MaterialEntry {
  /** 物料名 */
  name: string
  /** 归属插件，用于卸载与错误上报 */
  plugin: string
  /** 属性 schema */
  props: JsonSchema
  /** 是否容器 */
  container: boolean
  /** 渲染模式；SSR/导出不支持的物料走 headless browser */
  renderMode?: 'client' | 'ssr' | 'both'
  /** 懒加载组件 */
  load: () => Promise<MaterialModule>
}

export interface ResolvedMaterial extends MaterialEntry {
  /** 已加载的组件；运行时根据渲染器适配 Vue/React */
  component: unknown
}
```

#### 属性设置器

```ts
export interface SetterService extends Registry<SetterDefinition> {
  /** 根据属性 schema 选择设置器；找不到时回退到 JSON 类型默认设置器 */
  resolve(schema: JsonSchema): SetterDefinition
}

export interface SetterDefinition {
  /** 设置器名，如 color / expression / dataSource */
  name: string
  /** 匹配条件；material 的 props schema 可用 ui:setter 或 format 指定 */
  match: (schema: JsonSchema) => boolean
  /** 设置器组件，首次渲染该属性时加载 */
  load: () => Promise<unknown>
}
```

匹配顺序：`ui:setter` 精确匹配 → `format` 匹配 → `match()` 注册顺序 → JSON 类型兜底。兜底设置器由平台提供，保证任何物料至少能被编辑。

#### 渲染器

```ts
export interface RendererService {
  /** 解析节点：加载物料、计算绑定、返回可渲染描述 */
  resolve(node: NodeSchema, context: RenderContext): Promise<ResolvedNode>
  /** 注册渲染钩子；插件卸载时自动移除 */
  registerHook(hook: RendererHook): Disposable
}
```

Vue 实现放在 `@lc/vue`；小程序、SSR、静态 HTML 导出可以替换适配器，内核和契约不依赖 Vue。

#### 数据源

```ts
export interface DataSourceService extends Registry<DataSourceType> {
  /** 根据实例配置创建数据源实例 */
  create(type: string, options: unknown): Promise<DataSourceInstance>
}

export interface DataSourceType {
  /** 类型标识，如 http、graphql、mock */
  name: string
  /** 展示名 */
  title: string
  /** 执行位置；confidential 数据源建议 server */
  execution?: 'browser' | 'worker' | 'server'
  /** 服务端执行入口；execution=server 时必填 */
  serverMain?: string
  /** 实例配置 schema，设计器据此生成表单 */
  configSchema: JsonSchema
  /** 创建实例；signal 在文档关闭/预览结束时 abort */
  create(options: unknown, context: DataSourceContext): Promise<DataSourceInstance>
}

export interface DataSourceInstance {
  /** 执行一次查询 */
  run(params: unknown, signal: AbortSignal): Promise<unknown>
  /** 可选：销毁连接池、取消订阅 */
  dispose?(): void
}
```

#### 命令与动作

```ts
export interface CommandService extends Registry<Command> {
  /** 执行命令；找不到返回 undefined */
  execute(id: string, ...args: unknown[]): Promise<unknown>
}

export interface Command {
  /** 命令 id，建议命名空间化 */
  id: string
  /** 展示名 */
  title: string
  /** 是否可执行，用于菜单禁用态 */
  enabled?: (context: CommandContext) => boolean
  /** 执行体 */
  run(context: CommandContext, ...args: unknown[]): unknown
}

export interface ActionService extends Registry<Action> {
  /** 运行时执行动作 */
  execute(id: string, params: unknown, context: ActionContext): Promise<unknown>
}
```

命令用于设计时（撤销、删除、导出、打开面板），动作用于运行时（点击后跳转、请求、弹窗）。不要把两者合并，权限与上下文完全不同。

#### Schema 与历史

```ts
export interface DocumentService {
  /** 当前文档只读快照 */
  readonly snapshot: Readonly<DocumentModel>
  /** 应用 patch，产生一次可撤销操作 */
  apply(patches: SchemaPatch[], label: string): void
  /** 校验，返回问题列表 */
  validate(): ValidationIssue[]
  /** 迁移旧版本文档 */
  migrate(): void
  /** 文档变化通知 */
  onDidChange(listener: (patches: SchemaPatch[]) => void): Disposable
}

export interface HistoryService {
  /** 是否有可撤销操作 */
  readonly canUndo: boolean
  /** 是否有可重做操作 */
  readonly canRedo: boolean
  undo(): void
  redo(): void
  /** 清空历史，打开新文档时调用 */
  reset(): void
}
```

**所有修改都必须走 `document.apply()`**，禁止插件直接改 schema 对象。这是撤销、协作、脏状态、自动保存能成立的前提。

### 6.6 事件契约

事件命名用 `<领域>:<时机>`，例如：

```
schema:beforeSave
schema:afterLoad
schema:transform
document:open
document:close
canvas:drop
canvas:select
material:beforeRender
dataSource:beforeRequest
dataSource:afterResponse
command:beforeRun
export:before
export:after
```

规则：

- 事件名必须是共享常量，不能拼字符串；
- 事件 payload 用对象，不用长参数列表，方便演进；
- 会修改数据的管线用 `waterfall`，只通知的用 `emit`；
- 事件监听器必须通过 `ctx.on` 注册，自动回收；
- 事件不允许携带可变 DOM 节点或 Vue 实例。

---

## 7. 共享什么，不共享什么

这是平台架构里最容易失控的部分。原则：**共享稳定语义，不共享便利函数；共享契约，不共享状态。**

### 7.1 共享包矩阵

| 包                      | 共享内容                                             | 是否含 Vue | 稳定性              |
| ----------------------- | ---------------------------------------------------- | ---------- | ------------------- |
| `@lc/kernel`            | Context、生命周期、服务、事件、effect、配置          | 否         | 内核级，严格 semver |
| `@lc/contracts`         | 服务接口、事件、slot、权限、manifest 类型、常量      | 否         | 稳定，只增不改      |
| `@lc/schema`            | 节点模型、表达式 AST、patch、校验、迁移工具          | 否         | 稳定                |
| `@lc/shared`            | 日志、ID、深合并、存储适配器、HTTP 封装、i18n 工具   | 否         | 稳定                |
| `@lc/loader`            | manifest 扫描、贡献注册、激活、权限、远程安装        | 否         | 演进中              |
| `@lc/canvas`            | 画布微内核：视口、交互管线、图层、吸附、事务         | 否         | 稳定                |
| `@lc/security`          | 权限网关、出站代理、凭据句柄、签名校验               | 否         | 稳定                |
| `@lc/sandbox`           | iframe/Worker 沙箱、RPC 协议、消息校验               | 否         | 稳定                |
| `@lc/server-runtime`    | S 服务端插件 Host、容器生命周期、Server RPC          | 否         | 演进中              |
| `@lc/control-plane-sdk` | 控制面客户端、策略/授权类型、配置同步                | 否         | 演进中              |
| `@lc/audit`             | 审计事件 schema、写入客户端、脱敏工具                | 否         | 稳定                |
| `@lc/telemetry`         | OpenTelemetry 封装、插件维度指标、脱敏               | 否         | 稳定                |
| `@lc/vue`               | ctx 注入、Slot、错误边界、响应式桥接、HMR            | 是         | 稳定                |
| `@lc/ui`                | 设计器外壳组件：按钮、表单、弹窗、树                 | 是         | 演进中              |
| `@lc/testing`           | createTestApp、fake services、契约测试、租户隔离测试 | 否         | 稳定                |
| `@lc/build`             | Vite 预设、manifest 代码生成、dts 打包、SBOM 挂钩    | 否         | 稳定                |
| `@lc/devtools`          | 插件树、服务表、事件日志、依赖图、画布调试           | 是         | 可选                |

### 7.2 必须单例的依赖

以下依赖在运行时只能有一份，插件必须 external，不能各自打包：

- `@lc/kernel`：Context / Service / 事件类型身份必须一致；
- `@lc/contracts`：类型 + 常量，重复不会崩，但应保持一致；
- `vue`：两份 Vue 会导致响应式、组件实例、provide/inject 全部失效；
- `@lc/schema`：schema 模型与 patch 的类型判断依赖同一份代码；
- `@lc/canvas`：每个 CanvasRealm 只能有一份画布微内核，双份会导致坐标、图层、事件管线错乱；
- `@lc/security`：权限网关必须只包一层，重复包装会导致审计重复与权限交集错误；
- `@lc/telemetry`：全局 Tracer/Meter Provider 唯一；
- `@lc/audit`：审计写入器唯一，避免乱序与重复；
- i18n 实例、主题令牌、图标注册表：运行时单例。

工程手段：

- 插件的 `peerDependencies` 声明 `vue`、`@lc/kernel`、`@lc/contracts`；
- Vite 库构建 `rollupOptions.external` 排除这些包；
- 应用侧 `resolve.dedupe: ['vue', '@lc/kernel']`；
- 远程插件用 import map 固定 shared 依赖版本；
- 安装时做“重复依赖检测”，发现插件自带 kernel/vue 直接拒绝。

### 7.3 共享 UI、样式与主题

- 设计器外壳样式进 `@lc/ui`，物料组件不进，避免运行时包被设计器样式污染。
- 共享设计令牌（颜色、间距、字体、圆角）通过 CSS 变量下发，插件只消费，不覆盖根令牌。
- 插件样式统一加前缀 `lc-<plugin>-`，并放进 `@layer lowcode.plugins`，避免优先级战争。
- 不可信插件的 UI 放 iframe，不允许向主文档注入全局 CSS。
- 图标统一走图标注册表，禁止各插件打包重复图标集；常用图标用 SVG sprite 懒加载。

### 7.4 共享存储与数据边界

| 数据             | 存放位置                            | 归属            |
| ---------------- | ----------------------------------- | --------------- |
| 插件配置         | 应用级配置存储                      | loader          |
| 插件私有数据     | `ctx.storage.namespace(pluginName)` | 插件            |
| 文档 schema      | 文档存储                            | `document` 服务 |
| 文档级临时状态   | Realm 内存                          | Realm 服务      |
| 物料/主题/语言包 | 构建产物或 CDN                      | 插件包          |
| 用户偏好         | 应用级存储                          | 宿主            |

规则：

- 插件不得直接读写 `localStorage` / `indexedDB`，必须走 `ctx.storage`；
- 存储 key 自动加插件命名空间，避免冲突；
- 卸载插件默认保留数据，重新安装可恢复；`manifest.dataPolicy = 'purge'` 才清除；
- 文档数据与插件版本解耦，插件升级必须能读旧文档（或提供迁移）。

### 7.5 共享工具链

- `tsconfig.base.json`：strict、`moduleResolution: bundler`、`verbatimModuleSyntax`；
- ESLint：禁止插件互相 import、禁止直接使用 `setTimeout` / `addEventListener`（要求走 ctx.effect）、禁止魔法 slot 字符串；
- Vite 预设：统一 external、dts、manifest 生成、Vue SFC 编译；
- Vitest：内核单测 + 插件契约测试；
- Playwright：设计器拖拽、安装/卸载、面板打开；
- Changesets：独立版本与 changelog；
- dependency-cruiser：检查分层依赖方向。

### 7.6 不要共享什么

- **不要做一个巨大的 `@lc/utils`**：只共享稳定、跨三个以上包使用的工具；插件私有工具留在插件内。
- **不要共享全局可变状态**：除明确设计的单例服务，其他状态挂 Realm 或插件实例。
- **不要把 Pinia store 当跨插件服务**：插件内部可以用 Pinia 管理自己的 UI 状态，但跨插件状态必须通过契约服务暴露，并遵守 Realm 生命周期；Pinia 是 Vue 应用级单例，无法表达依赖与卸载。
- **不要共享业务模型**：订单、客户、页面模板属于业务插件或应用，不属于平台契约。
- **不要共享 Vue 组件实例 / store**：跨插件传递响应式对象会制造隐式耦合，传 ID 或只读快照。
- **不要共享“快捷方式”服务**：例如 `ctx.helpers.doEverything()`，这种服务三个月后必然变成新的单体。

---

## 8. Vue 3 宿主集成

内核与 Vue 解耦，Vue 适配层只做四件事：注入 Context、渲染 Slot、桥接响应式、兜住错误。

### 8.1 注入 Context

```ts
// packages/vue/src/context.ts
import type { App, InjectionKey, Ref } from 'vue'
import { inject, onScopeDispose, shallowRef } from 'vue'
import type { Context } from '@lc/kernel'

export const LowcodeKey: InjectionKey<Context> = Symbol('lowcode')

export function createLowcodePlugin(ctx: Context) {
  return {
    install(app: App) {
      app.provide(LowcodeKey, ctx)
      // 兜底错误上报；组件级边界仍由 PluginBoundary 负责
      app.config.errorHandler = (error, _instance, info) => {
        ctx.diagnostics.report(error, { phase: 'runtime' })
      }
    },
  }
}

export function useLowcode(): Context {
  const ctx = inject(LowcodeKey)
  if (!ctx) throw new Error('[lowcode] 未找到 Lowcode Context')
  return ctx
}
```

### 8.2 Slot 渲染器

宿主不写任何具体面板，只写一个通用渲染器：

```vue
<!-- packages/vue/src/Slot.vue -->
<script setup lang="ts">
import { computed, shallowRef, watchEffect, type Component } from 'vue'
import type { SlotName } from '@lc/contracts'
import { useLowcode } from './context'
import PluginBoundary from './PluginBoundary.vue'

const props = defineProps<{
  name: SlotName
  props?: Record<string, unknown>
}>()

const ctx = useLowcode()
const entries = computed(() => ctx.contribution.list(props.name))
const modules = shallowRef(new Map<string, Component>())

watchEffect(() => {
  for (const entry of entries.value) {
    if (modules.value.has(entry.id)) continue
    void ctx.modules
      .load(entry.module)
      .then((component) => {
        modules.value = new Map(modules.value).set(entry.id, component)
      })
      .catch((error) => {
        ctx.diagnostics.report(error, { phase: 'runtime' })
      })
  }
})
</script>

<template>
  <PluginBoundary v-for="entry in entries" :key="entry.id" :plugin-id="entry.plugin">
    <component :is="modules.get(entry.id)" v-bind="props.props" />
  </PluginBoundary>
</template>
```

### 8.3 响应式桥接

**不要把内核对象深度 `reactive()`。** 原因：插件对象、服务实例、组件模块都可能很大，深层代理会带来性能和身份问题，还会让第三方库拿到代理对象后行为异常。

正确做法：

- 注册表维护 `version` 计数；
- Vue 侧用 `shallowRef` + `computed` 读取快照；
- 服务出现/消失通过 `internal/service` 通知；
- 文档 schema 用不可变 patch，Vue 侧整体替换快照。

```ts
export function useRegistry<T>(registry: Registry<T>) {
  const version = shallowRef(0)
  const stop = registry.onDidChange(() => {
    version.value += 1
  })
  onScopeDispose(() => stop.dispose())
  return computed(() => {
    void version.value // 建立依赖
    return registry.list()
  })
}

export function useService<T>(name: string) {
  const ctx = useLowcode()
  const value = shallowRef(ctx.get<T>(name))
  const stop = ctx.services.onDidChange(name, (next) => {
    value.value = next as T | undefined
  })
  onScopeDispose(() => stop.dispose())
  return value
}
```

### 8.4 物料渲染与异步加载

运行时渲染节点时，物料组件可能还没下载：

1. 从 `material.ensure(name)` 取组件；并发请求共享 Promise；
2. 加载期间渲染骨架，保持画布布局稳定；
3. 加载失败渲染 fallback 组件，并发出 `material:loadError`；
4. 组件运行时报错由 `PluginBoundary` 捕获，替换为错误占位；
5. SSR / 导出静态 HTML 时，先扫描 schema 用到的物料并预加载。

### 8.5 HMR

开发期插件热更新不能整页刷新：

```ts
if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    if (!mod?.default) return
    // 保留 rawConfig，停用旧实例后用新定义重新激活
    runtime.reload(pluginName, mod.default)
  })
}
```

对声明式贡献，Vite 插件重新生成 manifest 后，loader 做 diff：新增注册、删除注销、变更的条目替换。正在编辑的文档状态不受影响。

### 8.6 错误边界

```vue
<!-- packages/vue/src/PluginBoundary.vue -->
<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'
import { useLowcode } from './context'

const props = defineProps<{ pluginId: string }>()
const ctx = useLowcode()
const failed = ref<Error | null>(null)

onErrorCaptured((error) => {
  failed.value = error
  ctx.diagnostics.report(error, { pluginId: props.pluginId, phase: 'runtime' })
  return false // 阻止继续冒泡，避免整个设计器白屏
})
</script>

<template>
  <div v-if="failed" class="lc-plugin-error" role="alert">
    插件 {{ props.pluginId }} 渲染失败
  </div>
  <slot v-else />
</template>
```

---

## 9. Monorepo 工程结构

### 9.1 目录树

```
lowcode-platform/
├── .changeset/
├── .github/
│   ├── CODEOWNERS
│   ├── dependabot.yml
│   ├── pull_request_template.md
│   └── workflows/
│       ├── ci.yml
│       ├── compatibility.yml
│       ├── e2e.yml
│       ├── release.yml
│       ├── security-scan.yml
│       └── supply-chain.yml
├── .vscode/
├── docs/
│   ├── lowcode-plugin-platform-design.md
│   ├── adr/
│   │   ├── 0001-thin-kernel.md
│   │   ├── 0002-canvas-microkernel.md
│   │   ├── 0003-control-data-plane.md
│   │   ├── 0004-tenant-isolation.md
│   │   ├── 0005-trust-tiers.md
│   │   └── 0006-supply-chain.md
│   ├── api/
│   │   ├── kernel.md
│   │   ├── canvas.md
│   │   ├── manifest.md
│   │   └── services.md
│   ├── guides/
│   │   ├── plugin-authoring.md
│   │   ├── canvas-plugin-authoring.md
│   │   ├── security-review.md
│   │   ├── release-and-rollback.md
│   │   └── offline-install.md
│   ├── operations/
│   │   ├── slo.md
│   │   ├── dr-plan.md
│   │   ├── incident-response.md
│   │   └── runbooks/
│   └── compliance/
│       ├── control-mapping.md
│       ├── data-classification.md
│       └── dsar.md
├── examples/
│   ├── hello-plugin/
│   ├── hello-canvas-plugin/
│   ├── material-chart/
│   └── enterprise-tenant-config/
├── infra/
│   ├── docker/
│   │   ├── designer.Dockerfile
│   │   ├── player.Dockerfile
│   │   ├── control-plane.Dockerfile
│   │   └── registry.Dockerfile
│   ├── helm/
│   │   └── lowcode-platform/
│   │       ├── Chart.yaml
│   │       ├── values.yaml
│   │       ├── values-prod.yaml
│   │       ├── values-offline.yaml
│   │       └── templates/
│   │           ├── designer.yaml
│   │           ├── player.yaml
│   │           ├── control-plane.yaml
│   │           ├── registry.yaml
│   │           ├── postgres.yaml
│   │           ├── redis.yaml
│   │           ├── object-storage.yaml
│   │           ├── otel-collector.yaml
│   │           └── ingress.yaml
│   ├── offline/
│   │   ├── bundle.sh
│   │   └── images.txt
│   ├── policies/
│   │   ├── opa/
│   │   │   ├── install.rego
│   │   │   ├── publish.rego
│   │   │   ├── export.rego
│   │   │   └── tenant.rego
│   │   └── kyverno/
│   └── terraform/
│       ├── envs/
│       │   ├── dev/
│       │   ├── staging/
│       │   └── prod/
│       └── modules/
│           ├── network/
│           ├── kubernetes/
│           ├── postgres/
│           ├── redis/
│           ├── object-storage/
│           ├── kms/
│           └── observability/
├── packages/
│   ├── kernel/
│   │   ├── src/
│   │   │   ├── context.ts
│   │   │   ├── service.ts
│   │   │   ├── runtime.ts
│   │   │   ├── effect.ts
│   │   │   ├── events.ts
│   │   │   ├── config.ts
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── tests/
│   │   │   ├── lifecycle.spec.ts
│   │   │   ├── dependencies.spec.ts
│   │   │   ├── isolation.spec.ts
│   │   │   ├── config.spec.ts
│   │   │   └── effects.spec.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vite.config.ts
│   ├── contracts/
│   │   ├── src/
│   │   │   ├── services/
│   │   │   │   ├── material.ts
│   │   │   │   ├── setter.ts
│   │   │   │   ├── renderer.ts
│   │   │   │   ├── dataSource.ts
│   │   │   │   ├── action.ts
│   │   │   │   ├── command.ts
│   │   │   │   ├── workspace.ts
│   │   │   │   ├── document.ts
│   │   │   │   ├── history.ts
│   │   │   │   ├── canvas.ts
│   │   │   │   ├── loader.ts
│   │   │   │   ├── contribution.ts
│   │   │   │   ├── modules.ts
│   │   │   │   ├── i18n.ts
│   │   │   │   ├── theme.ts
│   │   │   │   ├── storage.ts
│   │   │   │   ├── http.ts
│   │   │   │   ├── audit.ts
│   │   │   │   ├── policy.ts
│   │   │   │   ├── quota.ts
│   │   │   │   ├── secrets.ts
│   │   │   │   ├── flags.ts
│   │   │   │   ├── telemetry.ts
│   │   │   │   └── permission.ts
│   │   │   ├── events.ts
│   │   │   ├── slots.ts
│   │   │   ├── manifest.ts
│   │   │   ├── permissions.ts
│   │   │   ├── canvas-contributions.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── schema/
│   │   ├── src/
│   │   │   ├── document.ts
│   │   │   ├── node.ts
│   │   │   ├── expression.ts
│   │   │   ├── patch.ts
│   │   │   ├── validate.ts
│   │   │   ├── migrate.ts
│   │   │   └── index.ts
│   │   ├── tests/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── shared/
│   │   ├── src/
│   │   │   ├── logger.ts
│   │   │   ├── id.ts
│   │   │   ├── deepMerge.ts
│   │   │   ├── http.ts
│   │   │   ├── storage.ts
│   │   │   ├── i18n.ts
│   │   │   ├── result.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── loader/
│   │   ├── src/
│   │   │   ├── manifest.ts
│   │   │   ├── contribution.ts
│   │   │   ├── activation.ts
│   │   │   ├── install.ts
│   │   │   ├── moduleLoader.ts
│   │   │   ├── policy.ts
│   │   │   └── index.ts
│   │   ├── tests/
│   │   └── package.json
│   ├── canvas/
│   │   ├── src/
│   │   │   ├── viewport.ts
│   │   │   ├── scene.ts
│   │   │   ├── hitTest.ts
│   │   │   ├── measure.ts
│   │   │   ├── selection.ts
│   │   │   ├── transaction.ts
│   │   │   ├── scheduler.ts
│   │   │   ├── interaction/
│   │   │   │   ├── pipeline.ts
│   │   │   │   ├── gestures.ts
│   │   │   │   └── events.ts
│   │   │   ├── layers/
│   │   │   │   ├── layerHost.ts
│   │   │   │   └── bands.ts
│   │   │   ├── snap/
│   │   │   │   ├── engine.ts
│   │   │   │   ├── providers.ts
│   │   │   │   └── types.ts
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── tests/
│   │   │   ├── coordinates.spec.ts
│   │   │   ├── zoom-invariant.spec.ts
│   │   │   ├── snap.spec.ts
│   │   │   ├── interaction-conflict.spec.ts
│   │   │   └── transaction.spec.ts
│   │   ├── package.json
│   │   └── vite.config.ts
│   ├── security/
│   │   ├── src/
│   │   │   ├── permissionGateway.ts
│   │   │   ├── egress.ts
│   │   │   ├── secretHandle.ts
│   │   │   ├── signature.ts
│   │   │   ├── sanitize.ts
│   │   │   └── index.ts
│   │   └── tests/
│   ├── sandbox/
│   │   ├── src/
│   │   │   ├── iframeHost.ts
│   │   │   ├── workerHost.ts
│   │   │   ├── serverSandbox.ts
│   │   │   ├── rpc.ts
│   │   │   ├── protocol.ts
│   │   │   └── index.ts
│   │   └── tests/
│   ├── server-runtime/
│   │   ├── src/
│   │   │   ├── host.ts
│   │   │   ├── container.ts
│   │   │   ├── rpc.ts
│   │   │   ├── protocol.ts
│   │   │   └── index.ts
│   │   └── tests/
│   ├── control-plane-sdk/
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── tenant.ts
│   │   │   ├── policy.ts
│   │   │   ├── config.ts
│   │   │   ├── registry.ts
│   │   │   ├── telemetry.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── audit/
│   │   ├── src/
│   │   │   ├── event.ts
│   │   │   ├── writer.ts
│   │   │   ├── redact.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── telemetry/
│   │   ├── src/
│   │   │   ├── browser.ts
│   │   │   ├── server.ts
│   │   │   ├── attributes.ts
│   │   │   ├── sampling.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── vue/
│   │   ├── src/
│   │   │   ├── context.ts
│   │   │   ├── Slot.vue
│   │   │   ├── PluginBoundary.vue
│   │   │   ├── CanvasStage.vue
│   │   │   ├── LayerHost.vue
│   │   │   ├── useRegistry.ts
│   │   │   ├── useService.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── ui/
│   │   ├── src/
│   │   │   ├── components/
│   │   │   ├── tokens/
│   │   │   ├── styles/
│   │   │   └── index.ts
│   │   └── package.json
│   ├── testing/
│   │   ├── src/
│   │   │   ├── createTestApp.ts
│   │   │   ├── fakeServices.ts
│   │   │   ├── canvasHarness.ts
│   │   │   ├── tenantHarness.ts
│   │   │   ├── contract.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── build/
│   │   ├── src/
│   │   │   ├── vitePluginManifest.ts
│   │   │   ├── vitePreset.ts
│   │   │   ├── dts.ts
│   │   │   ├── sbom.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── devtools/
│   │   ├── src/
│   │   │   ├── pluginTree/
│   │   │   ├── serviceTable/
│   │   │   ├── dependencyGraph/
│   │   │   ├── canvasInspector/
│   │   │   └── index.ts
│   │   └── package.json
│   ├── presets/
│   │   ├── preset-designer/
│   │   ├── preset-player/
│   │   ├── preset-canvas/
│   │   └── preset-enterprise/
│   ├── services/
│   │   ├── service-canvas-core/
│   │   ├── service-material/
│   │   ├── service-setter/
│   │   ├── service-renderer/
│   │   ├── service-datasource/
│   │   ├── service-action/
│   │   ├── service-command/
│   │   ├── service-workspace/
│   │   ├── service-document/
│   │   ├── service-history/
│   │   ├── service-persistence/
│   │   ├── service-i18n/
│   │   ├── service-theme/
│   │   ├── service-storage/
│   │   ├── service-http/
│   │   ├── service-audit/
│   │   ├── service-policy/
│   │   ├── service-quota/
│   │   ├── service-secrets/
│   │   ├── service-flags/
│   │   └── service-telemetry/
│   ├── plugins/
│   │   ├── plugin-materials-basic/
│   │   ├── plugin-materials-charts/
│   │   ├── plugin-datasource-http/
│   │   ├── plugin-datasource-graphql/
│   │   ├── plugin-action-script/
│   │   ├── plugin-panel-outline/
│   │   ├── plugin-panel-ai/
│   │   ├── plugin-export-vue/
│   │   ├── plugin-export-react/
│   │   ├── plugin-shortcuts/
│   │   ├── plugin-theme-enterprise/
│   │   └── plugin-locale-zh/
│   └── canvas-plugins/
│       ├── canvas-zoom/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   └── ZoomSettings.vue
│       │   ├── tests/
│       │   │   ├── wheel.spec.ts
│       │   │   └── zoom-at.spec.ts
│       │   ├── package.json
│       │   └── vite.config.ts
│       ├── canvas-pan/
│       ├── canvas-resize/
│       ├── canvas-rotate/
│       ├── canvas-selection/
│       ├── canvas-drag/
│       ├── canvas-drop/
│       ├── canvas-snap/
│       ├── canvas-guides/
│       ├── canvas-grid/
│       ├── canvas-rulers/
│       ├── canvas-align/
│       ├── canvas-context-menu/
│       └── canvas-minimap/
├── apps/
│   ├── designer/
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── App.vue
│   │   │   ├── bootstrap.ts
│   │   │   ├── layout/
│   │   │   ├── pages/
│   │   │   ├── plugins.generated.ts
│   │   │   └── styles/
│   │   ├── index.html
│   │   ├── package.json
│   │   └── vite.config.ts
│   ├── player/
│   ├── admin/
│   ├── control-plane/
│   │   ├── src/
│   │   │   ├── api/
│   │   │   ├── tenants/
│   │   │   ├── identity/
│   │   │   ├── registry/
│   │   │   ├── policy/
│   │   │   ├── release/
│   │   │   ├── audit/
│   │   │   ├── quota/
│   │   │   └── main.ts
│   │   ├── migrations/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── registry/
├── scripts/
│   ├── create-plugin.ts
│   ├── create-canvas-plugin.ts
│   ├── generate-manifests.ts
│   ├── sign-artifacts.ts
│   ├── verify-signatures.ts
│   ├── check-compat.ts
│   ├── offline-bundle.ts
│   └── release.ts
├── tests/
│   ├── e2e/
│   ├── performance/
│   ├── security/
│   ├── isolation/
│   └── fixtures/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── turbo.json
├── .npmrc
├── .nvmrc
├── .editorconfig
├── .gitignore
├── .gitattributes
├── CODEOWNERS
├── SECURITY.md
├── CONTRIBUTING.md
├── CHANGELOG.md
└── LICENSE
```

### 9.2 包规范

- 全部 ESM：`"type": "module"`；
- 每个包只暴露 `exports`，不暴露内部路径；
- 内部包用 `workspace:^`，发布时由 changesets 替换为 semver；
- 应用插件包 `peerDependencies` 声明 `vue`、`@lc/kernel`、`@lc/contracts`；
- 画布插件包额外声明 `@lc/canvas`，覆盖层组件声明 `vue`；
- 安全/控制面相关包不允许进入物料或画布插件依赖；
- 每个插件包必须有 `lowcode` 字段和构建后的 `dist/plugin.json`；
- 类型产物用 `vite-plugin-dts` 打包成单文件 `.d.ts`。

画布插件包粒度 = 发布边界。14 个包适合大团队/市场化；小团队可以先合并成 `canvas-core-features`、`canvas-snap-suite`、`canvas-hud` 3～4 个包，manifest 仍用独立 `canvasFeatures` id，之后按需拆包。

库构建示例：

```ts
// packages/plugins/plugin-datasource-http/vite.config.ts
import { defineConfig } from 'vite'
import { lowcodeManifest } from '@lc/build'

export default defineConfig({
  plugins: [lowcodeManifest()],
  build: {
    target: 'es2022',
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['vue', '@lc/kernel', '@lc/contracts', '@lc/shared'],
    },
  },
})
```

应用侧：

```ts
// packages/apps/designer/vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { lowcodePlugins } from '@lc/build'

export default defineConfig({
  plugins: [vue(), lowcodePlugins()],
  resolve: {
    dedupe: ['vue', '@lc/kernel', '@lc/contracts'],
  },
  optimizeDeps: {
    exclude: ['@lc/kernel', '@lc/vue'],
  },
})
```

### 9.3 开发期源码直连

Monorepo 里不必每次先构建依赖包。两种做法：

1. Vite alias 指向各包 `src`，生产构建仍走 `dist`；
2. `exports` 加 `development` 条件，dev 解析到源码，build 解析到 dist。

```json
{
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

注意：源码直连时，插件包里的 Vue SFC 需要应用侧 Vite 能处理，因此 alias 方案要确保 `@vitejs/plugin-vue` 作用到 workspace 源码。

### 9.4 Manifest 代码生成

`@lc/build` 的 Vite 插件做四件事：

1. 扫描 workspace 与 `node_modules` 中带 `lowcode` 字段的包；
2. 校验 manifest（engine、字段、权限、provides 与 exports 是否一致）；
3. 生成 `virtual:lowcode-plugins`，包含静态 manifest 和 `load()`；
4. 监听 `package.json` 变化，dev 时重新生成并触发热更新。

不要用 `import.meta.glob('/node_modules/**')`，不可靠且难以控制 chunk。

### 9.5 CI 与发布

```
pnpm install
pnpm lint
pnpm typecheck
pnpm test            # 内核单测 + 契约测试
pnpm build           # turbo 按依赖拓扑构建
pnpm test:e2e        # Playwright
pnpm changeset       # 版本与 changelog
pnpm release         # 发布包 + 插件市场元数据
```

发布插件时额外产出：

- `dist/plugin.json`：manifest；
- `dist/index.js` + `dist/index.d.ts`；
- 物料/面板的独立 chunk；
- 签名（远程分发时）；
- 兼容性矩阵（内核版本、Vue 版本）。

---

## 10. 画布微内核：为什么画布能力也要插件化

### 10.1 单体画布的典型结局

第一版设计器通常长这样：

```
DesignerCanvas.vue  （3000 行）
├── 缩放 / 平移
├── 节点拖拽 / 框选 / 多选
├── 节点缩放 / 旋转
├── 吸附 / 辅助线 / 网格 / 标尺
├── 拖入物料 / 容器判定
├── 小地图 / 右键菜单 / 对齐分布
└── 快捷键 / 撤销重做
```

半年后会出现四个问题：

1. **无法裁剪**：表单设计器不需要旋转，大屏设计器不需要容器拖入，但代码拆不开。
2. **回归耦合**：改吸附逻辑会影响框选；改缩放会影响手柄命中；每次发版全量回归。
3. **坐标漂移**：每个功能各自维护 `zoom/offset`，手势叠加后位置对不上。
4. **性能不可控**：多个 `pointermove` 监听、多个 rAF、多个覆盖层各自重绘。

### 10.2 目标：画布微内核 + 画布插件

画布微内核之于画布插件，等于应用内核之于应用插件。它只做所有画布能力都必须共享的东西：

| 能力                                  | 归属     | 原因                                 |
| ------------------------------------- | -------- | ------------------------------------ |
| 坐标系与视口状态（x/y/zoom/rotation） | 内核服务 | 所有交互和覆盖层必须共享同一套变换   |
| 场景图 / 命中测试 / 测量              | 内核服务 | 拖拽、框选、吸附、手柄都要同一份几何 |
| 事件管线（pointer/wheel/keyboard）    | 内核服务 | 只能有一个根监听器，否则冲突不可控   |
| 图层宿主与 z-order                    | 内核服务 | 覆盖层必须可组合，不能各建 canvas    |
| 渲染调度（rAF / 脏标记）              | 内核服务 | 一帧一次，避免重绘风暴               |
| 事务 / 历史集成                       | 内核服务 | 手势预览与提交必须统一，才能撤销     |
| 选择状态                              | 内核服务 | 属性面板、命令、覆盖层共享选中集     |
| 缩放交互                              | 插件     | 滚轮/快捷键/按钮/fit 可以独立装卸    |
| 平移交互                              | 插件     | 空格拖拽/中键/触控板可以独立装卸     |
| 节点缩放/旋转                         | 插件     | 手柄、约束、角度吸附是业务能力       |
| 吸附引擎与提供者                      | 插件     | 网格/元素/辅助线候选可组合           |
| 辅助线/网格/标尺                      | 插件     | 纯可视化，可独立开关                 |
| 小地图/右键菜单/对齐分布              | 插件     | 非核心，按设计器类型装配             |

> 注意：这里说的是**插件**，不是普通 Vue 组件。画布插件可以包含 Vue 覆盖层组件，但它的本质是“生命周期 + 交互处理器 + 图层 + 命令 + 设置”的注册单元；只写一个 `<ZoomButton>` 组件，不叫画布插件。

### 10.3 一条硬规则：一个画布只能有一个舞台

画布插件**不允许**各自创建 `<canvas>` 或各自监听 `window.pointermove`。所有插件向同一个 `CanvasRealm` 注册：

```
CanvasRealm（每个文档一个）
├── 核心服务
│   ├── viewport      视口状态与坐标变换
│   ├── scene         场景图 / 节点注册 / 空间索引
│   ├── hitTest       命中测试
│   ├── measure       尺寸测量与缓存
│   ├── selection     选中集
│   ├── interaction   单根事件管线
│   ├── layers        图层宿主与 z-order
│   ├── transaction   手势事务 / patch 提交
│   └── scheduler     rAF 渲染调度
├── 画布插件（各自用 ctx.effect 注册）
│   ├── canvas-zoom / canvas-pan / canvas-camera-rotate
│   ├── canvas-resize / canvas-rotate
│   ├── canvas-selection / canvas-drag / canvas-drop
│   ├── canvas-snap / canvas-guides / canvas-grid / canvas-rulers
│   └── canvas-align / canvas-minimap / canvas-context-menu
└── 宿主组件
    ├── CanvasStage   唯一的内容舞台（CSS transform）
    └── LayerHost     唯一的覆盖层容器（按 band 分层）
```

这样才能保证：

- 所有插件用同一套 `screen ↔ world` 变换；
- 一帧只调度一次；
- 覆盖层 z-index 由 band 统一管理；
- 插件卸载时只移除自己的处理器/图层/命令；
- 画布可以整体做性能分析，而不是每个插件各说各话。

### 10.4 画布插件与预设

`preset-canvas` 不硬编码 import，而是声明产品预设：默认启用哪些 `canvasFeatures`、顺序与配置。CanvasHost 读取 manifest 贡献后实例化。

```json
{
  "name": "@lc/preset-canvas-designer",
  "lowcode": {
    "name": "preset-canvas-designer",
    "contributes": {
      "canvasProfiles": [
        {
          "id": "designer-default",
          "features": [
            "selection",
            "zoom",
            "pan",
            "drag",
            "drop",
            "resize",
            "rotate",
            "snap",
            "guides",
            "grid",
            "rulers",
            "align",
            "minimap"
          ]
        }
      ]
    }
  }
}
```

不同产品可以发布不同 profile；企业也可以在工作区覆盖启用的 feature 列表，而不需要 fork 设计器。

`preset-canvas` 是承载 profile 的插件，`canvasProfiles` 是 profile 数据，不是两套机制。CanvasHost 合并“profile 默认启用/顺序”与“已安装的 canvasFeatures”：profile 不能凭空启用未安装的插件，只能决定已安装能力的默认状态。

| 产品形态   | 画布预设                                                     |
| ---------- | ------------------------------------------------------------ |
| 表单设计器 | 缩放、平移、选择、拖拽、吸附、辅助线、网格；无旋转、无小地图 |
| 大屏设计器 | 全部 + 自由缩放 + 小地图 + 标尺 + 对齐分布                   |
| 流程编排器 | 缩放、平移、连线、节点拖拽；无节点缩放/旋转                  |
| 只读预览   | 缩放、平移；无选择/拖拽/手柄                                 |

预设只是“安装清单”，不是特权代码。任何画布插件都可以被企业自定义预设替换。

画布插件必须 `executionProfile: 'inline'`，认证等级只能是 `platform` 或 `verified + uiReview=inline`。Community 插件不能直接参与画布交互，只能贡献 iframe 面板或声明式物料。

### 10.5 非目标

- 不是通用图形引擎：不做 WebGL 渲染、不做无限白板级别的空间索引优化（架构可扩展，但 v1 不承诺）。
- 不是第二套插件框架：画布插件复用同一套 `Context / Service / Effect / 依赖`，只是挂载在 `CanvasRealm`。
- 不承诺“每个手势都插件化”：手势识别（click/drag/pinch）属于管线；具体业务动作（缩放、旋转、拖拽）才是插件。

---

## 11. 画布内核设计

### 11.1 CanvasRealm 的生命周期

```ts
// 打开文档时
const editor = app.workspace.createEditorRealm({ documentId })
const canvas = editor.createCanvasRealm()
canvas.context.plugin(canvasCore) // 提供 ctx.canvas 与核心服务
canvas.context.plugin(presetCanvas) // 按产品形态装配画布插件

// 关闭文档时
canvas.dispose() // 只关画布；editor.dispose() 会级联关闭文档与画布
```

规则：

- 一个文档一个主 `CanvasRealm`；对比预览、缩略图预览可以另建只读 CanvasRealm，拥有独立视口。
- 画布插件必须挂载在 CanvasRealm，不允许挂到 AppContext，否则多文档会共享视口和交互。
- 画布服务只在 CanvasRealm 内可见；应用级插件读取画布状态要通过文档级命令或只读快照。

### 11.2 坐标系与视口

画布有四个坐标系，必须严格区分：

| 坐标系     | 单位                  | 用途                              |
| ---------- | --------------------- | --------------------------------- |
| world      | 文档逻辑像素          | schema 中的节点位置、尺寸、辅助线 |
| screen     | 画布视口本地 CSS 像素 | 指针事件、覆盖层、手柄尺寸        |
| client     | 浏览器视口            | 事件原始坐标、拖拽出画布          |
| node-local | 节点自身坐标          | 节点内部布局、旋转中心            |

视口负责 `world ↔ screen`：

```ts
export interface ViewportState {
  /** 视口左上角对应的世界坐标 x */
  x: number
  /** 视口左上角对应的世界坐标 y */
  y: number
  /** 缩放倍数，1 表示 100% */
  zoom: number
  /** 视口旋转弧度；默认 0 */
  rotation: number
}

export interface ViewportService {
  /** 只读快照；不要直接改对象 */
  readonly state: Readonly<ViewportState>
  /** world → screen 的当前矩阵 */
  readonly matrix: DOMMatrix
  /** screen → world */
  screenToWorld(point: Point): Point
  /** world → screen */
  worldToScreen(point: Point): Point
  /** 视口中心对应的世界坐标 */
  readonly center: Point
  /** 围绕某个屏幕点缩放，保持该点下的世界坐标不动 */
  zoomAt(screen: Point, factor: number): void
  /** 平移，参数为屏幕像素 */
  panBy(delta: Point): void
  /** 缩放到容纳某个世界矩形 */
  fit(rect: Rect, padding?: number): void
  /** 设置视口；内部会 clamp 到 min/max zoom */
  set(next: Partial<ViewportState>): void
  /** 视口变化通知；覆盖层用它重绘 */
  onDidChange(listener: () => void): Disposable
}
```

关键实现细节：

- 变换顺序固定为 `translate(x, y) * scale(zoom) * rotate(rotation)`，所有插件不得自行拼接矩阵。
- `zoomAt` 必须满足不变量：缩放前后，指针下的世界坐标不变。单测要覆盖 zoom 0.1～8、rotation 0/90/180/270。
- 缩放范围 clamp（如 0.1～4），但具体数值由 `canvas-zoom` 插件配置，内核只提供 `set` 和边界校验。
- 内容舞台用 CSS `transform: matrix3d(...)`，走 GPU 合成；覆盖层**在屏幕空间绘制**，线宽、手柄、文字不随缩放变粗。
- 旋转视口后，指针命中必须用逆矩阵；不要用 `offsetX/offsetY` 直接当世界坐标。
- 设备像素比（DPR）下，1px 辅助线要按 `devicePixelRatio` 对齐，避免模糊。

### 11.3 场景图、测量与命中测试

画布内容仍然是 Vue 组件树（物料渲染），但内核维护一份几何索引：

```ts
export interface SceneService {
  /** 节点挂载/卸载时登记 DOM 与几何 */
  registerNode(nodeId: string, element: HTMLElement): Disposable
  /** 世界坐标下的包围盒；旋转节点返回 AABB */
  getBounds(nodeId: string): Rect | undefined
  /** 多个节点的联合包围盒 */
  getBounds(ids: string[]): Rect | undefined
  /** 当前文档的根尺寸 */
  getRootSize(): Size
  /** 当前文档的世界包围盒；fit 使用 */
  getRootBounds(): Rect
  /** schema 变化时失效测量缓存 */
  invalidate(nodeIds?: string[]): void
}

export interface HitTestService {
  /** 命中屏幕点下最深的节点；忽略覆盖层 */
  at(screen: Point): string | undefined
  /** 命中矩形内的节点；框选使用 */
  inRect(screenRect: Rect): string[]
  /** 命中容器节点，用于拖入判定 */
  containerAt(screen: Point): string | undefined
}

export interface MeasureService {
  /** 节点世界矩形；缓存由 scene.invalidate 控制 */
  measure(nodeId: string): Rect | undefined
  /** 批量测量，避免多次强制回流 */
  measureMany(ids: string[]): Map<string, Rect>
}
```

实现建议：

- 常规页面（< 2000 节点）用 DOM + `getBoundingClientRect()` + 缓存即可；指针移动期间禁止强制回流。
- 大页面用空间索引（R-tree/网格哈希）缓存世界包围盒；schema 变化时增量更新。
- 旋转节点的 AABB 只用于粗筛，最终命中用逆变换后的局部矩形。
- 容器判定与普通命中分开：`canvas-drop` 需要“最近的、允许接收子节点的容器”，不是最上层节点。

### 11.4 交互管线：一个根监听器，多个处理器

事件管线是画布微内核的核心。它把浏览器事件标准化后，按阶段分发给插件：

```ts
export type PointerPhase = 'capture' | 'target' | 'bubble'

export interface CanvasEventBase {
  /** 分发阶段；键盘事件也走 capture/target/bubble */
  phase: PointerPhase
  /** 修饰键快照 */
  modifiers: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }
  /** 命中的节点；覆盖层手柄另走 target */
  targetNodeId?: string
  /** 阻止浏览器默认行为；只有真正处理了才调用 */
  preventDefault(): void
  /** 阻止后续处理器；慎用 */
  stopPropagation(): void
}

export interface CanvasPointerEvent extends CanvasEventBase {
  /** 指针/滚轮/右键事件类型 */
  type:
    | 'pointerdown'
    | 'pointermove'
    | 'pointerup'
    | 'pointercancel'
    | 'wheel'
    | 'click'
    | 'dblclick'
    | 'contextmenu'
  /** 屏幕坐标（画布视口本地） */
  screen: Point
  /** 世界坐标，已经过逆矩阵 */
  world: Point
  /** 相对上一次事件的屏幕位移 */
  delta: Point
  /** PointerEvent.buttons 快照 */
  buttons: number
  /** 命中的手柄 id；不是手柄时为 undefined */
  targetHandleId?: string
  /** 指针 id，多指手势用 */
  pointerId: number
  /** 原始事件，仅用于 preventDefault / 读取 pressure 等 */
  originalEvent: PointerEvent | WheelEvent | MouseEvent
}

export interface CanvasKeyboardEvent extends CanvasEventBase {
  /** 键盘事件类型 */
  type: 'keydown' | 'keyup'
  /** KeyboardEvent.key，如 ArrowLeft、Delete */
  key: string
  /** KeyboardEvent.code，布局无关 */
  code: string
  /** 是否长按重复 */
  repeat: boolean
  /** 原始键盘事件 */
  originalEvent: KeyboardEvent
}

export type CanvasInputEvent = CanvasPointerEvent | CanvasKeyboardEvent

export function isPointerEvent(event: CanvasInputEvent): event is CanvasPointerEvent {
  return event.type !== 'keydown' && event.type !== 'keyup'
}

export type InteractionResult = 'pass' | 'handled' | 'stop' | void

export interface InteractionHandler<E extends CanvasInputEvent = CanvasPointerEvent> {
  /** 全局唯一 id，建议 <plugin>.<gesture> */
  id: string
  /** 默认 bubble；手柄类用 target/capture */
  phase?: PointerPhase
  /** 越大越先执行；同 phase 内排序 */
  priority?: number
  /** 廉价纯函数；不要在这里做 DOM 测量 */
  when?: (event: E, ctx: CanvasContext) => boolean
  /** 处理事件；返回 handled 表示消费 */
  handle: (event: E, ctx: CanvasContext) => InteractionResult
}
```

`InteractionHandler` 默认泛型是 `CanvasPointerEvent`；键盘插件显式写 `InteractionHandler<CanvasKeyboardEvent>`；`isPointerEvent` 做收窄。

分发规则：

1. 只有一个根 `pointerdown` 监听器，命中后 `setPointerCapture`；`pointermove/up` 走 capture 目标。
2. 处理器按 `phase`（capture → target → bubble）+ `priority` 排序；同一事件最多一个 `stop`。
3. `handled` 表示该处理器消费了本次事件，后续同阶段处理器跳过；`pass` 继续。
4. `preventDefault` 只在 `handled` 时调用，避免无谓地阻止页面滚动。
5. 位移超过阈值（默认 3px）才进入 drag 手势；否则 pointerup 生成 click。
6. 指针离开画布用 pointer capture 保持手势；`pointercancel` 必须回滚事务。
7. 滚轮监听必须 `{ passive: false }`，但只有缩放/平移插件返回 handled 时才 `preventDefault`。
8. 键盘事件只从画布焦点容器冒泡，输入框内不触发画布快捷键。
9. pointerdown 前先 `layers.hitTest(screen)`；命中 `data-handle-id` 时设置 `targetHandleId`，直接进入 target 阶段。
10. 右键菜单走 `contextmenu` 通道；键盘走 `keydown/keyup` 通道，两者与指针通道共用 phase/priority/stop 规则。

错误隔离：管线对每个 handler 单独 try/catch，失败时用 `ctx.diagnostics.report` 附带 `handlerId/pluginId`，然后继续下一个 handler；同一 handler 连续失败超过阈值（如 5 次/分钟）自动熔断并在 devtools 标红。一个画布插件不能因为一次异常阻断整个手势。

冲突处理示例：

| 场景                 | 胜出者                  | 机制                                         |
| -------------------- | ----------------------- | -------------------------------------------- |
| 按在缩放手柄上拖动   | `canvas-resize`         | 手柄在 handles 层，target 阶段，priority 100 |
| 按在节点上拖动       | `canvas-drag`           | bubble 阶段，priority 50                     |
| 空格 + 拖动          | `canvas-pan`            | `when` 检查 space，priority 80，选择插件让位 |
| 中键拖动             | `canvas-pan`            | `when` 检查 button=1                         |
| 空白处拖动           | `canvas-selection` 框选 | 无 targetNodeId 时生效                       |
| Ctrl/⌘ + 滚轮        | `canvas-zoom`           | `when` 检查 ctrl/meta，preventDefault        |
| 普通滚轮/触控板      | `canvas-pan`            | `when` 检查无修饰键                          |
| 旋转手柄 vs 缩放手柄 | 各自手柄                | 不同元素命中，互不冲突                       |

### 11.5 图层：覆盖层不是各自一张 canvas

图层按 band 统一管理，插件只注册“我要在哪个 band 画什么”：

```ts
export type LayerBand =
  | 'background' // 网格、背景
  | 'content' // 节点内容（通常由 CanvasStage 渲染，不开放）
  | 'selection' // 选中框、框选矩形
  | 'guides' // 辅助线、间距标注
  | 'handles' // 缩放手柄、旋转手柄
  | 'preview' // 拖拽预览、吸附幽灵
  | 'hud' // 标尺、小地图、缩放比例
  | 'modal' // 画布内弹层

export interface CanvasLayer {
  /** 全局唯一 id */
  id: string
  /** 图层带，决定基础 z-order */
  band: LayerBand
  /** 同 band 内排序，越大越靠上 */
  zIndex?: number
  /** none=整层穿透；children=容器穿透、子元素可命中；auto=整层命中 */
  pointerEvents?: 'none' | 'children' | 'auto'
  /** 可见条件；廉价纯函数 */
  visible?: (ctx: CanvasContext) => boolean
  /** 覆盖层模块，懒加载；由宿主解析为组件，核心不依赖 Vue */
  load: () => Promise<unknown>
}
```

规则：

- 覆盖层默认 `pointer-events: none`；手柄、右键菜单用 `children`，让容器穿透、只有子元素命中；只有小地图这类整层可交互的才用 `auto`。
- LayerHost 在 pointerdown 前调用 `layers.hitTest(screen)`，命中 `data-handle-id` 时设置 `targetHandleId`，再进入交互管线。
- 覆盖层组件在**屏幕空间**渲染，通过 `viewport.worldToScreen` 投影；不要给覆盖层套 `scale(zoom)`。
- 网格可以用 CSS `background-image` 或单独一张低分辨率 canvas；辅助线用 SVG；手柄用 DOM；小地图用 canvas。每个插件可以选择自己的技术，但都必须挂在统一 LayerHost 下。
- 图层数量预算：常驻不超过 10 层；拖拽时临时层在 `pointerup` 后立即卸载。
- z-order 冲突由 band + zIndex + 注册顺序决定；插件不能直接改 DOM 的 `z-index`。

### 11.6 渲染调度

```ts
export interface SchedulerService {
  /** 标记视口脏；下一帧更新内容舞台 transform */
  invalidateViewport(): void
  /** 标记某个覆盖层脏 */
  invalidateLayer(id: string): void
  /** 下一帧执行；返回取消函数 */
  nextFrame(task: () => void): Disposable
}
```

- 一帧最多一次内容 transform 更新、一次覆盖层批量重绘。
- 手势进行中，节点预览直接改 `style.transform`，**不要**每个 pointermove 写 schema / 触发 Vue 重渲染。
- `pointerup` 时提交事务，产生一次 patch / 一条历史记录。
- 视口变化时，内容舞台只改矩阵；覆盖层按需重绘，不重建节点组件树。
- 组件卸载时取消所有 rAF 与 ResizeObserver。

### 11.7 事务：预览与提交分离

```ts
export interface TransactionService {
  /** 开始一次手势事务；同一时刻只允许一个活动事务 */
  begin(options: { label: string; owner: string }): CanvasTransaction
}

export interface CanvasTransaction {
  /** 预览 patch；不写历史、不标脏文档 */
  preview(patches: SchemaPatch[]): void
  /** 提交；写入文档并产生一条历史 */
  commit(): void
  /** 取消；恢复到手势前状态 */
  cancel(): void
  /** 是否已结束 */
  readonly closed: boolean
}
```

- 拖拽、缩放、旋转、对齐、分布都必须走事务。
- 手势中允许预览多节点变换；`Esc`、`pointercancel`、窗口失焦触发 `cancel()`。
- 事务提交前必须做约束校验（最小尺寸、父容器边界、锁定节点、权限）。
- 事务 owner 用于诊断“谁没提交/谁重复提交”；同一文档同一时刻只允许一个活动手势事务（多指缩放由单个插件内部合并）。

### 11.8 吸附：引擎是插件，候选是提供者

吸附被拆成三层，避免“吸附”变成一个巨大的 if-else：

```ts
export type SnapAxis = 'x' | 'y' | 'angle' | 'distance'

export interface SnapCandidate {
  /** 吸附轴 */
  axis: SnapAxis
  /** 世界坐标值；angle 用弧度，distance 用世界像素 */
  value: number
  /** 来源 id，用于调试与辅助线样式 */
  source: string
  /** 吸附分层优先级：先按优先级分层，层内再比距离（网格 0、元素 1、参考线更高） */
  priority?: number
  /** 候选的显示范围，辅助线只画这一段 */
  range?: [number, number]
  /** 是否为该候选画辅助线；网格只吸附不画线 */
  showGuide?: boolean
}

export interface SnapProvider {
  /** 全局唯一 id */
  id: string
  /** 返回候选点；必须限制在当前视口附近，避免全量扫描 */
  getCandidates(context: SnapContext): SnapCandidate[]
}

export interface SnapService {
  /** 是否启用吸附；由设置/快捷键控制 */
  enabled: boolean
  /** 阈值以屏幕像素表示，内部按 zoom 换算，保证手感一致 */
  thresholdScreenPx: number
  registerProvider(provider: SnapProvider): Disposable
  /** 解析一组移动中的矩形/点，返回吸附结果与辅助线 */
  resolve(input: SnapInput): SnapResult
}
```

规则：

- 阈值用**屏幕像素**（如 6px），换算成世界单位 `threshold / zoom`；这样 10% 和 400% 下手感一致。
- 候选来源：网格、节点边/中心、标尺参考线、间距相等、角度步进（旋转）。
- 候选按“priority 分层 → 层内距离最近 → source 稳定排序”选择；同一轴只应用一个吸附，但可以显示多条辅助线。
- **移动中的元素自身既不是吸附目标也不是辅助线来源**：元素候选用 `SnapContext.movingIds` 排除被拖节点；网格候选由被拖元素的边推导（只是裁剪候选数量的手段），按构造永远贴着自身且距离极小，因此 `priority` 必须低于元素层、并用 `showGuide: false` 声明不画线，否则辅助线会贴在元素自己的边上、真实对象对齐也永远抢不过网格。
- 按住 `Alt` 临时禁用吸附；按住 `Shift` 约束轴向/角度步进。
- `SnapService` 由 `canvas-snap` 插件提供；`canvas-resize`、`canvas-drag`、`canvas-rotate` 通过**可选 inject** 使用它。没有安装 `canvas-snap` 时，这些插件仍然工作，只是不吸附。
- 辅助线渲染属于 `canvas-guides`；它订阅吸附结果或读取 `snap.lastResult`，不参与吸附计算。
- 性能：只收集视口内候选；节点数量大时用空间索引；一次 pointermove 只解析一次，多个插件共享结果。
- 错误隔离：每个 provider 单独 try/catch + 超时；失败只跳过该 provider 并上报，连续失败熔断；不能因为一个第三方 provider 抛错让整个吸附失效。

### 11.9 选择、测量与手柄的职责边界

- `selection` 是内核服务：保存选中 id、主选中、锚点、联合包围盒；不负责点击/框选交互。
- `canvas-selection` 是插件：处理点击、Shift 多选、空白框选、双击进入容器；调用 `selection.set()`。
- `canvas-resize` / `canvas-rotate` 读取 `selection.bounds`，在 handles 层画手柄；自己处理手柄命中。
- 属性面板通过 `selection` 和 `document` 读取选中节点，不直接依赖画布插件。
- 卸载 `canvas-selection` 后，选择服务仍在，命令/大纲仍可通过 id 选中节点；只是鼠标点击/框选没了。

### 11.10 画布内核的扩展点汇总

| 扩展点     | API                                             | 谁使用                                |
| ---------- | ----------------------------------------------- | ------------------------------------- |
| 交互处理器 | `ctx.canvas.interaction.register(handler)`      | 缩放、平移、选择、拖拽、缩放/旋转手柄 |
| 覆盖层     | `ctx.canvas.layers.register(layer)`             | 选择框、辅助线、手柄、小地图、标尺    |
| 命令       | `ctx.command.register(command)`                 | 放大、缩小、fit、对齐、分布、删除     |
| 快捷键     | `ctx.keybinding.register(binding)`              | +/−、0、Shift+1、空格                 |
| 吸附提供者 | `ctx.get('snap')?.registerProvider(provider)`   | 网格、节点、辅助线、间距              |
| 设置项     | `ctx.canvas.settings.register(setting)`         | 吸附阈值、网格大小、缩放步长          |
| 命中提供者 | `ctx.canvas.hitTest.registerProvider(provider)` | 自定义图形、连线                      |
| 右键菜单   | `ctx.canvas.contextMenu.register(item)`         | 画布/节点菜单                         |

所有注册都返回 `Disposable`，插件必须用 `ctx.effect` 托管。

### 11.11 坐标、事件、图层的性能预算

| 项             | 预算                | 说明                         |
| -------------- | ------------------- | ---------------------------- |
| 事件管线       | < 1 ms / 事件       | 只做标准化与分发，不做测量   |
| 单个交互处理器 | < 1 ms / 事件       | `when` 必须廉价              |
| 吸附解析       | < 2 ms（1000 节点） | 视口裁剪 + 空间索引          |
| 覆盖层重绘     | < 4 ms / 帧         | 只重绘脏层                   |
| 内容 transform | < 0.5 ms / 帧       | 只改矩阵                     |
| 常驻图层数     | ≤ 10                | 拖拽临时层用完即卸           |
| 交互处理器数   | ≤ 30                | 超过需要合并或按 `when` 裁剪 |

---

## 12. 画布插件契约

### 12.1 画布插件就是普通插件

没有第二种插件框架，也没有“画布组件基类”。画布插件就是普通插件，只是注入 `canvas` 服务、挂载在 CanvasRealm：

```ts
export default definePlugin({
  name: 'canvas-zoom',
  inject: ['canvas'],
  schema: z.object({
    /** 最小缩放倍数 */
    min: z.number().positive().default(0.1),
    /** 最大缩放倍数 */
    max: z.number().positive().default(4),
  }),
  apply(ctx, config) {
    ctx.effect(() =>
      ctx.canvas.interaction.register({
        id: 'canvas-zoom.wheel',
        phase: 'bubble',
        priority: 10,
        when: (event) =>
          event.type === 'wheel' && (event.modifiers.ctrl || event.modifiers.meta),
        handle: (event) => {
          event.preventDefault()
          const factor = Math.exp(-event.originalEvent.deltaY * 0.0015)
          ctx.canvas.viewport.zoomAt(event.screen, clamp(factor, config.min, config.max))
          return 'handled'
        },
      }),
    )
  },
})
```

画布插件通常随 `preset-canvas` 在打开文档时激活；只有小地图、AI 标注这类重 HUD 才需要按需加载。它们的工具栏、设置面板仍通过普通 manifest 贡献点暴露。

### 12.2 画布服务接口

```ts
// CanvasContext 由 @lc/contracts 定义：EditorContext & { canvas: CanvasService }

export interface CanvasService {
  /** 视口状态与坐标变换 */
  viewport: ViewportService
  /** 场景图与几何 */
  scene: SceneService
  /** 命中测试 */
  hitTest: HitTestService
  /** 尺寸测量 */
  measure: MeasureService
  /** 选中集 */
  selection: SelectionService
  /** 交互处理器注册 */
  interaction: CanvasInteractionService
  /** 覆盖层注册 */
  layers: CanvasLayerService
  /** 手势事务 */
  transaction: TransactionService
  /** 画布设置 */
  settings: CanvasSettingsService
  /** rAF 调度 */
  scheduler: SchedulerService
}

export interface CanvasInteractionService {
  /** 注册交互处理器；id 冲突时报错 */
  register(handler: InteractionHandler): Disposable
  /** 当前处理器，调试用 */
  list(): readonly InteractionHandler[]
  /** 声明当前处理器接管后续 move/up；返回的 Disposable 用于提前结束 */
  beginGesture(callbacks: GestureCallbacks): Disposable
}

export interface LayerHit {
  /** 命中的图层 */
  layerId: string
  /** 命中的手柄 id；来自 data-handle-id */
  handleId?: string
  /** 命中的节点 id；覆盖层节点可选 */
  nodeId?: string
}

export interface CanvasLayerService {
  /** 注册覆盖层；band + zIndex 决定顺序 */
  register(layer: CanvasLayer): Disposable
  /** 当前图层，调试用 */
  list(): readonly CanvasLayer[]
  /** 命中覆盖层；pipeline 用它设置 targetHandleId */
  hitTest(screen: Point): LayerHit | undefined
}

export interface CanvasSettingsService {
  /** 注册设置项；scope 决定持久化层级 */
  register<T>(setting: CanvasSetting<T>): Disposable
  /** 读取合并后的值 */
  get<T>(id: string): T
  /** 修改当前 scope 的值；受租户策略锁定时抛错 */
  set<T>(id: string, value: T): void
  /** 订阅变化；插件卸载自动移除 */
  onDidChange(id: string, listener: (value: unknown) => void): Disposable
}
```

`snap` 不在 `CanvasService` 里：它由 `canvas-snap` 插件提供，通过 `ctx.get<SnapService>('snap')` 可选获取；没安装就没有吸附，拖拽/缩放仍能工作。

### 12.3 交互处理器契约

```ts
export interface InteractionHandler<E extends CanvasInputEvent = CanvasPointerEvent> {
  /** 全局唯一 id，建议 <plugin>.<gesture> */
  id: string
  /** 默认 bubble；手柄类用 target；需要抢在目标前拦截时用 capture */
  phase?: 'capture' | 'target' | 'bubble'
  /** 同 phase 内越大越先执行 */
  priority?: number
  /** 廉价纯函数；禁止 DOM 测量、禁止异步 */
  when?: (event: E, ctx: CanvasContext) => boolean
  /** 处理事件；返回 handled 表示消费 */
  handle: (event: E, ctx: CanvasContext) => InteractionResult
}

export interface GestureCallbacks {
  /** 手势中的 pointermove */
  onMove(event: CanvasPointerEvent): void
  /** 手势结束；commit=false 表示 Esc/pointercancel */
  onFinish(commit: boolean): void
}
```

硬性规则：

- 一个处理器只做一件事，`id` 用命名空间；不要写 `canvas.everything`。
- `when` 必须纯、快、无副作用；它会在每个 pointermove 上执行。
- `handle` 同步执行，预算 1 ms；需要异步的工作放到事务/命令里。
- 只有确认消费时才 `preventDefault()`，否则会影响页面滚动与浏览器快捷键。
- 不要在处理器里直接 `addEventListener('pointermove')`；手势状态由管线维护，pointer capture 已处理。
- 处理器如果开启了事务，必须在 `pointerup` / `pointercancel` / 卸载时关闭事务。
- 同一手势只允许一个事务 owner；抢不到 `transaction.begin` 就放弃处理。

### 12.4 覆盖层契约

```ts
export interface CanvasLayer {
  /** 全局唯一 id */
  id: string
  /** 基础层级 */
  band: LayerBand
  /** 同 band 内排序 */
  zIndex?: number
  /** none=整层穿透；children=容器穿透、子元素可命中；auto=整层命中 */
  pointerEvents?: 'none' | 'children' | 'auto'
  /** 可见条件；廉价纯函数 */
  visible?: (frame: CanvasFrame) => boolean
  /** 覆盖层模块；首次可见时加载，由宿主解析为组件 */
  load: () => Promise<unknown>
}

export interface CanvasFrame {
  /** 只读视口快照 */
  viewport: Readonly<ViewportState>
  /** 当前选中 id */
  selection: readonly string[]
  /** 当前吸附结果；没有吸附插件时为 null */
  snap: SnapResult | null
  /** 画布尺寸（屏幕像素） */
  size: Size
}
```

规则：

- 覆盖层在屏幕空间渲染，通过 `frame.viewport` 投影；不要给覆盖层套 `scale(zoom)`。
- 默认 `pointer-events: none`；手柄用 `children`（容器穿透、子元素命中），只有小地图这类整层交互才用 `auto`。
- 覆盖层组件只接收 `CanvasFrame`，不直接拿整个 `Context`；需要命令时通过 props 传入受限回调。
- 覆盖层加载失败显示空层并上报，不影响其他图层。
- 卸载时组件、rAF、ResizeObserver、全局光标样式全部清理。

### 12.5 设置项契约

```ts
export interface CanvasSetting<T> {
  /** 设置 id，建议与插件同名 */
  id: string
  /** 展示名 */
  title: string
  /** 作用域：用户偏好 / 工作区 / 文档 */
  scope: 'user' | 'workspace' | 'document'
  /** 表单 schema */
  schema: JsonSchema
  /** 默认值 */
  default: T
  /** 是否允许租户策略锁定 */
  lockable?: boolean
}
```

- 设置读取走合并后的值：平台默认 → 租户锁定 → 工作区 → 用户 → 文档。
- 插件配置（manifest config）决定“能不能做”；画布设置决定“用户怎么做”。不要混用。
- 设置变更不重启插件；插件在事件处理时读取最新值，或订阅 `onDidChange`。
- 租户策略可以锁定设置（如强制开启吸附、禁用视口旋转），`set` 抛错并审计。
- 设置面板是应用级 UI：`document` scope 通过 `ctx.workspace.activeEditor` 找到当前 EditorRealm，再取 `editor.canvas.context.canvas.settings`；没有活动文档时 document scope 禁用，只允许 user/workspace。
- document scope 的值随文档 UI 状态持久化，不写入 schema；文档关闭时由文档服务保存。

### 12.6 画布插件之间怎么协作

| 方式     | 用法                               | 例子                          |
| -------- | ---------------------------------- | ----------------------------- |
| 必需服务 | `inject: ['canvas']`               | 所有画布插件                  |
| 可选服务 | `inject: { optional: ['snap'] }`   | 拖拽/缩放插件没有吸附也能工作 |
| 命令     | `ctx.command.register` / `execute` | 对齐、分布、fit、删除         |
| 事件     | `ctx.on('canvas:gestureEnd', ...)` | 埋点、教程、协作适配          |
| 只读快照 | `selection` / `scene`              | 属性面板、AI 助手             |
| 禁止     | 直接 import 另一个画布插件         | 会造成版本与装载耦合          |

可选依赖的写法：

```ts
export default definePlugin({
  name: 'canvas-resize',
  inject: { required: ['canvas'], optional: ['snap'] },
  apply(ctx) {
    const snap = ctx.get<SnapService>('snap')
    // snap 不存在时走无吸附分支
  },
})
```

如果 `snap` 在插件激活后才出现，插件不会自动重启；需要吸附的插件应在 `apply` 时读取，或者用 `ctx.services.onDidChange('snap', ...)` 重新绑定。更简单的做法：把 `canvas-snap` 放在预设里，保证它在拖拽/缩放之前挂载。

### 12.7 生命周期与卸载

画布插件必须在 `dispose` 后满足：

- 交互处理器数量回到安装前；
- 图层数量回到安装前；
- 命令、快捷键、设置项全部移除；
- 活动手势事务已取消；
- pointer capture 已释放；
- 光标样式恢复；
- rAF、ResizeObserver、事件监听为 0。

测试方式：安装前后对比 `ctx.canvas.interaction.list().length`、`layers.list().length`、`command.list().length`，并断言没有 `pointermove` 监听残留。

### 12.8 画布插件测试契约

`@lc/testing/canvas` 提供：

```ts
const canvas = await createCanvasHarness({
  viewport: { width: 1200, height: 800, zoom: 1, x: 0, y: 0, rotation: 0 },
  nodes: [
    { id: 'a', rect: { x: 0, y: 0, width: 100, height: 50 } },
    { id: 'b', rect: { x: 200, y: 120, width: 100, height: 50 } },
  ],
  plugins: [canvasZoom, canvasResize, canvasSnap],
})

await canvas.pointer.drag({ from: { x: 50, y: 25 }, to: { x: 150, y: 125 } })
expect(canvas.selection.ids).toEqual(['a'])
expect(canvas.viewport.state.zoom).toBe(1)
```

必须覆盖：

- 坐标变换：`screenToWorld(worldToScreen(p)) === p`（浮点误差内）。
- 缩放不变量：`zoomAt(p, k)` 前后，`p` 下的世界坐标不变。
- 吸附阈值：zoom 0.5/1/2/4 下，屏幕像素阈值一致。
- 手势提交：一次拖拽只产生一条历史。
- 手势取消：Esc/pointercancel 后文档与历史不变。
- 冲突优先级：手柄优先于拖拽，空格平移优先于框选。
- 卸载清理：卸载后处理器/图层/命令/监听器为 0。
- 性能回归：5000 节点、30 个处理器下，pointermove 管线 p95 < 2 ms。

### 12.9 画布插件禁止事项

- 禁止自己创建 `<canvas>` 或第二套 LayerHost；
- 禁止在 `window`/`document` 上挂指针监听；
- 禁止直接改 schema 对象，必须走事务；
- 禁止在每个 pointermove 上写 Vue 响应式状态或触发全量重渲染；
- 禁止用 `offsetX/offsetY` 当世界坐标；
- 禁止直接改覆盖层 DOM 的 `z-index`；
- 禁止在 `when` 里做测量、异步、日志；
- 禁止卸载时不取消活动事务。

### 12.10 画布插件如何做到“装即用”

画布插件不能靠 `preset-canvas` 里写死 `import`，否则新增一个画布能力又要改预设。做法与应用插件一致：**manifest 声明贡献，CanvasHost 按文档实例化**。

manifest：

```json
{
  "name": "@lc/canvas-plugin-zoom",
  "version": "1.0.0",
  "lowcode": {
    "name": "canvas-zoom",
    "engines": { "lowcode": "^1.0.0" },
    "certification": "verified",
    "executionProfile": "inline",
    "uiReview": "inline",
    "main": "./dist/index.js",
    "activationEvents": ["onCanvasFeature:zoom"],
    "contributes": {
      "canvasFeatures": [
        {
          "id": "zoom",
          "title": "画布缩放",
          "module": "./dist/index.js",
          "defaultEnabled": true,
          "order": 10,
          "requires": ["canvas"]
        }
      ]
    }
  }
}
```

CanvasHost 在创建 CanvasRealm 时：

```ts
const features = ctx.contribution
  .list('canvasFeatures')
  .filter((item) => item.enabled) // 租户/工作区策略
  .sort((a, b) => a.order - b.order)

for (const feature of features) {
  // 只加载模块，不跑应用级 apply；实例由 CanvasHost 创建
  const module = await ctx.loader.loadCanvasFeatureModule(feature.id)
  canvas.context.plugin(module.default, feature.config)
  // 注册关系挂在 canvas 上，文档关闭自动卸载
}
```

关键规则：

- `onCanvasFeature:<id>` 由 CanvasHost 的 `loadCanvasFeatureModule(id)` 处理：loader 只负责校验/加载模块，**不调用 `runtime.load`**；否则插件会被 AppContext 挂载一次，而不是每个 CanvasRealm 一次。
- `onCanvasFeature` 不允许出现在应用级 `activateStartup()` 的激活队列里；loader 启动扫描时应把它归入 canvas feature registry。
- 同一个画布插件包在每个 CanvasRealm 里创建独立实例；不要把带视口状态的插件挂到应用级。
- `preset-canvas` 只保存产品预设（默认启用哪些 feature、顺序、配置），不硬编码具体插件代码。
- 安装新画布插件 → manifest 贡献出现 → 租户/工作区启用 → 新打开的文档自动装配；不需要改宿主或预设。
- 卸载/禁用：新文档不再装配；已打开的 CanvasRealm 通过贡献变化通知卸载实例、取消事务、移除图层。若产品不支持热装配，则明确要求重开文档。
- 画布插件的 manifest 也受签名、认证等级、租户允许清单、配额约束，与普通插件共用供应链。

这样，`canvas-zoom`、`canvas-resize`、`canvas-rotate`、`canvas-snap`、`canvas-guides` 每一个都可以作为独立包发布、独立启用、独立回滚。

---

## 13. 画布功能拆解：节点缩放、节点旋转、画布缩放、吸附、辅助线

### 13.1 先对齐四个概念

| 概念             | 改变什么          | 插件                   | 是否写文档   |
| ---------------- | ----------------- | ---------------------- | ------------ |
| 画布缩放         | 视口 zoom         | `canvas-zoom`          | 否           |
| 画布平移         | 视口 x/y          | `canvas-pan`           | 否           |
| 画布旋转（可选） | 视口 rotation     | `canvas-camera-rotate` | 否           |
| 节点缩放         | 节点 width/height | `canvas-resize`        | 是，提交事务 |
| 节点旋转         | 节点 rotation     | `canvas-rotate`        | 是，提交事务 |

用户说“缩放、旋转、画布的缩放”时，必须先区分：**节点变换写文档，视口变换不写文档**。两者混在一个插件里，撤销栈和协作都会出问题。

### 13.2 画布插件总表

| 插件包                 | 职责                     | 必需依赖          | 贡献                     | 卸载后                           |
| ---------------------- | ------------------------ | ----------------- | ------------------------ | -------------------------------- |
| `canvas-zoom`          | 滚轮/快捷键/按钮缩放视口 | canvas            | 交互、命令、快捷键、设置 | 视口保留，缩放交互消失           |
| `canvas-pan`           | 空格/中键/触控板平移     | canvas            | 交互、命令、设置         | 平移交互消失                     |
| `canvas-camera-rotate` | 视口旋转（可选）         | canvas            | 交互、命令、设置         | 视口角度保留，旋转交互消失       |
| `canvas-resize`        | 节点缩放、手柄、约束     | canvas            | 交互、handles 层、命令   | 手柄消失，属性面板仍可改尺寸     |
| `canvas-rotate`        | 节点旋转、角度吸附       | canvas            | 交互、handles 层、命令   | 旋转手柄消失，属性面板仍可改角度 |
| `canvas-selection`     | 点击/Shift/框选          | canvas            | 交互、selection 层、命令 | 选择服务仍在，鼠标选择消失       |
| `canvas-drag`          | 移动节点、自动滚动       | canvas、可选 snap | 交互、preview 层、命令   | 不能拖动，属性/大纲仍可改布局    |
| `canvas-drop`          | 物料拖入、容器判定       | canvas、可选 snap | 交互、preview 层、命令   | 不能从物料面板拖入               |
| `canvas-snap`          | 吸附引擎、网格/元素候选  | canvas            | 服务、设置、命令         | 拖拽/缩放不再吸附                |
| `canvas-guides`        | 对齐辅助线、间距标注     | canvas、可选 snap | guides 层                | 吸附仍生效，但没有辅助线         |
| `canvas-grid`          | 网格/点阵背景            | canvas            | background 层、设置      | 背景网格消失，不影响布局         |
| `canvas-rulers`        | 标尺、参考线拖出         | canvas            | hud 层、交互、设置       | 标尺消失，已有参考线仍可渲染     |
| `canvas-align`         | 对齐/分布命令            | canvas            | 命令、工具栏/面板        | 对齐按钮消失                     |
| `canvas-minimap`       | 小地图导航               | canvas            | hud 层、交互、设置       | 小地图消失                       |
| `canvas-context-menu`  | 右键菜单                 | canvas、command   | 交互、DOM 菜单           | 右键菜单消失                     |

### 13.3 视口类插件

#### canvas-zoom

- 交互：`Ctrl/⌘ + wheel` 以指针为中心缩放；触控板双指缩放；`+/-` 快捷键；工具栏按钮；`0` 回到 100%；`Shift+1` fit。
- 命令：`canvas.zoom.in`、`canvas.zoom.out`、`canvas.zoom.reset`、`canvas.zoom.fit`。
- 设置：缩放范围、滚轮灵敏度、是否平滑动画、是否允许触控板缩放。
- 不写文档、不产生历史、不占用事务。
- 卸载：视口状态保留，其他插件仍可 `viewport.set()`；只是没有滚轮/快捷键入口。

#### canvas-pan

- 交互：空格 + 拖动；中键拖动；触控板双指滚动；可选边缘自动滚动（拖拽节点时由 drag 插件处理，不在 pan 里）。
- 命令：`canvas.pan.center`、`canvas.pan.toNode`。
- 设置：反向滚动、惯性、触控板速度。
- 与 `canvas-selection` 的冲突：空格按下时 selection 的 `when` 返回 false；中键只归 pan。
- 不写文档、不产生历史。

#### canvas-camera-rotate

- 交互：`Alt + 拖动` 或旋转按钮；`Shift` 15° 步进；双击复位。
- 命令：`canvas.camera.rotate.reset`。
- 设置：是否启用、步进角度、旋转中心（视口中心/指针）。
- 与节点旋转严格区分：这个插件只改 `viewport.rotation`，不写任何节点属性。
- 很多表单设计器不需要它，默认不装；视口旋转会抬高命中测试、吸附、覆盖层坐标的测试成本，不是刚需就不进 v1 预设。

### 13.4 节点变换类插件

#### canvas-resize

- 覆盖层：handles 层画 8 个手柄（四角 + 四边），尺寸固定为屏幕像素，不随 zoom 变粗。
- 交互：
  - pointerdown 在手柄上 → capture → `transaction.begin('resize')`；
  - pointermove → 世界坐标 delta → 应用最小尺寸、父容器约束、宽高比（Shift）、中心缩放（Alt）→ 吸附（可选）→ `tx.preview()`；
  - pointerup → `tx.commit()`；Esc/pointercancel → `tx.cancel()`。
- 多选：按选中集的联合包围盒缩放；每个节点按比例变换。
- 命令：`canvas.resize.width` / `canvas.resize.height` / `canvas.resize.reset`。
- 设置：手柄大小、最小尺寸、是否允许非等比、是否吸附。
- 卸载：手柄层移除、活动事务取消；节点仍按 schema 尺寸渲染。

#### canvas-rotate

- 覆盖层：旋转手柄 + 角度提示。
- 交互：pointerdown → 事务；pointermove 计算中心到指针角度 → 减去起始角 → 角度吸附（15°/自定义）→ 预览；pointerup 提交。
- 多选：围绕联合包围盒中心旋转；每个节点更新 rotation。
- 命令：`canvas.rotate.90`、`canvas.rotate.reset`。
- 设置：角度步进、是否显示角度、旋转中心。
- 卸载：手柄消失，节点旋转属性仍生效。

### 13.5 选择、移动、拖入

#### canvas-selection

- 交互：点击选中；Shift 切换多选；空白拖动框选；双击进入容器；Esc 清空。
- 覆盖层：selection 层画选中框/框选矩形。
- 选择服务仍是内核的：卸载插件后，命令/大纲仍可 `selection.set()`。
- 设置：框选是否需要完全包含、是否允许穿透选中。

#### canvas-drag

- 交互：在节点上 pointerdown → 阈值 → 事务 → 移动预览 → 吸附（可选）→ pointerup 提交。
- 多选拖动：所有选中节点一起移动；容器内拖动要更新父级/插入位置。
- 自动滚动：指针靠近画布边缘时平移视口（调用 viewport.panBy），但不要写文档。
- 覆盖层：preview 层显示拖拽幽灵/落点。
- 命令：`canvas.move.up/down/left/right`（键盘微调）。
- 卸载：不能鼠标拖动；属性面板/大纲/命令仍可以改位置。

#### canvas-drop

- 交互：接收来自物料面板的拖拽（HTML5 DnD 或 pointer 拖拽），计算落点容器与插入索引；显示 drop indicator。
- 事务：创建节点 + 插入 schema；一次 drop 一条历史。
- 容器判定：调用 `hitTest.containerAt()`，过滤 `allowedParents` 与 `container` 物料。
- 卸载：不能从物料面板拖入；仍可通过大纲插入/命令创建。

### 13.6 吸附、辅助线、网格、标尺、对齐

#### canvas-snap

- 提供 `SnapService`，内置两类提供者：
  - 网格候选：按 grid size 计算 x/y 候选；`showGuide: false` 只吸附不画线，已落在网格线上的边不再产生候选，避免吸附到自己当前位置；
  - 元素候选：视口内其它节点的左/中/右、上/中/下、间距相等候选；`movingIds` 内的被拖节点被排除，`priority` 高于网格层。
- 设置：启用、阈值（屏幕 px）、网格尺寸、是否吸附到隐藏节点、是否吸附到参考线。
- 命令：`canvas.snap.toggle`；按住 Alt 临时禁用。
- 输出 `SnapResult`：每个轴最多一个 applied match，guide 只收集 `showGuide` 为真的候选，因此不会出现贴在被拖元素自身边上的线。
- 卸载：拖拽/缩放/旋转仍工作，只是不吸附；`canvas-guides` 自动隐藏吸附辅助线。

#### canvas-guides

- 覆盖层：guides 层画垂直/水平辅助线、间距标注、角度提示。
- 数据：读取 `snap.lastResult` 或订阅 `canvas:snap` 事件；不参与吸附计算。
- 用户参考线：从标尺拖出、拖动、删除；独立持久化到文档 UI 状态，不写 schema。
- 设置：线颜色、间距标注、是否显示数值。
- 卸载：吸附仍生效，但用户看不到辅助线；预设里通常与 snap 一起安装。

#### canvas-grid

- 覆盖层：background 层画网格/点阵；密度随 zoom 自适应（避免过密）。
- 设置：网格类型（线/点）、间距、颜色、是否随缩放变化、是否显示次级网格。
- 只负责视觉；网格吸附候选由 `canvas-snap` 提供，二者可以独立卸载。

#### canvas-rulers

- 覆盖层：hud 层画顶部/左侧标尺、原点、指针位置；单位可配置（px/cm）。
- 交互：从标尺拖出参考线；拖动参考线；双击删除。
- 设置：单位、刻度密度、是否显示指针位置。
- 卸载：标尺消失；已存在的参考线数据保留（由 guides 渲染）。

#### canvas-align

- 命令：左/中/右、上/中/下、水平/垂直分布、等间距。
- 无交互、无覆盖层；读取 selection.bounds，提交一个事务。
- 工具栏/右键菜单通过命令 id 引用，不直接 import 插件。
- 卸载：按钮消失；命令不存在；其他功能不受影响。

### 13.7 HUD 与菜单

#### canvas-minimap

- 覆盖层：hud 层绘制缩略图与视口矩形；点击/拖动导航。
- 只改 viewport，不写文档；大文档可懒加载。
- 设置：位置、大小、是否显示节点轮廓。

#### canvas-context-menu

- 交互：`contextmenu` 事件进入画布管线；根据 targetNodeId/selection 组装菜单。
- 菜单项来自 `ctx.command` 与 `ctx.canvas.contextMenu` 注册；不硬编码。
- 卸载：右键菜单消失；命令仍可通过快捷键/命令面板执行。

### 13.8 交互冲突矩阵

| 手势          | 候选插件                 | 结果         | 机制                                |
| ------------- | ------------------------ | ------------ | ----------------------------------- |
| 手柄上拖动    | resize / drag            | resize       | handles 层 target + priority 100    |
| 节点上拖动    | drag / selection         | drag         | 有 targetNodeId，drag priority 50   |
| 空白拖动      | selection / pan          | selection    | 无 targetNodeId；pan 需要空格/中键  |
| 空格 + 拖动   | pan / selection          | pan          | pan 的 when 检查 space，priority 80 |
| 中键拖动      | pan / selection          | pan          | 检查 button=1                       |
| Ctrl/⌘ + 滚轮 | zoom / pan               | zoom         | zoom 的 when 检查修饰键             |
| 普通滚轮      | pan / zoom               | pan          | pan 处理无修饰键滚轮                |
| 旋转手柄拖动  | rotate / resize          | rotate       | 不同手柄元素，target 阶段           |
| 右键          | context-menu / selection | context-menu | contextmenu 单独通道                |
| Esc           | 活动事务                 | cancel       | 全局键盘处理器，优先级最高          |

### 13.9 预设与裁剪

| 产品       | 安装的画布插件                                                |
| ---------- | ------------------------------------------------------------- |
| 表单设计器 | zoom、pan、selection、drag、drop、resize、snap、guides、grid  |
| 大屏设计器 | 全部                                                          |
| 流程编排   | zoom、pan、selection、drag、guides、minimap；无 resize/rotate |
| 只读预览   | zoom、pan；无 selection/drag/drop/handles                     |
| 移动端预览 | zoom、pan；手势由触控适配插件提供                             |

裁剪不是“删代码”，而是换预设。企业客户可以按工作区选择不同预设，不需要 fork 设计器。

---

## 14. 画布插件示例、冲突与性能

### 14.1 画布缩放插件完整示例

```ts
// packages/canvas-plugins/canvas-zoom/src/index.ts
import { definePlugin } from '@lc/kernel'
import { z } from 'zod'

export default definePlugin({
  name: 'canvas-zoom',
  inject: ['canvas'],
  schema: z.object({
    /** 最小缩放倍数 */
    min: z.number().positive().default(0.1),
    /** 最大缩放倍数 */
    max: z.number().positive().default(4),
    /** 滚轮灵敏度 */
    wheelSensitivity: z.number().positive().default(0.0015),
  }),
  apply(ctx, config) {
    const viewport = ctx.canvas.viewport

    const zoomAt = (screen: Point, factor: number) => {
      const next = clamp(viewport.state.zoom * factor, config.min, config.max)
      viewport.zoomAt(screen, next / viewport.state.zoom)
    }

    // Ctrl/⌘ + 滚轮：以指针为中心缩放
    ctx.effect(() =>
      ctx.canvas.interaction.register({
        id: 'canvas-zoom.wheel',
        phase: 'bubble',
        priority: 10,
        when: (event) =>
          event.type === 'wheel' && (event.modifiers.ctrl || event.modifiers.meta),
        handle: (event) => {
          event.preventDefault()
          const delta = event.originalEvent.deltaY
          zoomAt(event.screen, Math.exp(-delta * config.wheelSensitivity))
          return 'handled',
        },
      }),
    )

    // 快捷键 / 工具栏共用命令
    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.zoom.in',
        title: '放大',
        run: () => zoomAt(viewport.center, 1.1),
      }),
    )
    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.zoom.out',
        title: '缩小',
        run: () => zoomAt(viewport.center, 1 / 1.1),
      }),
    )
    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.zoom.reset',
        title: '实际大小',
        run: () => viewport.set({ zoom: 1 }),
      }),
    )
    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.zoom.fit',
        title: '适应画布',
        run: () => viewport.fit(ctx.canvas.scene.getRootBounds(), 48),
      }),
    )

    // 设置项：租户可以锁定 min/max
    ctx.effect(() =>
      ctx.canvas.settings.register({
        id: 'canvas-zoom',
        title: '画布缩放',
        scope: 'user',
        schema: {
          type: 'object',
          properties: {
            min: { type: 'number', default: config.min },
            max: { type: 'number', default: config.max },
          },
        },
        default: { min: config.min, max: config.max },
        lockable: true,
      }),
    )
  },
})
```

要点：

- 只改视口，不写文档、不产生历史、不占事务。
- 滚轮只在 Ctrl/⌘ 时缩放；普通滚轮留给 `canvas-pan`，避免触控板用户无法滚动。
- 所有注册都用 `ctx.effect`，卸载即回收。
- 缩放范围来自插件配置，租户可以通过设置锁定。

### 14.2 节点缩放插件骨架

```ts
export default definePlugin({
  name: 'canvas-resize',
  inject: { required: ['canvas'], optional: ['snap'] },
  apply(ctx) {
    const { selection, viewport, hitTest, transaction, layers } = ctx.canvas
    const snap = ctx.get<SnapService>('snap')

    // 1. 手柄覆盖层
    ctx.effect(() =>
      layers.register({
        id: 'canvas-resize.handles',
        band: 'handles',
        pointerEvents: 'auto',
        load: () => import('./ResizeHandles.vue'),
      }),
    )

    // 2. 手柄命中：capture 阶段，优先级高于 drag
    ctx.effect(() =>
      ctx.canvas.interaction.register({
        id: 'canvas-resize.gesture',
        phase: 'target',
        priority: 100,
        when: (event) =>
          event.type === 'pointerdown' && !!event.targetHandleId && !!selection.primary,
        handle: (event) => {
          const tx = transaction.begin({ label: 'resize', owner: 'canvas-resize' })
          const start = selection.bounds()

          const onMove = (move: CanvasPointerEvent) => {
            const worldDelta = {
              x: (move.screen.x - event.screen.x) / viewport.state.zoom,
              y: (move.screen.y - event.screen.y) / viewport.state.zoom,
            }
            const next = applyResizeConstraints(start, event.targetHandleId!, worldDelta, {
              keepRatio: move.modifiers.shift,
              fromCenter: move.modifiers.alt,
            })
            const snapped = snap?.resolve({ rects: [next], source: 'resize' })
            tx.preview(buildResizePatches(selection.ids, snapped?.rects[0] ?? next))
          }

          const finish = (commit: boolean) => {
            commit ? tx.commit() : tx.cancel()
            cleanupGesture()
          }

          // 管线负责 pointermove/up 分发；beginGesture 在手势结束后自动释放
          ctx.canvas.interaction.beginGesture({ onMove, onFinish: finish })
          return 'handled'
        },
      }),
    )
  },
})
```

真实实现里，`beginGesture` 是画布内核提供的手势作用域：它把后续 pointermove/up 绑定到当前处理器，避免每个插件自己监听 window。关键是**预览走事务、pointerup 才提交、Esc/pointercancel 必回滚**。

### 14.3 吸附引擎与辅助线

```ts
// canvas-snap：提供服务和内置候选
export default definePlugin({
  name: 'canvas-snap',
  inject: ['canvas'],
  apply(ctx) {
    const snap = new SnapServiceImpl(ctx.canvas)
    ctx.effect(() => ctx.provide('snap', snap)) // 或在 service-canvas-core 中预留

    ctx.effect(() =>
      snap.registerProvider({
        id: 'snap.grid',
        getCandidates: ({ viewport, movingRect, gridSize }) =>
          gridCandidates(movingRect, gridSize, viewport.zoom),
      }),
    )
    ctx.effect(() =>
      snap.registerProvider({
        id: 'snap.elements',
        priority: 10,
        getCandidates: ({ viewport, movingRect, scene }) =>
          elementCandidates(movingRect, scene.visibleIn(viewport), viewport.zoom),
      }),
    )
  },
})

// canvas-guides：只负责画
export default definePlugin({
  name: 'canvas-guides',
  inject: { required: ['canvas'], optional: ['snap'] },
  apply(ctx) {
    const snap = ctx.get<SnapService>('snap')
    if (!snap) return

    ctx.effect(() =>
      ctx.canvas.layers.register({
        id: 'canvas-guides.lines',
        band: 'guides',
        pointerEvents: 'none',
        visible: () => !!snap.lastResult,
        load: () => import('./GuidesLayer.vue'),
      }),
    )
  },
})
```

辅助线层只读 `snap.lastResult`，不参与候选计算。这样：

- 不装 `canvas-snap` 时，guides 自动不显示；
- 不装 `canvas-guides` 时，吸附仍生效，只是用户看不到线；
- 第三方可以注册新的 `SnapProvider`（如设计令牌基线、栅格系统），不需要改引擎。

### 14.4 冲突解决案例

1. **缩放手柄 vs 节点拖拽**：手柄是 handles 层的独立元素，命中后走 target 阶段，`canvas-resize` priority 100；`canvas-drag` 的 `when` 要求 `targetNodeId` 且 `targetHandleId` 为空，自然让位。
2. **空格平移 vs 框选**：`canvas-pan` 的 `when` 检查 `space`，priority 80；`canvas-selection` 的 `when` 检查 `!space`，不会启动框选。
3. **Ctrl+滚轮缩放 vs 普通滚轮平移**：两个插件都监听 wheel，但 `when` 条件互斥；都没有处理时，事件不被 `preventDefault`，页面可以正常滚动。
4. **旋转手柄 vs 缩放手柄**：手柄 id 不同，命中不同元素；不要用同一个透明层覆盖两种手柄。
5. **辅助线挡住手柄**：guides 层 `pointer-events: none`，handles 层才 `auto`。
6. **Esc 取消手势**：键盘处理器优先级最高，调用活动事务 `cancel()`，并释放 pointer capture。
7. **两个插件都想开启事务**：`transaction.begin` 只允许一个 owner；抢不到就返回 `pass`，不要强行处理。

### 14.5 性能与验收

- 画布插件的事件处理器不能做 DOM 测量；测量走 `measure` 缓存。
- 指针移动期间只更新 transform / 预览层，不写 schema、不触发节点组件重渲染。
- 5000 节点、30 个处理器下，pointermove 管线 p95 < 2 ms，拖拽帧率 ≥ 55 fps。
- 吸附候选限制在视口内；空间索引命中 O(log n) 级别。
- 卸载后画布处理器/图层/命令/监听器为 0；活动事务已取消。
- 单测覆盖坐标、缩放不变量、吸附阈值、冲突优先级、撤销/取消。
- E2E 覆盖：拖入物料、缩放节点、旋转节点、吸附到另一节点、撤销、卸载插件后功能消失。

---

## 15. 企业级总体架构与部署拓扑

### 15.1 企业级约束

企业客户与个人开发者最大的差别不是“功能更多”，而是：

- **多租户**：一个平台实例服务多个组织，数据、配置、插件、审计必须隔离。
- **强治理**：谁能装插件、谁能改配置、谁能发布页面，必须有审批和留痕。
- **可合规**：数据驻留、保留期限、删除请求、审计导出、访问复核。
- **可运维**：灰度、回滚、Kill Switch、SLO、故障演练。
- **可离线**：私有化/信创/内网环境不能依赖公网 CDN 与 SaaS 控制面。

因此企业级架构的第一刀不是加功能，而是**控制面与数据面分离**。

### 15.2 控制面与数据面

```
┌──────────────────────────── 控制面（服务端） ────────────────────────────┐
│ 租户与身份 │ 插件注册表 │ 策略中心 │ 配置中心 │ 发布编排 │ 审计 │ 配额/计费 │
│            │ 认证/签名  │ OPA/Cedar│ 环境/密钥│ 灰度/回滚│ SIEM │ 成本归因   │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ 签名 manifest / 策略包 / 配置 / 灰度指令
                                    ▼
┌──────────────────────────── 数据面（浏览器/边缘/客户 VPC） ──────────────┐
│ 设计器 Host │ 运行时 Player │ 文档服务 │ 发布/渲染服务 │ 插件资产 CDN      │
│ 应用插件内核 │ 画布微内核     │ 版本/协作│ SSR/静态导出   │ 沙箱 Host/Worker  │
└──────────────────────────────────────────────────────────────────────────┘
```

职责边界：

| 能力               | 控制面                 | 数据面                 |
| ------------------ | ---------------------- | ---------------------- |
| 租户/用户/角色     | 权威数据源             | 只读缓存 + 短期令牌    |
| 插件制品/签名/认证 | 权威数据源             | 校验签名、缓存制品     |
| 策略               | 策略包生成与签名       | 本地策略决策缓存       |
| 配置               | 分层配置与锁定         | 合并、缓存、应用       |
| 发布/灰度          | 编排、审批、指标门禁   | 执行版本切换、上报指标 |
| 审计               | 不可篡改存储、SIEM     | 产生审计事件、批量上报 |
| 文档数据           | 不保存业务文档（默认） | 文档服务/对象存储      |

**失败策略**：

- 读操作 **fail-static**：控制面不可用时，数据面用本地缓存的签名策略/配置继续提供只读与编辑能力。
- 写操作 **fail-closed**：安装、提权、发布、修改租户策略、导出敏感数据必须回源控制面；不可用就拒绝。
- 缓存必须带版本与过期时间；策略包过期后降级为“只读/禁止特权操作”，不能永久使用旧策略。

### 15.3 租户、工作区、环境、文档

```
Platform
└── Tenant（隔离与计费单位）
    └── Workspace（团队/项目）
        └── Environment（dev / staging / prod）
            └── Document（页面/应用）
                └── CanvasRealm（画布状态）
```

| 层级        | 隔离内容                       | 典型配置                  |
| ----------- | ------------------------------ | ------------------------- |
| Platform    | 全局插件、平台策略、默认配置   | 平台管理员                |
| Tenant      | 数据、插件允许清单、配额、审计 | 租户管理员、SSO、数据驻留 |
| Workspace   | 成员、项目、插件 opt-in        | 工作区管理员、设计器预设  |
| Environment | 发布版本、配置覆盖、审批策略   | prod 只读/审批，dev 放宽  |
| Document    | schema、版本、协作状态         | 设计器/运行时             |
| CanvasRealm | 视口、选择、画布插件实例       | 每个打开文档独立          |

原则：

- **隔离单位是 Tenant，不是 Workspace**：数据库行级安全、对象存储前缀、缓存 key、搜索索引、日志都必须带 `tenant_id`。
- **环境是配置与发布边界**，不是数据隔离边界；prod 与 staging 可以共享租户，但配置、密钥、发布制品必须分开。
- **文档是协作边界**；多人编辑同一文档共享一个文档 Realm，不同文档不共享画布与历史。
- **画布是交互边界**；同一文档的多个画布实例（对比预览）可以有独立 CanvasRealm，但共享只读 schema。
- **白标是配置与主题，不是 fork**；租户 Logo、主题、域名、登录页、邮件模板通过主题插件与配置实现，不改变权限与审计边界。

### 15.4 部署形态

| 形态        | 控制面     | 数据面              | 适用                           | 代价                             |
| ----------- | ---------- | ------------------- | ------------------------------ | -------------------------------- |
| SaaS 多租户 | 平台托管   | 平台托管、池化      | 大多数企业                     | 需要强租户隔离与配额             |
| 专属数据面  | 平台托管   | 客户 VPC / 独立集群 | 金融、政务、数据敏感           | 运维成本高、升级编排复杂         |
| Hybrid      | 平台或客户 | 客户 VPC            | 数据不能出网，但希望用平台市场 | 控制面与数据面网络/证书复杂      |
| 私有化/离线 | 客户内网   | 客户内网            | 信创、军工、强监管             | 需要离线注册表、离线升级、许可证 |

离线部署必须支持：

- 插件离线包（manifest + 制品 + 签名 + SBOM + 依赖）；
- 本地注册表镜像与 CRL（吊销列表）；
- 本地策略包与配置中心；
- 无外网 DNS/HTTP 依赖；字体、图标、地图等资产本地化；
- 许可证与到期降级策略（只读/禁止新安装，不锁死已有文档）。

### 15.5 高可用与容量

| 组件            | 高可用手段                      | 注意                        |
| --------------- | ------------------------------- | --------------------------- |
| Web/设计器 Host | 无状态、多副本、CDN             | 会话放外部，不依赖 sticky   |
| API Gateway/BFF | 多 AZ、限流、熔断               | 租户级配额与公平调度        |
| 文档服务        | Postgres HA + PITR              | 租户行级安全、连接池隔离    |
| 协作/实时       | Redis/消息队列 + WebSocket 网关 | 租户隔离、背压、断线重连    |
| 插件资产        | 对象存储 + CDN + 签名           | 不可变 digest、缓存失效策略 |
| 控制面          | 多副本、事件溯源/Outbox         | 策略/配置变更可回滚         |
| 审计            | 追加写、WORM、异地复制          | 写入失败要告警，不能静默丢  |
| 渲染/导出       | 无状态 Worker + 队列            | 单租户并发上限、超时、隔离  |

容量策略：

- 按租户限制：插件数、文档数、并发编辑、渲染任务、存储、出站请求。
- 入口限流 + 队列 + 背压；不允许一个租户的导出任务拖垮全局。
- 大文档（> 1 万节点）限制画布交互能力或进入“性能模式”，并给出明确提示。
- 容量测试以“租户 × 文档规模 × 插件数 × 画布插件数”为维度，不只测单用户。

### 15.6 数据面组件清单

| 组件                  | 职责                                     |
| --------------------- | ---------------------------------------- |
| API Gateway / BFF     | 认证、租户解析、限流、审计入口、API 聚合 |
| Designer Host         | 设计器壳、应用插件、画布微内核、属性面板 |
| Player Host           | 运行时渲染、数据源执行、动作执行         |
| Document Service      | 文档 CRUD、版本、锁、协作快照            |
| Publish Service       | 发布编排、版本冻结、制品生成             |
| Render/Export Service | SSR、静态 HTML、截图、PDF、代码导出      |
| Plugin Asset Service  | 插件制品、manifest、签名、SBOM、CDN 回源 |
| Sandbox Host          | iframe/Worker/容器沙箱与 RPC 网关        |
| Policy Service        | 策略包分发、决策缓存、决策日志           |
| Audit Service         | 审计写入、WORM、SIEM 导出                |
| Telemetry Collector   | OTel 收集、脱敏、租户/插件维度聚合       |
| Job Workers           | 导出、迁移、扫描、通知、清理             |

### 15.7 与内核的边界

- 内核只在数据面运行，不知道控制面存在。
- 控制面通过 loader、服务包装、策略包影响数据面，不直接操作 Context。
- 数据面缓存控制面下发的签名制品与策略；缓存是性能优化，不是权威数据源。
- 控制面故障不能让已打开文档不可编辑；但新安装、提权、发布必须停。

### 15.8 控制面技术栈与职责

控制面不是“前端多几个页面”，而是独立后端系统。建议明确选型，避免实现时才发现缺数据库、队列、迁移和 OpenAPI。

| 层        | 选型                                   | 说明                                               |
| --------- | -------------------------------------- | -------------------------------------------------- |
| Runtime   | Node.js 22 LTS                         | 与插件 SDK 同语言，便于共享类型与契约测试          |
| HTTP      | NestJS + Fastify adapter               | 模块化、DI、守卫/拦截器适合租户与策略              |
| 数据库    | PostgreSQL 16 + Kysely                 | 显式 SQL、RLS、迁移可控；避免 ORM 隐藏租户条件     |
| 缓存/队列 | Redis 7 + BullMQ                       | 会话、限流、异步任务、扫描/导出/通知               |
| 对象存储  | S3 兼容                                | 文档、制品、导出、审计归档；租户前缀               |
| 身份      | 外部 IdP（OIDC/SAML）+ SCIM            | 平台不自建密码体系                                 |
| API       | OpenAPI 3.1                            | `control-plane-sdk` 由 schema 生成，前端不手写 DTO |
| 事件      | Postgres Outbox + NATS/Kafka（按部署） | 审计、发布、配额、通知的可靠投递                   |
| 可观测    | OpenTelemetry                          | 与数据面同一套租户/插件维度                        |
| 部署      | 无状态副本 + Worker + Cron             | 迁移独立 Job，不在 Web 进程跑 schema 变更          |

`apps/control-plane` 与 `apps/registry` 的职责必须拆开：

| 应用            | 负责                                               | 不负责                             |
| --------------- | -------------------------------------------------- | ---------------------------------- |
| `control-plane` | 租户、身份、策略、配置、发布编排、审计、配额、计费 | 不实现 OCI 协议；不直接存插件 blob |
| `registry`      | 制品元数据、签名/SBOM/认证状态、CRL、下载鉴权      | 不承载租户/策略/发布审批           |
| Harbor/S3       | OCI 仓库或对象存储、不可变 digest、复制            | 不做业务审批                       |

每个控制面模块独立 schema + 迁移 + 测试；数据库连接带租户上下文，RLS 是最后一道防线，不是唯一防线。

### 15.9 服务端执行路径

到目前为止，文档主要描述浏览器内的插件运行。企业低代码还有三类服务端执行需求：

1. **机密数据源**：凭据不能下发到浏览器，请求必须服务端代理或服务端执行。
2. **SSR / 导出**：静态 HTML、PDF、截图、代码生成需要服务端渲染物料与执行数据源。
3. **服务端扩展**：定时同步、Webhook、批量处理，不能依赖用户打开页面。

统一模型：

| 执行位置       | 适用                       | 约束                        |
| -------------- | -------------------------- | --------------------------- |
| `inline`       | 物料、画布插件             | T0/T1；同 realm             |
| `worker`       | 表达式、数据转换、轻量计算 | 无 DOM；RPC                 |
| `server-proxy` | 数据源/动作只需代发请求    | 只代理 HTTP，不执行插件代码 |
| `server`       | S 服务端扩展、SSR 数据源   | 容器/微 VM；无默认网络；RPC |

契约补充：

```ts
export interface DataSourceType {
  /** 执行位置；confidential 数据源建议 server */
  execution?: 'browser' | 'worker' | 'server'
  /** 服务端执行时由 ServerPluginHost 加载 */
  serverMain?: string
  // ...
}

export interface MaterialContribution {
  /** 渲染模式；ssr=false 的物料导出时走 headless browser */
  renderMode?: 'client' | 'ssr' | 'both'
  // ...
}
```

规则：

- `execution: 'server'` 的数据源/动作必须在 manifest 声明 `serverMain`，由 S ServerPluginHost 在容器内加载；浏览器只拿结果，不拿凭据。
- `server-proxy` 不执行插件代码，只按 manifest 的出站策略代发请求；适合简单 REST。
- SSR/导出服务先解析 schema 用到的物料：`renderMode` 支持 SSR 的直接渲染；不支持的物料走 headless browser 或明确标记“不可导出”。
- 服务端插件复用同一套 `@lc/contracts`，但不允许访问 DOM/Vue；依赖通过 Server RPC 注入。
- `serverMain` 同样进签名与 SBOM；服务端制品单独扫描、单独配额。

### 15.10 协作：明确范围

多人实时编辑不是“加个 WebSocket”就能完成。它会影响文档模型、历史、画布事务和插件 API：

- 需要 CRDT/OT、操作日志、presence、冲突解决、离线重放；
- `document.apply(patch)` 要变成可合并的 op；
- 画布手势事务要能产生可协作的 op，而不是只在本地预览；
- 插件不能持有不可合并的本地状态。

建议：

- **v1 明确不做多人实时编辑**，只做“乐观锁 + 版本冲突提示”；插件 API 继续用 patch，为未来留接口。
- 若企业客户强制要求，单独立项，在 document service 层引入 Yjs/Automerge，画布事务改为 op-based；不要把它塞进插件内核。
- 在 ADR 中记录该边界，避免销售承诺与架构脱节。

---

## 16. 租户、身份、权限与审计

### 16.1 身份

| 能力         | 要求                                                 |
| ------------ | ---------------------------------------------------- |
| SSO          | OIDC 必备，SAML 2.0 企业版；支持 IdP 发起与 SP 发起  |
| 用户生命周期 | SCIM 2.0 自动开通/停用；离职即失效                   |
| MFA          | 由 IdP 负责；平台支持强制策略与高风险操作二次验证    |
| 会话         | 短期 access token + 刷新令牌；支持全局登出、设备管理 |
| 服务账号     | 自动化/后台任务使用，独立于人类用户，最小权限        |
| API Key      | 可轮换、可限定租户/环境/权限、可审计                 |
| Break-glass  | 应急账号，必须审批、限时、全量审计                   |

### 16.2 RBAC 角色

| 角色                      | 权限范围                               |
| ------------------------- | -------------------------------------- |
| Platform Admin            | 平台配置、全局插件、所有租户（极少人） |
| Platform Security Auditor | 只读审计、策略、供应链证据             |
| Tenant Admin              | 租户配置、成员、插件允许清单、配额     |
| Workspace Admin           | 工作区成员、项目、设计器预设           |
| Designer                  | 创建/编辑文档、使用已启用插件          |
| Viewer                    | 只读文档/预览                          |
| Plugin Publisher          | 发布插件到私有/市场命名空间            |
| Plugin Reviewer           | 认证审核、签名审批、吊销               |
| Service Account           | 自动化任务，按 scope 授权              |

### 16.3 ABAC 与策略即代码

RBAC 只回答“是不是管理员”，企业还需要属性条件：

- 租户、工作区、环境、文档分级；
- 插件认证等级、发布者、数据分级；
- 用户部门、地理位置、设备合规状态；
- 操作风险等级（安装、发布、导出、删除）。

策略用 OPA/Rego、Cedar 或内部 DSL 编写，编译为签名策略包下发。每次决策返回：

```ts
export interface PolicyDecision {
  /** 是否允许 */
  allow: boolean
  /** 拒绝原因码，便于前端提示与审计 */
  reason?: string
  /** 附加义务：二次审批、水印、只读、限时 */
  obligations?: Array<'require-approval' | 'watermark' | 'read-only' | 'just-in-time'>
  /** 命中的策略 id 与版本 */
  policyId: string
  policyVersion: string
}
```

策略示例：

```rego
package lowcode.install

default allow = false

allow {
  input.action == "plugin.install"
  input.plugin.certification == "platform"
  input.environment == "production"
  input.user.roles[_] == "tenant_admin"
}

allow {
  input.action == "plugin.install"
  input.plugin.certification == "verified"
  input.plugin.publisher.verified == true
  input.tenant.allowlist[input.plugin.id]
  input.environment != "production"
}
```

要求：

- 策略包签名、版本化、可回滚；决策日志保留策略版本。
- 策略变更走审批与灰度；不能直接在生产热改。
- 前端只做提示，最终以服务端决策为准；数据面缓存决策必须有 TTL 与失效通道。
- 高风险操作即使 allow，也可以附加审批、二次 MFA、水印等义务。

### 16.4 权限交集：用户权限 ∩ 插件权限

插件永远不能超过当前用户的权限：

```
最终允许 = 用户在该租户/环境的权限
         ∩ 插件 manifest 声明的权限
         ∩ 租户策略允许的能力
         ∩ 当前文档/数据分级允许的范围
```

示例：

- 用户是 Viewer，插件申请 `schema:write`：拒绝。
- 用户是 Designer，插件申请 `network: api.foo.com`：允许访问该域名，但仍受租户出站策略限制。
- 后台任务（定时导出）使用服务账号，服务账号的权限独立审计，不继承触发者权限。
- 插件不能通过“后台任务”绕过用户权限；任务创建时必须记录触发者与授权范围。

### 16.5 租户隔离

| 层        | 隔离手段                                           | 验证                    |
| --------- | -------------------------------------------------- | ----------------------- |
| 数据库    | `tenant_id` + Row Level Security；连接池按租户标记 | 跨租户查询必须返回 0 行 |
| 对象存储  | 前缀 `tenant/{id}/` + 短期签名 URL                 | 伪造 key 无法访问       |
| 缓存      | key 前缀包含 tenant/workspace/env                  | 缓存穿透测试            |
| 搜索      | 索引按租户过滤/分片                                | 搜索结果不含他租户      |
| 日志/遥测 | 结构化字段 + 脱敏 + 租户隔离查询                   | 日志后台越权测试        |
| 插件配置  | 配置层级带 tenant；密钥独立命名空间                | 配置串租户测试          |
| 审计      | 租户维度不可篡改存储                               | 导出/检索隔离           |
| 加密      | 每租户 KMS 密钥（企业版可选）                      | 密钥轮换/撤销测试       |

隔离测试必须是自动化 CI 的一部分，不能只靠 code review。

### 16.6 密钥与凭据

- 统一 Secret Manager/Vault；插件不持有明文长期密钥。
- 插件拿到的是 `SecretHandle`，使用时由网关换取短期凭据；句柄绑定租户、插件、环境、用途。
- 密钥轮换对插件透明；插件不能把密钥写进日志、schema、错误信息。
- 插件卸载/租户删除时吊销句柄与派生凭据。
- 前端插件默认不能读服务端密钥；需要服务端能力的插件走 BFF/服务账号。

```ts
export interface SecretsService {
  /** 获取句柄，不返回明文 */
  handle(key: string): Promise<SecretHandle>
  /** 由宿主网关代换短期凭据；插件只拿到结果 */
  use<T>(handle: SecretHandle, fn: (credential: ShortLivedCredential) => Promise<T>): Promise<T>
}
```

### 16.7 审计

审计事件必须覆盖：

- 登录/登出、SSO 配置变更、角色变更、Break-glass；
- 插件安装、启用、停用、卸载、升级、回滚、吊销；
- 配置修改、策略修改、发布、导出、删除；
- 插件执行的高风险动作：网络访问、文档写入、数据导出、密钥使用；
- 管理员查看敏感数据、导出审计日志。

```ts
export interface AuditEvent {
  /** 全局唯一事件 id */
  id: string
  /** 发生时间，UTC ISO8601 */
  at: string
  /** 租户 id */
  tenantId: string
  /** 工作区/环境/文档，按需填写 */
  scope: { workspaceId?: string; environment?: string; documentId?: string }
  /** 操作者：用户/服务账号/系统 */
  actor: { type: 'user' | 'service' | 'system'; id: string; displayName?: string }
  /** 动作，如 plugin.install */
  action: string
  /** 资源类型与 id */
  resource: { type: string; id: string }
  /** 结果 */
  outcome: 'success' | 'denied' | 'error'
  /** 关联的请求/追踪 id */
  correlationId: string
  /** 策略决策与版本 */
  policy?: { id: string; version: string; decision: string }
  /** 变更前后摘要；敏感字段脱敏 */
  diff?: unknown
}
```

要求：

- 追加写、不可篡改（WORM/哈希链），保留期可配置（默认 1 年，金融/政务可 3～7 年）。
- 审计写入失败必须告警，不能静默丢；高风险操作在审计不可用时 fail-closed。
- 支持 SIEM 导出（Splunk/Elastic/Chronicle 等），字段稳定、版本化。
- 审计查询本身要审计；审计员角色只读。

### 16.8 访问复核与应急

- 季度访问复核：租户管理员、平台管理员、服务账号、插件发布者。
- 离职/转岗自动触发权限回收；SCIM 停用即会话失效。
- Break-glass 账号：审批、限时、全量录屏/审计、事后复核。
- 高风险操作支持“双人复核”（four-eyes），审批记录进入审计。

---

## 17. 配置、环境与发布治理

### 17.1 配置层级

```
平台默认值
  → 租户策略/默认配置（可锁定）
    → 工作区配置
      → 环境配置（dev/staging/prod）
        → 文档/实例配置
          → 用户偏好（仅 UI）
```

规则：

- 配置项声明 `scope` 与 `lockable`；租户可锁定“安全相关”配置（如允许的域名、是否开启吸附、是否允许视口旋转）。
- 配置与密钥分离：配置里只放密钥句柄/引用，不放明文。
- 每次配置变更产生 diff 与审计；支持回滚到上一个版本。
- 数据面缓存配置，带版本与 TTL；配置中心不可用时读缓存，写操作 fail-closed。

### 17.2 环境模型

| 环境    | 用途          | 策略                          |
| ------- | ------------- | ----------------------------- |
| dev     | 开发/沙箱     | 放宽安装，允许 beta/canary    |
| staging | 预发/验收     | 接近 prod，允许灰度与回放     |
| prod    | 生产          | 审批、只允许 stable、严格审计 |
| sandbox | 插件试用/演示 | 隔离租户、禁止真实数据        |

发布流程：构建 → 测试 → 认证 → staging 验收 → prod 灰度 → 全量。每次提升保留制品 digest、配置快照、策略版本、审批记录。

### 17.3 安装范围与允许清单

- Platform：平台团队统一安装，所有租户可用。
- Tenant：租户管理员在允许清单内安装；默认进隔离层。
- Workspace：租户允许 + 工作区 opt-in；适合部门级插件。
- Environment：prod 安装需审批；dev 可自助。
- User：仅本地/沙箱，不进生产。

任何安装都要检查：签名、认证等级、许可证、内核兼容、资源配额、数据分级、出站策略。

### 17.4 变更审批

| 变更                  | 审批                                 |
| --------------------- | ------------------------------------ |
| 生产安装/升级特权插件 | 租户管理员 + 安全/平台审批（可配置） |
| 修改租户策略/允许清单 | 双人复核                             |
| 发布页面到生产        | 业务负责人 + 发布管理员（可配置）    |
| 导出敏感数据          | 数据 owner 审批 + 水印               |
| 紧急 Kill Switch      | 安全值班可单签，事后补审             |

审批不是走形式：审批单必须包含制品 digest、变更内容、影响范围、回滚方案、测试证据。

### 17.5 发布通道

| 通道   | 用途              | 自动更新            |
| ------ | ----------------- | ------------------- |
| stable | 生产              | 按策略自动补丁/手动 |
| beta   | 预发/尝鲜         | 手动                |
| canary | 灰度              | 控制面编排          |
| pinned | 金融/政务固定版本 | 禁止自动更新        |

- 插件版本不可变；同一版本不能重新发布（只能发新补丁版本）。
- `pinnedMajor` 允许补丁自动更新，但不跨 major。
- 维护窗口、冻结期（如月末结算、重大活动）由租户配置。

### 17.6 灰度与回滚

- 灰度维度：租户白名单、租户百分比、用户百分比、会话百分比、环境。
- 门禁指标：错误率、激活失败率、画布帧率、发布成功率、P95 延迟、审计异常。
- 自动回滚：指标越界自动切回 N-1；人工回滚 ≤ 5 分钟。
- 制品保留 N-2；回滚只切版本，不回滚数据；数据迁移必须 expand/contract，保证旧版本可读。
- 插件数据迁移必须双向兼容至少一个版本；破坏性迁移需要维护窗口与备份。

### 17.7 Kill Switch 与功能开关

| 级别       | 作用                             |
| ---------- | -------------------------------- |
| Platform   | 全局禁用某插件/某能力            |
| Tenant     | 单租户禁用                       |
| Plugin     | 禁用某插件所有版本               |
| Version    | 禁用某个具体版本                 |
| Capability | 禁用某个能力（如导出、外部网络） |

Kill Switch 必须：

- 控制面一键下发，数据面秒级生效（WebSocket/长轮询 + 本地缓存）；
- 禁用时优雅降级：插件贡献隐藏、活动事务取消、错误提示；
- 不删除用户数据；恢复后状态可继续；
- 全量审计，通知租户管理员。

### 17.8 配置漂移与期望状态

- 控制面保存“期望状态”（装哪些插件、什么版本、什么配置、什么策略）。
- 数据面定期上报“实际状态”；偏差产生漂移告警。
- 自动 reconcile 只用于低风险配置；高风险变更仍需审批。
- 漂移记录进入审计，避免“手工改生产”无法追踪。

---

## 18. 插件供应链与市场治理

### 18.1 私有注册表与制品

- 制品存 OCI Registry 或对象存储；内容寻址（digest），不可变。
- manifest、SBOM、签名、扫描报告作为制品附件，一起分发。
- 命名空间按发布者/租户隔离；跨租户共享需平台审批。
- 保留策略：生产版本至少保留 N-2 与审计要求的年限；被吊销版本保留证据但禁止安装。

### 18.2 发布者身份

- 发布者实名/企业认证；命名空间所有权绑定。
- 发布必须使用签名密钥 + 2FA；密钥支持轮换与吊销。
- 发布者安全联系人必须可用；高危漏洞 24 小时内可联系。
- 离职/合作终止时吊销发布权限与密钥，保留已发布制品的审计。

### 18.3 供应链证据

| 证据     | 要求                                           |
| -------- | ---------------------------------------------- |
| 签名     | Sigstore/cosign 或企业 PKI；安装与加载双重校验 |
| SBOM     | SPDX 或 CycloneDX；依赖版本完整                |
| 构建来源 | SLSA 级别目标；至少记录构建系统、commit、环境  |
| 扫描报告 | SCA、SAST、Secret、Malware、License            |
| 测试报告 | 契约测试、兼容矩阵、性能、可访问性             |
| 许可证   | SPDX 标识；禁止/限制许可证策略                 |

### 18.4 CI 门禁

```
build → unit/contract tests → SBOM → sign → SCA/SAST/secret scan
      → license policy → package → integration/e2e → certify → publish
```

门禁策略示例：

- Critical 漏洞：0；High：7 天内修复；Medium：30 天。
- 禁止 GPL/AGPL（按企业法务策略可配置）。
- 禁止安装脚本、禁止动态下载代码、禁止 obfuscation。
- 依赖必须锁定；禁止 `*` 版本范围。
- 制品体积、激活耗时、内存占用超标阻断发布。

### 18.5 认证等级

认证等级回答“谁审核过”，执行位置回答“代码跑在哪”，两者不能混成一张表。

| 等级      | 要求                                             | 允许的执行位置                                       | 可见范围      |
| --------- | ------------------------------------------------ | ---------------------------------------------------- | ------------- |
| Platform  | 平台自研/深度审计、完整测试、LTS                 | inline / iframe / worker / server                    | 所有租户      |
| Verified  | 发布者认证、签名、SBOM、扫描、隔离测试、人工评审 | inline（必须通过 UI 评审）/ iframe / worker / server | 租户允许清单  |
| Community | 基本签名与扫描                                   | iframe / worker（完整沙箱）/ server（服务端评审）    | 仅沙箱/开发者 |
| Blocked   | 漏洞、吊销、违规                                 | 禁止加载                                             | 无            |

`server` 是执行位置，不是信任等级；服务端插件仍然需要容器隔离、出站控制和独立评审。`inline` 只允许 Platform 或 Verified+UI 评审，Community 永远不能 inline。

认证不是一次性的：内核 major 升级、插件 major 升级、重大安全事件都需要重新认证。

### 18.6 评审清单

- 威胁模型：数据访问、网络出站、权限提升、供应链。
- 权限最小化：是否真的需要 `schema:write`、`network:*`、`clipboard`。
- 数据分级：是否接触 confidential/restricted 数据；是否需要驻留。
- 性能：激活耗时、物料加载、画布帧率、内存。
- 可访问性：键盘操作、对比度、屏幕阅读器（UI 插件）。
- 许可证与出口管制。
- 支持能力：文档、SLA、安全响应联系人。

### 18.7 运行时校验

loader 在安装与加载时都要校验：

1. manifest 签名有效；
2. 制品 digest 与 manifest 一致；
3. 认证等级满足当前环境策略；
4. 租户允许清单包含该插件；
5. 内核/宿主版本兼容；
6. 资源配额未超；
7. 发布者密钥未吊销。

任一失败 → fail-closed，审计 `plugin.load.denied`，前端展示可操作的错误（不是白屏）。

### 18.8 吊销与应急

- CRL/吊销列表随策略包下发；数据面定期拉取。
- 紧急 Kill Switch 可先禁用后补流程；安全值班有权单签。
- 吊销后：停止新加载、终止运行中实例、取消活动事务、通知租户、提供替代版本/回滚指引。
- 漏洞披露流程：私有渠道、修复 SLA、CVE/公告、租户通知。

### 18.9 市场与支持

- 列表页展示：发布者、认证等级、权限、数据分级、支持等级、版本、变更日志、SBOM/扫描摘要。
- 支持等级：Platinum（24×7、专属 TAM）、Gold（工作时间、4h 响应）、Standard（社区/工单）、Community（尽力）。
- 计费可选：按租户订阅、按用量、私有报价；计费与权限解耦。
- 评价/下载量只做参考，不替代认证。

### 18.10 法务与出口管制

- 插件许可证白名单/黑名单；SBOM 许可证聚合。
- DPA、子处理者清单、数据驻留声明。
- 出口管制/制裁名单筛查（按企业合规要求）。
- 开源贡献政策与 CLA/DCO。

---

## 19. 运行时隔离与安全加固

### 19.1 威胁模型

| 威胁          | 例子                       | 主要控制                               |
| ------------- | -------------------------- | -------------------------------------- |
| 恶意插件      | 窃取文档、上传数据、挖矿   | 认证等级、沙箱、权限网关、资源限额     |
| 被投毒依赖    | 供应链植入后门             | 签名、SBOM、锁定版本、扫描             |
| XSS/HTML 注入 | 物料渲染恶意 HTML          | 输出编码、sanitize、Trusted Types、CSP |
| SSRF/出站     | 插件访问内网元数据         | 出站代理、私网地址拒绝、域名白名单     |
| 权限提升      | 插件借用户权限做管理员操作 | 用户权限 ∩ 插件权限、服务端决策        |
| 数据外泄      | 复制/截图/请求带出         | DLP、剪贴板策略、水印、出站审计        |
| 资源滥用      | 死循环、超大内存、请求风暴 | Worker/容器限额、超时、熔断、配额      |
| 供应链替换    | 同版本重新发布恶意包       | 不可变 digest、签名、CRL               |

### 19.2 信任等级与执行位置

先记住两个正交维度：

- **认证等级**：`platform` / `verified` / `community`，回答“谁审核过”。
- **执行位置**：`inline` / `iframe` / `worker` / `server`，回答“代码跑在哪”。

| 级别                  | certification              | executionProfile | 代码位置               | UI 位置   | 网络                           | 密钥                 | 允许数据        |
| --------------------- | -------------------------- | ---------------- | ---------------------- | --------- | ------------------------------ | -------------------- | --------------- |
| T0 Platform Inline    | platform                   | inline           | 主 realm（同源）       | 主文档    | 受限网关                       | 服务端句柄           | 按租户策略      |
| T1 Verified Inline UI | verified + uiReview=inline | inline           | 主 realm（同源）       | 主文档    | 只能走网关，禁止 ambient fetch | 默认无长期密钥       | internal 及以下 |
| T2 Sandboxed          | verified / community       | iframe 或 worker | Worker + 独立源 iframe | iframe    | 出站代理 + 白名单              | 短期句柄（verified） | internal 及以下 |
| T3 Community Sandbox  | community                  | iframe 或 worker | Worker + 独立源 iframe | iframe    | 默认拒绝                       | 无                   | public/沙箱数据 |
| S Server Extension    | 任意认证                   | server           | 独立容器/微 VM         | 无直接 UI | 默认拒绝 + 代理                | 服务端句柄           | 按任务授权      |

关键原则：

- **只有 T0 / T1 允许同 realm**。同 realm 的 JS 无法被沙箱化，这是浏览器事实；T0/T1 是受信任代码，不是沙箱。
- T1 是给物料/画布插件准备的：必须通过 UI 安全评审、无 ambient 网络与长期密钥、严格 CSP、所有特权调用走网关。它比 T0 多一层限制，但仍然不能防恶意 JS。
- T2/T3 的 UI 必须在独立源 iframe 中，逻辑在 Worker 中；两者通过 RPC 与宿主通信。
- **物料插件与画布插件必须 `executionProfile: 'inline'`**；Community 不能 inline，只能贡献声明式物料或 iframe 面板。
- S 是执行位置，不是信任等级；服务端插件绝不使用 Node `vm` 作为安全边界，用容器/gVisor/Firecracker，配合 seccomp、只读文件系统、非 root、无宿主挂载。
- 认证等级越高，允许的数据分级与网络能力越高；不允许“社区插件 + 生产敏感数据”。

### 19.3 iframe 沙箱

- 独立源（如 `plugins-{tenant}.example.com`），不能与主应用同源。
- `sandbox="allow-scripts"`，按需加 `allow-forms`；禁止 `allow-same-origin` 与 `allow-top-navigation`。
- CSP：`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src` 只列允许的代理。
- postMessage 协议：
  - 固定 `targetOrigin`，校验 `event.origin`；
  - 消息 schema 校验；
  - 消息大小上限、频率限制；
  - 请求 id + 超时 + 取消；
  - 不传递 DOM 节点、函数、Vue 实例。
- iframe 生命周期由宿主管理；插件崩溃只影响自己的 iframe，宿主显示降级 UI。
- 禁止 iframe 直接访问主文档 cookie/localStorage；需要数据走 RPC。

### 19.4 Worker 沙箱

- 逻辑插件（数据源、表达式、导出、计算）优先放 Worker，避免阻塞主线程。
- Worker 无 DOM；通过 RPC 调用受限服务（http、storage、document 只读）。
- 每个插件实例独立 Worker或共享池 + 隔离上下文；高风险插件独立 Worker。
- 超时、内存上限、消息队列上限；超限终止并上报。
- Worker 内禁止 `importScripts` 任意 URL；只允许打包进制品的代码。
- Worker 终止时清理端口、定时器、未完成请求。

### 19.5 服务端沙箱

- 独立容器/微 VM，按租户/任务隔离；不复用进程处理不同租户的不可信代码。
- 只读根文件系统；临时目录限额；非 root；seccomp/AppArmor；无宿主 Docker socket。
- 网络默认拒绝；需要出站走代理，代理做域名白名单、私网地址拒绝、审计。
- CPU/内存/时间/磁盘配额；任务超时强杀；队列背压。
- 环境变量不注入长期密钥；需要凭据时通过 Secret Broker 换短期 token。
- 产物（导出文件、截图）写入租户前缀对象存储，带 TTL 与访问审计。

### 19.6 权限网关

所有特权操作都必须经过宿主包装，而不是直接暴露底层能力：

```ts
export interface PermissionContext {
  /** 当前用户 */
  userId: string
  /** 租户/工作区/环境 */
  tenantId: string
  workspaceId: string
  environment: string
  /** 插件身份 */
  pluginId: string
  pluginVersion: string
  /** 当前请求的追踪 id */
  traceId: string
}

export interface GuardedHttpService {
  /** 受权限网关约束的请求；插件不能绕过 */
  request(input: RequestInfo, init?: RequestInit): Promise<Response>
}
```

网关职责：

- 用户权限 ∩ 插件权限 ∩ 租户策略；
- 域名/端口/方法白名单；私网地址拒绝；重定向逐跳校验；
- 请求/响应大小限制、超时、重试策略；
- 审计：谁、哪个插件、访问了什么、结果；
- 速率限制与配额；
- 敏感数据脱敏/阻断（按租户 DLP 策略）。

### 19.7 出站、SSRF 与数据外泄

- 所有出站走统一代理；插件不能直接 `fetch` 任意 URL。
- 拒绝 `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、IPv6 私网/链路本地。
- DNS 解析后校验 IP，防止 DNS rebinding；重定向逐跳校验。
- 请求体/响应体大小限制；文件下载走对象存储扫描。
- DLP：识别身份证、手机号、密钥；按策略阻断、脱敏或告警。
- 剪贴板/下载/打印策略；敏感页面加水印；导出需审批。

### 19.8 Web 安全

- CSP 禁止 `unsafe-eval`；脚本仅允许签名来源；`object-src 'none'`。
- Trusted Types：所有 `innerHTML`/`insertAdjacentHTML` 走策略；物料 HTML 必须 sanitize。
- 表达式引擎白名单函数，禁止原型链访问、禁止 `constructor`。
- URL 协议白名单（http/https/mailto/tel）；禁止 `javascript:`、`data:`（除图片白名单）。
- 文件上传：类型/大小/病毒扫描；图片重编码；SVG 去脚本。
- CSRF：SameSite Cookie + CSRF token；敏感操作二次确认。
- postMessage：origin + schema + 大小 + 频率校验。

### 19.9 秘密管理

- 前端插件不持有服务端长期密钥；使用 SecretHandle。
- 服务端插件通过 Secret Broker 获取短期凭据；凭据绑定租户、插件、任务、TTL。
- 禁止把密钥写入 schema、日志、错误堆栈、审计 diff。
- 密钥轮换、吊销、访问审计；泄露应急预案。

### 19.10 事件响应控制

- Kill Switch：秒级禁用插件/版本/能力。
- 隔离租户：可疑租户进入只读/沙箱模式，不影响其他租户。
- 吊销制品：CRL + 强制卸载/禁止加载。
- 证据保全：审计、日志、制品、内存快照（按合规要求）。
- 租户通知与补救指引；事后 RCA 与认证复核。

### 19.11 隔离验证

- iframe：验证独立源、sandbox 属性、CSP、postMessage origin 校验。
- Worker：验证超时终止、内存超限、消息洪泛、无 DOM 访问。
- 服务端：验证无网络、无宿主挂载、非 root、seccomp、资源限额、跨租户隔离。
- 权限网关：验证越权 URL、私网地址、重定向、DNS rebinding、超限请求全部拒绝。
- 每次发布跑隔离回归；每年至少一次红队/渗透测试。

---

## 20. 可观测性、SLO 与运维

### 20.1 遥测架构

```
浏览器/Worker/服务端
  → OpenTelemetry SDK（租户/插件/文档维度）
  → Collector（脱敏、采样、批量）
  → Metrics / Traces / Logs 后端
  → SLO 看板 / 告警 / 成本归因
```

- 统一资源属性：`tenant.id`、`workspace.id`、`environment`、`plugin.id`、`plugin.version`、`document.id`、`release.channel`。
- 前端采样：错误 100%，普通 trace 采样（如 5%～10%），慢请求全采。
- PII 脱敏在 SDK/Collector 完成；禁止把文档内容、用户输入、密钥写入遥测。
- 遥测失败不影响业务；队列满时丢弃低优先级数据并计数。

### 20.2 Trace 模型

```
user.click
  → command.execute (canvas.zoom.in)
    → plugin span (canvas-zoom)
      → viewport.update
  → render frame

action.run
  → dataSource.execute (http)
    → permission gateway
      → egress proxy
        → upstream API
```

每个 span 带插件 id/version、租户、文档、环境；插件边界必须显式 span，否则无法定位“是插件慢还是宿主慢”。

### 20.3 指标

| 类别   | 指标                                                     |
| ------ | -------------------------------------------------------- |
| 插件   | 激活耗时、激活失败率、运行错误率、卸载残留、版本分布     |
| 画布   | 帧率、pointermove p95、吸附耗时、图层数、事务提交/取消率 |
| 物料   | 加载耗时、失败率、chunk 大小、缓存命中                   |
| 数据源 | 请求量、错误率、P95、超时、出站拒绝                      |
| 发布   | 发布成功率、回滚次数、灰度失败、制品验证失败             |
| 安全   | 签名失败、越权拒绝、CSP 违规、DLP 命中、Kill Switch 次数 |
| 平台   | API P95、错误率、队列深度、数据库连接、缓存命中          |
| 成本   | 租户/插件 CPU、内存、存储、出站流量、渲染任务            |

### 20.4 日志与审计分离

- 运行日志：排障用，可采样、可轮转，含 traceId，不含敏感数据。
- 审计日志：合规用，追加写、不可篡改、全量、长期保留。
- 两者字段模型不同，不能用一个“万能日志表”糊弄。
- 审计查询本身审计；运行日志访问也要权限控制。

### 20.5 SLO 与错误预算

| SLO          | 目标                                       | 度量                             |
| ------------ | ------------------------------------------ | -------------------------------- |
| 设计器可用性 | 99.9%                                      | 成功加载并完成一次编辑的会话比例 |
| 设计器可交互 | p95 < 2 s                                  | 打开文档到可编辑                 |
| 发布成功率   | 99.5%                                      | 发布任务成功比例                 |
| 插件激活     | p95 < 300 ms                               | 不含网络下载                     |
| 画布拖拽     | ≥ 55 fps（5000 节点）；常规页面目标 60 fps | P95 帧时间                       |
| 数据源调用   | p95 < 1 s                                  | 不含上游慢请求                   |
| 审计写入     | 99.99%                                     | 高风险操作审计成功比例           |

错误预算用于发布门禁：预算耗尽时冻结非紧急发布，优先修复可靠性。

### 20.6 看板与告警

- 平台总览、租户视图、插件视图、发布视图、画布性能视图、安全视图。
- 告警按症状而非原因：用户看到的是白屏/卡顿/发布失败，不是“CPU 高”。
- 每个告警必须链接 Runbook：影响、排查、缓解、回滚、升级路径。
- 告警分级：P0 全租户不可用/数据泄露；P1 单租户不可用/发布阻断；P2 性能退化；P3 个别插件异常。

### 20.7 故障与应急

- 值班：平台 on-call + 安全 on-call + 插件 owner on-call。
- 应急手段：Kill Switch、回滚、切只读、降级画布、禁用出站、隔离租户。
- 事故沟通：状态页、租户通知、时间线、RCA、改进项跟踪。
- 事后复盘非追责；但必须有可验证的改进项与截止时间。

### 20.8 成本与容量

- 按租户/插件计量 CPU、内存、存储、出站、渲染任务。
- 预算告警与配额；超配额降级而不是直接封禁（除非策略要求）。
- 成本分摊到工作区/项目；插件作者能看到自己插件的资源消耗。
- 容量规划按增长曲线与峰值；大促/月末预留缓冲。

### 20.9 插件健康分

| 维度   | 指标                             |
| ------ | -------------------------------- |
| 稳定性 | 错误率、崩溃率、激活失败率       |
| 性能   | 激活耗时、物料加载、画布帧率影响 |
| 安全   | 漏洞数、越权拒绝、签名/扫描状态  |
| 采用   | 安装租户数、活跃使用、版本分布   |
| 支持   | 工单响应、修复时长、文档完整度   |

健康分用于市场排序、认证复核、租户告警，不替代人工评审。

### 20.10 演练

- 每季度：控制面故障（fail-static/fail-closed）、插件供应链吊销、租户隔离渗透。
- 每半年：区域故障切换、备份恢复、审计不可用、Kill Switch 全链路。
- 每年：红队、灾难恢复、供应商故障、内部威胁演练。

---

## 21. 数据治理、合规与灾备

### 21.1 数据分级

| 级别         | 例子                         | 默认控制                               |
| ------------ | ---------------------------- | -------------------------------------- |
| public       | 公开素材、示例页面           | 基础审计                               |
| internal     | 企业内部页面、普通配置       | 租户隔离、加密                         |
| confidential | 客户数据、业务流程           | 加密、访问审批、DLP、审计              |
| restricted   | 密钥、身份数据、敏感个人信息 | 最强隔离、字段加密、禁止导出、双人审批 |

插件 manifest 声明 `dataPolicy.classification`；租户策略决定哪些插件能接触哪些级别。

### 21.2 租户数据隔离（纵深）

- 数据库：`tenant_id` 非空约束 + RLS；应用层禁止裸 SQL 跨租户。
- 对象存储：租户前缀 + 服务端加密 + 短期签名 URL。
- 缓存：key 带 tenant/workspace/env；禁止共享敏感缓存。
- 搜索：索引过滤/分片；查询强制租户条件。
- 消息队列：消息头带 tenant；消费者校验。
- 日志/遥测：租户字段 + 脱敏；查询层强制过滤。
- 备份：按租户可恢复（企业版）；至少支持整库恢复 + 文档级导出。
- 加密：每租户 KMS 密钥（企业版可选），密钥撤销即数据不可读。

### 21.3 加密

- 传输：TLS 1.2+，内部服务 mTLS。
- 存储：AES-256 at rest；对象存储服务端加密；数据库透明加密。
- 密钥：KMS/HSM，轮换周期可配置；密钥访问审计。
- 字段级加密：restricted 数据（如身份号、密钥）单独加密。
- 备份加密；恢复时校验完整性。

### 21.4 数据驻留

- 租户选择驻留区域；控制面元数据与数据面数据分别声明。
- 跨区域复制需租户显式授权；默认不跨区。
- 子处理者清单公开；新增子处理者提前通知。
- 离线/私有化部署数据不出客户网络。

### 21.5 保留、法律保留与 DSAR

| 数据         | 默认保留                  | 说明            |
| ------------ | ------------------------- | --------------- |
| 文档当前版本 | 租户生命周期              | 删除进入回收站  |
| 文档历史版本 | 90 天（可配）             | 企业可延长      |
| 审计         | 1 年（金融/政务 3～7 年） | WORM            |
| 运行日志     | 30 天                     | 可采样          |
| 遥测         | 90 天                     | 聚合后长期保留  |
| 备份         | 35 天                     | PITR + 月度归档 |
| 插件数据     | 按 manifest dataPolicy    | 卸载可 purge    |

- 法律保留（Legal Hold）：命中后禁止删除，需审批解除。
- DSAR：导出、删除、更正；跨插件数据由平台编排，插件必须实现删除钩子。
- 删除证明：对象存储/数据库/备份的删除记录；备份中的删除按 SLA 生效。

### 21.6 文档版本与回滚

- 每次发布冻结不可变版本；运行时只读发布制品。
- 文档编辑保留版本历史；支持查看 diff、恢复、命名版本。
- 发布回滚不改变文档历史；只切运行时版本。
- 插件升级导致文档不兼容时，提供迁移与回滚策略；破坏性迁移需备份与维护窗口。

### 21.7 备份与灾难恢复

| 项           | 目标                 | 手段                         |
| ------------ | -------------------- | ---------------------------- |
| 文档 RPO     | ≤ 5 min              | Postgres PITR / 增量备份     |
| 文档 RTO     | ≤ 1 h                | 多 AZ 热备 + 恢复演练        |
| 插件配置 RPO | 0                    | 控制面多副本 + 事件溯源      |
| 审计 RPO     | ≈ 0                  | 同步写 + 异地复制            |
| 对象存储     | 99.999999999% 持久性 | 版本化 + 跨区复制（按需）    |
| 区域故障     | RTO ≤ 4 h            | 灾备区域、DNS 切换、制品同步 |

- 每半年恢复演练；记录实际 RTO/RPO。
- 租户级恢复是付费能力；至少支持“导出 + 导入到新工作区”。
- 备份加密、访问审计、恢复权限双人审批。

### 21.8 合规映射

以 SOC 2 Type II、ISO 27001、GDPR/CCPA 为控制基线（认证以第三方审计为准）：

| 控制域     | 平台证据                                   |
| ---------- | ------------------------------------------ |
| 访问控制   | SSO、RBAC/ABAC、访问复核、Break-glass 审计 |
| 变更管理   | 发布审批、灰度、回滚、配置 diff            |
| 供应链     | 签名、SBOM、扫描、认证、CRL                |
| 监控与响应 | SLO、告警、事故记录、演练                  |
| 数据保护   | 加密、隔离、驻留、保留、DSAR               |
| 业务连续性 | 备份、DR、RTO/RPO 演练                     |
| 供应商管理 | 子处理者清单、评估、合同                   |

### 21.9 插件数据访问

- 插件访问文档数据必须经 `document` 服务，不能直接读数据库/对象存储。
- 读写范围按用户权限 ∩ 插件权限 ∩ 文档分级。
- 插件私有数据存 `ctx.storage.namespace(pluginId)`，租户隔离；卸载按 dataPolicy purge。
- 插件导出数据必须走审批与审计；禁止静默批量导出。
- 插件不得在客户端缓存 confidential/restricted 数据超过会话；必要时加密缓存。

### 21.10 离线与信创

- 离线包包含：制品、manifest、签名、SBOM、扫描报告、依赖、许可证。
- 本地注册表、本地策略、本地审计、本地 KMS/国密适配（按项目要求）。
- 无外网时禁止遥测外发；提供本地遥测/日志导出。
- 更新通过离线介质，校验签名与 digest；升级失败可回滚。
- 许可证到期降级：禁止新安装/发布，不锁死已有文档与导出。

---

## 22. 企业工程体系、认证与支持

### 22.1 仓库与注册表策略

- 平台核心（kernel/contracts/canvas/loader/security）在受控 Monorepo，严格 review + 发布门禁。
- 官方插件可在同一 Monorepo 或独立仓库；第三方插件独立仓库，只依赖公开 SDK。
- 私有注册表按环境分区（dev/staging/prod），制品不可变，跨环境只提升 digest。
- 平台 SDK 与插件 SDK 分开版本；插件只依赖稳定契约，不依赖内部实现。

### 22.2 CI/CD 流水线

```
lint → typecheck → unit → contract → build → SBOM → sign → scan
     → integration → e2e → perf → a11y → security → certify → publish
```

每个阶段产物可追溯：commit、构建环境、依赖、测试报告、签名、扫描报告。发布到生产必须引用一个已认证的 digest，不能“本地构建直接上线”。

### 22.3 测试矩阵

| 类型 | 范围                                | 门禁              |
| ---- | ----------------------------------- | ----------------- |
| 单元 | 坐标、吸附、事务、权限判断          | 覆盖率 + 关键分支 |
| 契约 | 插件与服务接口、事件、manifest      | 所有插件必须通过  |
| 集成 | 插件装卸、依赖变化、画布组合        | 关键组合          |
| E2E  | 设计器拖拽、缩放、旋转、发布、回滚  | 主流程 + 回归     |
| 性能 | 画布 5000 节点、30 处理器、物料加载 | 预算不退化        |
| 安全 | SAST/DAST/SCA/secret/渗透           | 无 Critical/High  |
| 隔离 | 租户、iframe、Worker、容器          | 每次发布          |
| 混沌 | 控制面故障、Kill Switch、区域切换   | 季度              |

### 22.4 兼容矩阵

必须明确测试：

- 内核版本（当前 + 两个 LTS）× 插件版本；
- 设计器/运行时 Host 版本；
- Vue 3 次版本；
- 浏览器（Chrome/Edge/Safari/Firefox 企业基线）；
- 操作系统/设备（桌面为主，触控板/触屏）；
- 部署形态（SaaS/专属/离线）。

兼容矩阵是发布门禁的一部分，不靠“用户反馈才发现”。

### 22.5 SDK 与 LTS

- 内核 API semver；LTS 版本支持 18 个月，安全修复按严重级别。
- 破坏性变更提前 12 个月公告；提供 codemod、迁移指南、双版本兼容期。
- 插件通过能力标志检测功能，不通过版本号猜行为。
- 契约测试保证旧插件在新内核上可运行；不兼容时 loader 拒绝并给出升级路径。
- 弃用策略：标记 → 警告（devtools/CI）→ 移除；至少两个 minor。

### 22.6 认证与评审组织

- 插件评审委员会：平台架构、安全、法务、支持、产品。
- 认证流程：提交 → 自动扫描 → 人工评审 → 隔离测试 → 认证 → 发布 → 复核。
- 认证等级、有效期、复核周期写入 manifest 与注册表。
- 重大内核升级、插件 major、重大安全事件触发重新认证。
- 评审记录、证据、决策进入审计与知识库。

### 22.7 开发者体验

- `create-lowcode-plugin` 脚手架：manifest、构建、测试、示例、CI 模板。
- 本地开发服务器：mock 控制面、mock 租户、热更新、画布调试面板。
- 契约测试工具：一条命令验证服务、事件、贡献点、卸载清理。
- 画布测试工具：合成指针、缩放、吸附、冲突场景。
- 文档：API 参考、迁移指南、最佳实践、反模式、安全基线。
- 沙箱环境：开发者可试用 Verified/Community 插件，不接触真实数据。

### 22.8 支持与 SLA

| 等级      | 响应               | 渠道            | 适用      |
| --------- | ------------------ | --------------- | --------- |
| Platinum  | 24×7，15 min（P0） | 专属 TAM + 电话 | 关键业务  |
| Gold      | 工作时间，4 h      | 工单 + IM       | 企业标准  |
| Standard  | 下一个工作日       | 工单            | 中小企业  |
| Community | 尽力               | 社区            | 开源/试用 |

插件支持责任：

- Platform 插件由平台团队负责；
- Verified 插件由发布者负责，平台提供升级/吊销协调；
- Community 插件不承诺 SLA，只在沙箱可用。
- 每个插件必须有 owner、安全联系人、升级/回滚指引。

### 22.9 治理机制

- 架构评审委员会（ARB）：内核/契约/画布核心变更。
- 变更顾问（CAB）：生产高风险变更。
- 插件评审委员会：认证、吊销、例外。
- 数据治理委员会：数据分级、驻留、DSAR 例外。
- 安全响应小组：漏洞、供应链事件、Kill Switch。
- 每个插件有 owner 与 on-call；无 owner 的插件不得进生产。

### 22.10 工程效能指标

| 指标         | 说明                   |
| ------------ | ---------------------- |
| 部署频率     | 平台/插件发布节奏      |
| 变更前置时间 | commit 到生产          |
| 变更失败率   | 回滚/事故比例          |
| MTTR         | 平均恢复时间           |
| 插件认证周期 | 提交到认证通过         |
| 兼容性回归数 | 每次内核升级发现的问题 |
| 逃逸缺陷     | 生产发现、测试未覆盖   |

指标用于改进，不用于个人考核；插件质量分与认证/市场排序挂钩。

### 22.11 企业落地路线

1. **单租户试点**：内核 + 画布 + 基础插件，验证“装即用”和性能。
2. **多租户 SaaS**：租户/SSO/RBAC/审计/配额，先内部租户再外部。
3. **受治理市场**：私有注册表、签名、认证、灰度、Kill Switch。
4. **隔离升级**：Verified/Community 插件进 iframe/Worker/容器。
5. **合规与私有化**：SOC 2/ISO 控制、数据驻留、离线部署、DR 演练。
6. **生态**：第三方认证、支持分级、计费、区域扩展。

---

## 23. 安全与权限实现基线

完整的认证/执行矩阵见 §18.5 与 §19.2。这里给出代码落地时的最小基线：同 realm 的 JavaScript 无法被真正沙箱化，必须分层。

| 信任级别              | certification + executionProfile    | 隔离方式                                        | 适用                   |
| --------------------- | ----------------------------------- | ----------------------------------------------- | ---------------------- |
| T0 Platform Inline    | platform + inline                   | 同 realm + 权限网关 + 代码审计                  | 官方核心物料/画布插件  |
| T1 Verified Inline UI | verified + inline + uiReview=inline | 同 realm + 无 ambient 网络/密钥 + CSP + UI 评审 | 认证物料/画布插件      |
| T2 Sandboxed          | verified/community + iframe/worker  | Worker/iframe（独立源） + 权限包装 + CSP        | 面板、无头逻辑、数据源 |
| T3 Community Sandbox  | community + iframe/worker           | 完整沙箱 + RPC                                  | 市场长尾插件           |
| S Server              | 任意认证 + server                   | 容器/微 VM + 出站代理                           | 服务端扩展             |

这份基线对 T2/T3 提供 preventive isolation；T0/T1 是受信任代码，CSP、代码评审、网关审计是 detective/限制性控制，不能宣称能防同 realm 恶意 JS。

权限声明：

```ts
export type Permission =
  | { type: 'network'; hosts: string[] }
  | { type: 'storage'; scope: 'plugin' | 'document' }
  | { type: 'clipboard' }
  | { type: 'schema'; mode: 'read' | 'write' }
  | { type: 'ui'; area: 'panel' | 'canvas' }
  | { type: 'canvas'; mode: 'read' | 'interact' | 'write' }
```

执行方式不是“检查 manifest”，而是**注入受限服务实现**：

```ts
export function createHttpService(root: HttpService, permissions: Permission[]): HttpService {
  const allowed = new Set(
    permissions.filter((item) => item.type === 'network').flatMap((item) => item.hosts),
  )

  return {
    request(input, init) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      const sameOrigin = url.origin === location.origin
      if (!sameOrigin && !allowed.has(url.host)) {
        throw new PermissionError(`network:${url.host}`)
      }
      return root.request(input, init)
    },
  }
}
```

注意：上面的 `permissions` 只是插件自身声明，实际允许还要求当前用户权限与租户策略通过；完整权限交集见 §16.4。

其他措施：

- manifest 与制品必须签名，安装/加载双重校验；
- 核心服务名保留 + `ServiceGrant` 授权；`manifest.provides` 只是声明，不是运行时授权；
- 内部生命周期事件走私有总线，插件只能通过 `ctx.diagnostics` / `ctx.services` 只读观察；
- 远程模块必须 HTTPS + SRI + 签名；
- 安装时展示权限，运行时不可提权；
- 禁止插件访问 `window.parent`、`top`、`document.cookie`（T2/T3 必须在 iframe）；
- 插件脚本不允许 `eval` / `new Function`，表达式引擎单独做白名单解释器；
- CSP 禁止 `unsafe-eval`，远程脚本走固定域名；
- 供应链：锁定版本、校验完整性、不允许安装脚本。

---

## 24. 性能预算与容量基线

| 指标                 | 目标                        | 手段                                    |
| -------------------- | --------------------------- | --------------------------------------- |
| 内核 gzip            | < 15 KB                     | 无第三方依赖、无 Vue                    |
| 设计器空壳首屏可交互 | < 500 ms（30 个插件已安装） | 只加载 manifest 元数据，不执行插件代码  |
| 单插件激活           | < 30 ms（不含网络）         | 懒激活、微任务批处理                    |
| 物料 chunk           | 常规 < 100 KB gzip          | 按物料/插件切 chunk                     |
| 注册表查询           | O(1)                        | Map 索引                                |
| 画布事件管线         | p95 < 2 ms                  | 单根监听、处理器预算、rAF 批处理        |
| 画布拖拽             | ≥ 55 fps（5000 节点）       | 视口裁剪、空间索引、直接 transform 预览 |
| 画布覆盖层           | ≤ 10 层常驻                 | band + 脏层重绘                         |
| 吸附解析             | < 2 ms（1000 候选）         | 视口裁剪、候选缓存                      |

代码级预算与 §20.5 的业务 SLO 配套使用；容量规划与租户配额见 §15.5、§20.8。

额外规则：

- 物料面板只读 manifest，不加载组件；
- 面板组件首次打开才加载；
- 命令面板只加载命令元数据；
- 启动后空闲时段激活 `onStartupFinished` 插件；
- 卸载插件时清空模块缓存，避免内存只增不减；
- devtools 默认关闭，生产不打包。

---

## 25. 版本、兼容与 LTS

### 25.1 三层版本

| 版本             | 位置                          | 语义                 |
| ---------------- | ----------------------------- | -------------------- |
| 内核 API 版本    | `manifest.engines.lowcode`    | 不兼容变更升 major   |
| 插件版本         | `package.json.version`        | 插件自身 semver      |
| 文档 schema 版本 | `DocumentModel.schemaVersion` | 文档迁移，独立于插件 |

### 25.2 兼容策略

- 内核 API 遵循 semver，插件安装时校验 `engines.lowcode`；
- 契约新增字段/服务是 minor，删除/改签名是 major；
- 废弃 API 先在 devtools 警告，至少保留两个 minor；
- 插件升级必须兼容旧文档；不兼容时提供 `migrate`，在打开文档时执行；
- 远程插件市场按内核版本过滤可用插件；
- 禁止插件通过探测内核版本分支逻辑，应使用能力标志（`ctx.capabilities.has('...')`）。

### 25.3 插件数据版本

```ts
export interface PluginDataMeta {
  /** 插件写入的数据版本 */
  version: number
  /** 最后写入时间，用于冲突提示 */
  updatedAt: number
}
```

插件自己的存储数据由插件负责迁移；平台只提供命名空间和版本元信息。

### 25.4 LTS 策略

- 内核同时维护两个 LTS 版本；每个 LTS 支持 18 个月（含安全修复）。
- 破坏性变更提前 12 个月公告；提供 codemod、迁移指南、双版本兼容期。
- 插件声明 `engines.lowcode` 与能力标志；不通过版本号猜测行为。
- 每个 LTS 维护兼容矩阵：Host、Vue、浏览器、画布插件、Tier 1 认证插件。
- LTS 结束前 6 个月通知插件作者；未升级的插件在市场中标记风险。
- 安全修复优先回补 LTS；Critical 漏洞修复 SLA 以合同为准。

---

## 26. 关键流程时序

### 26.1 启动

```
控制面 sync：签名策略包 / 插件允许清单 / 租户配置
  → 安装核心服务插件
  → loader.scan()：校验签名/认证/策略，注册已批准贡献
  → loader.activateStartup()
  → mount(Designer)
  → 打开文档 → EditorRealm → CanvasRealm → preset-canvas
  → 用户打开物料面板：读 manifest，不加载组件
  → 用户拖入 Button：ensureMaterial → 加载 chunk → 渲染
```

### 26.2 依赖缺失

```
PluginA.apply 需要 service X
  → activate 检查缺失 → state = pending
  → 不报错，不上屏，devtools 显示“等待 X”
  → PluginX.apply provide X
  → internal/service 事件
  → PluginA 重新调度 → apply
```

### 26.3 依赖消失

```
PluginX 卸载
  → EffectScope 逆序释放，X 服务移除
  → internal/service(name=X, value=undefined)
  → 所有 inject 包含 X 的 active 实例 → deactivate
  → 它们提供的服务也随之移除 → 级联 deactivate
  → X 重新安装 → 依赖者按拓扑顺序恢复
```

### 26.4 安装 / 卸载

见 5.6，核心是“贡献先注册、代码后加载、卸载全回收”。

### 26.5 打开文档与画布

```
openDocument(docId)
  → editor = app.workspace.createEditorRealm({ documentId: docId })
  → editor 提供 history / selection / document
  → canvas = editor.createCanvasRealm()
  → canvas.context.plugin(canvasCore)    // viewport / interaction / layers / transaction
  → canvas.context.plugin(presetCanvas)  // 按产品形态安装画布插件
  → mount(CanvasStage + LayerHost)
  → Ctrl+wheel → canvas-zoom 处理器 → viewport.zoomAt
  → 拖拽手柄 → canvas-resize → transaction.preview → commit
  → 关闭文档 → editor.dispose() → 画布 + 文档级插件/监听器全部回收
```

### 26.6 企业安装与发布

```
request install
  → 控制面：签名 / 认证 / SBOM / 许可证 / 配额
  → 策略：租户 / 环境 / 允许清单 / 数据分级
  → 生产环境审批（双人复核）
  → 下载制品 → 校验 digest + signature（fail-closed）
  → loader 注册贡献 → 激活 → 审计
  → 灰度（租户/用户/会话）→ 指标门禁 → 全量或自动回滚
  → 异常：Kill Switch → 禁用 → 通知 → 修复/吊销
```

---

## 27. 交付路线

周期是参考值，取决于团队规模与合规范围；企业级能力必须按阶段验收，不能“最后补安全”。

### Phase 0：内核 + 画布微内核（6～8 周）

- Context / ServiceScope / EffectScope / EventBus / PluginRuntime
- 配置解析与校验；生命周期测试矩阵全绿
- 画布内核：viewport / scene / hitTest / measure / interaction / layers / transaction / scheduler
- 首批画布插件：zoom、pan、selection、drag、resize、snap、guides
- 验收：画布插件独立安装/卸载，5000 节点拖拽 ≥ 55 fps，坐标与吸附单测全绿

### Phase 1：低代码产品闭环（6～8 周）

- 核心服务：schema、material、setter、document、history、command、renderer
- Vue 宿主：Context 注入、Slot、错误边界、响应式桥接
- 设计器壳：物料面板、画布、属性面板、大纲
- 内置插件：基础物料、HTTP 数据源、导出 Vue、画布预设
- 验收：新增物料包/画布插件只改 manifest 与包，不修改宿主

### Phase 2：企业基础能力（12～16 周）

- 控制面：租户、SSO、SCIM、RBAC/ABAC、策略中心、审计
- 配置/环境/发布：分层配置、审批、灰度、回滚、Kill Switch
- 供应链：私有注册表、签名、SBOM、扫描、认证流水线
- 隔离：T0/T1 inline、T2 Worker/iframe、T3 完整沙箱、S 服务端容器
- 可观测：OTel、SLO、租户/插件看板、成本归因
- 验收：跨租户隔离测试、签名校验、Kill Switch、回滚演练通过

### Phase 3：合规与私有化（12～16 周）

- 数据驻留、保留/删除、DSAR、Legal Hold
- 备份/DR、RTO/RPO 演练、区域切换
- 离线/信创部署、本地注册表、许可证降级
- SOC 2 / ISO 27001 **控制就绪与证据自动化**；正式认证单独排期（通常 6～12 个月，需组织级审计）
- 验收：DR 演练达标、离线安装升级成功、审计可导出 SIEM

### Phase 4：生态与规模化

- 第三方认证、支持分级、计费、市场
- 多区域、容量优化、成本优化
- 协作/多人编辑：单独立项，v1 不承诺（见 §15.10）
- AI 扩展、行业插件包
- 验收：认证插件可灰度上架，租户可自助安装/回滚

> 周期假设 6～10 人全职团队；小团队请乘 1.5～2，且不要把合规认证与“控制就绪”混为一谈。

---

## 28. 架构决策记录（ADR 摘要）

| ADR     | 决策                                                                       | 理由                                                         | 代价                                                                |
| ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| ADR-001 | 自研薄内核，而不是直接依赖 cordis                                          | 需要 Realm、声明式贡献、权限、Vue 适配，且内核是平台核心资产 | 生命周期/并发细节要自己维护                                         |
| ADR-002 | 显式 `inject`，不做隐式响应式依赖追踪                                      | 可诊断、可生成依赖图、行为确定                               | 插件作者多写一行声明                                                |
| ADR-003 | 声明式贡献 + 代码懒加载                                                    | 安装即可见、首屏快、卸载干净                                 | manifest 与实现可能不一致，需要构建期校验                           |
| ADR-004 | 只有 T0 Platform 与 T1 Verified Inline UI 允许同 realm；Community 永远沙箱 | 物料/画布必须内联，但同 realm 无法安全隔离第三方 JS          | T1 需要 UI 评审、无 ambient 网络/密钥、CSP；沙箱带来 RPC 与 UI 限制 |
| ADR-005 | 文档级 Realm 独立 service scope                                            | 多文档状态隔离、预览 mock 简单                               | 需要明确哪些服务是文档级                                            |
| ADR-006 | 插件配置不可变，变更即重启                                                 | 避免半初始化状态，回滚简单                                   | 热更新粒度粗                                                        |
| ADR-007 | 画布采用微内核，每个画布能力是独立插件                                     | 可裁剪、可独立测试、避免单体画布与坐标漂移                   | 需要设计交互管线/图层/事务契约                                      |
| ADR-008 | 控制面与数据面分离                                                         | 独立扩缩容、故障隔离、支持 SaaS/专属/离线                    | 控制面与数据面之间的签名、缓存、网络复杂                            |
| ADR-009 | 多租户默认池化，专属/离线可选                                              | 成本与交付平衡                                               | 池化需要强 RLS、配额与隔离测试                                      |
| ADR-010 | 制品不可变 + 签名 + SBOM + 认证                                            | 供应链可信，可吊销、可回滚                                   | 发布流程更重，认证成本高                                            |
| ADR-011 | 策略即代码 + 用户权限 ∩ 插件权限                                           | 可审计、可解释、最小权限                                     | 策略复杂度和缓存一致性成本                                          |
| ADR-012 | 可观测性是发布门禁的一等公民                                               | 没有租户/插件维度就无法定位与计费                            | 遥测成本与脱敏要求                                                  |
| ADR-013 | 内核 LTS 18 个月，破坏性变更提前 12 个月                                   | 企业插件需要稳定预期                                         | 旧版本维护成本                                                      |
| ADR-014 | v1 不做多人实时协作，只做乐观锁 + 冲突提示                                 | CRDT/OT 会重写文档/历史/画布事务，不能塞进插件内核           | 需要单独立项；插件 API 保留 patch                                   |
| ADR-015 | 控制面 NestJS + Fastify + Postgres/Kysely；registry 委托 Harbor/S3         | 企业需要模块化、RLS、迁移、OpenAPI；不自研 OCI               | 后端运维与数据库成本                                                |
| ADR-016 | 机密数据源/SSR/定时任务走 S ServerPluginHost                               | 浏览器不能持有服务端密钥，导出需要服务端渲染                 | 容器/沙箱与 RPC 运维复杂                                            |

如果团队只有 1～2 人且上线紧迫，ADR-001 可以改为“直接用 cordis 作为底座”，把精力放在 loader、贡献点、Vue 适配和低代码服务上；内核 API 保持相近，后续再替换。若目标是平台型产品，建议自研，因为多 Realm、权限、贡献点、诊断会持续侵入内核边界。

---

## 29. 附录：从零写一个插件

### 29.1 目录

```
packages/plugins/plugin-datasource-http/
├── package.json
├── vite.config.ts
└── src/
    ├── index.ts
    ├── source.ts
    └── types.ts
```

### 29.2 插件入口

```ts
// src/index.ts
import { definePlugin } from '@lc/kernel'
import { z } from 'zod'
import { HttpDataSource } from './source'
import { httpSourceSchema } from './types'

export default definePlugin({
  name: 'datasource-http',
  inject: ['http'],
  schema: z.object({
    /** 默认超时，毫秒；实例配置可覆盖 */
    timeout: z.number().int().positive().default(10_000),
    /** 允许访问的域名；空数组表示仅同源 */
    allowHosts: z.array(z.string()).default([]),
  }),
  apply(ctx, config) {
    // 注册即副作用；用 effect 包住，卸载时自动注销
    ctx.effect(() =>
      ctx.dataSource.register({
        name: 'http',
        title: 'HTTP 请求',
        configSchema: httpSourceSchema,
        async create(options, { signal }) {
          return new HttpDataSource(ctx, config, httpSourceSchema.parse(options), signal)
        },
      }),
    )
  },
})
```

### 29.3 实例实现

```ts
// src/source.ts
import type { Context } from '@lc/kernel'
import type { z } from 'zod'
import type { httpSourceSchema } from './types'

type PluginConfig = {
  /** 默认超时，毫秒 */
  timeout: number
  /** 允许访问的域名 */
  allowHosts: string[]
}

type SourceConfig = z.infer<typeof httpSourceSchema>

export class HttpDataSource {
  constructor(
    private readonly ctx: Context,
    private readonly pluginConfig: PluginConfig,
    private readonly config: SourceConfig,
    private readonly scopeSignal: AbortSignal,
  ) {}

  async run(params: unknown, signal: AbortSignal): Promise<unknown> {
    const url = new URL(this.config.url)

    // 实例级白名单优先，其次插件级白名单，最后同源
    const allowed =
      this.config.allowHosts?.includes(url.host) ||
      this.pluginConfig.allowHosts.includes(url.host) ||
      url.origin === location.origin
    if (!allowed) {
      throw new Error(`[datasource-http] 域名未授权: ${url.host}`)
    }

    // 文档关闭（scopeSignal）或单次请求取消（signal）都会中止
    const composed = AbortSignal.any([signal, this.scopeSignal])

    return this.ctx.http.request(url, {
      method: this.config.method,
      headers: this.config.headers,
      body: this.config.method === 'GET' ? undefined : JSON.stringify(params),
      signal: composed,
      timeout: this.config.timeout ?? this.pluginConfig.timeout,
    })
  }
}
```

### 29.4 纯物料插件

```json
{
  "name": "@lc/plugin-material-stat",
  "version": "1.0.0",
  "type": "module",
  "peerDependencies": {
    "vue": "^3.5.0"
  },
  "lowcode": {
    "name": "material-stat",
    "engines": { "lowcode": "^1.0.0" },
    "activationEvents": ["onMaterial:lc.stat"],
    "contributes": {
      "materials": [
        {
          "name": "lc.stat",
          "title": "统计卡片",
          "category": "数据展示",
          "icon": "chart",
          "module": "./dist/StatCard.js",
          "props": {
            "type": "object",
            "properties": {
              "title": { "type": "string", "default": "今日访问" },
              "value": { "type": "number", "default": 0 }
            }
          }
        }
      ]
    }
  }
}
```

这个包可以没有 `main`，也没有 `apply`。装载器注册元数据，物料面板立刻出现；拖入画布时才加载 `StatCard.js`。

纯物料包的构建入口就是组件模块；一个包提供多个物料时用多入口构建，每个 `module` 指向独立 chunk。

### 29.5 插件作者的硬性检查清单

- [ ] manifest 的 `contributes` 覆盖所有宿主可见入口；
- [ ] 所有依赖写在 `inject`，不通过 `ctx.get` 偷依赖；
- [ ] 所有副作用都通过 `ctx.effect` / `ctx.on` 托管；
- [ ] 异步任务接收并转发 `ctx.signal`；
- [ ] 不直接 import 其他插件；
- [ ] 不直接读写 `localStorage` / `indexedDB`；
- [ ] 不直接改 schema 对象，只走 `document.apply`；
- [ ] UI 组件有错误边界降级；
- [ ] 物料/命令/动作 id 带命名空间；
- [ ] 权限声明最小化；
- [ ] 通过契约测试：安装 → 功能出现 → 卸载 → 无残留。

---

## 30. 企业级验收清单

### 30.1 插件与画布

- [ ] 新增物料/面板/命令/数据源只新增包，不修改宿主与已有插件；
- [ ] 安装后入口自动出现，元数据来自 manifest，不执行插件代码；
- [ ] 首次使用才加载实现模块；
- [ ] 卸载后服务、监听器、定时器、DOM、注册表条目全部为 0；
- [ ] 依赖缺失进入 pending，依赖恢复自动启动；
- [ ] 单个插件失败不影响宿主与其他插件；
- [ ] 画布缩放/平移/节点缩放/节点旋转/吸附/辅助线/网格/标尺/小地图各自可独立安装与卸载；
- [ ] 卸载画布插件后活动事务取消、pointer capture 释放、光标恢复；
- [ ] 画布只有一个舞台/一个事件管线/一个 rAF 调度，插件不各自创建 canvas；
- [ ] 5000 节点拖拽 ≥ 55 fps，pointermove 管线 p95 < 2 ms；
- [ ] 缩放不变量、吸附阈值、冲突优先级、撤销/取消有自动化测试。

### 30.2 租户、权限与隔离

- [ ] 所有数据表有 tenant_id + RLS，跨租户查询测试返回 0 行；
- [ ] 对象存储/缓存/搜索/日志/审计均带租户边界；
- [ ] SSO（OIDC/SAML）与 SCIM 可用，离职停用即失效；
- [ ] RBAC + ABAC 策略生效，策略包签名、版本化、可回滚；
- [ ] 最终权限 = 用户权限 ∩ 插件权限 ∩ 租户策略，越权请求被拒绝并审计；
- [ ] 密钥只以 SecretHandle 形式暴露，无明文入库/入日志；
- [ ] T0/T1 inline、T2 Worker/iframe、T3 完整沙箱、S 容器隔离通过回归测试；
- [ ] T1 inline 插件有 UI 评审记录、无 ambient 网络/长期密钥、CSP 证据；
- [ ] iframe 独立源、CSP、postMessage origin/schema/大小/频率校验通过；
- [ ] 出站代理拒绝私网地址、DNS rebinding、越权重定向；
- [ ] 隔离测试与红队/渗透测试完成，无 Critical/High 未修复。

### 30.3 供应链与发布

- [ ] 制品不可变，digest + 签名 + SBOM + 来源证明齐全；
- [ ] 安装/加载双重校验，签名失败/吊销/未认证一律 fail-closed；
- [ ] CI 门禁包含 SCA/SAST/secret/许可证/恶意代码扫描；
- [ ] 认证等级（Platform/Verified/Community）与运行位置匹配；
- [ ] 生产安装/升级经过审批，审批记录包含 digest、影响、回滚方案；
- [ ] 灰度按租户/用户/会话可配，指标门禁与自动回滚可用；
- [ ] N-1/N-2 回滚 ≤ 5 分钟，数据迁移 expand/contract 可回退；
- [ ] Kill Switch 秒级生效，恢复后状态可继续；
- [ ] CRL/吊销链路可用，租户通知与替代版本指引齐全。

### 30.4 可观测、数据与合规

- [ ] 插件激活/错误/画布性能/数据源/发布/安全指标可按租户与插件维度查询；
- [ ] 插件边界有独立 span，可定位插件慢/宿主慢；
- [ ] 审计覆盖登录、权限、安装、配置、发布、导出、删除、密钥使用；
- [ ] 审计 WORM/哈希链、保留期可配、可导出 SIEM；
- [ ] 运行日志与审计分离，遥测 PII 脱敏；
- [ ] SLO 看板、告警、Runbook、值班表就绪；
- [ ] 数据分级、驻留、保留、Legal Hold、DSAR 流程可执行；
- [ ] 备份/DR 演练达到 RPO ≤ 5 min、RTO ≤ 1 h（文档）；
- [ ] 插件 dataPolicy 的 purge/retention 实际执行并有审计；
- [ ] SOC 2 / ISO 27001 控制证据可导出（认证以第三方审计为准）。

### 30.5 工程、兼容与交付

- [ ] 单元/契约/集成/E2E/性能/安全/隔离/混沌测试全部进 CI；
- [ ] 兼容矩阵覆盖内核 LTS、Host、Vue、浏览器、SaaS/专属/离线；
- [ ] 内核 LTS 18 个月，破坏性变更提前 12 个月公告；
- [ ] 旧插件在新内核上通过契约测试，不兼容时 loader 给出升级路径；
- [ ] 脚手架、本地 mock 控制面、画布测试工具、文档齐全；
- [ ] 每个生产插件有 owner、安全联系人、支持等级、回滚指引；
- [ ] 私有化/离线安装、升级、回滚、许可证降级验证通过；
- [ ] 控制面具备 Postgres 迁移、RLS、OpenAPI、队列/Worker 运维手册；
- [ ] 机密数据源/SSR/定时任务走 S ServerPluginHost，浏览器不接触服务端密钥；
- [ ] v1 协作范围明确：乐观锁 + 冲突提示，不承诺实时多人；
- [ ] 租户可自助安装/回滚已认证插件，平台可一键禁用；
- [ ] 插件市场展示权限、认证、数据分级、SBOM 摘要与支持等级。

做到以上全部，才算真正具备“企业级插件即功能”的扩展能力，而不只是一个能加载远程代码的框架。
