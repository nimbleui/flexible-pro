# 09 Vue 宿主与渲染

`@lc/vue`（10 个源文件）是**唯一持有 Vue 运行时的平台包**；`@lc/host`（apps/host）是产品外壳，`@lc/designer`（apps/designer）是只出画布的远程模块。分工遵循 `Core → Framework Adapter → Component` 的边界：内核与画布内核不含任何 `ref/computed/onMounted`。

## 1. `@lc/vue` 导出面

`packages/vue/src/index.ts:10-24`：

| 类别     | 导出                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------- |
| Context  | `LC_CONTEXT`、`LC_CONTEXT_KEY`、`provideContext`、`useAppContext`、`useService`、`useRegistryList` |
| 组件     | `LcSlot`、`ContextScope`、`PluginBoundary`、`CanvasStage`、`LayerHost`                             |
| 服务插件 | `rendererPlugin`（插件名 `service-renderer`）                                                      |

`package.json:19-21` 用 `peerDependencies` 声明 `vue ^3.5`，配合两个应用的 `resolve.dedupe: ['vue']`（`apps/host/vite.config.ts:34-37`、`apps/designer/vite.config.ts:31-33`）与 MF `shared.vue: { singleton: true, eager: true }` 保证 Vue 单例——多实例会直接击穿 `provide/inject`，并让远程组件的 vnode 在宿主应用里渲染失败。

## 2. Context 桥接

### `LC_CONTEXT` 与两级注入

