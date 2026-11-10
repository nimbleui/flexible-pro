# 05 契约与数据模型

`@lc/contracts` 与 `@lc/schema` 一起构成平台的「公共语言」：前者声明**平台能力面**（插件能声明什么、能拿到什么服务、能收哪些事件），后者声明**文档数据结构**及其纯函数。

两包都没有框架依赖；`@lc/contracts` 唯一的运行时函数是 `installContextServices`，`@lc/schema` 全是类型 + 纯函数（可被 vitest 在 node 环境直接测试）。

---

# A. `@lc/contracts`

## 1. `PluginManifest`：安装期契约

`packages/contracts/src/manifest.ts:39-69`。

| 字段               | 类型                                            | 运行时是否生效           | 说明                                                                          |
| ------------------ | ----------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `name`             | string                                          | ✅ 强校验                | 全局唯一；必须等于 `definition.name`（`service-loader/src/index.ts:229-233`） |
| `displayName`      | string?                                         | 展示用                   | 缺省取 `name`                                                                 |
| `version`          | string                                          | ✅ `assertManifest` 必填 | semver                                                                        |
| `engines.lowcode`  | string                                          | ✅ `assertManifest` 必填 | 内核 API 版本范围；**当前没有实际比较逻辑**                                   |
| `main`             | string?                                         | ✅ 决定是否激活          | 纯声明式插件可省略；无 `main` → `activate` 直接返回（`:220-221`）             |
| `requires`         | string[]?                                       | ❌                       | 「静态依赖，运行时以 `inject` 为准」（`:53-54` 注释）                         |
| `activationEvents` | string[]?                                       | ✅                       | 与 `ensureActivated(event)` 全等匹配；为空表示只注册贡献                      |
| `provides`         | string[]?                                       | ❌                       | 供构建期与运行时 provide 对照                                                 |
| `permissions`      | `Permission[]`?                                 | ❌                       | 见 §7                                                                         |
| `certification`    | `'platform' \| 'verified' \| 'community'`?      | ❌                       | `@default 'community'`                                                        |
| `executionProfile` | `'inline' \| 'iframe' \| 'worker' \| 'server'`? | ❌                       | `@default 'inline'`；iframe/worker/server **无实现**                          |
| `uiReview`         | `'inline' \| 'sandboxed'`?                      | ❌                       | inline 执行时生产环境必填（约束未落地）                                       |
| `contributes`      | `Contributions`?                                | ✅                       | 五个点见 §2                                                                   |

现有激活事件只有两类：`onPanel:{panelId}`（4 个面板）与 `onCanvasFeature:{featureId}`（15 个画布能力，且在 loader 里被显式跳过，由 `preset-canvas` 按 CanvasRealm 实例化）。

## 2. 贡献点：封闭的五个

`packages/contracts/src/contribution.ts:57-71`：

```ts
interface ContributionValueMap {
  materials: MaterialContribution
  panels: PanelContribution
  toolbar: ToolbarContribution
  canvasFeatures: CanvasFeatureContribution
  canvasProfiles: CanvasProfileContribution
}
type ContributionPoint = keyof ContributionValueMap
```

`ContributionService`（`:89-102`）四个方法：`register(plugin, point, items): Disposable`（一批条目一次性撤销）、`list(point)`、`listSlot(slot)`（**只对 `panels` 生效**）、`onDidChange`。

`listSlot(slot)` 的实现注释解释了一个设计选择：「只筛 `panels` 一个贡献点，slot 是面板自己的字段而不是通用维度，因此没有做成 `list(point, filter)` 以免把过滤协议扩散到所有贡献点」；未声明 `slot` 的面板不会出现在任何插槽里（`service-loader/src/index.ts:100-105`）。

**当前仓库的贡献分布**（实测 20 个已登记包）：

| 贡献点           | 条目数 | 来源                                                                                                        |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `materials`      | 5      | `materials-basic`（Box / Text / Circle / Group / Button）                                                   |
| `panels`         | 4      | `panel-outline`（浮层槽）、`panel-materials`（左槽）、`panel-properties`（右槽）、`panel-eventflow`（底槽） |
| `toolbar`        | 20     | `canvas-align` 8、`canvas-commands` 8、`canvas-zoom` 4                                                      |
| `canvasFeatures` | 15     | 15 个画布能力包各 1                                                                                         |
| `canvasProfiles` | **0**  | 无贡献者，且 `preset-canvas` 也不读它——契约留位，代码未接                                                   |

排序规则在实现里（`service-loader/src/index.ts:44-52`）：`order ↑ → priority ↓ → 插件名`，三者全同时依赖 `Array.sort` 稳定性落到登记先后。

### `PanelContribution`（`:15-32`）

`id`、`title`、`slot: SlotName`、`icon?`、`order?`、`module`（首次打开才加载）、`when?`（骨架阶段保留字段，**宿主暂未求值**）、`priority?`（同 id 冲突时）。

### `ToolbarContribution`（`:39-54`）

`id`、`title`、`slot`、`command`、`icon?`、`order?`、`when?`。注释确立了一条重要约束：「按钮不直接携带逻辑，只声明要执行的命令 id，保证**命令是唯一执行入口**」。

## 3. `SLOT`：插槽即产品边界

`packages/contracts/src/slots.ts:7-55`：

```ts
SLOT = {
  designerLeftPanel: 'designer.leftPanel', // 物料
  designerRightPanel: 'designer.rightPanel', // 属性、AI
  designerToolbar: 'designer.toolbar',
  designerBottomPanel: 'designer.bottomPanel', // 事件流、数据绑定、代码
  designerStatusBar: 'designer.statusBar',
  designerOverlayPanel: 'designer.overlayPanel', // 页面大纲
  designerStylePanel: 'designer.stylePanel', // 右侧「样式」页签
  designerEventPanel: 'designer.eventPanel', // 右侧「事件」页签
  designerAdvancedPanel: 'designer.advancedPanel', // 右侧「高级」页签
}
type SlotName = (typeof SLOT)[keyof typeof SLOT]
```

右侧四个页签各占一个槽（`designer.rightPanel` / `stylePanel` / `eventPanel` / `advancedPanel`），页签条本身仍由外壳固定渲染。分槽而不是让属性面板一家包办四页的理由写在 `slots.ts` 的注释里：属性面板按物料 schema 回答「这个组件能配什么」，样式面板回答「这个节点在画布上长什么样」，两者的字段来源、变更原因与替换成本都不同，混在一个面板里改任一侧必然碰另一侧。事件槽与底槽写同一份 `connections` / `actions`，但视角相反——右栏按选中节点筛、只做「接没接上」这一层，动作链本体仍归 `designer.bottomPanel`。

`designer.bottomPanel` 的宿主渲染点是 `DesignerView.vue` 的底部停靠区：外壳画 32px 的页签条与折叠按钮，**页签条按 `contribution.listSlot('designer.bottomPanel')` 动态生成**，当前贡献者是 `panel-eventflow`（order 10）、`panel-data`（20）、`panel-code`（30）。装几个面板就有几个页签，卸载即消失——这是它和右侧四页签的分工差别。

