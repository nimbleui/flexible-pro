# 05 契约与数据模型

`@lc/contracts` 与 `@lc/schema` 一起构成平台的「公共语言」：前者声明**平台能力面**（插件能声明什么、能拿到什么服务、能收哪些事件），后者声明**文档数据结构**及其纯函数。

两包都没有框架依赖；`@lc/contracts` 唯一的运行时函数是 `installContextServices`，`@lc/schema` 全是类型 + 纯函数（可被 vitest 在 node 环境直接测试）。

---

# A. `@lc/contracts`

## 1. `PluginManifest`：安装期契约

`packages/contracts/src/manifest.ts:39-68`。

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

`packages/contracts/src/contribution.ts:57-68`：

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

| 贡献点           | 条目数 | 来源                                                                                              |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `materials`      | 4      | `materials-basic`（Box / Text / Circle / Group）                                                  |
| `panels`         | 4      | `panel-outline`、`panel-materials`（左槽）、`panel-properties`（右槽）、`panel-eventflow`（底槽） |
| `toolbar`        | 20     | `canvas-align` 8、`canvas-commands` 8、`canvas-zoom` 4                                            |
| `canvasFeatures` | 15     | 15 个画布能力包各 1                                                                               |
| `canvasProfiles` | **0**  | 无贡献者，且 `preset-canvas` 也不读它——契约留位，代码未接                                         |

排序规则在实现里（`service-loader/src/index.ts:44-52`）：`order ↑ → priority ↓ → 插件名`，三者全同时依赖 `Array.sort` 稳定性落到登记先后。

### `PanelContribution`（`:15-32`）

`id`、`title`、`slot: SlotName`、`icon?`、`order?`、`module`（首次打开才加载）、`when?`（骨架阶段保留字段，**宿主暂未求值**）、`priority?`（同 id 冲突时）。

### `ToolbarContribution`（`:39-54`）

`id`、`title`、`slot`、`command`、`icon?`、`order?`、`when?`。注释确立了一条重要约束：「按钮不直接携带逻辑，只声明要执行的命令 id，保证**命令是唯一执行入口**」。

## 3. `SLOT`：插槽即产品边界

`packages/contracts/src/slots.ts:7-23`：

```ts
SLOT = {
  designerLeftPanel: 'designer.leftPanel', // 大纲、物料
  designerRightPanel: 'designer.rightPanel', // 属性、AI
  designerToolbar: 'designer.toolbar',
  designerBottomPanel: 'designer.bottomPanel', // 事件流、数据绑定、代码
  designerStatusBar: 'designer.statusBar',
}
type SlotName = (typeof SLOT)[keyof typeof SLOT]
```

`designer.bottomPanel` 的宿主渲染点是 `DesignerView.vue` 的底部停靠区：外壳只画 28px 的标题条与折叠按钮，标题和页签由面板插件自己提供（否则同一块区域会出现两行「事件流」）；当前唯一贡献者是 `panel-eventflow`。事件流放在底槽而不是左侧面板的页签里，是因为「左边选节点、下边配事件」需要同时可见，互相挤占高度会让这个组合无法成立（`slots.ts:14-19` 注释）。

`designer.statusBar` 当前只有常量没有消费者——`StatusBar.vue` 是宿主直接渲染的组件，不走贡献。文件头注释规定了扩展流程：先加契约常量 → 再加宿主插槽 → 才允许插件声明。

## 4. `contexts.ts`：服务名与类型糖

`packages/contracts/src/contexts.ts`

- `declare module '@lc/kernel'` 给 `Context` 加 15 个服务属性（`:25-58`）：**10 个应用级必选**（loader、contribution、modules、material、command、renderer、workspace、expression、setter、keybinding）+ **5 个 Realm 级可选**（document、history、selection、canvas、snap）。头注释解释这样切分是为了「避免 `AppContext` 谎报能力」。
- `AppContext = Context`、`EditorContext`（document/history/selection 必选）、`CanvasContext extends EditorContext`（canvas 必选）（`:62-78`）。
- `defineEditorPlugin<S>` / `defineCanvasPlugin<S>`（`:85-96`）：**只做类型收窄，不改变运行时**。
- `SERVICE_NAMES`（`:99-115`）15 项 + `installContextServices()`（`:123-125`）→ 内核 `installServiceAccessors`。
- 集中声明的纪律写在头注释里：「所有 Context 扩展集中在本包，插件不得各自 `declare module`」。