`packages/vue/src/context.ts:17` 导出常量 `LC_CONTEXT_KEY = '@lc/context/v1'`，`:25-27` 由 `Symbol.for(LC_CONTEXT_KEY)` 生成 `LC_CONTEXT: InjectionKey<Context>`。必须是 `Symbol.for`：宿主与远程各打包一份 `@lc/vue`，`Symbol()` 产生的两个键互不相等，远程侧的画布覆盖层组件就注入不到上下文（详见 [12](./12-module-federation.md#3-画布能力如何跨边界进宿主内核)）。键名带命名空间与 `v1` 结构版本：同页第二个宿主 / 远程或第三方脚本不会占用同名键，结构不兼容时递增版本让新旧副本取到不同键，而不是静默拿到残缺的 Context。

`useAppContext()`（`:61-70`）另有一层轻量形状校验：`hasContextShape`（`:46-56`）只查 `get` / `provide` / `require` 三个方法，未注入或注入值形状不兼容时直接抛错并给出键名。目的是让宿主 v1 与远程 v2 结构不兼容、或第三方脚本往同名键里塞了无关对象时，错误在注入点就明确报出，而不是到 `ctx.get` 处变成无法定位的 `undefined` / `TypeError`。

- `provideContext(app, context)`（`:34-36`）**只在应用根调用一次**，注入的是 AppContext。
- `ContextScope.vue:6-16` 用**组件级 `provide`** 再注入一层。注释点明关键理由：「同一应用里可以按子树注入不同的 Realm，嵌套时子组件取到的是最近一层（画布作用域会再注入一次）」。

所以 `views/DesignerView.vue` 模板中的 `<ContextScope :context="editor.context">` 之下的面板调用 `useAppContext()`（`:61-70`，**未注入即抛错，不静默返回 undefined**）拿到的是 **EditorRealm 上下文**，于是 `ctx.get('document')` 才成立。这是多 Realm 支持的落地方式，而不是靠约定「只有一个编辑器」。

### `useService` / `useRegistryList`

- `useService(name)`（`:78-93`）返回 `Ref<Service | undefined>`：因为服务可能晚于组件出现（Realm 装载、晚绑定），所以用 `shallowRef` + `context.services.onDidChange` 只在 `changed === name` 时刷新（注释 `:84-85` 说明逐名订阅是为了避免累加无效监听），`onUnmounted` 自动解绑。
- `useRegistryList(getRegistry)`（`:101-132`）用 `watchEffect` 重新订阅（服务实例被替换时先释放旧订阅再挂新的，`:107-108`），返回的 `computed` 同时读 `version.value` 与 `registry.version`（`:124-130`）建立双重依赖。

**as-built 事实**：`useService` 目前**只有 `index.ts:10-17` 的再导出，仓库内没有任何消费者**，属于「已交付但未采用」的 API；`useRegistryList` **有 2 处消费者**（`apps/host/src/views/ComponentListView.vue:23`、`ComponentBlueprintView.vue:125`），删掉它会让宿主编译失败。其余现存组件走更朴素的版本计数桥（见下），见 [10 已知边界](./10-development-guide.md#9-已知边界与技术债)。

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
   - `await ctx.loader.ensureActivated` 在加载面板模块前先等插件行为激活完成（`:117`）——**先保证插件行为已激活**现在才真正成立：第一波把 `void ensureActivated` 改成 `await` 并移入既有 `try`，激活异常时 `finally` 也能回收 `loading`；纯声明式插件没有 `main`，直接返回。
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

外壳拆成三个文件：`apps/host/src/App.vue` 只放跨路由的壳（顶栏 + `RouterView`），`views/ProjectShellView.vue` 是项目外壳（面包屑 + 四个资产页签 + 项目不存在态），`views/DesignerView.vue` 放一个文档的设计器界面。下面两段里的行号只作定位辅助，结构以文件为准。

```text
apps/host/src/App.vue                                   外壳
└ .lc-app
  ├ header.lc-app__header                               顶栏三项：项目管理（实链）+ 插件市场 / AI 助手（占位）
  │   brand（低代码平台 / 企业版徽章）
  │   nav > RouterLink「项目管理」→ /projects；其余两项 aria-disabled
  │   button「搜索」→ appCtx.emit('palette:toggle')，通知与账户按钮尚未接入
  └ RouterView :key="route.path"                        换文档即整页重建

apps/host/src/views/ProjectShellView.vue                项目外壳
├ .lc-shell__bar                                        项目管理 / 项目名 + id + 说明 + 四个页签（带计数）
├ activeTab                                             剥掉项目前缀后比前缀，design/ 与 preview/ 归页面页签
└ RouterView                                            项目内的资产视图

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

设计器外壳（`DesignerView.vue`）有活动栏：56px 的 `.lc-rail`（`apps/host/src/styles/app.css:769`）排 7 个入口，其中「组件库 / 页面大纲 / 底部面板」开关各自的界面、「数据源 / 方法管理 / 版本管理」执行宿主命令（版本管理是 `version.openHistory`）、只有「设置」仍是禁用占位。`railItems`（`views/composables/use-designer-rail.ts` 的 `railItems`）里 `versions` 已带 `action: { kind: 'command', commandId: 'version.openHistory' }`（同文件 `versions` 项），**不再是禁用占位**；它由 [13](./13-version-control.md) 的 P4 落地，状态栏分支指示与版本面板同批接入。左栏 248px（`:856`）与右栏 300px（`:863`）都是常驻 `aside`，左栏不再画标题，标题、页签与搜索由面板自己提供；页面大纲改走覆盖在画布上的浮层（`components/OverlayPanel.vue`）。插槽为空时用 `#empty` 具名插槽显示「暂无面板贡献」。

右栏的「页面配置 / 样式 / 事件 / 高级」四页是外壳固定的产品边界（`rightTabs`，不做动态注册），但每页内容都来自各自的插槽，外壳不内置任何一段表单；页签条支持方向键与 Home / End 循环导航（`onRightTabKeydown`）。样式 / 事件 / 高级三个槽的贡献者见 08 号文档 §3.5–3.7。

### 三个宿主组件

| 组件                 | 数据来源                                                                                                                                  | 关键点                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolbarStock.vue`   | `contribution.list('toolbar')` 过滤 `slot === 'designer.toolbar'`（`:29-33`）                                                             | 每个按钮读 `ctx.command.get(id)` 求 `enabled`（`:35-41`）——依赖契约对 `enabled()` 的「廉价纯函数」约束（`contracts/src/services/command.ts:20-26`）；点击 `void ctx.command.execute(id)`（`:45-47`）。**按钮不携带任何逻辑** |
| `StatusBar.vue`      | `canvas.viewport.state.zoom`、`selection.ids.length`、`document.model.dirty`（`:20-21`、`:56-69`）、`history.canUndo/canRedo`（`:71-78`） | setup 阶段同步订阅（`:26-35`，原因见上）；显示 `已同步/未保存`、`选中 N/未选中`、缩放百分比；**底部两个撤销/重做按钮用 `:disabled="!canUndo"` 表达可用性**（`:91-100`）——这是宿主里唯一直接操作历史的 UI 入口                |
| `CommandPalette.vue` | `ctx.command.list()` + `ctx.keybinding.keyFor(id)`（`:61-79`）                                                                            | 订阅 `palette:toggle` 做开/合（`:27`）；查询词小写匹配 `title` 或 `id`（`:66-72`）；`watch(items)` 变化时把 `activeIndex` 归 0（`:81-83`）；打开时 `nextTick` 聚焦输入框（`:21-23`）；执行前关闭面板（`:85-88`）             |

命令面板是**应用级**能力，所以它的命令注册在 `apps/host/src/bootstrap.ts:83-92` 而不是某个插件里；`Mod+K` 快捷键同样应用级。面板组件本身渲染在设计器视图的编辑器作用域内（`views/DesignerView.vue` 模板中的 `<CommandPalette />`），因为要用文档级服务。

### 演示文档

`apps/host/src/demo-document.ts:13-40+`：`createDemoSchema()` 返回 `version: SCHEMA_VERSION`、`nodeId: 'board'`、根 `Box` 820×540，`children: ['title','subtitle','cards','circle','badge','watermark','note']`。头注释说明它刻意包含**一个分组、一个锁定节点、一个隐藏节点**，并埋了深链 `board → cards → cardB → cardBList → 文本`，用来验证变换类手势作用在容器上时是否连带整棵子树。

### 宿主侧存储与项目工作台

五份记录都还没有后端，一律落 localStorage；接服务端时只替换各自 store 文件里的 `readStorage` / `persist`，其余模块不动。

| 键                        | 模块                                     | 写入方                                                 |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `lc.projects.v1`          | `projects/project-store.ts`              | 项目管理页的建/改名/删                                 |
| `lc.pages.v1`             | `pages/page-store.ts`                    | 页面列表的新建/改名/删，以及设计器「保存」写回文档快照 |
| `lc.flows.v1`             | `workflows/flow-store.ts`                | 流程列表与流程编辑器（草稿、发布）                     |
| `lc.global-functions.v1`  | `functions/global-functions.ts`          | 函数管理页                                             |
| `lc.custom-components.v1` | `custom-components/custom-components.ts` | 组件列表与组件蓝图页                                   |
| `lc.apis.v1`              | `apis/api-store.ts`                      | 接口管理页的登记/修改/删除                             |
| `lc.api-scope.v1`         | `apis/api-config.ts`                     | 接口管理页的「请求配置」面板（多套环境的域名与默认头） |
| `lc.releases.v1`          | `projects/release-store.ts`              | 发布页的「发布新版本」与「切到此版本」                 |

**项目是五类资产的归属容器**：`projects/project-model.ts` 里 `ProjectDefinition` 只带展示字段，资产记录各带一个可选 `projectId` 外键，缺省即 `DEFAULT_PROJECT_ID`（唯一的解释点是 `resolveProjectId`）。项目记录不反向存资产 id——双向引用会在删资产后留下悬空指针，而「项目里有什么」永远能从资产侧过滤出来。项目卡片上的计数与删除拦截共用 `countProjectAssets` 一次过滤。

`PageRecord`（`pages/page-model.ts`）取代了改造前的 `apps/host/src/pages.ts` 常量数组：那份数组的条目带 `createSchema` 工厂函数，「新建页面」在刷新后必然消失，项目侧也就无从统计。首次装载时由 `pages/page-seed.ts` 按原 id 写入内置页面，之后它们与设计器保存出来的页面是同一种记录，可改名可删除。设计器保存走 `savePageSchema`：只替换文档，标题与归属各有唯一写入方，写回前做 JSON 往返拷贝，避免存储与画布内存里的 `model.schema` 共享引用。

**路由带项目段，读取端与写入端都按项目校验**。五类资产与发布/运行路径都挂在 `/projects/:projectId` 下面（`router.ts` 的 `projectChildren`，共 17 条子路由），`ProjectShellView` 提供面包屑与六个页签（页面/流程/函数/组件/接口/发布，前五个带计数），页签计数与卡片计数都走 `countAssetsOf` 的同一套过滤。旧路径 `/pages`、`/design/:documentId`、`/preview/:documentId` 等 11 条继续存在并回落默认项目——书签与写进文档动作里的跳转目标（示例文档的 `navigate` 动作写着 `/preview/event-doc`）都指向无前缀路径，而文档内容已经落盘。

作用域在两头各有一道：列表与编辑器用 `visibleInProject(record, projectId)` 把不属于本项目的记录当不存在；`savePageSchema(id, schema, projectId)` 再校验一次。后者不是重复——地址栏把 A 项目的文档挂到 B 项目的 URL 上时，画布显示的是空白回退文档，而「保存」写的是同一个 id，只过滤读取端正好漏在这条路上（实测：写回被拒、A 的记录 `updatedAt` 未变）。

**页面事件到流程图的绑定存在页面这一侧**：`connection.flowId` 一个字段就是全部真相，运行时按 id 向宿主图仓库要**已发布**版本（`workflows/flow-service.ts` → `flow-store.getPublishedFlowById`）。项目作用域仍然卡住——页面写下的 id 只是个字符串，把 B 项目的图粘到 A 项目的页面上照样存得下，所以查询带项目段，缺省即默认项目。

这里有一段历史值得留着：绑定原先写在图的触发节点上，用「文档 + 来源节点 + 事件名」三段键匹配，配套还有发布抢键闸门（`workflows/flow-conflicts.ts`，已删除）。那套设计有两个改不掉的毛病——节点 id 只在页面内唯一，少一段就会让一张图跑到别人的同名节点上；而「图上写着绑 A 页、页面里也写着绑 B 页」这种两处真相一旦出现，运行时听谁的没有任何界面说得出。改成页面持有之后，三段键、占位段 `NON_PAGE_TRIGGER`、抢键闸门一起退役，「一个事件绑两张图」也从结构上不可能了。

### 接口管理与页面引用

**接口是第五类资产，归属项目而不是归属文档**。`apis/` 各司其职：`api-model.ts` 是接口记录的纯逻辑（输入归一化、读档收窄、按 `group` 分组），`api-store.ts` 持 `lc.apis.v1` 与增删改（`findApiReferences` 反查页面文档里的 `schema.apis`，`removeApi` 对仍被引用的接口直接拒绝，与 `removeProject` 同一取舍），`api-config-model.ts` + `api-config.ts` 持请求环境与 `lc.api-scope.v1`，`api-request.ts` 是调试台的请求执行，`api-load.ts` 是文档装载侧的唯一入口。视图是 `views/ApiListView.vue`（顶部嵌 `components/api/ApiRequestConfigPanel.vue`）与 `views/ApiEditorView.vue`（请求定义 / 响应与类型 / 调试三页签）。

**请求环境（域名、默认头、默认参数、凭据策略）存在接口侧而不是 `ProjectDefinition` 上**：给项目加一个只有取数读得懂的字段，会让「项目」变成杂物抽屉。一个项目可以并存「本地 / 测试 / 生产」多套，同一时刻只有一套生效；切环境只改这一处，所有相对路径与没写同名头的请求都跟着变——这正是「域名配在页面里」变成 N 处副本的反面。

**两条边界是刻意的**：其一，环境值合并发生在**发请求前一刻**（`@lc/schema` 的 `mergeRequestDefaults`，被运行时取数与调试台共用），不进文档 schema，所以切环境不产生一次可撤销的编辑，token 也不会跟着文档导出、复制或进页面记录；其二，同名值**局部优先**——全局是兜底而不是覆盖，需要强制统一注入时就不该在接口里写这一项。配置面板里 `Authorization` 一类敏感头的值按密码框渲染（可勾「显示敏感值」），但存储仍是浏览器明文：这是没有后端的必然结果；内核保留名单里没有 `secrets` 服务（P1 已清除无提供者的保留名），凭据托管要等服务端能力落地时随真实提供者一并登记。切换「编辑目标」与「设为当前」是两个动作，只有后者会调 `pushRequestDefaults` 把新值推给**本项目**已打开的 Realm 并触发重新取数——`listEditors()` 里可能挂着别的项目的 Realm，把 A 的 token 推给 B 是那种一发现就说明作用域错了的 bug。

**调试台用的是表单上当前的草稿而不是已保存的定义**，`apis/api-request.ts` 为此把入参收成 `ApiRequestFields`（`ProjectApi` 的请求侧子集，定义在 `@lc/schema`），不必为一次调试伪造 id 与时间戳；配置映射与默认值合并完全复用 `apiToRestConfig` + `mergeRequestDefaults`，所以「调试通、放进页面就挂」不会是两套规则造成的。剩下的差别只有两处刻意的：本模块自带一份 fetch 调用而不是 import `@lc/service-datasource` 的 `fetchRest`（宿主没声明那个依赖，语义漂移以运行时为准），以及结果不抛异常——状态码、响应头、耗时与失败原因要一起显示。响应可以一键写回 `sample` 与 `resultType`（`typeNodeFromSample`），这是接口管理相对「在页面里手抄一份数据源」的实际增量。

**凭据（token）走「登录接口 + 401 重取一次」**：环境里可以选一条**项目已登记的接口**当登录来源，并写明 token 在响应里的点路径（`data.accessToken`，与数据源 `PathTransform.path` 同一套写法）。发业务请求前先取票（`withAuthHeader` 注入 `Authorization: Bearer …`，可改头名与值模板），命中 401 就丢掉缓存重取一次并重发——**只重发一次**，否则凭据始终无效的请求会在两端之间无限打转。三处刻意的设计：token 缓存在模块级并按**合并后的登录地址**作键，所以换环境自然换票、并发请求只登录一次；登录接口本身不带凭据，杜绝递归；环境改动、切换或删除时 `dropTokens()`，避免继续送出上一个环境的凭据。实现落在宿主的 `apis/api-request.ts`，并通过 `http` 服务名对外提供（这个名字在 `RESERVED_SERVICES` 里早已占位，宿主提供也要走 GRANTS 授权）：`@lc/service-datasource` 拿到 `http` 就用它发请求，没有就退回本包的 `fetchRest`——于是运行时取数与接口调试台共用同一份凭据逻辑，不存在「调试通、页面 401」。实测：以 `/package.json` 当登录接口（`tokenPath: name`），绑定后的数据源发出两次请求，第一次不带凭据、第二次带 `Bearer @lc/host` 并成功；随后在调试台点「发送」只发了一次业务请求，说明凭据缓存是共用的。

**登录接口是按当前定义拷一份副本进环境**（`apiRequestFieldsOf`），不是运行时按 id 回查接口表：快照与 Realm 不该依赖可能被改过的表，也不该有跨项目读表的能力。代价是改了登录接口的路径之后，环境要重新保存一次——面板会把副本路径显示出来。

**页面存引用，不存副本**：`PageSchema.apis?: PageApiBinding[]` 只记 `{ id: 绑定名, apiId }`，地址/方法/头/参数/样本/类型都在项目定义那一侧。展开与剥离是一对纯函数（`@lc/schema` 的 `applyApiBindings` / `stripApiBindings`，判据同为「id 出现在 `apis` 里就归绑定所有」）：

| 端   | 位置                                                       | 作用                                                         |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| 装载 | `apis/api-load.ts` → `DesignerView.vue`、`PreviewView.vue` | 进 Realm 前把绑定展开成 `datasources` 里的完整条目           |
| 写回 | `pages/page-store.ts` 的 `savePageSchema`                  | 落盘前剥离展开结果，否则引用退化成副本、改定义对这个页面无效 |

因此 `@lc/service-datasource` 取数、`buildPageSymbols` 补全、`PageRuntime` 渲染与「数据绑定」面板都不用知道项目接口存在，运行也不需要新增跨作用域服务。绑定与解绑由 `components/page-data/utils/api-binding.ts` 的 `bindingPatches` 一次打两条补丁（`/apis` 与 `/datasources`），所以点完「引用项目接口」画布立刻能取数；绑定名走 `validateDataName` 与 `suggestBindingName`（取路径最后一个真实段转驼峰），与变量、页面自有数据源共用同一张占用表。

### 发布、快照与运行态

**一次发布 = 汇总校验 + 不可变快照 + 移动指针**，三段分别在不同文件里，边界是刻意的：

| 段   | 位置                        | 内容                                                                                                                                                                                                                            |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 校验 | `projects/release-model.ts` | `validateProjectRelease`：没有页面 / 页面引用的项目接口已不存在 / 页面文档有阻断问题 / 页面事件绑了不存在的图 → error；已发布图当前内容仍有阻断 → error；草稿流程、页面事件绑了草稿图 → warning                                 |
| 快照 | `projects/release-store.ts` | `publishProject` 把 `collectProjectAssets` 的结果 JSON 深拷贝成 `ProjectRelease`，写进 `lc.releases.v1`；引用在此展开成完整配置，**当时生效的那套请求环境整体记进 `assets.environment`**，线上版本不跟着后来改的域名或 token 漂 |
| 指针 | `projects/project-store.ts` | `setPublishedRevision` 是 `publishedRevision` 的唯一写入方；回滚只调它                                                                                                                                                          |

- **回滚只动指针，不写回资产记录**。工作区里未发布的草稿被一次回滚盖掉是数据丢失，而「线上跑哪个版本」本来就该是随时能拨回去的开关。
- **快照写入前做 JSON 深拷贝**（`cloneAssets`）。各资产 store 都是整对象替换，理论上不会原地改旧对象，但快照声明的是不可变，不能依赖上游自觉：一次别名共享会让「运行 v1 的内容」跟着草稿一起变，而界面上毫无痕迹。实测过这条路径：改了草稿的标题并保存，`v1` 快照里仍是旧文本。
- **每项目保留最近 5 份**（`RELEASE_RETENTION`）。快照装整份资产内容，全留会让 localStorage 随发布次数线性膨胀。剪枝只删最旧的，所以现存最大号永远等于历史最高号。
- **`nextRevision` 必须同时看现存快照与指针**：只看指针时，线上切回 v1 后再发布会算出 v2，而 v2 那份快照还在表里，同号两份内容，运行页取到哪份取决于遍历顺序。这条是浏览器实测里真踩到的，回归用例见 `tests/release-model.spec.ts` 的「回滚后再发布不跟已有快照撞号」。
- **运行页与预览页是两条不同的路**：预览（`/preview/:documentId`）复用设计器打开的那个 Realm，所以能看到没保存的草稿；运行页（`/run/:documentId`）读 `currentReleaseOf(projectId)` 指向的快照，并且 Realm key 带版本号（`demo-doc@r7`）——同 key 会让 `workspace` 复用设计器那份草稿 Realm，于是「运行 v7」显示的是从没发布过的内容。合成 key 只用于 Realm 索引，文档模型 id 在全仓没有其他消费者。请求默认值也按这条分工走：预览拿**当前**环境，运行页拿**快照里记下的**那套（实测：把项目环境切到一个不存在的域名前缀，预览立即报 `响应不是合法 JSON（GET /__nope/package.json）`，运行页仍然正常返回数据）。
- 两者的渲染生命周期共用 `pages/use-page-runtime.ts`（建/复用 Realm、就绪门、页面函数注册与注销、`$route` 作用域），差别只在 `preferExisting`：为 `false` 时 Realm 是自己新建的，卸载即回收，避免版本×页面的 Realm 只增不减。
- 发布页的按钮禁用依据是 `checkProjectRelease`（纯读，不写任何东西），问题清单在同一页展开为「N 处阻断 · M 条提示」；页面列表每行的「运行」按线上快照存在与否决定可用，不就在快照里的页面直接禁用并解释原因，而不是跳进一张空白运行页。

### 样式

- 设计令牌：`apps/host/src/styles/tokens.css:4-24` 共 **18 个 `--lc-*` 变量**（画布底色、surface、border、text、accent、danger、radius、guide、handle、grid line、shadow、font）。头注释即规则：「外壳与覆盖层只消费语义变量，不硬编码主题色」。令牌由宿主提供，远程画布只读变量——换一个宿主复用画布时必须自带同一套令牌。
- 布局样式：`apps/host/src/styles/app.css`（392 行）定义 `.lc-app*`、`.lc-app__nav*`、`.lc-designer*`、`.lc-pages*`、`.lc-toolbar*`、`.lc-status*` 等宿主类。
- **每个可复用组件都带 `<style scoped>`**：`CanvasStage.vue:290`、`LayerHost.vue:204`、`PluginBoundary.vue:46`、`Slot.vue:139`、`CommandPalette.vue:144`、`OutlinePanel.vue:335`、`PropertiesPanel.vue:353`。`ToolbarStock.vue`/`StatusBar.vue`/`App.vue` 无 style 块，走全局 `app.css`——它们本来就是宿主壳层。
- **画布覆盖层是 `.ts` 渲染函数，用内联 `style` 对象 + CSS 变量兜底**：例 `canvas-selection/src/overlay.ts:107-118` 的 `border: 1px solid var(--lc-accent, #2563eb)`、`canvas-grid/src/overlay.ts:58-60` 的 `var(--lc-grid-line, rgba(15,23,42,0.08))`。这样插件在没有宿主持色文件时仍能自洽显示。一处不一致：hover 描边硬编码 `rgba(37, 99, 235, 0.55)`（`canvas-selection/src/overlay.ts:95`）未走变量。
- 没有 `prefers-reduced-motion` / `prefers-color-scheme` 适配（两个样式文件里均无），深色模式与动效降级属于未做项。