右侧是一页签一槽，底部是多个面板共用一槽，两种形态各自解决一个真实问题：右栏四页要**同时可见地常驻**（换页签只是切换显示，四份面板都得留在文档里等着），底栏则是同一块区域的多种视图，**互斥且懒**。底栏因此给 `LcSlot` 加了可选的 `active` prop（`packages/vue/src/components/Slot.vue:22-30`）：只渲染命中的那个面板 id，过滤发生在加载之前，所以未选中的页签不会被激活、也不会被下载。

页签条过去由事件流插件自己画，五个页签硬编码在它的常量表里，加一个面板就得改另一个插件的源码——现在外壳只认贡献，插件只认自己的槽位。事件流放在底槽而不是左侧面板的页签里，是因为「左边选节点、下边配事件」需要同时可见，互相挤占高度会让这个组合无法成立（`slots.ts:14-24` 注释）。

停靠区给面板一条确定高度：`.lc-dock__body` 用 `grid-template-rows: minmax(0, 1fr)` 而不是 `flex: 1`，前者只约束行轨、不必挑选手插槽内部的类名。这条约束是后加的——此前 body 是 `overflow: auto` 的普通块，面板的 `height: 100%` 解成 `auto`，29 条绑定就能把 260px 的停靠区撑成一块长页面，面板自己的内部滚动也就无从谈起。

`designer.overlayPanel` 是第三个面：覆盖在画布之上的浮层，由外壳左侧活动栏的入口开关、带一个 × 关闭按钮，当前唯一贡献者是 `panel-outline`。大纲不放左槽是因为它和物料面板都要占满整栏高度、叠在一起谁都看不全；不放右槽是因为属性面板得常驻，选完节点不能每次都要重新唤它。浮层只盖画布那一段（定位参照 `.lc-designer__stage`），底部事件流仍然露在外面——「选节点 + 配事件」的组合不因打开大纲而失效。左槽的标题也一并交给面板自己画，与底槽同一约定（`DesignerView.vue:493` 注释）。

`designer.statusBar` 当前只有常量没有消费者——`StatusBar.vue` 是宿主直接渲染的组件，不走贡献。文件头注释规定了扩展流程：先加契约常量 → 再加宿主插槽 → 才允许插件声明。

别把两套 `slots` 混为一谈：本节说的是**插件挂哪块界面**（`SLOT` 里的 `designer.*` 常量，条目上的 `slot` 字段），而 `MaterialContribution.slots` / `NodeSchema.slots` 说的是**组件内部怎么分格**（`SlotDefinition` 具名内容容器）。两者正交，一个画布能力包可以同时有这两种「插槽」。

## 4. `contexts.ts`：服务名与类型糖

`packages/contracts/src/contexts.ts`

- `declare module '@lc/kernel'` 给 `Context` 加 20 个服务属性（`:30-75`）：**10 个应用级必选**（loader、contribution、modules、material、command、renderer、workspace、expression、setter、keybinding）+ **2 个宿主能力可选**（toast、navigation，由宿主注入，无 DOM / 无路由环境不提供）+ **8 个 Realm 级可选**（document、history、selection、dataSource、pageState、action、canvas、snap）。头注释解释这样切分是为了「避免 `AppContext` 谎报能力」。
- `AppContext = Context`、`EditorContext`（document/history/selection/dataSource/pageState/action 必选）、`CanvasContext extends EditorContext`（canvas 必选）（`:81-100`）。
- `defineEditorPlugin<S>` / `defineCanvasPlugin<S>`（`:107-118`）：**只做类型收窄，不改变运行时**。
- `SERVICE_NAMES`（`:121-142`）20 项 + `installContextServices()`（`:150-152`）→ 内核 `installServiceAccessors`。
- 集中声明的纪律写在头注释里：「所有 Context 扩展集中在本包，插件不得各自 `declare module`」。

## 5. 服务接口

`packages/contracts/src/services/*`。

### 版本服务（`version.ts`，方案 13 的 P1 / P3 / P4 落地）

`packages/contracts/src/services/version.ts` 定义内容寻址版本库的数据模型（`SectionObject` / `DocumentObject` / `Commit` / `Ref` / `BranchMeta` / `EntityChange` / `DiffResult` 等）、P1 能力集 `VersionServiceCore`（提交、历史、diff、分支、检出、单文档恢复、脏状态刷新）、P3 能力集 `VersionServiceMerge`（`mergePreview` / `merge`）与 `VersionStore`（对象 / 提交 / ref / 分支元数据的读写）。`VersionService = VersionServiceCore & VersionServiceMerge` 是 `createVersionService()` 当前返回类型；按阶段组合而不是提前写满接口，避免 `Not implemented` 伪实现。P3 另导出 `MergePlan` / `MergeConflict` / `MergeResolution` / `MergeResult` / `DanglingRef` / `MergeValidate` 等类型，其中 `MergeValidate` 是注入既有 `validateDocument` / `validateFlow` 的钩子：内核不另写一套 schema 规则，未注入时 `MergePlan.validation` 为 `skipped`，不谎报校验通过。`VersionStore.putObject` 与 `putCommit` 都是内容寻址写入，契约要求**同地址不同内容一律 fail-closed**：`createdAt` 不参与提交寻址，同父同树同消息同作者的两次提交会撞同一 id，静默覆盖等于改写既有历史。两个适配器共用 `commitConflictMessage()` 出同一条诊断，避免同一份数据在单测里失败、在浏览器里悄悄坏掉。实现在 `@lc/service-version`，纯 Core 无 Vue / DOM；`IdbVersionStore` 是唯一使用浏览器 API 的适配器。服务名 `'version'` 已加入 `RESERVED_SERVICES` 占位，防止第三方插件抢注。

P4 在同一文件补了宿主面板桥接：`VersionMode`（从 `@lc/service-version` 上移到契约层，面板 / 状态栏 / 宿主共用一份联合）、`VersionHostService`（按 `projectId` 惰性取 `VersionService`、变化通知、宿主发布快照摘要与发布 / 回滚薄桥接）、`VersionPanelSection` / `VersionOpenPayload` / `VersionReleaseSummary`。`contexts.ts` 把 `version` 声明为**可选应用级服务**并加入 `SERVICE_NAMES`，`events.ts` 加 `version:open`，保留服务授权来自 `GRANTS['host-version']`。这样 `plugin-panel-version` 与 `StatusBar` 只依赖 `@lc/contracts`，不反向 import `apps/host`；注入的是应用 Context，不是 Realm 级。`MergeValidate` 的 P4 实现落在宿主 `version-validation.ts`。`VersionServiceOptions.workingTreeReplaceable`（缺省 `true`）声明宿主的 `writeWorkingTree` 是否真正替换工作区：宿主在资产替换 API 落地前传 `false`，内核据此把 `checkout` 当只读查看（不持久化 HEAD、期间拒绝 `commit`）、并拒绝 `restoreDoc` 与 `merge`，错误码为 `read-only-view`。拦在写入路径而不是 UI，理由与受保护分支相同——否则一次保存就会把切出前的草稿记到刚检出的分支上。`VersionHead` 相应带出三个字段供 UI 置灰按钮并说明原因：`workingTreeReplaceable`（宿主写权限，等于同名 option）、`viewOnly`（只读查看态，此时 `commit` 被拒）、`draftBranch`（工作区实际归属的分支）。判据一律由内核给出，UI 不得自行从 `branch` 推导——两条分支指向同一提交时只比分支会漏判。发布与环境绑定属于 P5，届时再扩展服务面。