## 5. 服务接口

`packages/contracts/src/services/*`。

### `Registry<T>`（`registry.ts:10-21`）

`register(item): Disposable` / `get(key)` / `list()` / `readonly version: number` / `onDidChange`。头注释说明复用它的理由（物料、setter、数据源、动作、命令同一模式），并允许实现按自身主键取值（**物料用 `name`，命令用 `id`**）。`version` 明确是给 Vue 适配层做重渲染触发的，不深度代理条目。

使用者：`CommandService extends Registry<Command>`、`MaterialService extends Registry<MaterialEntry>`、`SetterService extends Registry<SetterEntry>`。**contribution 没有复用 Registry**，因为它需要 `order`/`slot`/`point` 三维排序与过滤。

### `CommandService`（`command.ts:32-35`）

`Command = { id, title, enabled?(), run(ctx) }`。`enabled?` 的注释是硬约束：**必须是廉价纯函数，调用频率与渲染一致**（工具栏/命令面板每帧调它判断置灰）。`execute(id, args)` 未注册时不抛错只上报诊断。

### `MaterialService`（`material.ts:59-62`）

- `MaterialContribution`（`:10-31`）：`name`、`title`、`category`、`icon?`、`props: JsonSchema`、`module`、`snippet?: NodeSchema`、`container?`、`allowedParents?`、`priority?`。
- `MaterialEntry = 贡献 + plugin + moduleKey`（`:38-43`），`moduleKey` 由物料服务注册时算好，渲染器直接拿去 `ModuleService.load`。
- `ResolvedMaterial.component: unknown`（`:50`）——框架无关的收窄点。
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

`LoaderService`（`loader.ts:23-42`）确立「**安装 ≠ 启用**」：`register` 只落清单与贡献，`ensureActivated(event)` 命中激活事件才 `import()` + `ctx.plugin`。`PluginPackage = { manifest, load }`（`:10-15`），注释说明生产环境应由 Vite 插件扫描 `package.json.lowcode` 生成虚拟模块——当前由 `bootstrap.ts:57-77` 手工列表替代。

### `WorkspaceService` 与 Realm（`workspace.ts`）

`RealmOptions = { documentId, title?, schema?, mode? }`（`:6-15`）；`EditorRealm extends Disposable`（`:18-27`，暴露 `id`、`documentId`、`context: EditorContext`、`createCanvasRealm()`）；`CanvasRealm extends Disposable`（`:30-35`）；`WorkspaceService`（`:43-54`）提供 `createEditorRealm` / `activeEditor` / `getEditor` / `listEditors` / `onDidChange`。

注意契约与实现的一处口径差：接口注释写「主画布、每文档一个」（`:25-26`），而实现明确不限制调用次数（`service-workspace/src/index.ts:100-106` 注释）。

### `RendererService`（`renderer.ts:6-13`）

只有一个方法：`resolveMaterial(name): Promise<unknown | undefined>`，物料不存在或模块未导出该组件时返回 `undefined`。

### `CanvasService`（`services/canvas.ts:222-259`）

画布微内核的唯一入口，13 个成员（viewport / scene / hitTest / measure / selection / interaction / layers / contextMenu / transaction / settings / scheduler / nodeFlags / `attach`）。详解见 [06 画布微内核](./06-canvas-kernel.md)。

## 6. `canvas-contributions.ts`：交互与视觉协议

