# 09 Vue 宿主与渲染

`@lc/vue`（10 个源文件）是**唯一持有 Vue 运行时的平台包**；`@lc/host`（apps/host）是产品外壳，`@lc/designer`（apps/designer）是只出画布的远程模块。分工遵循 `Core → Framework Adapter → Component` 的边界：内核与画布内核不含任何 `ref/computed/onMounted`。

## 1. `@lc/vue` 导出面

`packages/vue/src/index.ts:10-24`：

| 类别     | 导出                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| Context  | `LC_CONTEXT`、`provideContext`、`useAppContext`、`useService`、`useRegistryList` |
| 组件     | `LcSlot`、`ContextScope`、`PluginBoundary`、`CanvasStage`、`LayerHost`           |
| 服务插件 | `rendererPlugin`（插件名 `service-renderer`）                                    |

`package.json:19-21` 用 `peerDependencies` 声明 `vue ^3.5`，配合两个应用的 `resolve.dedupe: ['vue']`（`apps/host/vite.config.ts:34-37`、`apps/designer/vite.config.ts:31-33`）与 MF `shared.vue: { singleton: true, eager: true }` 保证 Vue 单例——多实例会直接击穿 `provide/inject`，并让远程组件的 vnode 在宿主应用里渲染失败。

## 2. Context 桥接

### `LC_CONTEXT` 与两级注入