### `Registry<T>`（`registry.ts:10-21`）

`register(item): Disposable` / `get(key)` / `list()` / `readonly version: number` / `onDidChange`。头注释说明复用它的理由（物料、setter、数据源、动作、命令同一模式），并允许实现按自身主键取值（**物料用 `name`，命令用 `id`**）。`version` 明确是给 Vue 适配层做重渲染触发的，不深度代理条目。

使用者：`CommandService extends Registry<Command>`、`MaterialService extends Registry<MaterialEntry>`、`SetterService extends Registry<SetterEntry>`。**contribution 没有复用 Registry**，因为它需要 `order`/`slot`/`point` 三维排序与过滤。

### `CommandService`（`command.ts:32-35`）

`Command = { id, title, enabled?(), run(ctx) }`。`enabled?` 的注释是硬约束：**必须是廉价纯函数，调用频率与渲染一致**（工具栏/命令面板每帧调它判断置灰）。`execute(id, args)` 未注册时不抛错只上报诊断。

### `MaterialService`（`material.ts:97-100`）

- `MaterialContribution`（`:10-69`）：`name`、`title`、`category`、`icon?`、`props: JsonSchema`、`module`、`snippet?: NodeSchema`、`container?`、`slots?: SlotDefinition[]`、`allowedParents?`、`events?`、`priority?`。
- `slots` 与节点侧 `NodeSchema.slots`（`:248`）配对：物料说「这个组件有哪些内容分发点」，节点说「那些点里放了谁」。类型复用 `@lc/schema` 的 `SlotDefinition`（`schema/src/slots.ts:32-58`，带 `accepts` / `maxChildren` / `region`），自定义组件蓝图 `ComponentSchema.slots`（`schema/src/component.ts:78`）用的是同一个类型。
- 执行点在拖入：`canvas-drop/src/slot-target.ts` 按落点相对容器矩形的比例（`SlotDefinition.region`，0–1）选出该写进哪一格，命中格被 `accepts` 拒绝或被 `maxChildren` 占满时降级到 `default` 插槽，都不可用才回落 `children`；插槽声明只认**容器**物料的（`resolveSlotTarget` 收 `container` + `slotsOf` 而不是直接收数组，就是为了不让「传成被拖物料的 slots」这种写法成立）。
- 还没接上的两处：`validate.ts:380-408` 只校验插槽引用的节点是否存在，不检查插槽名有没有声明；渲染层把 children 与全部插槽扁平成同一份默认插槽内容（`vue/src/render/tree.ts:49-51`，画布 / 预览 / 运行时共用），所以「放进 header」目前只改变数据落档位置。`allowedParents` 仍是零消费者的留位字段。
- `MaterialEntry = 贡献 + plugin + moduleKey`（`:76-81`），`moduleKey` 由物料服务注册时算好，渲染器直接拿去 `ModuleService.load`。
- `ResolvedMaterial.component: unknown`（`:84-89`）——框架无关的收窄点。
- `ensure(name): Promise<ResolvedMaterial | undefined>`：注释声明并发调用共享同一 Promise。
- 服务边界写得很清楚：物料服务「只负责元数据注册 + 懒加载组件，不负责渲染」。

### `DocumentService` / `HistoryService` / `SelectionService`

见 [07 服务层](./07-services.md)。契约层要点：`DocumentApplyOptions.record` 决定「正式提交（写历史+标脏）」还是「手势预览」；`SelectionService.ids` 的顺序即多选顺序，`primary` 取最后加入者。

### `SetterService`（`setter.ts:33-36`）

`SetterKind = 'text' | 'number' | 'color' | 'toggle' | 'select'`（`:6`），`SetterEntry = { id, propType, kind, priority?, options? }`。注释说明「骨架阶段只描述控件种类而不加载自定义组件」，并预留了将来加 `component` 入口而不破坏契约的路径。`resolve(propType)` 返回同类型优先级最高者；**未注册类型由调用方回退文本控件**（这个兜底发生在 `PropertiesPanel.vue:107`，不在服务里）。

### `KeybindingService`（`keybinding.ts:24-31`）

`Keybinding = { id, key, command, args?, when?() }`。`key` 规范：`Mod+Shift+Z`、`Delete`、`Shift+ArrowUp`；`Mod` 在 macOS 是 ⌘；**匹配要求修饰键精确一致**，避免 `ArrowUp` 与 `Shift+ArrowUp` 互误触。接口注释一句话定性：「命令是唯一执行目标」。

### `ModuleService` / `LoaderService`

`ModuleService`（`modules.ts:9-18`）：`register`（key 重复抛错）/ `load`（并发共享 Promise）/ `preload`（失败只上报）/ `evict(plugin)`（按 `plugin/` 前缀清缓存）。`moduleKey(plugin, module)`（`:34-36`）注释解释拼法动机：贡献里只写包内模块名，拼出全局 key 以免两个插件同名互相覆盖。

`LoaderService`（`loader.ts:23-42`）确立「**安装 ≠ 启用**」：`register` 只落清单与贡献，`ensureActivated(event)` 命中激活事件才 `import()` + `ctx.plugin`。`PluginPackage = { manifest, load }`（`:10-15`），注释说明生产环境应由 Vite 插件扫描 `package.json.lowcode` 生成虚拟模块——当前由 `bootstrap.ts:52-58` 手工列表替代。

### `WorkspaceService` 与 Realm（`workspace.ts`）

`RealmOptions = { documentId, title?, schema?, mode?, requestDefaults? }`（`:6-24`；`requestDefaults` 是宿主按当前项目与环境给出的请求默认值，交给数据源服务在发请求前合并，运行页传的是快照里记下的那一套）；`EditorRealm extends Disposable`（`:20-29`，暴露 `id`、`documentId`、`context: EditorContext`、`createCanvasRealm()`）；`CanvasRealm extends Disposable`（`:32-37`）；`WorkspaceService`（`:45-56`）提供 `createEditorRealm` / `activeEditor` / `getEditor` / `listEditors` / `onDidChange`。`DataSourceService`（`services/datasource.ts`）另有 `setRequestDefaults(defaults)`：配置在项目侧被改动后由宿主推给**本项目**已打开的 Realm，它中止在途请求并重取 autoFetch 的 REST 源——默认值不参与配置指纹，所以 `sync()` 自己看不见这次变化。

契约把 `createCanvasRealm()` 描述为「新建一个画布视图」（`:27`），没有限制调用次数；实现同样允许一篇文档挂多个画布，按创建顺序反向回收（`service-workspace/src/index.ts:109-128`）。