361 行，画布侧全部公共类型的唯一出处。

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
| `SnapAxis`、`SnapCandidate`、`SnapContext`、`SnapProvider`、`SnapEdgeMode`、`SnapInput`、`SnapGuide`、`SnapResult` | `:158`–`:295`         | 吸附协议；`SnapCandidate.priority` 注释给出分层理由与约定「网格 0、其他元素 1、参考线更高」，`showGuide` 注释解释网格只吸附不画线                                                                                                                                                                                              |
| `CanvasMenuTarget` / `CanvasMenuItem`                                                                              | `:161` / `:176`       | 菜单项按 `order` 升序，相邻 `group` 不同自动插分隔线                                                                                                                                                                                                                                                                           |
| `CANVAS_CONTEXT_MENU_STATE`                                                                                        | `:199`                | `'canvas-context-menu.state'`：菜单开合走设置总线，注册表只存条目                                                                                                                                                                                                                                                              |
| `CanvasSetting<T>`                                                                                                 | `:305-320`            | `id` / `title` / `scope: 'user'\|'workspace'\|'document'` / `schema: JsonSchema` / `default` / `lockable?`                                                                                                                                                                                                                     |
| `CanvasFeatureContribution`                                                                                        | `:325-340`            | 画布能力声明：`id`（建议与插件名一致，如 `zoom`）、`title`、`module`、`defaultEnabled?`、`order?`（越小越先挂载，`@default 0`）、`requires?`（依赖服务名，供依赖图校验）、`config?`（传给插件的配置）。注释强调它只是「装什么」的声明，真正的插件定义由 module 导出；来源插件名不在字段里，而由 `ContributionItem.plugin` 携带 |
| `CanvasProfileContribution`                                                                                        | `:343-361`            | 画布预设：`id` / `title` / `default?` / `features[{ id, enabled?, order?, config? }]`，即「保存默认启用哪些 feature、顺序与配置」，不含插件代码                                                                                                                                                                                |

覆盖层的空间约定写在 `:126-129`：**覆盖层在屏幕空间渲染，通过 `frame.viewport` 投影；不要给覆盖层套 `scale(zoom)`**。

## 7. 其余契约文件

- `nodes.ts`：`NodeFlagView`（`:10`）、`resolveNodeFlags(schema)`（`:29`，沿树继承 hidden/locked，O(n)，循环引用安全）、`EMPTY_NODE_FLAGS`（`:61`）、`transformableIds(ids, schema)`（`:74`，变换起始处批量过滤，顺带剔除文档里已不存在的 id）。
- `drag.ts`：`MATERIAL_DRAG_MIME_PREFIX = 'application/x-lc-material:'`（`:8`）、`toMaterialDragType(name)`（`:17`，按码点转十六进制，保证大小写与特殊字符安全）、`materialNameFromDragTypes(types)`（`:25`，从 `dataTransfer.types` 反解物料名）、`CANVAS_DROP_PREVIEW_SETTING`（`:48`）。
- `permissions.ts`：`Permission = { type:'network', hosts } | { type:'storage' } | { type:'clipboard' }`（`:8-22`）、`PermissionRisk = 'low'|'medium'|'high'`（`:25`）。头注释明确了边界：「这里描述的是 manifest 申请什么能力，不负责运行时决策；运行时决策由 permission 服务与 policy 服务共同决定（骨架阶段未实现，契约先行）」。
- `events.ts`：7 个业务事件的类型表（见 [02 §4](./02-runtime-flow.md#4-两套通道业务事件-vs-服务通知)）。`flow:drop` 已随流程图方案删除。
- `json.ts`：`JsonSchema = Record<string, unknown>`（`:7`）——**刻意不引入 json-schema 类型库**，物料 `props` 与设置项 `schema` 都是宽松结构。
- `geometry.ts`：`Point`（`:13`）等基础几何类型；`Rect`/`Size` 来自 `@lc/schema/styles.ts:60-72`。

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
  lifecycles?: LifecycleSchema[]
  functions?: FunctionSchema[] // 声明式函数，自动注册进表达式引擎
  metadata?: PageMeta
}
```

`packages/schema/src/page.ts:42-92`。**核心结构选择：树用「扁平表 + id 引用」表达**，而不是嵌套对象。收益直接体现在 patch 模型上——任何节点的 path 都是 `/nodes/<id>/...`，深度无关，移动子树只需改父级的引用数组（`tree.ts:124` `detachFromParents`），不必搬运子树本身。`actions` / `connections` 沿用同一形态：动作按 id 被多条连接引用，事件链的顺序存在 `actionIds` 数组里而不是对象键序里。

`page.ts:89-90` 有一行被注释掉的 `// theme?: ThemeConfig;`：主题令牌目前只存在于宿主 CSS（`apps/host/src/styles/tokens.css`），**没有进入 DSL**。

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

`NodeSchemaBase`（`node.ts:111-183`）字段全表：

