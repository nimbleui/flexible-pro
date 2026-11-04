# 08 插件层

20 个已登记插件包 + 2 个预设。全部通过 `manifest.contributes` 声明入口，宿主与预设不认识任何一个具体插件。

## 1. 装配路径回顾

```text
preset-designer（应用级，静态 import 9 个服务插件）
   └─ workspace.createEditorRealm → document / history / selection
        └─ editor.createCanvasRealm → canvas（service-canvas-core）
             └─ preset-canvas（CanvasRealm 级）
                  └─ contribution.list('canvasFeatures') → 按 order 逐个 modules.load → ctx.plugin
```

面板与物料走另一条路：`loader.register(pkg)` 只登记清单，**面板组件在插槽首次渲染该面板时才激活并加载**（`packages/vue/src/components/Slot.vue:95`、`:98`）。

## 2. 预设

### `@lc/preset-designer`

`packages/presets/preset-designer/src/index.ts:19-38`，`definePlugin({ name: 'preset-designer' })`，apply 里 9 次 `ctx.plugin`：`modules → loader → material → command → expression → setter → keybinding → rendererPlugin → workspacePlugin`。注释把顺序语义说清了：「装配顺序由各服务插件的 `inject` 决定；这里按『被依赖者先声明』书写，便于阅读与诊断」。

### `@lc/preset-canvas`

`packages/presets/preset-canvas/src/index.ts:11-60`：

```ts
inject: ['canvas', 'contribution', 'modules']
// apply 直接返回 installCanvasFeatures 的 Promise
contribution.list('canvasFeatures')
  .filter(item => item.value.defaultEnabled !== false)      // :17
  .sort((a, b) => (a.value.order ?? 0) - (b.value.order ?? 0)) // :18
for (const feature of features)
  module = await modules.load(moduleKey(feature.plugin, feature.value.module))  // :22
  if (!module.default) → 诊断 + continue                    // :25-31
  ctx.plugin(module.default, feature.value.config)          // :34
```

三条要点：**每个 CanvasRealm 独立实例**（注释 `:33`：实例注册关系挂在画布上，文档关闭自动卸载）；配置来自 manifest 的 `config` 字段；单个能力失败不影响其余。

`@lc/preset-canvas` 的依赖只有 `contracts` 与 `kernel`，**不认识任何画布插件**——这是「新增画布能力不需要改宿主」的结构保证。

## 3. 业务插件（8 个）