### `RendererService`（`renderer.ts:6-13`）

只有一个方法：`resolveMaterial(name): Promise<unknown | undefined>`，物料不存在或模块未导出该组件时返回 `undefined`。

### `CanvasService`（`services/canvas.ts:224-261`）

画布微内核的唯一入口，13 个成员（viewport / scene / hitTest / measure / selection / interaction / layers / contextMenu / transaction / settings / scheduler / nodeFlags / `attach`）。详解见 [06 画布微内核](./06-canvas-kernel.md)。

## 6. `canvas-contributions.ts`：交互与视觉协议

`packages/contracts/src/canvas-contributions.ts` —— 379 行，画布侧全部公共类型的唯一出处；下表全部位置都相对本文件。

| 类型                                                                                                               | 位置                  | 关键语义                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PointerPhase = 'capture' \| 'target' \| 'bubble'`                                                                 | `:9`                  | 分发阶段，对齐 DOM 心智                                                                                                                                                                                                                                                                                                        |
| `CanvasModifiers` / `CanvasEventBase`                                                                              | `:12` / `:24`         | 修饰键与事件基类（screen/world/delta/buttons/pointerId/targetNodeId/targetHandleId/originalEvent）                                                                                                                                                                                                                             |
| `CanvasPointerEvent` / `CanvasKeyboardEvent` / `CanvasInputEvent`                                                  | `:38` / `:67` / `:81` | `click` 由管线合成，不是原生事件                                                                                                                                                                                                                                                                                               |
| `isPointerEvent()`                                                                                                 | `:84`                 | 类型守卫，处理器自行判断                                                                                                                                                                                                                                                                                                       |
| `InteractionResult = 'pass' \| 'handled' \| 'stop' \| void`                                                        | `:97`                 | 决定是否终止分发                                                                                                                                                                                                                                                                                                               |
| `InteractionHandler<E>`                                                                                            | `:100`                | `id` / `phase` / `priority` / `when?` / `handle`                                                                                                                                                                                                                                                                               |
| `GestureCallbacks`                                                                                                 | `:114`                | `onMove(event)` + `onFinish(commit)`，`commit=false` 表示 Esc / pointercancel                                                                                                                                                                                                                                                  |
| `LayerBand`                                                                                                        | `:122-123`            | `background \| content \| selection \| guides \| handles \| preview \| hud \| modal`                                                                                                                                                                                                                                           |
| `CanvasLayer`                                                                                                      | `:130-143`            | `band` / `zIndex?`（同 band 内，越大越上）/ `pointerEvents: 'none'\|'children'\|'auto'` / `visible?(frame)` 廉价纯函数每帧调用 / `load()`                                                                                                                                                                                      |
| `CanvasFrame`                                                                                                      | `:146-155`            | 一帧的只读快照：`viewport` / `selection` / `snap` / `size`                                                                                                                                                                                                                                                                     |
| `SnapAxis`、`SnapCandidate`、`SnapContext`、`SnapProvider`、`SnapEdgeMode`、`SnapInput`、`SnapGuide`、`SnapResult` | `:158`–`:321`         | 吸附协议；`SnapCandidate.priority` 注释给出分层理由与约定「网格 0、其他元素 1、参考线更高」，`showGuide` 注释解释网格只吸附不画线。**这一段与下面的菜单类型交错排布**：`SnapAxis` 在 `:158`，紧接着 `:161`–`:201` 是菜单三件，`:202` 起才是其余 Snap 类型                                                                      |
| `CanvasMenuTarget` / `CanvasMenuItem`                                                                              | `:161` / `:176`       | 菜单项按 `order` 升序，相邻 `group` 不同自动插分隔线                                                                                                                                                                                                                                                                           |
| `CANVAS_CONTEXT_MENU_STATE`                                                                                        | `:199`                | `'canvas-context-menu.state'`：菜单开合走设置总线，注册表只存条目                                                                                                                                                                                                                                                              |
| `CanvasSetting<T>`                                                                                                 | `:323-336`            | `id` / `title` / `scope: 'user'\|'workspace'\|'document'` / `schema: JsonSchema` / `default` / `lockable?`                                                                                                                                                                                                                     |
| `CanvasFeatureContribution`                                                                                        | `:343-358`            | 画布能力声明：`id`（建议与插件名一致，如 `zoom`）、`title`、`module`、`defaultEnabled?`、`order?`（越小越先挂载，`@default 0`）、`requires?`（依赖服务名，供依赖图校验）、`config?`（传给插件的配置）。注释强调它只是「装什么」的声明，真正的插件定义由 module 导出；来源插件名不在字段里，而由 `ContributionItem.plugin` 携带 |
| `CanvasProfileContribution`                                                                                        | `:361-379`            | 画布预设：`id` / `title` / `default?` / `features[{ id, enabled?, order?, config? }]`，即「保存默认启用哪些 feature、顺序与配置」，不含插件代码                                                                                                                                                                                |

覆盖层的空间约定写在 `:128`：**覆盖层在屏幕空间渲染，通过 `frame.viewport` 投影；不要给覆盖层套 `scale(zoom)`**。

## 7. 其余契约文件

- `nodes.ts`：`NodeFlagView`（`:10`）、`resolveNodeFlags(schema)`（`:29`，沿树继承 hidden/locked，O(n)，循环引用安全）、`EMPTY_NODE_FLAGS`（`:61`）、`transformableIds(ids, schema)`（`:74`，变换起始处批量过滤，顺带剔除文档里已不存在的 id）。
- `drag.ts`：`MATERIAL_DRAG_MIME_PREFIX = 'application/x-lc-material:'`（`:8`）、`toMaterialDragType(name)`（`:17`，按码点转十六进制，保证大小写与特殊字符安全）、`materialNameFromDragTypes(types)`（`:25`，从 `dataTransfer.types` 反解物料名）、`CANVAS_DROP_PREVIEW_SETTING`（`:48`）。
- `permissions.ts`：`Permission = { type:'network', hosts } | { type:'storage' } | { type:'clipboard' }`（`:8-22`）、`PermissionRisk = 'low'|'medium'|'high'`（`:25`）。头注释明确了边界：「这里描述的是 manifest 申请什么能力，不负责运行时决策；运行时决策由 permission 服务与 policy 服务共同决定（骨架阶段未实现，契约先行）」。
- `events.ts`：7 个业务事件的类型表（见 [02 §4](./02-runtime-flow.md#4-两套通道业务事件-vs-服务通知)）。`flow:drop` 已随流程图方案删除。
- `json.ts`：`JsonSchema = Record<string, unknown>`（`:7`）——**刻意不引入 json-schema 类型库**，物料 `props` 与设置项 `schema` 都是宽松结构。
- `geometry.ts`：`Point`（`:13`）等基础几何类型；`Rect`/`Size` 来自 `@lc/schema/styles.ts:59-82`。

---

# B. `@lc/schema`

## 8. 文档顶层结构

```ts
interface PageSchema<T extends ComponentPropsMap = DefaultComponentPropsMap> {
  version: string // 需与 SCHEMA_VERSION 一致
  nodeId: string // 起始节点 id
  nodes: { [key: string]: NodeSchema<T> } // 扁平表，键即节点 id
  components: ComponentSchema<T>[] // 组件注册列表
  actions?: Record<string, ActionDeclaration> // 动作表，键即动作 id
  connections?: Record<string, EventConnection> // 事件连接表，键即连接 id
  datasources?: DataSourceSchemaDef[]
  apis?: PageApiBinding[] // 页面引用项目接口：只存 { 绑定名, 接口 id }
  functions?: FunctionSchema[] // 声明式函数，自动注册进表达式引擎
  metadata?: PageMeta
}
```

`packages/schema/src/page.ts:84-140`。**核心结构选择：树用「扁平表 + id 引用」表达**，而不是嵌套对象。收益直接体现在 patch 模型上——任何节点的 path 都是 `/nodes/<id>/...`，深度无关，移动子树只需改父级的引用数组（`tree.ts:132` `detachFromParents`），不必搬运子树本身。`actions` / `connections` 沿用同一形态：动作按 id 被多条连接引用，事件链的顺序存在 `actionIds` 数组里而不是对象键序里。

`datasources` 与 `apis` 是 `data` 命名空间下的两种来源，边界由 `api.ts` 里一对纯函数守住：`applyApiBindings` 在文档进 Realm 前把绑定展开成完整的 `DataSourceSchemaDef`（`apiToRestConfig` 按固定字段序生成配置——取数服务拿配置 JSON 做指纹，字段顺序漂一次就会白重置一轮请求），`stripApiBindings` 在写回存储前把展开结果剥掉。判据同为「`id` 出现在 `apis` 里就归绑定所有」，因此两端不会各有一套理解。这样做的直接收益是下游零改动：`@lc/service-datasource` 取数、`buildPageData` 装配、`buildPageSymbols` 补全都只读 `datasources`，不需要为项目接口新增一个跨作用域服务。`findBindingIdConflicts` 与 `findUnresolvedBindings` 是这条模型的两个体检点：重名会顶掉页面自有条目并在写回时消失，接口被删则让绑定展开不出内容。

**展开出的 `config.url` 就是登记的路径本身，不带域名**。域名、默认请求头（token 这类）、默认查询参数与凭据策略属于环境而不属于文档，合并在发请求前一刻由 `request.ts` 的 `mergeRequestDefaults` 完成，规则是局部优先（请求自己写过的同名值不被覆盖，请求头名按 HTTP 语义忽略大小写）。这条约束同时解决了两个问题：把域名抄进配置指纹会让切环境变成一次文档编辑，而两处各拼一次会出现 `/svc/svc/users` 这种叠加。`RequestDefaults` 与 `RequestEnvironment` 也在这个文件里，宿主、取数服务与发布快照共用同一份形状。

`page.ts:136-137` 有一行被注释掉的 `// theme?: ThemeConfig;`：主题令牌目前只存在于宿主 CSS（`apps/host/src/styles/tokens.css`），**没有进入 DSL**。