| 字段         | 类型                                 | 语义                                                                                                                                                                                        |
| ------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | string                               | 页面内唯一                                                                                                                                                                                  |
| `children`   | string[]?                            | 子节点 id 列表                                                                                                                                                                              |
| `slots`      | `Record<string, string[]>`?          | 具名插槽 → 子节点 id 列表                                                                                                                                                                   |
| `events`     | `Record<string, EventBindingValue>`? | 两种绑定形态：处理器数组 / `EventChain`；`FlowEventBinding` / `FlowHandlerDef` 已删除，事件流改由 `connections` + `actions` 表达                                                            |
| `directives` | `Directive[]`?                       | 按数组顺序评估的指令列表（show/hide/disabled）                                                                                                                                              |
| `condition`  | `ExpressionString`?                  | 条件渲染：为假时销毁/重建组件实例，与 show/hide 不同                                                                                                                                        |
| `loop`       | `LoopConfig`?                        | 循环渲染，绑定 `dataSource` 表达式                                                                                                                                                          |
| `key`        | string?                              | 渲染优化用的唯一键                                                                                                                                                                          |
| `style`      | `StyleSchema`?                       | 内联样式                                                                                                                                                                                    |
| `layout`     | `LayoutSchema`?                      | **设计态**布局：`mode: 'flow' \| 'absolute'`（`styles.ts:106-127`，flow 为默认且此时 `rect` 通常无意义）、`rect`（编辑器坐标系像素）、`rotate`（度）、`zIndex`、`constraints`（锚定与缩放） |
| `className`  | string?                              | CSS 类名字符串                                                                                                                                                                              |
| `name`       | string?                              | 图层树显示名，缺省显示 `componentName`                                                                                                                                                      |
| `hidden`     | boolean?                             | 设计态开关：不渲染、不参与命中，但保留在 schema 与图层树（`@default false`）                                                                                                                |
| `locked`     | boolean?                             | 不可点选/框选/参与变换命令，但**可通过图层树选中**（`@default false`）                                                                                                                      |

`NodeSchema<T>`（`:222`）是 `NodeSchemaBase` 的可辨识联合展开：`componentName` 命中泛型映射表时 `props` 推导为该组件属性类型，未命中时回退 `Record<string, PropValue>`；借助 `string & {}` 技巧既保留已登记组件名的补全，又不禁止未登记组件名（`:185-232` 的注释与例子）。

`layout` 字段的注释特别澄清一个易混点（`:155-160`、`styles.ts:96-104`）：它描述「节点自身如何被放置」，与容器组件 props 里的「子项如何排布」是不同概念。另需注意当前实现的口径：**画布宿主无视 `mode`，一律按绝对定位写 DOM**（`CanvasStage.vue:97-110` 固定 `position: 'absolute'` 并做父级原点补偿），新文档模板也固定 `mode: 'absolute'`（`service-workspace/src/index.ts:33-36`）。也就是说 `flow` 分支目前只在数据模型里存在。

## 10. 属性、样式与表达式