`packages/vue/src/context.ts:12`：`const LC_CONTEXT: InjectionKey<Context> = Symbol.for('lc-context')`。必须是 `Symbol.for`：宿主与远程各打包一份 `@lc/vue`，`Symbol()` 产生的两个键互不相等，远程侧的画布覆盖层组件就注入不到上下文（详见 [12](./12-module-federation.md#3-画布能力如何跨边界进宿主内核)）。

- `provideContext(app, context)`（`:14-16`）**只在应用根调用一次**，注入的是 AppContext。
- `ContextScope.vue:6-16` 用**组件级 `provide`** 再注入一层。注释点明关键理由：「同一应用里可以按子树注入不同的 Realm，嵌套时子组件取到的是最近一层（画布作用域会再注入一次）」。

所以 `views/DesignerView.vue:81` 的 `<ContextScope :context="editor.context">` 之下的面板调用 `useAppContext()`（`:19-25`，**未注入即抛错，不静默返回 undefined**）拿到的是 **EditorRealm 上下文**，于是 `ctx.get('document')` 才成立。这是多 Realm 支持的落地方式，而不是靠约定「只有一个编辑器」。

### `useService` / `useRegistryList`

- `useService(name)`（`:33-48`）返回 `Ref<Service | undefined>`：因为服务可能晚于组件出现（Realm 装载、晚绑定），所以用 `shallowRef` + `context.services.onDidChange` 只在 `changed === name` 时刷新（注释 `:39-40` 说明逐名订阅是为了避免累加无效监听），`onUnmounted` 自动解绑。
- `useRegistryList(getRegistry)`（`:56-87`）用 `watchEffect` 重新订阅（服务实例被替换时先释放旧订阅再挂新的，`:62-64`），返回的 `computed` 同时读 `version.value` 与 `registry.version`（`:83-84`）建立双重依赖。

**as-built 事实**：这两个 composable 目前**只有 `index.ts:12-15` 的再导出，仓库内没有任何消费者**。所有现存组件都走更朴素的版本计数桥（见下）。它们属于「已交付但未采用」的 API，见 [10 已知边界](./10-development-guide.md#9-已知边界与技术债)。

## 3. 三种响应式桥接范式（全仓实测）

内核服务与注册表都不是响应式源，`@lc/vue` 用三种手法接入 Vue 依赖系统：

| 范式                                                                                                              | 适用                                             | 代码                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ref(0)` 版本计数**：在服务的 `onDidChange` 里 `version.value += 1`，`computed` 内先读 `version.value` 建立依赖 | 低频结构变化（贡献表、注册表、文档、选中、图层） | `Slot.vue:25`、`:36-38`；`OutlinePanel.vue:21`、`:39-40`；`PropertiesPanel.vue:25`、`:32-37`；`CanvasStage.vue:46`、`:245-249`；`LayerHost.vue:45`、`:77-81`；`ToolbarStock.vue:10-22`；`StatusBar.vue:23-49` |
| **`shallowRef` 整体替换**                                                                                         | 高频每帧值（视口矩阵、frame 快照）               | `CanvasStage.vue:43`、`:172-175`；`LayerHost.vue:54`、`:72-75`（注释：「只比较引用，所以必须换整个对象才触发更新」）                                                                                          |
| **`reactive(new Map())` + `markRaw`**                                                                             | 模块/组件缓存                                    | `Slot.vue:28`、`:105`；`LayerHost.vue:36`、`:123`；`CanvasStage.vue:48`、`:166`（注释 `:122`：组件对象不能进响应式代理，否则 Vue 重复代理产生开销）                                                           |

另有一条时间线约束写在 `StatusBar.vue:26-27`：

> 在 setup 阶段同步订阅：`CanvasStage` 的首次居中发生在父级 mounted 之后，若在 `onMounted` 里订阅会漏掉这一次视口变化。

所以状态栏不用 `onMounted`，而 `Slot.vue`、`CanvasStage.vue` 用 `onMounted`（它们的订阅对象不会在挂载期间变化）。

## 4. `LcSlot`：插槽宿主

`packages/vue/src/components/Slot.vue`

```ts
props: { name: SlotName, context?: Record<string, unknown> }   // :16-20
ctx = useAppContext()                                          // :22
watch(() => { version.value; return ctx.contribution.listSlot(props.name) }, ...)  // :57-80
```

流程（`:63-80` + `:89-115`）：

1. 列表**先用缓存渲染**：`entries.value = items.map(... component: components.get(key))`，未命中的先出骨架。
2. 对每项 `ensurePanel(plugin, panelId, module)`：
   - `key = ${plugin}/${panelId}`，`components.has(key) || loading.has(key)` 即跳过（`:90-92`）；`loading` 集合只做并发去重、不参与渲染（`:33-34`）。
   - `ctx.loader.ensureActivated('onPanel:' + panelId)`（`:95`）——**先保证插件行为已激活**；纯声明式插件没有 `main`，直接返回。
   - `ctx.modules.load(moduleKey(plugin, module))`（`:98`）→ `markRaw(module.default)`（`:105`）。
   - **只重建 `entries` 里对应那一项**（`:106-108`），其余项保持原对象引用，keyed `v-for` 因此只重渲染到达的面板而不是整个插槽（注释 `:82-88` 明确「key 的拼接方式必须与 watch 内一致，否则面板会一直停在骨架」）。
   - 失败：写 `failures` + `ctx.diagnostics.report(error, { scope:'slot', plugin, panel, module })`（`:109-111`）。
3. 模板（`:118-136`）：每个面板单独包 `PluginBoundary`；`<component :is="entry.component" :context="props.context" />`；失败态渲染文案（`role="alert"`）；中间态渲染骨架 `data-panel`；空插槽走 `#empty` 具名插槽。

`props.context` 是个**弱类型透传口**（`Slot.vue:12-19` 注释）：「以 `context` 这一个 prop 原样下发，插槽不校验字段；键名约定由贡献声明与面板实现自行对齐。未传时面板收到 undefined」。宿主 `App.vue:40` 传的是 `{ documentId: 'demo-doc' }`，面板自己声明 `context?: Record<string, unknown>` 并接受但不强依赖（`PropertiesPanel.vue:14-17`）。**面板真正取服务用的是 `useAppContext()`，不是这个 prop**——prop 里的 `documentId` 目前没有任何消费者，只是个约定占位。

## 5. `CanvasStage`：舞台宿主

`packages/vue/src/components/CanvasStage.vue`（327 行）

### 服务获取

`:34-37` 四个 `props.context.require<...>`：`canvas`、`document`、`renderer`、`expression`。**用 `require` 而非 `get`**：舞台没有这些服务就无法工作，早失败比渲染空白好。

### 渲染树

```ts
const tree = computed<RenderNode[]>(() => {
  docVersion.value // :56 建立依赖
  return buildRenderTree({ schema, scope, resolveValue: expression.resolveValue }) // :58-62
})
```

`resolveValue` 不再是宿主自己实现的递归函数，而是直接注入引擎的 `expression.resolveValue`（`:61`）。入口顺序：`isExpressionString` → 求值；`isJsExpression` → 走 `allowUnsafeJs` 门控的执行器（默认关闭，拒绝并上报诊断）；含 `{{` 的字符串 → 插值；数组与「原型为 `Object.prototype`」的普通对象递归；`Date`/`Map`/类实例原样透传，避免日期字段被重建成空对象。**条件、循环、指令共用这一个入口**，保证渲染树里的值都已求值。递归深度上限与「错误吞掉并上报诊断以免白屏」的策略都在引擎侧，见 `docs/05` 的表达式一节。

`buildRenderTree`（`packages/vue/src/render/tree.ts:50-169`）的规则（`:39-49` 注释）：

| 规则                                                                                                      | 位置                  |
| --------------------------------------------------------------------------------------------------------- | --------------------- |
| `condition` 为假 → 整棵子树不渲染                                                                         | `:130`                |
| `hidden` → 不渲染（设计态开关，整棵子树）                                                                 | `:131-132`            |
| `directives` 按序求值：`show` → visible=true，`hide` → false，`disabled` → disabled=true                  | `:66-81`              |
| `loop` 展开为多实例，作用域注入 `$item` / `$index`（或自定义 `itemName/indexName`），key 带 `#index` 后缀 | `:135-150`            |
| **同一节点只渲染一次（父级优先）**，循环实例除外                                                          | `:152-154`            |
| **未被任何节点引用的节点作为顶层孤儿渲染**，兼容旧文档                                                    | `:160-166`            |
| 递归深度上限 `maxDepth = 24`；同一路径上的重复 id 直接返回，防循环引用                                    | ``:52-53`、`:122-127` |
| 缺 `layout.rect` 时的兜底 `DEFAULT_RECT = {x:0,y:0,width:100,height:40}`                                  | `:33`、`:108`         |

`tree.ts:45` 有一句重要的限制：**循环实例共用同一个世界矩形**（「流式布局属于后续能力」），所以 `loop` 目前在画布上表现为重叠盒子，只有运行时渲染才有意义。

### DOM 与坐标补偿

`renderNode`（`:112-138`）+ `NodeTree`（`:141-150`，`defineComponent` 递归组件）：

```ts
style: nodeStyle(item, origin) // :97-110
// left = rect.x − origin.x，top = rect.y − origin.y，width/height 取世界值
// zIndex 来自 layout.zIndex，transform: rotate(...) 来自 layout.rotate
// visible 为 false → display: none
```

注释给出为什么（`:91-96`）：schema 里的 rect **始终是世界坐标**，嵌套 DOM 只负责裁剪与层叠，视觉与扁平渲染一致；配合内容层唯一的 `transform: matrix(...)`，缩放到 400% 也不重算节点样式（`:281`）。

物料未解析到位时渲染 `.lc-node__placeholder`，内容就是 `componentName`（`:134`）——**「未知组件」在画布上是可见的，不是空白**。

### 组件解析与挂载

`syncComponents()`（`:136-147`）：遍历 `document.model.schema.nodes` 的 `componentName`，`components.has(name) || loading.has(name)` 跳过，`renderer.resolveMaterial(name)` 后 `components.set(name, markRaw(component) ?? null)`。`refreshMatrix()`（`:152-154`）把 `canvas.viewport.matrix` 拼成 CSS `matrix(...)` 写入 `shallowRef`。

`centerRootAtCurrentZoom()`（`:163`）是首帧的唯一视口写入：它按当前缩放（默认 100%）把文档根矩形摆到视口中心，**不再调 `viewport.fit`**——fit 会为了塞下整张画幅把 zoom 夹到下限，窄容器里直接掉到 10%；要看全貌由用户执行「适应画布」命令（`canvas-zoom` 注册）。

`onMounted`（`:236-259`）顺序不可换：

```text
canvas.attach(element)              // :241 注册监听 + 同步写尺寸（注释 :240）
canvas.scheduler.onFrame(refreshMatrix)  // :242
document.onDidChange(...)           // :243-248 bump + syncComponents
window 'dragend' → clearDropPreview // :249-250
refreshMatrix(); syncComponents()   // :252-253 首帧
centerRootAtCurrentZoom()           // :255 必须晚于 attach 的尺寸写入，否则尺寸为 0 直接跳过
element.focus()                     // :258 键盘挂在舞台上
```

`onUnmounted`（`:261-266`）**逆序释放**：先断后注册的订阅，再卸载画布挂载，避免订阅读到已销毁的 DOM。

### 原生拖放 → 事件总线

`dragover`（`:197-211`）：`materialNameFromDragTypes(dataTransfer.types)` → `preventDefault` + `dropEffect = 'copy'` → 计算 `screen`（减 stage rect）与 `world` → `canvas.hitTest.containerAt(screen)` → `canvas.settings.set(CANVAS_DROP_PREVIEW_SETTING, {...})`。

`setDropPreview`（`:189-195`）把 `settings.set` 包在 `try/catch` 里：`canvas-drop` 未安装时该 id 未注册会抛错（`settings.ts:61-63`），**忽略预览但不影响 drop 本身**。

`drop`（`:220-231`）：清预览 → `context.bail('canvas:drop', payload)`，由 `canvas-drop` 消费。

### 模板结构

```html
<div class="lc-stage" tabindex="0" data-lc-stage @dragover @dragleave @drop>
  <!-- :272-280 -->
  <div class="lc-stage__content" :style="{ transform: matrix }">
    <!-- :282 -->
    <NodeTree :items="tree" :origin="rootOrigin" />
    <!-- :283 -->
  </div>
  <LayerHost :context="props.context" />
  <!-- :286 -->
</div>
```

`.lc-stage`：`position: relative; overflow: hidden; touch-action: none; user-select: none; outline: none`（`:291-301`）。`.lc-stage__content`：`position:absolute; inset:0; transform-origin: 0 0; will-change: transform`（`:303-309`，注释：改 origin 会让视口换算与画面分裂）。

## 6. `LayerHost`：覆盖层宿主

`packages/vue/src/components/LayerHost.vue`

| 机制                    | 位置                   | 说明                                                                                                                                                                                                             |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame` 快照            | `:56-70`               | `buildFrame()` 一次读 `canvas.viewport.state` / `selection.ids` / `snap?.lastResult ?? null` / `canvas.viewport.size`。注释解释目的：「覆盖层拿到的永远是同一时刻的视口/选中/吸附/尺寸，不会各读各的而出现撕裂」 |
| `snap` 服务可能中途出现 | `:47-51`、`:142+`      | `ctx.get('snap')` 初始可能为 undefined；订阅按实例比对（`boundSnap`），**服务被替换才重绑**，避免重复注册同一个 refresh                                                                                          |
| 图层列表                | `:77-81`               | `layerVersion.value` + `canvas.layers.list()`（排序由服务给出 `band → zIndex → seq`）                                                                                                                            |
| 可见性                  | `:83-86`               | `layer.visible ? layer.visible(frame.value) : true`；注释强调「该判断每帧对每层执行，必须保持廉价」                                                                                                              |
| 层级样式                | `:88-103`              | `position:absolute; inset:0; pointerEvents: layer.pointerEvents ?? 'none'; zIndex: (index+1)*10 + (layer.zIndex ?? 0)`，并警告 `zIndex ≥ 10` 会与下一层撞 z                                                      |
| 模块加载                | `:105-135`、`:138-140` | `syncLayers()` 对**全部注册图层**调用 `ensureLayer`；失败或无默认导出写 `failures` + 诊断，注释判定「图层缺失只降级为一条提示，不应把整个画布带崩」                                                              |
| 每帧刷新                | `:150-160`             | `scheduler.onFrame(refresh)`、`selection.onDidChange(refresh)`、`document.onDidChange` 等订阅                                                                                                                    |

**与契约的偏差**：`CanvasLayer.load` 注释写「首次可见时加载」（`packages/contracts/src/canvas-contributions.ts:141`），实现是全量加载（`LayerHost.vue:136` 注释明确接受代价）。文档按实现描述。

## 7. `PluginBoundary`：UI 错误边界

`packages/vue/src/components/PluginBoundary.vue`：`onErrorCaptured` 记录错误、`ctx.diagnostics.report(caught, { scope:'plugin-ui', plugin })` 并 **`return false` 阻止冒泡到整个设计器**（`:18-24`）；`watch(() => props.plugin)` 复位错误态（`:26-32`，注释：同一个边界实例被复用去渲染别的面板时必须复位，否则会一直显示上一个插件的错误）；降级 UI 带 `role="alert"`（`:37-41`）。

## 8. `rendererPlugin`：物料名 → 组件

`packages/vue/src/plugins/renderer.ts`：`definePlugin({ name: 'service-renderer', inject: ['material'], provides: ['renderer'] })`。

- `cache: Map<string, Promise<unknown | undefined>>`（`:24`）——**缓存的是 pending Promise 而不是结果**，同一组件名并发只加载一次；`material.onDidChange` 时整体 `clear()`（`:26-30`），让重新解析拿到新实现。
- `resolveMaterial(name)`（`:40-56`）**永不 reject**：`.catch` 里删缓存（`:48`）+ 诊断 + 返回 `undefined`。注释给出两条理由：调用方按「组件不可用」渲染占位即可；失败不留在缓存里，避免一次失败把该组件永久锁死成 `undefined`。
- provide 点：`:58`。
- 把解析从 UI 里抽出来的动机写在头注释：「`CanvasStage` 与导出器都通过 `ctx.renderer` 取得组件」——即**渲染能力可被非 UI 场景（导出/预览）复用**。

`@lc/vue` 用 `definePlugin` 而不是 `defineEditorPlugin`：renderer 是应用级服务，与 Realm 无关，因此物料组件缓存跨文档共享。

## 9. 设计器外壳

### 布局

外壳拆成两个文件：`apps/host/src/App.vue`（34 行）只放跨路由的壳，`apps/host/src/views/DesignerView.vue`（124 行）放一个文档的设计器界面。

```text
apps/host/src/App.vue                                   外壳
└ .lc-app
  ├ header.lc-app__header                               :15-29
  │   brand（LC / LowCode Studio / 微前端宿主徽章）      :16-20
  │   nav > RouterLink「页面」                           :22-24
  │   button「命令 ⌘K」→ appCtx.emit('palette:toggle')   :8-10、:26-28
  └ RouterView :key="route.path"                        :32   换文档即整页重建

apps/host/src/views/DesignerView.vue                    设计器视图
<div v-if="!ready" .lc-designer__loading>               :374  就绪门，见 12 号文档 §5
ContextScope(editor.context)                            :376
└ .lc-designer
  ├ .lc-designer__toolbar > ToolbarStock + 开发者工具按钮 :378-477
  ├ .lc-designer__body                                    :479-657
  │   nav.lc-rail（7 个活动栏入口）                        :480-496
  │   aside--left > LcSlot name="designer.leftPanel"      :499-511
  │   section--center > <CanvasModule :app-context :canvas-context :scope>  :513-523  远程画布（内部渲染 CanvasStage）
  │   .lc-dock > LcSlot name="designer.bottomPanel"       :530-576
  │   aside--right > 四页签 + 四个 LcSlot                  :579-653
  │   LcDevtools(v-if)                                    :655-661
  ├ StatusBar(:canvas-context)                            :664
  └ CommandPalette                                        :668
```

宿主侧不再直接引用 `CanvasStage`：舞台由远程模块 `apps/designer/src/CanvasModule.vue:40` 渲染，`CanvasStage` / `LayerHost` 仍是 `@lc/vue` 的导出，只是消费者换成了远程包。

设计器外壳（`DesignerView.vue`）有活动栏：56px 的 `.lc-rail`（`apps/host/src/styles/app.css:769`）排 7 个入口，其中「组件库 / 页面大纲 / 事件链」开关各自的界面、「数据源 / 方法管理」执行宿主命令、「版本管理 / 设置」是禁用占位。左栏 248px（`:856`）与右栏 300px（`:863`）都是常驻 `aside`，左栏不再画标题，标题、页签与搜索由面板自己提供；页面大纲改走覆盖在画布上的浮层（`components/OverlayPanel.vue`）。插槽为空时用 `#empty` 具名插槽显示「暂无面板贡献」。

右栏的「页面配置 / 样式 / 事件 / 高级」四页是外壳固定的产品边界（`rightTabs`，不做动态注册），但每页内容都来自各自的插槽，外壳不内置任何一段表单；页签条支持方向键与 Home / End 循环导航（`onRightTabKeydown`）。样式 / 事件 / 高级三个槽的贡献者见 08 号文档 §3.5–3.7。

### 三个宿主组件

| 组件                 | 数据来源                                                                                                                                  | 关键点                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolbarStock.vue`   | `contribution.list('toolbar')` 过滤 `slot === 'designer.toolbar'`（`:29-33`）                                                             | 每个按钮读 `ctx.command.get(id)` 求 `enabled`（`:35-41`）——依赖契约对 `enabled()` 的「廉价纯函数」约束（`contracts/src/services/command.ts:20-26`）；点击 `void ctx.command.execute(id)`（`:45-47`）。**按钮不携带任何逻辑** |
| `StatusBar.vue`      | `canvas.viewport.state.zoom`、`selection.ids.length`、`document.model.dirty`（`:20-21`、`:56-69`）、`history.canUndo/canRedo`（`:71-78`） | setup 阶段同步订阅（`:26-35`，原因见上）；显示 `已同步/未保存`、`选中 N/未选中`、缩放百分比；**底部两个撤销/重做按钮用 `:disabled="!canUndo"` 表达可用性**（`:91-100`）——这是宿主里唯一直接操作历史的 UI 入口                |
| `CommandPalette.vue` | `ctx.command.list()` + `ctx.keybinding.keyFor(id)`（`:61-79`）                                                                            | 订阅 `palette:toggle` 做开/合（`:27`）；查询词小写匹配 `title` 或 `id`（`:66-72`）；`watch(items)` 变化时把 `activeIndex` 归 0（`:81-83`）；打开时 `nextTick` 聚焦输入框（`:21-23`）；执行前关闭面板（`:85-88`）             |

命令面板是**应用级**能力，所以它的命令注册在 `apps/host/src/bootstrap.ts:83-92` 而不是某个插件里；`Mod+K` 快捷键同样应用级。面板组件本身渲染在设计器视图的编辑器作用域内（`views/DesignerView.vue:129`），因为要用文档级服务。

### 演示文档

`apps/host/src/demo-document.ts:13-40+`：`createDemoSchema()` 返回 `version: SCHEMA_VERSION`、`nodeId: 'board'`、根 `Box` 820×540，`children: ['title','subtitle','cards','circle','badge','watermark','note']`。头注释说明它刻意包含**一个分组、一个锁定节点、一个隐藏节点**，并埋了深链 `board → cards → cardB → cardBList → 文本`，用来验证变换类手势作用在容器上时是否连带整棵子树。`apps/host/src/pages.ts` 把它和一份只含根容器的空白页组成页面列表，路由按 `documentId` 取用。

### 样式

- 设计令牌：`apps/host/src/styles/tokens.css:4-24` 共 **18 个 `--lc-*` 变量**（画布底色、surface、border、text、accent、danger、radius、guide、handle、grid line、shadow、font）。头注释即规则：「外壳与覆盖层只消费语义变量，不硬编码主题色」。令牌由宿主提供，远程画布只读变量——换一个宿主复用画布时必须自带同一套令牌。
- 布局样式：`apps/host/src/styles/app.css`（392 行）定义 `.lc-app*`、`.lc-app__nav*`、`.lc-designer*`、`.lc-pages*`、`.lc-toolbar*`、`.lc-status*` 等宿主类。
- **每个可复用组件都带 `<style scoped>`**：`CanvasStage.vue:290`、`LayerHost.vue:204`、`PluginBoundary.vue:46`、`Slot.vue:139`、`CommandPalette.vue:144`、`OutlinePanel.vue:335`、`PropertiesPanel.vue:353`。`ToolbarStock.vue`/`StatusBar.vue`/`App.vue` 无 style 块，走全局 `app.css`——它们本来就是宿主壳层。
- **画布覆盖层是 `.ts` 渲染函数，用内联 `style` 对象 + CSS 变量兜底**：例 `canvas-selection/src/overlay.ts:107-118` 的 `border: 1px solid var(--lc-accent, #2563eb)`、`canvas-grid/src/overlay.ts:58-60` 的 `var(--lc-grid-line, rgba(15,23,42,0.08))`。这样插件在没有宿主持色文件时仍能自洽显示。一处不一致：hover 描边硬编码 `rgba(37, 99, 235, 0.55)`（`canvas-selection/src/overlay.ts:95`）未走变量。
- 没有 `prefers-reduced-motion` / `prefers-color-scheme` 适配（两个样式文件里均无），深色模式与动效降级属于未做项。