`DocumentModel`（`document.ts:11-26`）是运行时包装：

```ts
{
  id: string
  title: string
  schema: PageSchema
  version: number
  dirty: boolean
}
```

`dirty` 的注释即规则：预览（手势中）不算脏，只有事务提交或命令写入才置 `true`。`createDocument(input)`（`:53`）**建模型时整体克隆 schema**（`cloneSchema`，`:43`：优先 `structuredClone`，降级 JSON 往返，并注明「schema 必须是 JSON 可序列化数据——这是 DSL 的硬性约束」），因此宿主之后改原对象不影响文档内容（`service-document/src/index.ts:11` 同步说明了这点）。

## 9. 节点模型

`NodeSchemaBase`（`node.ts:108-169`）字段全表：

| 字段         | 类型                        | 语义                                                                                                                                                                                                                                                                                    |
| ------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | string                      | 页面内唯一                                                                                                                                                                                                                                                                              |
| `children`   | string[]?                   | 子节点 id 列表                                                                                                                                                                                                                                                                          |
| `slots`      | `Record<string, string[]>`? | 具名插槽 → 子节点 id 列表                                                                                                                                                                                                                                                               |
| `directives` | `Directive[]`?              | 按数组顺序评估的指令列表（show/hide/disabled）                                                                                                                                                                                                                                          |
| `condition`  | `ExpressionString`?         | 条件渲染：为假时销毁/重建组件实例，与 show/hide 不同                                                                                                                                                                                                                                    |
| `loop`       | `LoopConfig`?               | 循环渲染，绑定 `dataSource` 表达式                                                                                                                                                                                                                                                      |
| `key`        | string?                     | 渲染优化用的唯一键                                                                                                                                                                                                                                                                      |
| `style`      | `StyleSchema`?              | 内联样式                                                                                                                                                                                                                                                                                |
| `layout`     | `LayoutSchema`?             | **设计态**布局：`mode: 'flow' \| 'absolute'`（`styles.ts:110-134`，flow 为默认且此时 `rect` 通常无意义）、`rect`（编辑器坐标系像素）、`rotate`（度）、`zIndex`、`constraints`（锁位：自定义组件实例改尺寸时按它重排内部节点，`packages/vue/src/render/constraints.ts`；缺省固定左上角） |
| `className`  | string?                     | CSS 类名字符串                                                                                                                                                                                                                                                                          |
| `name`       | string?                     | 图层树显示名，缺省显示 `componentName`                                                                                                                                                                                                                                                  |
| `hidden`     | boolean?                    | 设计态开关：不渲染、不参与命中，但保留在 schema 与图层树（`@default false`）                                                                                                                                                                                                            |
| `locked`     | boolean?                    | 不可点选/框选/参与变换命令，但**可通过图层树选中**（`@default false`）                                                                                                                                                                                                                  |

节点**不**承载事件绑定：曾与动作链并存的 `NodeSchema.events`（`EventHandlerDef[] | EventChain` 两种形态）已整体删除，「某节点的某事件触发后做什么」只有 `PageSchema.connections` 一条路径（`node.ts` 头注释记录了这一取舍）。

`NodeSchema<T>`（`node.ts:208`）是 `NodeSchemaBase` 的可辨识联合展开：`componentName` 命中泛型映射表时 `props` 推导为该组件属性类型，未命中时回退 `Record<string, PropValue>`；借助 `string & {}` 技巧既保留已登记组件名的补全，又不禁止未登记组件名（`node.ts:171-225` 的注释与例子）。

`layout` 字段的注释特别澄清一个易混点（`:141-146`、`styles.ts:108-115`）：它描述「节点自身如何被放置」，与容器组件 props 里的「子项如何排布」是不同概念。另需注意当前实现的口径：**画布宿主无视 `mode`，一律按绝对定位写 DOM**（`CanvasStage.vue:96-109` 固定 `position: 'absolute'` 并做父级原点补偿），新文档模板也固定 `mode: 'absolute'`（`service-workspace/src/index.ts:37`）。也就是说 `flow` 分支目前只在数据模型里存在。

## 10. 属性、样式与表达式