| 包                            | manifest.name      | 贡献点      | 条目 | 关键属性                                                                                                                           |
| ----------------------------- | ------------------ | ----------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@lc/plugin-materials-basic`  | `materials-basic`  | `materials` | 4    | `certification: 'platform'`、`executionProfile: 'inline'`、**无 `main`**（纯声明式，`plugin-materials-basic/src/manifest.ts:3-7`） |
| `@lc/plugin-panel-outline`    | `panel-outline`    | `panels`    | 1    | slot `designer.overlayPanel`、title「页面大纲」、`order: 10`、`activationEvents: ['onPanel:outline']`                              |
| `@lc/plugin-panel-materials`  | `panel-materials`  | `panels`    | 1    | slot `designer.leftPanel`、title「组件库」、`order: 20`、`onPanel:materials`                                                       |
| `@lc/plugin-panel-properties` | `panel-properties` | `panels`    | 1    | slot `designer.rightPanel`、`order: 10`、`onPanel:properties`                                                                      |
| `@lc/plugin-panel-style`      | `panel-style`      | `panels`    | 1    | slot `designer.stylePanel`、title「样式」、`order: 10`、`onPanel:style`                                                            |
| `@lc/plugin-panel-node-event` | `panel-node-event` | `panels`    | 1    | slot `designer.eventPanel`、title「事件」、`order: 10`、`onPanel:nodeEvent`                                                        |
| `@lc/plugin-panel-advanced`   | `panel-advanced`   | `panels`    | 1    | slot `designer.advancedPanel`、title「高级」、`order: 10`、`onPanel:advanced`                                                      |
| `@lc/plugin-panel-eventflow`  | `panel-eventflow`  | `panels`    | 1    | slot `designer.bottomPanel`、`order: 10`、`onPanel:eventflow`（`plugin-panel-eventflow/src/manifest.ts:3-22`）                     |

左槽现在只剩物料面板一个贡献者（大纲改投浮层槽，`order` 10 < 20 的先后关系因此不再有意义）；底槽是事件流、浮层槽是页面大纲，右侧四个页签各一个贡献者，每个槽当前都只有一个面板。

一个插件包只能贡献**一个**面板组件：`collectModules` 把 manifest 里出现的每个 `module` 字符串都登记成 `插件名/模块路径`，但加载器一律指向同一个 `pkg.load`（`service-loader/src/index.ts:322-329`），`Slot.vue` 再取 `module.default`（`packages/vue/src/components/Slot.vue:100-106`）。所以样式 / 事件 / 高级三个页签是三个独立包，而不是属性面板多写三条 `panels` 贡献。

### 3.1 `materials-basic`：四个物料

`plugin-materials-basic/src/manifest.ts:16-96`：

| 物料     | title | category | container | props（JSON Schema）                                | snippet 尺寸                      |
| -------- | ----- | -------- | --------- | --------------------------------------------------- | --------------------------------- |
| `Box`    | 矩形  | 基础     | ✅        | `fill: string`、`radius: number`、`label: string`   | 180×120，`props.fill = '#eef2ff'` |
| `Text`   | 文本  | 基础     | —         | `text: string`、`fontSize: number`、`align: string` | 200×40                            |
| `Circle` | 圆形  | 基础     | —         | `fill: string`                                      | 96×96                             |
| `Group`  | 分组  | 布局     | ✅        | `{}`（无属性）                                      | 240×160，`name: '分组'`           |

表格没有插槽列：`MaterialContribution.slots`（具名插槽声明，`contracts/src/services/material.ts:10-69`）刚进契约，这四个物料都还没声明。它已经在拖入路径生效（按 `region` 分格，见 [05 §MaterialService](./05-contracts-and-schema.md)），但没有插槽声明的容器仍一律落 `children`，行为与今天完全一致。

`Group` 的注释说明它的身份：「组合命令产出的节点类型；同时提供空白分组，方便手工往里放节点」——`canvas-commands` 的 `canvas.group` 会造出这个 `componentName`，所以物料必须登记它，否则 `isContainer` 判定与占位渲染都会退化。

四者 `module` 都写 `./src/index.ts`：`collectModules` 去重后只登记一个 key `materials-basic/./src/index.ts`（`service-loader/src/index.ts:159-174`），四条物料共享同一份加载结果。组件导出形状是**名字表**：

```ts
// plugin-materials-basic/src/components.ts:9/47/90/120  defineComponent + h
// plugin-materials-basic/src/index.ts:6/8
export const components = { Box, Text, Circle, Group }
export default { components }
```

`extractComponent(module, name)` 先查 `module.components[name]`，取不到才回落 `module.default`（`service-material/src/index.ts:20-22`），所以单组件物料包可以直接 `export default Component`。

### 3.2 大纲面板

`packages/plugins/plugin-panel-outline/src/index.ts:6`（默认导出 `OutlinePanel.vue`）。贡献到 `designer.overlayPanel`，由外壳活动栏的「页面大纲」唤出。

- 服务获取：`ctx.get` 取 `document` / `selection` / `material`（`:21-23`），**可空取值而非 require**——面板理论上可能在无 Realm 的作用域里渲染。
- 刷新桥：`onMounted` 里把 `document.onDidChange` / `selection.onDidChange` 绑到 `bump()`（`:46-48`），`bump` 递增一个 `ref(0)` 计数；`computed` 里先读 `version.value` 建立依赖。
- 树来源：`buildOutlineTree(document.model.schema)` 再过一遍 `filterOutlineTree(..., query)`（`:92-95` → `packages/schema/src/tree.ts:162`、`:208`），返回 `OutlineItem{node, children, position}`；面板用 `walk` 把它摊平成行数组并叠加折叠集合（`:32`）。搜索态强制展开（`isSearching` `:99`），否则命中的后代藏在折叠的父级下面搜不出来。
- 行图标：容器一律 `folder`，叶子按 `componentName` 回查物料贡献的 `icon`（`:82-90`）；图标名取自 `@lc/vue` 的共享图标注册表（`packages/vue/src/icons.ts`），未注册名回退成方框而不是空白。
- 写回全部走 patch：`document.apply(patches, { record: true })`（`:129-132`）——`setNodeFlags`（`:152` 显隐/锁定）、`renameNode`（`:169`）、`reorderChildren`（`:216`，带同父约束守卫 `:195-200`）。
- 选中：`selection.set` / `selection.toggle`（`:148-149`），Shift 走 toggle 保持主选语义。
- 行高常量 `ROW_HEIGHT = 28`（`:26`），HTML5 拖放自实现排序。

### 3.3 属性面板

`packages/plugins/plugin-panel-properties/src/PropertiesPanel.vue`（472 行）

- 五个服务：`document` / `selection` / `material` / `setter` / `expression`（`:32-36`），`onMounted` 里逐个 `onDidChange` 绑 `bump`（`:49`）。
- 当前节点：`selection.primary` → `document.model.schema.nodes[id]`（`:66`）；**属性面板只编辑主选中**，多选只显示数量（`:61`）。
- 字段生成：`materialEntry.props`（JSON Schema）→ `Object.entries(properties)` → `toPropType(definition)`（`:94`）→ `setter.resolve(propType)?.kind ?? 'text'`（`:129`）。
  `toPropType` 的判定顺序值得记住：`format === 'color' → 'color'`；`Array.isArray(enum) → 'enum'`；否则按 JSON `type` 映射，未识别一律 `'string'`。
- `enum` 选项来自 schema 的 `enum` 数组（`toOptions`，`:111`），**不是** `SetterEntry.options`（内置 setter 未提供 options，靠属性定义补充——与契约 `setter.ts:23-24` 的注释一致）。
- 提交：`commit(patches, label)` 统一 `document.apply(..., {record:true})`（`:189`）；`path(suffix)` 拼 `/nodes/<id>${suffix}`（`:200`）；分别有 `commitProp`、`commitPropNumber`、`commitExpression`。数字输入用 `Number.isFinite` 过滤。
- 文本属性可以是表达式：`expressionModes`（`:136`）是**面板本地状态**，不写进 schema；值里含 `{{` 时自动进入表达式态，切节点即清空。
- 本面板现在只有「组件属性」一段。位置尺寸与样式已迁到 `designer.stylePanel`（§3.5），同一字段不留两处入口。

### 3.4 物料面板

`packages/plugins/plugin-panel-materials/src/index.ts:6`（默认导出 `MaterialsPanel.vue`）：读 `material` / `command` 服务（`:27-28`）、`onDidChange` 版本桥（`:42-47`）、按 `category` 分组并按关键词过滤（`:60-75`）、分组折叠集合（`:34`、`toggleGroup` `:77`）。

面板头部自带「组件库 / 区块模板 / 我的组件」三个来源页签，后两个是 `disabled` 占位（`:13-24`）——外壳不再画左栏标题，与底槽同一约定。瓦片用 3 列网格，图标取物料贡献的 `icon`。

拖拽起点在这里（`:84-94`）：

```ts
event.dataTransfer.setData(toMaterialDragType(entry.name), entry.name)
```

MIME 前缀 `application/x-lc-material:` + 物料名按码点转十六进制（`packages/contracts/src/drag.ts:8-24`），**这样任何物料名（含中文、空格、大小写）都能安全进入 `dataTransfer.types`**；消费侧 `materialNameFromDragTypes(types)` 反解（`:25`）。

### 3.5 样式面板

`packages/plugins/plugin-panel-style/src/StylePanel.vue`，贡献到 `designer.stylePanel`。七段：位置与尺寸、内边距、外边距、背景与边框、文本、显示、原始样式。

- 换算全部在 `src/utils/style-fields.ts`，组件只做绑定：`SpacingValue` / `BorderValue` 允许「简写字符串 / 四方向对象」两种形态，而渲染层是把 `node.style` **原样 spread 成 CSSProperties**（`packages/vue/src/components/CanvasStage.vue:99`），对象形态不会产生任何样式。因此面板按四边读、**写 CSS 长手属性**（`padding-top` 等），写任一边时顺带删掉同名简写键——两条路径同时存在时浏览器按书写顺序决胜，会留下「改上边、左右也跟着变」的幽灵回归。
- 值没变不产生 patch（`boxSideEdits` / `borderPartEdits` / `styleValueEdits` 都先比对），避免一次失焦留下一条空历史。
- 四边编辑器 `components/BoxSidesEditor.vue` 是 padding 与 margin 共用的子组件；留空即删该方向的长手键。
- `>4` 段的简写（`calc()` 里的空格已按括号深度切分，不算分隔符）判为无法解释，读回空四边且不动原值，让用户去原始样式段处理。
- 原始样式段是 `StyleSchema` 索引签名的逃生门：整份 `style` 用 JSON 编辑，半截 JSON 只回错误不落文档，非键值对象（数组 / 标量）直接拦下。
- 「位置与尺寸」段带一对锁位下拉（水平 `left | right | center | scale | stretch`、垂直 `top | bottom | center | scale | stretch`），写 `layout.constraints`：自定义组件实例改尺寸时按它重排内部节点（`packages/vue/src/render/constraints.ts`），没写就等于固定左上角。
- 不暴露 `layout.mode` / `node.className` / `node.key`：协议里有，但渲染层与画布都没有消费者，做进面板就是假功能。

### 3.6 节点事件面板

`packages/plugins/plugin-panel-node-event/src/NodeEventPanel.vue`，贡献到 `designer.eventPanel`，与底部事件流面板读写同一份 `connections` / `actions`。

- 分工：右栏按**选中节点**筛，只回答「哪些事件接上了链、链上有几步」；动作参数、顺序与分支仍在 `designer.bottomPanel`。这句话写在面板顶部的提示里，免得用户在这里找配置表单。
- 事件来源：`collectEventDefinitions` 合并页面 schema 的 `components[].events` 与物料登记的 `events`，按名去重、schema 先写者胜出；没声明事件的物料提供手填绑定。
- 一行动一个事件：`buildEventRows` 先列声明（未绑定的也要出现），再补未声明却已绑定的自定义事件；同事件的第二条连接属于校验错误，不再开第二行。
- 写操作全在 `composables/use-node-event-bindings.ts`：绑定（同节点同事件查重后 `add` 连接）、解绑（`remove` 连接 + `orphanedActionIds` 回收只被它引用的动作，同批提交）、启停、加动作（动作本体与 `actionIds` 引用同批提交，否则历史里会出现悬空引用的中间态）、摘动作（被复用的动作只摘引用）。
- 空配置动作标成「未填写参数」：`ui.toast` 这类必填字段不在 `validateDocument` 的表达式字段检查里，不写出来的话面板上是一条看起来正常、实际什么都不做的动作。
- 本节点连接与动作上的校验问题显示在列表上方（`issuesForConnections` 按 `/connections/<id>`、`/actions/<id>` 前缀过滤 `document.validate()`）。

### 3.7 高级面板

`packages/plugins/plugin-panel-advanced/src/AdvancedPanel.vue`，贡献到 `designer.advancedPanel`，只编辑运行时真正消费的节点级字段。

- 覆盖：图层显示名、`hidden` / `locked` 设计态开关、`condition` 条件渲染、`loop`（数据源 + 项名 / 下标名）、`directives` 列表。开关关闭写「删键」而不是存 `false`，schema 里只留与默认值不同的意图。
- 表达式读写在 `utils/expression-field.ts`：输入框统一显示 `{{ ... }}`，落盘存剥壳后的内层文本（与既有文档的 `condition` 写法一致）；空文本与只剩外壳都视为清空，不存恒为真的空表达式；裸字符串原样回显而不顺手包装——包装会把它从常量变成会求值的表达式，那是语义变更。
- 指令表整体替换而不逐条写索引路径（`utils/directives.ts`）：同一批编辑按索引改会互相覆盖，整表一次写入更稳；下标越界返回等值新数组而不抛错，因为列表可能在提交之间被撤销或画布删除改短。
- `readonly` / `required` 两种指令在协议里有、`buildRenderTree` 未实现（只吃 show / hide / disabled），下拉里照列但标注「渲染层未生效」。

## 4. 画布插件（15 个）

统一形态：`export default defineCanvasPlugin({ name, inject, apply })` + `src/manifest.ts` 出一条 `canvasFeatures` 贡献 + `activationEvents: ['onCanvasFeature:<id>']`。

| order | 包 / feature id                       | 交互处理器                                                          | 覆盖层                | 设置项                                                                                                              | 命令 / 快捷键                                                                                                             | 关键常量与算法                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------- | ------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5     | `canvas-grid` / `grid`                | —                                                                   | `background`          | `canvas-grid.size`（`scope: 'workspace'`、`schema: {type:'number',minimum:2,maximum:100}`、`default: 8`，`:16-22`） | —                                                                                                                         | `MIN_SCREEN_STEP = 6`（屏幕网格线过密则跳过）；CSS `linear-gradient` 双向渐变画线（`src/overlay.ts:8`、`:58-60`）                                                                                                                                                                       |
| 10    | `canvas-zoom` / `zoom`                | wheel + keydown（2 个 handler）                                     | —                     | —                                                                                                                   | 5 命令：`canvas.zoomIn/zoomOut/zoomReset/zoomFit/zoomToSelection`；1 快捷键 `Mod+Shift+1` → zoomToSelection（`:171-178`） | `WHEEL_SENSITIVITY = 0.0015`（指数映射，滚轮连续可复合）、`STEP = 1.2`、`MIN_ZOOM 0.1 / MAX_ZOOM 4`（`:8-20`）；Ctrl/⌘ + 滚轮                                                                                                                                                           |
| 11    | `canvas-pan` / `pan`                  | 3 个（capture 阶段）                                                | —                     | —                                                                                                                   | —                                                                                                                         | 空格 + 拖拽、中键 `MIDDLE_BUTTON = 4`（`buttons` 位掩码，`:6`、`:64`）、无修饰滚轮平移                                                                                                                                                                                                  |
| 20    | `canvas-selection` / `selection`      | click / pointer / hover / hover-reset / marquee / dblclick / escape | `selection`           | `canvas-selection.marquee`、`canvas-selection.hover`（`src/constants.ts:2`、`:5`）                                  | —                                                                                                                         | `CYCLE_RESET_PX = 4`（`:16`，Alt 循环选择时位移超过即重置）；Ctrl/⌘ 加选、Shift 连选、双击与 Esc 进入/退出父级（`src/hierarchy.ts`）；锁定节点由 `canvas.nodeFlags` 挡住                                                                                                                |
| 30    | `canvas-snap` / `snap`                | —                                                                   | —                     | —                                                                                                                   | —                                                                                                                         | **提供 `snap` 服务**（`ctx.provide('snap', …, {apiVersion:'1.0'})`，`:59`）；注册 `snap.grid`（`:61-66`）与 `snap.elements`（`:68-70`）两个 provider；配置 `{ thresholdScreenPx: 6, gridSize: 8 }` 由 manifest 注入，`parse` 逐项回落默认值（`:24-34`）                                 |
| 40    | `canvas-drag` / `drag`                | 1（bubble / priority 50）                                           | `preview`（拖拽徽标） | `canvas-drag.badge`                                                                                                 | —                                                                                                                         | `DRAG_THRESHOLD_PX = 3`（`:14`）；`transformableIds` 剔锁定（`:101`）+ `collectSubtree` 整树（`:105`）；起始 rect 快照避免浮点漂移（`:107-114`）；`transaction.begin` `:128` + `beginGesture` `:139`；写 `/nodes/<id>/layout/rect`                                                      |
| 50    | `canvas-resize` / `resize`            | 1（`phase: 'target'`、priority 100，`:120`）                        | `handles`             | —                                                                                                                   | —                                                                                                                         | 8 个手柄 `nw n ne e se s sw w`（`src/overlay.ts:18`），handle id 即方向串；`MIN_RESIZE_SIZE = 8`、`MIN_NODE_SIZE = 1`（`src/geometry.ts:5-8`）；`edgeModesOf(handleId)` 决定吸附哪条边（`:107`）；`shift` 锁比例；**排除 `rotate` 手柄**（`:18`、`:127`、`:132`）                       |
| 55    | `canvas-rotate` / `rotate`            | 1（target）                                                         | `handles`             | —                                                                                                                   | —                                                                                                                         | `ROTATE_HANDLE_ID = 'rotate'`；`snapRadians(radians, stepDeg = 15)`（`src/rotate.ts:33-34`，Shift 吸附到 15°）；`normalizeDegrees`、`rotateNodes`（绕组包围盒中心）、`placeRotateHandle`                                                                                                |
| 60    | `canvas-guides` / `guides`            | —                                                                   | `guides`              | —                                                                                                                   | —                                                                                                                         | 纯消费者：`visible: frame.snap.guides.length > 0`（`:20-23`）；svg 画线，线宽/颜色取 Token                                                                                                                                                                                              |
| 65    | `canvas-rulers` / `rulers`            | 3（含手柄拖出参考线）                                               | `hud`（zIndex 1）     | `canvas-rulers.guides`、`canvas-rulers.draft`（`src/guides.ts:23-24`，注册在 `src/index.ts:60`）                    | —                                                                                                                         | `CREATE_THRESHOLD_PX = 6`（`:22`）；handle id `ruler-h` / `ruler-v` / `guide-h-<i>`（`src/guides.ts:29`）；`rulerStep(zoom, minGapPx = 64)` 取 1-2-5 序列（`:133-135`）；**注册 `canvas-rulers.guides` 吸附 provider，`priority: 2`**（`:101-115`）                                     |
| 70    | `canvas-align` / `align`              | —                                                                   | —                     | —                                                                                                                   | 8 命令（`canvas.alignLeft/CenterX/Right/Top/CenterY/Bottom` + `canvas.distributeX/Y`，`:21-26`、`:109-118`）              | `AlignMode` 6 种（`src/align.ts:9`）；对齐最少 2 个、分布最少 3 个；`alignRects` / `distributeRects`，间距 `gap = (spanEnd − spanStart − totalSize) / (n − 1)`（`:44`、`:105`）；产出 patch 走 `document.apply(record:true)`                                                            |
| 80    | `canvas-drop` / `drop`                | —                                                                   | `preview`             | `canvas-drop.preview`                                                                                               | —                                                                                                                         | 监听 `canvas:drop`（`:56`，`bail` 首个非 undefined 消费）；`material.get(name)`（`:58`，未知物料记诊断 `:60`）；`cloneNode(entry.snippet)`（`:70`）；无 snippet 时 `DEFAULT_DROP_WIDTH/HEIGHT = 180/120`（`src/constants.ts:8`）；落点容器由 `hitTest.containerAt` 决定                 |
| 80    | `canvas-minimap` / `minimap`          | 1（target / priority 120）                                          | `hud`（zIndex 5）     | —                                                                                                                   | —                                                                                                                         | `MINIMAP_SIZE = 180×120`、`MARGIN = 12`、`HEADER = 20`、`padding = 0.92`（`src/geometry.ts:5-9`、`:58`）；`fitLayout` / `toMapRect` / `toWorldPoint` / `layoutFor` 纯函数                                                                                                               |
| 90    | `canvas-commands` / `commands`        | —                                                                   | —                     | —                                                                                                                   | **16 命令**（`:156-262`）+ **24 快捷键**（`:275-345`）                                                                    | `PASTE_OFFSET = 20`（`:17`）；纯逻辑在 `src/operations.ts`：`copySubtrees`（`:46`）、`insertSubtrees`（`:68`）、`deleteSelection`（`:148`）、`nudgeSelection`（`:163`）；结构操作复用 `@lc/schema` 的 `groupNodes/ungroupNodes/changeOrders/setNodeFlags`；`undo/redo` 直接调 `history` |
| 95    | `canvas-context-menu` / `contextMenu` | 3（contextmenu 事件）                                               | `hud`（zIndex 9）     | `CANVAS_CONTEXT_MENU_STATE`，`scope: 'document'`（`src/index.ts:35-38`）                                            | —                                                                                                                         | `src/items.ts` 提供 **16 条菜单项**，全部映射到已有命令 id，按 `group`（`edit` / `structure` / …）分组插分隔线；开合状态放在设置总线而不是注册表（契约 `canvas-contributions.ts:199` + `menu.ts:4-10`）                                                                                 |

## 5. 全平台命令与快捷键总账

| 来源                        | 命令数                    | 快捷键数     |
| --------------------------- | ------------------------- | ------------ |
| `canvas-zoom`               | 5                         | 1            |
| `canvas-align`              | 8                         | 0            |
| `canvas-commands`           | 16                        | 24           |
| 宿主 `bootstrap.ts:120-129` | 1（`app.commandPalette`） | 1（`Mod+K`） |
| **合计**                    | **30**                    | **26**       |

命令注册都是命令式 `ctx.command.register`（没有 `commands` 贡献点），快捷键同理 `ctx.keybinding.register`。`canvas-commands` 与 `canvas-zoom` 都做了**可选守卫**：先 `const keybinding = ctx.keybinding`，再 `if (keybindingService)` 才注册（`canvas-commands/src/index.ts:42`、`:345-349`；`canvas-zoom/src/index.ts:171`）——`keybinding` 不在 `RESERVED_SERVICES` 里也不是它们的 `inject` 声明项，所以必须容错。

## 6. 插件之间的协作方式

**实测没有任何一个插件 import 兄弟插件**（见 [01 依赖边](./01-structure.md#l4-插件层)）。五类合法通道：

| 通道                     | 用例                                                                                                                                                                        | 强度                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **可选服务注入**         | `canvas-drag` / `canvas-resize` 的 `inject: { required: [...], optional: ['snap'] }`（`canvas-drag/src/index.ts:26`）；未安装 snap 时 `ctx.snap` 为 undefined，直接跳过吸附 | 弱耦合，可裁剪               |
| **handle id 字符串约定** | `canvas-resize` 在自己的源里重声明 `ROTATE_HANDLE_ID = 'rotate'`（`:18`）并在 `when`/`handle` 里排除它（`:127`、`:132`），从而不与旋转手柄抢 target 阶段                    | 零引用，靠字符串             |
| **设置总线**             | 8 项设置是插件间唯一的状态广播面：`canvas-drop` 写预览 → 自己的 overlay 读；`canvas-selection` 写 hover/marquee；`canvas-rulers` 存用户参考线；`canvas-context-menu` 存开合 | 键名即协议                   |
| **类型化事件**           | `canvas:drop`（宿主 `bail` → `canvas-drop` 消费）、`canvas:gestureEnd`（canvas-core 发，供埋点）                                                                            | 有类型表                     |
| **priority 协商**        | `canvas-drag` 50 < `canvas-selection` 70；`canvas-resize` target 100；`canvas-rotate` target 110；`canvas-minimap` target 120；`snap` provider 0/1/2 分层                   | 数字即顺序，注释必须写明理由 |

`canvas-guides` 是纯下游消费者：它不读 snap 服务，只读 `frame.snap`（`CanvasFrame.snap` 由 `LayerHost.vue:63-69` 每帧快照给出，未安装 snap 时为 `null`）——**覆盖层拿到的是一帧的一致视图，不会各读各的而出现撕裂**。

## 7. 裁剪与差异化

| 需求                         | 做法                                                                    | 需要改代码吗     |
| ---------------------------- | ----------------------------------------------------------------------- | ---------------- |
| 某租户不要标尺               | `canvas-rulers` manifest 的 `defaultEnabled: false`，或装配时不提供该包 | 否               |
| 调整能力顺序                 | 改 `canvasFeatures[].order`                                             | 否               |
| 换吸附阈值/网格              | 改 `canvasFeatures[].config`（`{ thresholdScreenPx, gridSize }`）       | 否               |
| 只留基础物料                 | 不登记 `materials-basic`，改登记自己的物料包                            | 否               |
| 换一套面板                   | 新增 `panels` 贡献指向新模块，旧包不登记                                | 否               |
| 「按产品形态选一组画布预设」 | 契约有 `canvasProfiles` 点，**当前无实现**：`preset-canvas` 不读它      | 是（需接消费方） |