- `PropType`（`props.ts:18-31`）共 13 种：`string number boolean object array enum event slot json color icon style function`。`PropDefinition`（`:49+`）带 `name/title/type/defaultValue/required...`，`PropOption`（`:37-42`）为枚举选项。setter 的 `BUILTIN_SETTERS` 覆盖全部 13 种（`service-setter/src/index.ts:6-20`）。
- `StyleSchema` / `LayoutSchema` / `LayoutConstraints` / `Rect` / `Size` / `Position` / `SpacingValue` / `BorderValue`（`styles.ts:16-160`）。`Rect extends Position, Size`（`:72`）是画布几何的唯一表达。
- `ExpressionString`（`expression.ts:28`，载荷在 `raw` 字段）与 `JsExpression`（`:45`，载荷在 `code` 字段）是两种不同结构；`isExpressionString`（`:61`）、`isJsExpression`（`:78`）、`createExpression`（`:94`）、`createJsExpression`（`:105`）。`ExpressionString` 上**没有** `ast` 字段（曾经有 `ast?: unknown` 占位）：语法树缓存在引擎侧，写回 schema 会让 patch 与历史把运行时中间产物当作文档内容 diff。
- 语法树类型与求值契约同居 `@lc/schema`（`expression.ts:133-234` 的 12 个节点类型 + `ExpressionNode` 联合 `:236`）：设计器校验、编辑器补全、动作执行器（尚不存在）的静态检查与引擎求值必须共用一份定义，否则各自演化出互不兼容的语法树。
- `ExpressionEngine`（`:285`）六个成员：`evaluate`（吞异常、上报诊断、返回 undefined）、`interpolate`、`isExpression`、`compile`（`:262` `CompiledExpression`，**会抛错**，面向需要区分「结果为假」与「求值失败」的调用方）、`resolveValue`（递归解析 schema 值）、`functions`（`functions.ts:95` `FunctionRegistry`，承接 `PageSchema.functions` / `ComponentSchema.functions`）。
- 实现分两包：`@lc/expression`（`packages/expression`，词法/语法/求值/白名单方法表/函数注册表/缓存，无 Vue、无 DOM、无内核）与 `@lc/service-expression`（装配 + `ctx.diagnostics` 桥接 + 配置）。语言是**白名单子集**：不走原型链（只认 `Object.hasOwn`）、拒绝 `__proto__` / `constructor` / `prototype` 等键、函数对象属性不可读、方法按接收者类型查表、有步数 / 时间 / 调用深度三重预算。`new Function` 在全仓库只出现在 `service-expression/src/index.ts` 一处，由插件配置 `allowUnsafeJs` 门控且**默认关闭**——这是 §19.8「表达式引擎白名单函数」与 §23「不允许 eval / new Function」的落地方式：`JsExpression` 保留为受信逃生门，关掉即整体不可用，CSP 不需要 `unsafe-eval`。
- 时间预算（`timeBudgetMs`，默认 20ms）补的是步数预算兜不住的那一类：一次原生方法或宿主函数调用在语法树上只占一个节点，`bigList.join('')` 在步数上几乎免费却能耗时几十毫秒。检查点是两处——每 256 次语法树访问的取样，以及每次外部代码返回后。**它的边界要说清**：已经在执行中的调用无法被中断，只能在其返回后中止后续求值；且额度按单次求值计，整页聚合耗时不受约束。同 realm 的 JS 无法被沙箱化（§19.2）。
- **沙箱执行后端**（`packages/expression/src/sandbox/`，§19.4）：`createExpressionSandbox` 是异步旁路，把求值送进独立 realm。协议只传**表达式文本与纯数据作用域**（不传 AST，编译缓存留在 worker 内），三个操作与同步引擎一一对应；`FunctionSchema` 是纯 JSON 所以能过界，**宿主注入的 JS 函数不能**，这类表达式在沙箱里以 `unknown-function` 失败。worker 内被吞掉的诊断随响应回传，可观测性与主线程等价；请求超时走 `terminate()` 重建并**回放已保存的函数注册**——这是沙箱相对同 realm 的唯一实质收益：超时可以真的把执行停下来。通道抽象成三方法的 `SandboxTransport`，因此核心包不引用任何 worker 全局类型（本仓 `lib` 无 `WebWorker`，写 `DedicatedWorkerGlobalScope` 会 TS2304），协议在单测里可被直接驱动。
- 沙箱**当前没有调用方**：动作执行器与数据源管道都还不存在，devtools 七个面板没有一个求值表达式，而同步渲染路径（`CanvasStage.vue` 的 computed）不能被异步替换。因此它默认不启用、不注册成服务、不在 preset 里拉起线程——未引用时连 worker chunk 都不会产出。接入点已经留好：`apps/host/src/expression-sandbox.worker.ts` 是入口（实测被引用时 Vite 产出 20.58 kB 的独立 chunk），消费方 `createExpressionSandbox({ createTransport: () => createWorkerTransport(new Worker(new URL('./expression-sandbox.worker.ts', import.meta.url), { type: 'module' })) })`；`new URL(...)` 必须写在构造点，否则 Vite 无法静态分析出该资源。
- 事件与动作：设计态不再有自由流程图，事件编辑是「事件连接 + 动作序列」。`PageSchema.actions?: Record<id, ActionDeclaration>` 与 `connections?: Record<id, EventConnection>`（`page.ts:62-72`）把「谁触发」和「做什么」拆成两张扁平表：连接只存 `sourceNodeId` / `eventName` / `actionIds[]` / `enabled`，动作本体独立成表，便于同一动作被多条连接复用、也便于单独迁移与审计。**`actionIds` 的数组顺序就是执行顺序**，条件分支由 `flow.condition` 表达，所以一条事件流在数据上就是一条动作序列，不需要额外图结构（`actions.ts:1-11`）。页面级事件没有节点，来源统一填哨兵 `PAGE_EVENT_SOURCE = 'page'`，事件名取自 `PAGE_EVENTS = ['pageLoad', 'pageUnload']`（`actions.ts:64-71`）——用哨兵而不是再加 `scope` 字段，是因为「来源只有一个」不该由两个字段共同表达。
- 内置动作：`BUILTIN_ACTIONS` 8 种——`state.set` / `state.reset` / `dataSource.fetch` / `navigation.go` / `ui.toast` / `flow.condition` / `flow.sequence` / `plugin.invoke`（`actions.ts:111-190`）。每种带 `fields` 表单描述（`text|number|select|toggle|json`），只描述渲染表单需要什么、不含执行逻辑；`findActionDefinition(type)` 查内置类型，自定义类型由插件注册（`ActionDeclaration.type` 注释 `:22`）。物料事件声明仍用 `EventParameter` / `EventDefinition`，处理器数组里的多步形态仍是 `EventChainStep` / `EventChain`；`FlowEventBinding` / `FlowHandlerDef` 已删除，`EventBindingValue` 现在只有处理器数组与 `EventChain` 两种形态。
- 校验与写路径：`validateDocument` 先于组件树校验动作表与连接表（空页面不会整体漏掉）：连接键与自身 id 一致、非页面级来源节点必须存在、`actionIds` 引用的动作必须存在、同一节点同一事件重复绑定为 error、未被任何连接引用的动作为 warning（`validate.ts:49-119`）。写入用 `actionPath(id, suffix?)` / `connectionPath(id, suffix?)` / `nodeEventPath(nodeId, eventName)` 拼 JSON Pointer（`patch.ts:160-172`）；事件流面板把「新建动作 + 追加 `actionIds`」合成一批 patch 提交，避免历史里出现「连接已引用、动作尚未创建」的中间态（`packages/plugins/plugin-panel-eventflow/src/EventFlowPanel.vue:581-591`）。
- 数据源：`DataSourceType = 'rest'\|'graphql'\|'mock'\|'static'\|'localStorage'`（`datasource.ts:21`）+ 五种 config（`:27-104`）+ 10 种 `TransformConfig`（`:116-223`）+ `CacheStrategy`/`CacheConfig`（`:224-249`）+ `DataSourceSchemaDef`（`:251`）。
- 生命周期：`LifecycleEvent = 'onMount'\|'onUnmount'\|'onUpdate'\|'onDataChange'`（`lifecycle.ts:17`）、`LifecycleSchema`（`:25`）。
- 组件与片段：`ComponentMeta`（`component.ts:12`）、`SnippetSchema`（`:39`）、`ComponentSchema`（`:58`）。
- `SlotDefinition`（`schema/src/slots.ts:13`）与 `FunctionSchema`（`functions.ts:36`）。`FunctionSchema.body` 的作用域是**扁平**的：函数体只看得到形参与已注册/内置函数，看不到调用处的局部变量（`functions.ts:55-58` 注释说明了为什么这样选）。

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
| `applySchemaPatches(schema, patches)`        | `:175`   | 文档专用，**拷贝式**      |