- `PropType`（`props.ts:18-31`）共 13 种：`string number boolean object array enum event slot json color icon style function`。`PropDefinition`（`:49+`）带 `name/title/type/defaultValue/required...`，`PropOption`（`:37-42`）为枚举选项。setter 的 `BUILTIN_SETTERS` 覆盖全部 13 种（`service-setter/src/index.ts:6-20`）。
- `StyleSchema` / `LayoutSchema` / `LayoutConstraints` / `Rect` / `Size` / `Position` / `SpacingValue` / `BorderValue`（`styles.ts:16-186`）。`Rect extends Position, Size`（`:82`）是画布几何的唯一表达。
- `ExpressionString`（`expression.ts:28`，载荷在 `raw` 字段）与 `JsExpression`（`:45`，载荷在 `code` 字段）是两种不同结构；`isExpressionString`（`:61`）、`isJsExpression`（`:78`）、`createExpression`（`:94`）、`createJsExpression`（`:105`）。`ExpressionString` 上**没有** `ast` 字段（曾经有 `ast?: unknown` 占位）：语法树缓存在引擎侧，写回 schema 会让 patch 与历史把运行时中间产物当作文档内容 diff。
- 语法树类型与求值契约同居 `@lc/schema`（`expression.ts:133-307` 的 12 个节点类型 + `ExpressionNode` 联合 `:309`）：设计器校验、编辑器补全、动作执行器的静态检查与引擎求值必须共用一份定义，否则各自演化出互不兼容的语法树。
- `ExpressionEngine`（`:358`）六个成员：`evaluate`（吞异常、上报诊断、返回 undefined）、`interpolate`、`isExpression`、`compile`（`:335` `CompiledExpression`，**会抛错**，面向需要区分「结果为假」与「求值失败」的调用方——动作执行器的条件求值正是这类调用方）、`resolveValue`（递归解析 schema 值）、`functions`（`functions.ts:161` `FunctionRegistry`，承接 `PageSchema.functions` / `ComponentSchema.functions`）。
- 实现分两包：`@lc/expression`（`packages/expression`，词法/语法/求值/白名单方法表/函数注册表/缓存，无 Vue、无 DOM、无内核）与 `@lc/service-expression`（装配 + `ctx.diagnostics` 桥接 + 配置）。语言是**白名单子集**：不走原型链（只认 `Object.hasOwn`）、拒绝 `__proto__` / `constructor` / `prototype` 等键、函数对象属性不可读、方法按接收者类型查表、有步数 / 时间 / 调用深度三重预算。`new Function` 在全仓库只出现在 `service-expression/src/index.ts` 一处，由插件配置 `allowUnsafeJs` 门控且**默认关闭**——这是 §19.8「表达式引擎白名单函数」与 §23「不允许 eval / new Function」的落地方式：`JsExpression` 保留为受信逃生门，关掉即整体不可用，CSP 不需要 `unsafe-eval`。
- 时间预算（`timeBudgetMs`，默认 20ms）补的是步数预算兜不住的那一类：一次原生方法或宿主函数调用在语法树上只占一个节点，`bigList.join('')` 在步数上几乎免费却能耗时几十毫秒。检查点是两处——每 256 次语法树访问的取样，以及每次外部代码返回后。**它的边界要说清**：已经在执行中的调用无法被中断，只能在其返回后中止后续求值；且额度按单次求值计，整页聚合耗时不受约束。同 realm 的 JS 无法被沙箱化（§19.2）。
- **沙箱执行后端**（`packages/expression/src/sandbox/`，§19.4）：`createExpressionSandbox` 是异步旁路，把求值送进独立 realm。协议只传**表达式文本与纯数据作用域**（不传 AST，编译缓存留在 worker 内），三个操作与同步引擎一一对应；`FunctionSchema` 是纯 JSON 所以能过界，**宿主注入的 JS 函数不能**，这类表达式在沙箱里以 `unknown-function` 失败。worker 内被吞掉的诊断随响应回传，可观测性与主线程等价；请求超时走 `terminate()` 重建并**回放已保存的函数注册**——这是沙箱相对同 realm 的唯一实质收益：超时可以真的把执行停下来。通道抽象成三方法的 `SandboxTransport`，因此核心包不引用任何 worker 全局类型（本仓 `lib` 无 `WebWorker`，写 `DedicatedWorkerGlobalScope` 会 TS2304），协议在单测里可被直接驱动。
- 沙箱**当前没有调用方**：动作执行器与数据源运行时虽然都已落地，但它们都走同步引擎的 `compile(...).evaluate(scope)` / `resolveValue`，而两条渲染路径（`CanvasStage.vue` 与 `PageRuntime.vue` 的 computed）本身是同步的，不能被异步替换；devtools 七个面板没有一个求值表达式。因此它默认不启用、不注册成服务、不在 preset 里拉起线程——未引用时连 worker chunk 都不会产出。接入点已经留好：`apps/host/src/expression-sandbox.worker.ts` 是入口（实测被引用时 Vite 产出 20.58 kB 的独立 chunk），消费方 `createExpressionSandbox({ createTransport: () => createWorkerTransport(new Worker(new URL('./expression-sandbox.worker.ts', import.meta.url), { type: 'module' })) })`；`new URL(...)` 必须写在构造点，否则 Vite 无法静态分析出该资源。
- 事件与动作：设计态不再有自由流程图，事件编辑是「事件连接 + 动作序列」。`PageSchema.actions?: Record<id, ActionDeclaration>` 与 `connections?: Record<id, EventConnection>`（`page.ts:105-114`）把「谁触发」和「做什么」拆成两张扁平表：连接只存 `sourceNodeId` / `eventName` / `actionIds[]` / `enabled`，动作本体独立成表，便于同一动作被多条连接复用、也便于单独迁移与审计。**`actionIds` 的数组顺序就是执行顺序**，条件分支由 `flow.condition` 表达，所以一条事件流在数据上就是一条动作序列，不需要额外图结构（`actions.ts:1-26`）。分支是 **if/else 语义而不是 goto**：`flow.condition` 执行完选中分支后回到原链继续，需要提前终止要显式用 `flow.end`——否则面板上排的顺序与真实执行顺序就不一致。页面级事件没有节点，来源统一填哨兵 `PAGE_EVENT_SOURCE = 'page'`，事件名取自 `PAGE_EVENTS = ['pageLoad', 'pageUnload']`（`actions.ts:105-109`）——用哨兵而不是再加 `scope` 字段，是因为「来源只有一个」不该由两个字段共同表达。
- 内置动作：`BUILTIN_ACTIONS` 9 种——`state.set` / `state.reset` / `dataSource.fetch` / `navigation.go` / `ui.toast` / `flow.condition` / `flow.sequence` / `flow.end` / `plugin.invoke`（`actions.ts:180-277`）。每种带 `fields` 表单描述（`text|number|select|toggle|json|ref|expression`），只描述渲染表单需要什么、不含执行逻辑；`findActionDefinition(type)` 查内置类型，自定义类型由插件注册（`ActionDeclaration.type` 注释 `:38`）。`ActionFieldKind` 里 `ref` 是**唯一的引用形态**：字段声明 `ref: 'variable' | 'dataSource' | 'action' | 'flow'` 说明引用的是哪一类东西，`multiple: true` 表示多选（`flow.sequence.actionIds` 用它，取代原先手写 JSON 数组的做法），候选项由 `listRefOptions(source, input)`（`ref-options.ts`）按输入算出；原先的 `kind: 'action'` 已折进 `ref`，两套「选一个东西」的机制并存的唯一后果是新字段不知道该学哪个。曾经还有 `node` / `event` / `page` 三类，专供触发节点填「监听哪个页面的哪个按钮」——那条绑定现在写在页面自己的 `connection.flowId` 上，图侧不再引用别的文档，这三类随之删除（`ActionRefSource` 的注释记着这段）。引用一律按 **id** 而不是名字取值，因为分支目标写错字符会静默变成一条永不执行的分支。`expression` 让校验能要求该字段必须是表达式对象（裸文本在条件位置恒为真）。`RefOptionsInput.schema` 是**可选**的：`flow` 一类候选根本不来自页面文档，强行要求会让宿主为拼一份不需要的 schema 造出假对象。物料事件声明只用 `EventParameter` / `EventDefinition`；曾与动作链竞争的 `EventChain` / `EventChainStep` / `EventHandlerDef` / `ActionHandlerDef` / `ChainHandlerDef` 已整体删除，`events.ts` 只剩这两个纯声明类型加一个 `buildEventPayload`（`packages/schema/src/events.ts:67`，按声明的参数名折叠组件 emit 的实参）。
- 校验与写路径：`validateDocument` 先于组件树校验动作表与连接表（空页面不会整体漏掉）：连接键与自身 id 一致、非页面级来源节点必须存在、`actionIds` 引用的动作必须存在、同一节点同一事件重复绑定为 error、未被任何连接引用的动作为 warning（`validate.ts:213-343`）。除引用完整性外还查三件事：`onError: 'fallback'` 必须带 `fallbackActionId`、动作引用图**不得成环**（`detectActionCycles`，`:136`；引用来源由 `actions.ts` 的 `referencedActionIds` 统一提取，新增会引用动作的内置类型必须同步改它）、`kind: 'expression'` 的字段必须是表达式对象。连接上的 `flowId` 也查，但**只在调用方把图清单传进来时查**（`validateDocument(schema, { flows })`）：图住在另一份存储里，schema 层看不见它，不能因为自己看不见就断言「不存在」；传了清单则分两档——id 查不到是 error（多半是图被删了，这条绑定永远不会生效），图还在但仍是草稿是 warning（页面没坏，只是这条事件暂时唤起不了流程）。孤儿判定要先对「被其他动作引用的动作」做传递闭包（`expandUsedActions`，`:187`），否则只被 `flow.sequence` 成员引用的动作会被误报成死配置。写入用 `actionPath(id, suffix?)` / `connectionPath(id, suffix?)` 拼 JSON Pointer（`patch.ts:160-168`，节点事件用的 `nodeEventPath` 已随 `NodeSchema.events` 一起删除）；事件流面板把「新建动作 + 追加 `actionIds`」合成一批 patch 提交，避免历史里出现「连接已引用、动作尚未创建」的中间态（`use-action-chain.ts:125`）。
- 数据源：`DataSourceType = 'rest'\|'graphql'\|'mock'\|'static'\|'localStorage'`（`datasource.ts:23`）+ 五种 config（`:29-108`）+ 10 种 `TransformConfig`（`:118-216`）+ `CacheStrategy`/`CacheConfig`（`:236-249`）+ `DataSourceSchemaDef`（`:263`）。
- 项目接口与请求默认值：`api.ts`（`ProjectApi`、`PageApiBinding`、`ApiRequestFields`、`apiRequestFieldsOf`、`joinApiUrl`、`apiToRestConfig`、展开与剥离四个函数）与 `request.ts`（`RequestDefaults`、`RequestEnvironment`、`HttpRequestAuth`、`mergeRequestDefaults`、`withAuthHeader`）。两者都是纯逻辑、无浏览器依赖，因此同一份规则能被宿主管理页、运行时取数与发布快照共用。`joinApiUrl` 只服务「域名 + 路径」这一处拼接，被 `mergeRequestDefaults` 调用；`ApiRequestFields` 是 `ProjectApi` 的请求侧子集，存在的理由是调试台与凭据来源都要**引用一条接口的请求形状**而不该连带复制名称、分组与时间戳。契约层新增 `services/http.ts`（`HttpService`、`HttpExecuteOptions`）：凭据缓存必须有身份与生命周期，而运行时取数与调试台是两个真实调用方，所以它做成宿主提供的应用级服务（名字 `http` 早在 `RESERVED_SERVICES` 里占位），`Context.http` 是**可选**依赖。
- 组件与片段：`ComponentMeta`（`component.ts:11`）、`SnippetSchema`（`:38`）、`ComponentSchema`（`:57`）。
- `SlotDefinition`（`schema/src/slots.ts:32-58`）与 `SlotRegion`（`:16-25`，插槽在容器内的命中区域，按容器矩形的比例 0–1 给出）。消费者是拖入落点判定（`canvas-drop/src/slot-target.ts`）与物料/蓝图的插槽声明（`MaterialContribution.slots`、`ComponentSchema.slots`）；`FunctionSchema`（`functions.ts:65`）。`FunctionSchema.body` 的作用域是**扁平**的：函数体只看得到形参与已注册/内置函数，看不到调用处的局部变量（`functions.ts:97-101` 注释说明了为什么这样选）。

