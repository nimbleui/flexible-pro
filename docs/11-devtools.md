# 11 开发者工具（`@lc/devtools`）

## 1. 定位

宿主级只读调试面板，**不是插件，也不进 loader**：它由 `apps/designer` 直接渲染，通过 props 拿到根上下文与画布上下文。

三条硬边界：

- **只读公共面**：数据全部来自 `@lc/kernel` 与 `@lc/contracts` 的公共 API，不读 `private` 字段、不 `as unknown as` 内部结构。内核为此新增了四个观测入口（见 [04 §13](./04-plugin-kernel.md#13-观测面devtools-与错误面板用)）。
- **不改装配顺序**：不参与 `apply`、不拦截服务、不监听分发（`EventBus.monitor` 只收通知，拿不到返回值也改不了顺序）。
- **动作只落在已有公共方法上**：重试 = `PluginRuntime.retry`，卸载 = `PluginRuntime.unload`，清空日志只清本地环形缓冲。

设计稿 [§4.10](../lowcode-plugin-platform-design.md) 的必备面板清单落地为 7 个标签页：插件树、服务表、依赖图、事件日志、配置、诊断、画布。其中「一键停用」**没有实现**：内核只有 `unload`（连带卸载子树），没有「临时停用但保留实例、之后可重试」的公共入口，见 §7。

## 2. 包结构

```text
packages/devtools/src/
├─ core/
│  ├─ types.ts        面板用的数据契约（PluginRow / ServiceRow / DependencyView / CanvasView …）+ 两个常量
│  ├─ format.ts       展示纯函数：describeError / formatDuration / formatClock / formatZoom / summarizeValue / toDisplayJson
│  ├─ feed.ts         EventLog：事件日志环形缓冲（上限 EVENT_LOG_LIMIT = 500）
│  └─ snapshot.ts     采样与推算：collectScopes / collectPlugins / collectServices / buildDependencies /
│                     buildConfigView / buildCanvasView / findRecord
├─ use-devtools.ts    Vue 适配层：computed 快照 + 订阅注册/回收 + 三个动作
├─ components/        外壳 DevtoolsPanel.vue + 7 个面板 SFC
└─ index.ts           公共出口：LcDevtools、useDevtools 与数据类型
```

运行时依赖只有 `@lc/contracts`、`@lc/kernel`，`vue` 作为 peer。**不依赖 `@lc/vue`**：面板不读 `useAppContext()`，上下文由宿主以 props 传入。这也是它不进 `SLOT` 的原因——`SLOT` 只有四个设计区位置（`packages/contracts/src/slots.ts:7-16`），devtools 是宿主工具而不是贡献点。

## 3. 每个面板读什么

| 标签页   | 数据来源                                                                                                   | 出处                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 插件树   | 根 `Context.children` 递归 + `record.context?.children`；清单摘要走 `loader.scan()` / `isActivated()`      | `core/snapshot.ts:77`                                  |
| 服务表   | 每层 `context.scope.services`（`Map<name, ServiceEntry>`）+ 逐层遮蔽链                                     | `core/snapshot.ts:105`                                 |
| 依赖图   | 按 `record.inject` 与 `provides` 声明重算；另用 `manifest.provides` 指出「清单已登记但未加载」的候选提供者 | `core/snapshot.ts:136`                                 |
| 事件日志 | `EventBus.monitor` 的 `EventDispatchRecord` 流 → `EventLog`                                                | `packages/kernel/src/events.ts:132`、`core/feed.ts:12` |
| 配置     | `record.rawConfig` / `record.config` + 祖先上下文 `intercepts` 链                                          | `core/snapshot.ts:214`                                 |
| 诊断     | `diagnostics.list()` 回放 + `diagnostics.onChange` 增量刷新                                                | `packages/kernel/src/context.ts:196`                   |
| 画布     | `CanvasService` 的 `viewport/scene/layers/interaction/selection/nodeFlags` + `document`/`history`          | `core/snapshot.ts:251`                                 |

**作用域从哪来**：`collectScopes`（`core/snapshot.ts:40`）返回三层——应用根、文档 Realm、画布层。这里有个必须知道的约束：Realm 与画布层都是 `ctx.fork()` 出来的，**不进 `Context.children`**，从根树走不到。所以文档 Realm 靠 `workspace.listEditors()` 补齐，画布层只能由宿主传入（`use-devtools.ts` 的 `DevtoolsSource.canvas`）。认父时按 `scope.parent` 链向上找最近的**已登记**层，中间夹着宿主没传的层也不会把依赖链截断。

**插件树为什么能看见 pending 实例**：停在 pending/failed 的实例 `record.context === null`，但记录本身仍在父级 `children` 里，所以「起不来的那一个」照样在树上，`missing` 由解析上下文 `resolver.get(name)` 现场算。

**遮蔽链**（`buildChain`）：从本层向上收集同名服务，先命中的标 `active`，其余标「被遮蔽」。`isolate` 层的 `filter` 按**整层跳过**处理，与 `Context.get` 的语义一致（`context.ts:292-299`），否则会报出一条和实际取值不符的链。

## 4. 响应式与订阅

`useDevtools` 里维护四个独立版本号，避免「一条高频事件拖着整棵树重算」：

| 版本                 | 触发源                                                                   | 影响                                                                                  |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `revision`           | `internalBus('plugin')`、`services.onDidChange`、`workspace.onDidChange` | 作用域、插件树、服务表、依赖图、配置（微任务合并，启动期几十次 `provide` 只重算一次） |
| `eventRevision`      | `bus.monitor` 回调逐条追加                                               | 事件日志                                                                              |
| `diagnosticRevision` | `diagnostics.onChange`                                                   | 诊断列表                                                                              |
| `canvasRevision`     | `viewport/scene/layers/selection/document/history` 的 `onDidChange`      | 画布快照                                                                              |

所有订阅在 `useDevtools` 内注册、`onScopeDispose` 统一回收，面板用 `v-if` 关掉即退订；没有轮询，也没有定时器。

## 5. 动作与安全边界

| 动作 | 实现                 | 约束                                                                                             |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------ |
| 重试 | `runtime.retry(id)`  | 只接受 `pending` / `failed`；`active` 重启会连带重建整棵子树，不由该方法承担（`runtime.ts:201`） |
| 卸载 | `runtime.unload(id)` | 与内核语义一致：连带卸载子树、回收副作用                                                         |
| 清空 | `EventLog.clear()`   | 只清展示缓冲，序号不重置，避免列表 key 复用                                                      |

## 6. 事件日志的语义（容易误解）

日志是**按监听器**记的，不是按 `emit` 汇总：

- 一次 `emit` 命中 N 个监听器 → N 条记录，每条带 `pluginId`、耗时、`listenerCount = N`。
- 一次 `emit` **没人监听** → 也留 1 条，`listenerCount = 0`、`duration = 0`、`pluginId` 缺省。

第二条是刻意加的（`events.ts:141` 等五处）：平台的 UI 响应多数走服务级 `onDidChange` 而不是事件总线，所以真实运行时「事件发了没人听」很常见——它恰恰是「事件名写错 / 插件没挂上监听」的唯一线索。实测中 `selection:change` 在 designer 里就是无人监听的状态。

## 7. 已知边界

1. **「停用」未实现**：设计稿 §4.10 的「一键停用」需要「保留实例、可再启用」的生命周期入口，内核目前只有 `unload`。`enablement` 属于控制面能力（设计稿 §5.6），不在 devtools 里自造。
2. **耗时是「上一次装配」**：`activatedAt` / `applyMs` 在停用后不清零，pending 行展示的是上次尝试的数据；配置阶段失败发生在装配之前，不写耗时。
3. **诊断窗口固定 200 条**（`DIAGNOSTIC_LIMIT`，`context.ts:138`），超出后由内核淘汰最早的一条，devtools 不另存历史。
4. **事件日志渲染上限 100 行**（`EventLogPanel` 的 `MAX_RENDERED`）：缓冲保留 500 条，但一次画 500 行表格会拖慢面板自身。
5. **隔离层不作独立分组**：`ctx.isolate()` 自建的作用域只会在遮蔽链里标成「隔离层」，不是插件树的一层。
6. **画布面板依赖宿主传上下文**：不传 `canvasContext` 时不出现「画布」标签页。
7. **`manifest` 字段依赖 loader**：纯内核场景（无 `loader` 服务）下，插件行没有版本/认证等级/贡献计数，依赖图也没有「清单候选」。

## 8. 宿主接入

```vue
<!-- apps/designer/src/App.vue：头部按钮 + 覆盖式抽屉 -->
<LcDevtools
  v-if="devtoolsOpen"
  class="lc-app__devtools"
  :context="appCtx"
  :canvas-context="props.canvasContext"
  @close="devtoolsOpen = false"
/>
```

- 抽屉是覆盖层（`.lc-app` 为定位上下文，`app.css` 里 `.lc-app__devtools { position: absolute; inset: 0 0 0 auto }`），不挤压画布；关闭按钮在面板头部。
- `:context` 必须是**应用根上下文**（`useAppContext()` 的返回值），`:canvas-context` 是当前画布 Realm 的上下文。
- 生产构建里面板代码仍会进包（App.vue 静态 import）；如要彻底剥离，后续可改为 `import.meta.env.DEV` 下的动态 import。

## 9. 验证记录

- `pnpm typecheck`：无错误。
- `pnpm test`：**30 个测试文件 / 222 条用例全部通过**，其中 devtools 3 个 spec / 33 条（`format` 12、`feed` 4、`snapshot` 17）。
- `pnpm build`：通过。
- 浏览器实测（`http://localhost:5180`，designer dev）：
  - 打开面板后画布舞台宽度保持 721px（覆盖式抽屉不挤压），无横向溢出，控制台无 error/warn。
  - 插件树：30 个实例、3 层作用域（应用根 10 / 文档 demo-doc 3 / 画布视图 17），manifest 摘要与耗时（含 `preset-canvas 176 ms`）正常。
  - 服务表：15 条、13 个保留服务，提供者/apiVersion/值摘要正确。
  - 事件日志：点选图层产生 `selection:change`（`listenerCount = 0`），「清空」后归零。
  - 配置：选中 `canvas-grid#16` 显示 `rawConfig = undefined`、解析结果 `{}`、覆盖 0 层。
  - 依赖图：0 个卡住、38 条依赖边。
  - 画布：72% / 721×667、21 节点、31 个交互处理器、6 个覆盖层。
  - 卸载 `canvas-grid`：树 30→29、头部 `30 active`→`29 active`、画布覆盖层列表里 `canvas-grid.overlay` 同步消失。
- **未做**：像素级截图核对——in-app 浏览器处于隐藏状态（`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`），本次以 DOM 文本、计算样式与布局矩形为准。