路径转义实现齐全：`decodeSegment`/`encodeSegment` 处理 `~0`/`~1`（`:43-49`），`parsePath` 对不以 `/` 开头的路径抛错（`:51-60`）。

## 12. 树操作：语义 → patch

`packages/schema/src/tree.ts`（465 行，全部返回 `SchemaPatch[]`，不产生副作用）：

| 函数                               | 位置   | 用途                                                          |
| ---------------------------------- | ------ | ------------------------------------------------------------- |
| `childRefs(node)`                  | `:55`  | children + 所有 slots 扁平化（渲染与命中的引用来源）          |
| `findPosition(schema, nodeId)`     | `:91`  | 父级与索引                                                    |
| `collectSubtree(schema, roots)`    | `:100` | 拖拽整棵子树用（`Set` 去重）                                  |
| `detachFromParents(schema, ids)`   | `:124` | 从各父级引用数组中摘除                                        |
| `buildOutlineTree(schema)`         | `:154` | 图层树（`OutlineItem{node, children, position}`，`:26`）      |
| `paintOrder(schema)`               | `:194` | 绘制序 = 命中序（canvas-core 按它注册场景）                   |
| `reorderChildren(...)`             | `:224` | 移动到新父级/索引（大纲面板拖拽）                             |
| `changeOrders(schema, ids, mode)`  | `:251` | `OrderMode = 'front'\|'forward'\|'backward'\|'back'`（`:35`） |
| `groupNodes(...)`                  | `:328` | 打组，返回 `GroupResult`（`:44`）                             |
| `ungroupNodes(schema, ids)`        | `:405` | 解组                                                          |
| `setNodeFlags(schema, changes)`    | `:441` | `NodeFlagChange`（`:38`）批量 hidden/locked                   |
| `renameNode(schema, nodeId, name)` | `:459` | 改图层显示名                                                  |