## 11. patch 引擎

`packages/schema/src/patch.ts`。文件头注释就写了范围与意图（`:1-10`）：

```text
画布手势不应该直接改文档对象，而是产出一组 patch：
  手势中 record: false 预览（不写历史、不标脏）
  手势结束一次性提交（写历史、标脏）
patch 路径采用 JSON Pointer 风格（/nodes/n1/layout/rect/x），
只覆盖「对象属性 + 数组下标」两类操作，不实现完整 RFC 6902。
```

| API                                          | 位置     | 说明                      |
| -------------------------------------------- | -------- | ------------------------- |
| `SchemaPatchOp = 'add'\|'replace'\|'remove'` | `:15`    | `remove` 忽略 `value`     |
| `SchemaPatch { op, path, value? }`           | `:21-28` | —                         |
| `applyPatches(target, patches)`              | `:103`   | 泛型版，返回新对象        |
| `getAtPath(target, path)`                    | `:117`   | 读路径                    |
| `createNodeLayoutPatch(...)`                 | `:133`   | 布局 patch 构造器         |
| `nodePath(nodeId, suffix='')`                | `:145`   | 拼 `/nodes/<id>/<suffix>` |
| `isNodePatch(patch)`                         | `:154`   | 判断是否节点级 patch      |
| `applySchemaPatches(schema, patches)`        | `:170`   | 文档专用，**拷贝式**      |

路径转义实现齐全：`decodeSegment`/`encodeSegment` 处理 `~0`/`~1`（`:43-49`），`parsePath` 对不以 `/` 开头的路径抛错（`:51-60`）。

## 12. 树操作：语义 → patch

`packages/schema/src/tree.ts`（563 行，全部返回 `SchemaPatch[]` 或纯数据，不产生副作用）：

| 函数                                | 位置   | 用途                                                          |
| ----------------------------------- | ------ | ------------------------------------------------------------- |
| `childRefs(node)`                   | `:63`  | children + 所有 slots 扁平化（渲染与命中的引用来源）          |
| `findPosition(schema, nodeId)`      | `:99`  | 父级与索引                                                    |
| `collectSubtree(schema, roots)`     | `:108` | 拖拽整棵子树用（`Set` 去重）                                  |
| `detachFromParents(schema, ids)`    | `:132` | 从各父级引用数组中摘除                                        |
| `buildOutlineTree(schema)`          | `:162` | 图层树（`OutlineItem{node, children, position}`，`:26`）      |
| `filterOutlineTree(items, keyword)` | `:208` | 图层树搜索裁剪：留命中节点与祖先路径，空关键词原样返回        |
| `paintOrder(schema)`                | `:234` | 绘制序 = 命中序（canvas-core 按它注册场景）                   |
| `reorderChildren(...)`              | `:269` | 移动到新父级/索引（大纲面板拖拽）                             |
| `changeOrders(schema, ids, mode)`   | `:296` | `OrderMode = 'front'\|'forward'\|'backward'\|'back'`（`:36`） |
| `groupNodes(...)`                   | `:466` | 打组，返回 `GroupResult`（`:47`）                             |
| `ungroupNodes(schema, ids)`         | `:503` | 解组                                                          |
| `setNodeFlags(schema, changes)`     | `:539` | `NodeFlagChange`（`:39`）批量 hidden/locked                   |
| `renameNode(schema, nodeId, name)`  | `:557` | 改图层显示名                                                  |

## 13. 校验、迁移与版本

- `validateDocument(schema): ValidationIssue[]`（`validate.ts:446`）+ `hasBlockingIssue(issues)`（`:483`）；`ValidationSeverity = 'error' | 'warning'`（`:16`）。**校验不拦截任何已发生的写入**——`document.validate()` 只把结果返回给调用方（`service-document/src/index.ts:135-137` 注释）。
- `migrateDocument(...)`（`migrate.ts:28`）：fail-closed + 环检测；`SchemaMigration`（`:12`）。当前没有调用点（没有持久化入口），属于已实现未接入。
- `SCHEMA_VERSION = '1.0.0'`（`version.ts:9`）、`compareSchemaVersion(a, b)`（`:17`）。

## 14. 消费情况：schema 哪些部分被运行时用到

这是评估「DSL 完成度」的关键表（按当前代码实测）：

| schema 能力                                         | 消费方                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 状态              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `nodes` / `children` / `slots`                      | 渲染树 `buildRenderTree`（`packages/vue/src/render/tree.ts:64`）、命中/绘制 `paintOrder`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ✅                |
| `layout.rect` / `zIndex` / `rotate`                 | 场景几何取 `nodeRect`（`service-canvas-core/src/index.ts:31-37`）、`zIndex` / `rotate` 由 `nodeStyle` 落 DOM（`CanvasStage.vue:96-109`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ✅                |
| `style`                                             | 作为内联样式写入 DOM（`CanvasStage.vue:99`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | ✅                |
| `hidden` / `locked`                                 | `resolveNodeFlags` → `canvas.nodeFlags`；渲染树里 `hidden` 直接不渲染（`packages/vue/src/render/tree.ts:159`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | ✅                |
| `condition` / `directives` / `loop`                 | 渲染树求值（`packages/vue/src/render/tree.ts:80-93`、`:158-170`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ✅ 设计态求值     |
| `props` + `ExpressionString`                        | `resolveValue` → `expression.interpolate/evaluate`（`CanvasStage.vue:70-83`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ✅                |
| `name`（图层显示名）                                | 大纲面板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ✅                |
| `className` / `key`                                 | **未被消费**：`renderNode` 固定写 `class: 'lc-node'`（`CanvasStage.vue:125`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ⚠️ 仅数据         |
| `events` / `EventChain` / `connections` + `actions` | 事件连接与动作链有**设计态编辑器**：底部停靠面板 `@lc/plugin-panel-eventflow` 可新建事件、编排动作、编辑配置，右栏「事件」页签 `@lc/plugin-panel-node-event` 按选中节点列出可绑定事件、绑/解绑、启停、动作链摘要与**「执行流程图」下拉**（两者写同一份 `connections` / `actions`），并有**运行时执行器** `@lc/service-action`（顺序、`condition` 跳过、`onError` 三态、`flow.condition` / `flow.sequence` / `flow.end`）；触发侧由 `@lc/vue` 的 `PageRuntime` 接线，仅预览页装载，设计器画布不接。**一条连接还可以绑一张流程图**：`connection.flowId` 指向宿主图仓库里的图，`ActionService.trigger` 跑完链之后按 id 取**已发布**版本交给 `runFlowGraph`，两条都执行、互不覆盖，顺序固定为链在前。绑定只存在页面这一侧——图自己的触发节点只声明来源类型，不写「绑哪个页面的哪个按钮」，两处都写就会出现运行时听谁的没人说得出。图侧的入口节点 `flow.trigger` 必须装入内置处理器表，否则任何图都在第一个节点上失败。与动作模型竞争的 `EventChain` / `EventChainStep` / `EventHandlerDef` 与 `NodeSchema.events` 已整体删除 | ✅ 可编辑、可执行 |
| `datasources` / `functions`                         | 两条渲染路径与执行器都读：`datasources` 由 `@lc/service-datasource` 取数并写进表达式作用域（引用项目接口的条目由宿主在装载时经 `applyApiBindings` 展开进来，落盘的文档只存 `apis`），`functions` 由 `expression.functions.registerAll(..., 'page')` 注册（`DesignerView.vue` / `PreviewView.vue` 各一处）；动作 `dataSource.fetch` 也直接打这个服务                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ✅ 运行时消费     |
| `components`                                        | 顶层字段随文档保存，`components: []` 为空数组写入（`service-workspace/src/index.ts:42`）；渲染器解析物料走 `MaterialService` 注册表，**不读这份页面内清单**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | ⚠️ 仅数据         |
| `migrateDocument`                                   | 无调用点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ⚠️ 未接入         |

结论：当前实现的是**设计态数据模型**（结构、几何、属性绑定、显隐锁定）加上**一条已打通的运行态纵切**：事件连接 + 动作链由 `@lc/service-action` 执行、`@lc/vue` 的 `PageRuntime` 在预览页接线并读 `@lc/service-state` 的运行时值，`datasources` 与 `functions` 也参与运行。写文档和评审时仍不要把「DSL 里有」当成「平台支持」——设计器画布刻意**不**接事件、只读声明的默认值（协议规定设计器不执行真实业务），所以「画布上点了没反应」是预期行为，验证行为要去 `/preview/:documentId`。