## 13. 校验、迁移与版本

- `validateDocument(schema): ValidationIssue[]`（`validate.ts:38`）+ `hasBlockingIssue(issues)`（`:187`）；`ValidationSeverity = 'error' | 'warning'`（`:13`）。**校验不拦截任何已发生的写入**——`document.validate()` 只把结果返回给调用方（`service-document/src/index.ts:134-137` 注释）。
- `migrateDocument(...)`（`migrate.ts:28`）：fail-closed + 环检测；`SchemaMigration`（`:12`）。当前没有调用点（没有持久化入口），属于已实现未接入。
- `SCHEMA_VERSION = '1.0.0'`（`version.ts:9`）、`compareSchemaVersion(a, b)`（`:17`）。

## 14. 消费情况：schema 哪些部分被运行时用到

这是评估「DSL 完成度」的关键表（按当前代码实测）：

| schema 能力                                               | 消费方                                                                                                                                                                                  | 状态                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `nodes` / `children` / `slots`                            | 渲染树 `buildRenderTree`（`packages/vue/src/render/tree.ts:35-37`）、命中/绘制 `paintOrder`                                                                                             | ✅                  |
| `layout.rect` / `zIndex` / `rotate`                       | 场景几何（`service-canvas-core/src/index.ts:68-72`）、`nodeStyle`（`CanvasStage.vue:97-110`）                                                                                           | ✅                  |
| `style`                                                   | 作为内联样式写入 DOM（`CanvasStage.vue:100`）                                                                                                                                           | ✅                  |
| `hidden` / `locked`                                       | `resolveNodeFlags` → `canvas.nodeFlags`；渲染树里 `hidden` 直接不渲染（`tree.ts:132`）                                                                                                  | ✅                  |
| `condition` / `directives` / `loop`                       | 渲染树求值（`tree.ts:66-81`、`:130-150`）                                                                                                                                               | ✅ 设计态求值       |
| `props` + `ExpressionString`                              | `resolveValue` → `expression.interpolate/evaluate`（`CanvasStage.vue:70-73`）                                                                                                           | ✅                  |
| `name`（图层显示名）                                      | 大纲面板                                                                                                                                                                                | ✅                  |
| `className` / `key`                                       | **未被消费**：`renderNode` 固定写 `class: 'lc-node'`（`CanvasStage.vue:126`）                                                                                                           | ⚠️ 仅数据           |
| `events` / `EventChain` / `connections` + `actions`       | 事件连接与动作链有**设计态编辑器**（`@lc/plugin-panel-eventflow`，底部停靠面板可新建事件、编排动作、编辑配置）；`events` 的处理器数组与 `EventChain` 仍只随文档存取；**没有动作执行器** | ⚠️ 可编辑、不可执行 |
| `components` / `datasources` / `lifecycles` / `functions` | 顶层字段随文档保存，`components: []` 为空数组写入（`service-workspace/src/index.ts:39`）                                                                                                | ⚠️ 仅数据           |
| `migrateDocument`                                         | 无调用点                                                                                                                                                                                | ⚠️ 未接入           |

结论：当前实现的是**设计态数据模型**（结构、几何、属性绑定、显隐锁定），运行态语义（事件动作、数据源、生命周期、声明式函数）是**已建模、未执行**的部分。写文档和评审时不要把「DSL 里有」当成「平台支持」。事件编辑有设计态编辑器：底部「事件流」面板能建连接、排动作、改配置，校验会报悬空引用与重复绑定；但没有动作执行器，所以「配得出来」不等于「跑得起来」。
