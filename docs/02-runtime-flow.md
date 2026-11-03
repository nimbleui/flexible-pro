# 02 运行链路

本文按「一次冷启动」和「几次典型交互」两条轴描述运行时，每一步都给出源码位置。

## 1. 全局形态

平台运行时只有三个上下文层，全部由内核 `Context` 树承载：

```text
AppContext（createApp 根，1 个）
├─ 应用级服务：loader / contribution / modules / material / command / renderer /
│              workspace / expression / setter / keybinding
└─ EditorRealm（每文档 1 个，ctx.fork() 得到独立 service scope）
   ├─ document → history → selection
   └─ CanvasRealm（每画布视图 1 个，再 fork 一次）
      ├─ canvas（画布微内核聚合服务）
      └─ 15 个画布能力插件实例（snap 额外提供 snap 服务）
```

三层各自持有什么、隔离什么，见 [04 插件内核](./04-plugin-kernel.md)。

## 2. 冷启动链路

### 2.1 入口

| #   | 位置                            | 动作                                                                                                                                                                                                                                                            |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/host/index.html:10`       | `<script type="module" src="/src/main.ts">`，挂载点 `#app`                                                                                                                                                                                                      |
| 2   | `apps/host/src/main.ts:10`      | `await bootstrapHost()` —— **Vue 应用在内核就绪之后才创建**                                                                                                                                                                                                     |
| 3   | `apps/host/src/bootstrap.ts:72` | `installContextServices()`：把 15 个服务名装成 `Context.prototype` 上的 getter（`packages/kernel/src/context.ts:617`）；declaration merging 只是类型，运行时靠这一步才让 `ctx.canvas` 取得到值                                                                  |
| 4   | `bootstrap.ts:74`               | `createApp({ id: 'host', grants: GRANTS })` → `packages/kernel/src/app.ts:26`：建根 `Context`、`PluginRuntime`，并逐条 `runtime.grant()`（GRANTS 表 `bootstrap.ts:28-40`，画布插件的授权由远程自签，见 [12](./12-module-federation.md#4-授权远程自签画布插件)） |
| 5   | `bootstrap.ts:76`               | `context.plugin(presetDesigner)` → `Context.plugin`（`context.ts:451`）→ `PluginRuntime.load`（`runtime.ts:109`）→ `schedule`（`:274`，微任务批）→ `activate`（`:302`）→ `definition.apply`（`:357`）                                                           |

### 2.2 preset-designer：安装应用级服务

`packages/presets/preset-designer/src/index.ts:22-37` 的 apply 依次 `ctx.plugin` 九个服务插件：

```text
modulesPlugin → loaderPlugin → materialPlugin → commandPlugin → expressionPlugin
→ setterPlugin → keybindingPlugin → rendererPlugin → workspacePlugin
```

书写顺序是「被依赖者先声明」，**真正的执行顺序由内核依赖检查决定**：`PluginRuntime.activate` 在 `runtime.ts:316` 检查 `inject.required`，缺失即置 `pending` 并在服务出现时由 `onServiceChange`（`:383`）重新调度。`inject` 声明见各服务包（如 `service-loader/src/index.ts:185` 的 `inject: ['modules']`）。

九个 apply 完成后，`bootstrap.ts:77` 调 `await context.runtime.whenIdle()`（`runtime.ts:172`，循环等待在途激活任务集清空）。至此 `loader` / `contribution` / `modules` 等一定可用——**不依赖任何外部延时**。注意 `whenIdle` 只等在途的激活任务，**不为停在 `pending` 的插件等待**：await 之后仍缺某个服务，说明该插件的 `inject` 声明没被满足，而不是时序不够。

### 2.3 登记宿主侧 4 个内置插件包

`bootstrap.ts:79-80`：`context.require<LoaderService>('loader')`，对 `BUILTIN_PACKAGES`（`bootstrap.ts:43-49`，每项是 `{ manifest, load: () => import('…') }`）逐个 `loader.register(pkg)`。宿主只登记物料与三个面板；15 个画布能力包由远程在 `apps/designer/src/canvas-plugins.ts:24-46` 登记，形状完全相同，只是 `load` 闭包落在远程自己的模块图里。

`service-loader/src/index.ts:256` 的 `register` 只做三件事，**不加载任何代码**：

1. `assertManifest`（`:128`）：要求 `name` / `version` / `engines.lowcode`；重复登记抛错（`:260`）。
2. 把 `manifest.contributes` 的每个点逐点写进贡献表（`:267-277`）——贡献点是有限的五个：`materials | panels | toolbar | canvasFeatures | canvasProfiles`（`packages/contracts/src/contribution.ts:57-68`）。
3. `collectModules(pkg)`（`:165`）把贡献声明的模块路径注册进 ModuleService，key 为 `${manifest.name}/${module}`（`:279-286`）——**这个拼法必须与 `moduleKey()`（`packages/contracts/src/services/modules.ts:34`）一致**，否则消费方取不到模块。

登记完，UI 入口就已经能渲染出来：面板标题、工具栏按钮、物料缩略信息全部来自纯数据贡献。

### 2.4 打开文档：EditorRealm

| #   | 位置                                | 动作                                                                                                                                                                            |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `views/DesignerView.vue:43-49`      | `workspace.getEditor(id) ?? createEditorRealm({ documentId, title, schema })`，文档来自 `apps/host/src/pages.ts`                                                                |
| 2   | `service-workspace/src/index.ts:74` | 同 `documentId` 已存在则抛错；`:78` `ctx.fork()` 得到 Realm 专属 service scope                                                                                                  |
| 3   | `:79`                               | `realmCtx.plugin(documentPlugin, {id, schema, title, mode})` → `service-document/src/index.ts:146` 提供 `document`                                                              |
| 4   | `:85`                               | `historyPlugin` → 提供 `history`（`:94`）。装配顺序固定 document → history → selection，因为 `service-history` 声明 `inject: ['document']`（`service-history/src/index.ts:26`） |
| 5   | `:86`                               | `selectionPlugin` → 提供 `selection`（`service-selection/src/index.ts:76`）                                                                                                     |
| 6   | `:145`                              | `active = realm`（最近创建者即当前编辑器）                                                                                                                                      |
| 7   | `:148`                              | `ctx.effect(() => ({ dispose: () => realm.dispose() }))`：workspace 插件停用时级联关闭文档                                                                                      |

Realm 创建后不立刻渲染：`views/DesignerView.vue:68-73` 先 `await appCtx.runtime.whenIdle()` 作就绪门，再渲染需要 `require('canvas')` 的子树。

### 2.5 建立画布：CanvasRealm + 15 个能力插件

| #   | 位置                                      | 动作                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `views/DesignerView.vue:52`               | `editor.createCanvasRealm()` → `service-workspace/src/index.ts:107`：`realmCtx.fork()` + `canvasCtx.plugin(canvasCorePlugin)`                                                                                                                                                            |
| 2   | `service-canvas-core/src/index.ts:52-126` | 组装画布内核的全部工厂：`createViewport({minZoom:0.1,maxZoom:4})`、`createScheduler`、`createSettingsService`、`createLayerService`、`createContextMenuService`、`createScene({getRootRect})`、`createHitTest`、`createMeasure`、`createInteractionPipeline`、`createTransactionService` |
| 3   | `:176-179`                                | 接入脏来源：`document.onDidChange → syncScene`、`viewport.onDidChange → scheduler.invalidateViewport`、`selection.onDidChange → scheduler.invalidateViewport`                                                                                                                            |
| 4   | `:233`                                    | `ctx.provide('canvas', service, { apiVersion: '1.0' })`                                                                                                                                                                                                                                  |
| 5   | `apps/designer/src/CanvasModule.vue:28`   | `canvas.context.plugin(presetCanvas)`——这一步已在远程侧执行，登记与自签授权见同目录 `canvas-plugins.ts:65-74`                                                                                                                                                                            |
| 6   | `presets/preset-canvas/src/index.ts:16`   | `inject: ['canvas','contribution','modules']`                                                                                                                                                                                                                                            |
| 7   | `:22-25`                                  | `contribution.list('canvasFeatures')` → 过滤 `defaultEnabled !== false` → 按 `order` 升序                                                                                                                                                                                                |
| 8   | `:29`                                     | `modules.load(moduleKey(feature.plugin, feature.value.module))`                                                                                                                                                                                                                          |
| 9   | `:41`                                     | `ctx.plugin(module.default, feature.value.config)`：每个 CanvasRealm 独立实例，配置来自 manifest 贡献（如 `canvas-snap` 的 `{ thresholdScreenPx: 6, gridSize: 8 }`）                                                                                                                     |

单个能力包加载失败不会中断装配：`:33` 与 `:43` 都只 `ctx.diagnostics.report(...)` 然后继续下一个。

15 个能力按 `order` 装配（来自各自 `src/manifest.ts`）：

```text
5 grid · 10 zoom · 11 pan · 20 selection · 30 snap · 40 drag · 50 resize · 55 rotate
60 guides · 65 rulers · 70 align · 80 drop/minimap · 90 commands · 95 contextMenu
```

`order` 决定注册先后，进而决定同 `phase` 同 `priority` 下的分发先到先得顺序（`packages/canvas/src/interaction/pipeline.ts:116` 的 `PHASE_ORDER`、`:263-270` 比较器里的 `priority` → `seq`）与覆盖层堆叠。

### 2.6 应用级命令与调试入口

- `bootstrap.ts:83-92`：注册 `app.commandPalette` 命令（run 内 `context.emit('palette:toggle')`）与 `Mod+K` 快捷键。命令面板是应用级 UI，所以命令也注册在应用级，快捷键只是入口。面板组件本身挂在设计器视图的编辑器作用域里（`views/DesignerView.vue:129`），因为要用文档级服务。
- `bootstrap.ts:97`：`import.meta.env.MODE !== 'production'` 时挂 `window.__lc = { context }`。拆分后 `editor` / `canvas` 不再是启动期单例，改从 `__lc.context.workspace.listEditors()` 与 `getEditor(id)` 取当前 Realm；`__lc.canvas` 由设计器视图写入当前活动画布（`views/DesignerView.vue:55`、卸载时清空）。
- `apps/designer/src/CanvasModule.vue:29` 最后一次 `whenIdle()`，画布能力装配收敛。

### 2.7 首帧渲染

| #   | 位置                      | 动作                                                                                                                                                          |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `main.ts:11-14`           | `createApp(App, { editorContext: editor.context, canvasContext: canvas.context })`：Realm 上下文以 props 注入，宿主不查询全局单例                             |
| 2   | `main.ts:15`              | `provideContext(app, context)` → `packages/vue/src/context.ts:14`，把根 Context 挂到 Vue provide                                                              |
| 3   | `main.ts:16`              | `app.mount('#app')`；`main.ts:19-27` catch 启动异常并把错误写进 `#app`，避免出现白屏                                                                          |
| 4   | `App.vue:23`              | `<ContextScope :context="editorContext">` 把作用域切到 EditorRealm                                                                                            |
| 5   | `App.vue:31`              | `<ToolbarStock>`：`contribution.list('toolbar')` 过滤 `designer.toolbar`（`components/ToolbarStock.vue:32`），按钮只声明命令 id，点击时 `ctx.command.execute` |
| 6   | `App.vue:40`              | `<LcSlot name="designer.leftPanel">` → `packages/vue/src/components/Slot.vue:61` `ctx.contribution.listSlot(name)`                                            |
| 7   | `Slot.vue:95`             | 对每个面板 `ctx.loader.ensureActivated('onPanel:' + panelId)`（`service-loader/src/index.ts:333`；注意 `onCanvasFeature:*` 在 `:335` 被显式跳过）             |
| 8   | `Slot.vue:98`             | `ctx.modules.load(moduleKey(plugin, module))` → `:105` `markRaw(module.default)` 缓存组件；`:106-108` 只重建到达的那一项，keyed `v-for` 因此不整槽重渲染      |
| 9   | `Slot.vue:121-133`        | `PluginBoundary` 包裹 `<component :is>`；未到达时渲染骨架，失败时渲染错误文案                                                                                 |
| 10  | `App.vue:47`              | `<CanvasStage :context="canvasContext">`                                                                                                                      |
| 11  | `CanvasStage.vue:76`      | `buildRenderTree({ schema, resolveValue })`（`packages/vue/src/render/tree.ts:50`）把 `PageSchema` 摊成渲染树                                                 |
| 12  | `CanvasStage.vue:157-169` | `syncComponents()`：对文档里出现的每个 `componentName` 调 `renderer.resolveMaterial(name)`，缓存 `markRaw` 组件；`loading` 集合做并发去重                     |
| 13  | `CanvasStage.vue:241`     | `onMounted` 里 `canvas.attach(element)`：注册舞台上唯一一套 DOM 监听并同步写入尺寸（见 `service-canvas-core` 的 ResizeObserver 路径）                         |
| 14  | `CanvasStage.vue:242`     | `canvas.scheduler.onFrame(refreshMatrix)`：`:153` 把 `viewport.matrix` 拼成 `matrix(a,b,c,d,e,f)` 写进内容层 transform                                        |
| 15  | `CanvasStage.vue:255`     | `centerRootAtCurrentZoom()`（定义在 `:163`）：首帧保持默认 100% 缩放，只把文档根矩形摆到视口中心；尺寸未测得时跳过，要看全貌用「适应画布」命令                |
| 16  | `CanvasStage.vue:258`     | `element.focus()`：键盘事件挂在舞台元素上                                                                                                                     |
| 17  | `App.vue:51`              | 右侧 `designer.rightPanel` 插槽（属性面板，`order:10`）                                                                                                       |
| 18  | `App.vue:59-60`           | `<StatusBar>` 读视口/选中/脏/历史；`<CommandPalette>` 订阅 `palette:toggle`（`components/CommandPalette.vue:27`）                                             |
| 19  | `LayerHost.vue:138-139`   | `syncLayers()` 对**已注册的全部图层**调用 `ensureLayer()` → `layer.load()`（`:112-117`），每帧 `refresh`（`:157` 订阅 `scheduler.onFrame`）                   |

## 3. 三条典型数据流

### 3.1 拖拽一个节点（一次手势 = 一条历史）

```text
pointerdown（舞台 DOM）
  → pipeline 归一化：screen→world 经 viewport.screenToWorld，命中经 hitTest（逆 paintOrder 扫描）
  → 按 capture → target → bubble 分发，同阶段按 priority 降序、再按注册序号（pipeline.ts:263-270）
  → canvas-drag（bubble / priority 50，刻意低于 canvas-selection 的 70，让选中集先更新）
      when: pointerdown && buttons === 1 && targetNodeId 非空      // canvas-drag/src/index.ts:90-91
      handle: 选中则整组拖，否则只拖命中节点（:96-98）
            → transformableIds 剔除锁定节点（:101）
            → collectSubtree 展开整棵子树（:105，否则容器移动后子级留在原地）
            → 记录起始 rect 快照（:109-114，逐帧相对起始值算，避免浮点累加漂移）
            → canvas.transaction.begin({ label: '移动节点', owner: 'canvas-drag' })（:128；已有活动事务则抛错）
            → canvas.interaction.beginGesture({ onMove, onFinish })（:139）

pointermove × N
  → 计算世界坐标位移
  → snap?.resolve(input)   // inject.optional ['snap']（:26）→ ctx.snap（:31）→ :166
                          // 候选来自 canvas-snap 注册的 snap.grid / snap.elements（canvas-snap/src/index.ts:61-70）
  → transaction.preview(patches)          // transaction.ts:96-101
      → document.apply(patches, { record: false })            // service-document/src/index.ts:102
      → applySchemaPatches 拷贝式生成新 schema（schema/src/patch.ts:160）
      → commitSchema 递增 version，不写历史，emit document:change（:67）
  → canvas-core.syncScene() 按 paintOrder 重注册几何（service-canvas-core/src/index.ts:141）
  → scheduler.invalidateViewport() → 下一帧
      → CanvasStage.refreshMatrix + LayerHost.refresh + 选择/预览覆盖层重算

pointerup / Esc / pointercancel
  → transaction.commit()  // transaction.ts:115-127
      → pending 非空：document.apply(去重后的 pending, { record: true, label, before: base })
          → history.record({ before, after })（service-history/src/index.ts:55）
      → pending 为空：document.restore(base)   // 只回退预览，不写历史
  → close(committed) → ctx.emit('canvas:gestureEnd', { owner, label, committed })（service-canvas-core/src/index.ts:125）
```

关键点：预览期间每帧都写文档，但 `preview` 以 `patch.path` 去重（`transaction.ts:96-99`）；提交时**不再先回退再重放**，而是把去重后的 pending 直接落在当前文档上，并以 `before: base` 写入历史。`:103-114` 的注释解释了原因：先 `restore(base)` 再重放会把手势期间别处的写入（属性面板改了同一节点的其它字段、拖入的新节点）整体抹掉，而且不产生任何错误。只有 pending 为空时才 `restore(base)` 纯回退。因此**中间态不进历史**，一次拖拽只产生一条撤销记录。抢不到事务的插件应放弃本次手势。

### 3.2 快捷键 → 命令 → 文档 → 历史

```text
window keydown（service-keybinding/src/index.ts:71-74）
  → 跳过可编辑目标（:8 的判断）
  → matchesKeybinding / normalizeEventKey（service-keybinding/src/keys.ts:26 / :55）
  → binding.when() 求值（:62）
  → ctx.command.execute(binding.command, binding.args)（:66）
      → service-command/src/index.ts:75：命令缺失 → 诊断；enabled()===false → 静默；run 抛错 → 捕获
      → 命令实现内 document.apply(patches, { record: true, label })
      → history.record(...)
  → document:change → canvas-core.syncScene → scheduler → 覆盖层与面板刷新
```

服务间只有这一条合法路径：**keybinding 只认识命令，不认识任何业务逻辑**。

撤销链路：`history.undo()`（`service-history/src/index.ts:66`）取 `undoStack` 顶 → `document.restore(schema)`（`service-document/src/index.ts:130`，递增 version、不写历史、保留 dirty 标记）→ 重新入 `redoStack`。历史栈存的是整份 schema 引用，靠「patch 写入一律拷贝」保证旧对象不被改动，因此无需深拷贝（`service-history/src/index.ts:7`）。

### 3.3 物料拖入画布

```text
物料面板 dragstart（plugin-panel-materials/src/index.ts:52）
  → dataTransfer.setData(toMaterialDragType(name), name)   // contracts/src/drag.ts:17：按码点转十六进制，大小写安全
CanvasStage dragover（packages/vue/src/components/CanvasStage.vue:197）
  → materialNameFromDragTypes(dataTransfer.types)（:178 → contracts/src/drag.ts:25）
  → dropPoint()：屏幕坐标 = client - stage rect，世界坐标 = viewport.screenToWorld（:181-187）
  → canvas.settings.set(CANVAS_DROP_PREVIEW_SETTING, { materialName, screen, world, containerId: hitTest.containerAt() })（:206）
      // 设置写入失败会被忽略（:192）：canvas-drop 未安装时只失去预览，不影响 drop
CanvasStage drop（:220）
  → context.bail('canvas:drop', payload)（:230）        // bail：第一个非 undefined 返回值者消费
  → canvas-drop 监听（packages/canvas-plugins/canvas-drop/src/index.ts:54）
      → material.get(payload.materialName)（:56，未注册物料记诊断并终止 :57-62）
      → cloneNode(entry.snippet)（:68）+ DEFAULT_DROP_WIDTH/HEIGHT 兜底（:71-72）
      → 生成 NodeSchema 与插入 patch → document.apply({ record: true })
```

`containerAt` 故意不看 `isSelectable`（`packages/canvas/src/hitTest.ts`），所以拖入预览的容器归属与选择行为解耦。

## 4. 两套通道：业务事件 vs 服务通知

| 通道                 | 定义                                                                           | 用途                             | 订阅方式                                                 |
| -------------------- | ------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------- |
| 类型化事件表         | `packages/contracts/src/events.ts:52-72`（declaration merging 扩展内核空接口） | 跨插件的**语义事件**，载荷有类型 | `ctx.on/emit/bail/waterfall`，监听自动挂到 `ctx.effects` |
| 内部总线             | `packages/kernel/src/internal.ts:34`（`service` / `plugin` / `error`）         | 驱动生命周期，插件拿不到         | 仅 `PluginRuntime` 构造时订阅（`runtime.ts:57`）         |
| 服务级 `onDidChange` | 各服务接口自带                                                                 | UI 与脏标记刷新的**主通道**      | 返回 `Disposable`                                        |

事件表与当前监听情况（实测）：

| 事件                                 | 触发方                                     | 仓库内监听方                                                                               |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `document:change`                    | `service-document/src/index.ts:67`         | 无 —— 对外通知面；内部刷新走 `document.onDidChange`                                        |
| `selection:change`                   | `service-selection/src/index.ts:33`        | 无 —— 同上，UI 走 `selection.onDidChange`（`LayerHost.vue:158`、`PropertiesPanel.vue:33`） |
| `canvas:gestureEnd`                  | `service-canvas-core/src/index.ts:125`     | 无 —— 预留给埋点/协作                                                                      |
| `canvas:drop`                        | `CanvasStage.vue:230`（bail）              | `canvas-drop/src/index.ts:56`                                                              |
| `plugin:activated` / `plugin:failed` | `service-loader/src/index.ts:237` / `:240` | 无                                                                                         |
| `palette:toggle`                     | `bootstrap.ts:86`、`App.vue:9`             | `CommandPalette.vue:27`                                                                    |

`EventBus` 提供 5 种发射模式：`emit`（同步、逐监听器错误隔离）、`parallel`、`serial`、`bail`（首个非 undefined 生效）、`waterfall`（前一个返回值作为下一个输入），排序规则 `prepend` 优先于 `priority`（`packages/kernel/src/events.ts:132-229`，比较器在 `:264`）。其中 **`waterfall` 是唯一不做错误隔离的模式**（`:213`）：任一监听器抛错会中断整条管线并让 Promise reject。另有一条只读观测通道：`EventBus.monitor`（`:126`，逐监听器产出事件名、分发模式、归属插件 id、耗时与错误；无监视器时热路径不取时间戳）与 `Diagnostics.onChange`（`context.ts:196`），二者都不参与生命周期决策，详见 [04 插件内核](./04-plugin-kernel.md) 的观测面一节。

## 5. 懒加载时机汇总

| 内容                            | 加载时机                                       | 触发点                                                                                                       |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 服务实现                        | 启动即加载                                     | `preset-designer` 静态 import 九个服务包                                                                     |
| 画布能力模块                    | CanvasRealm 建立后，按 `order` 逐个 `import()` | `preset-canvas/src/index.ts:29`                                                                              |
| 面板组件                        | 插槽渲染该面板时                               | `Slot.vue:95` + `:98`                                                                                        |
| 覆盖层组件                      | 图层注册/列表变化时全量加载（不延迟到可见）    | `LayerHost.vue:138-139` → `ensureLayer`（`:112`）                                                            |
| 物料组件                        | 文档里出现该 `componentName`                   | `CanvasStage.vue:157-169` → `renderer.resolveMaterial` → `service-material.ensure`（`:139`）→ `modules.load` |
| 纯声明式插件（materials-basic） | **永不激活 apply**                             | `service-loader/src/index.ts:221`：无 `main` 直接返回                                                        |

ModuleService 缓存的是 Promise，因此同 key 并发加载只 `import()` 一次（`service-modules/src/index.ts:53`）；失败不入缓存，可重试。

> **契约与实现的偏差**：`CanvasLayer.load` 的注释写的是「首次可见时加载」（`packages/contracts/src/canvas-contributions.ts:141`），但 `LayerHost` 现在对所有注册图层立即加载，`LayerHost.vue:136` 的注释明确接受这份代价——不可见图层同样占一份模块与一个组件实例，换来的是每帧 frame 更新的逻辑一致。按实现为准。

## 6. 卸载链路

关闭文档（`EditorRealm.dispose`，`service-workspace/src/index.ts:129`）：

```text
幂等检查 → 反向销毁全部 CanvasRealm（先摘列表再 dispose，避免重复回收）
        → realmCtx.dispose()
        → realms.delete(documentId)；active 置空；notify()
```

`Context.dispose()`（`packages/kernel/src/context.ts:518-529`）的固定次序：**先 `abort()` 掐断在途异步任务，再反向卸载 children 插件，最后回收本层 effects**。这个顺序是刻意的——若先 dispose 再 abort，`PluginRuntime.deactivate`（`runtime.ts:444`）里「先 abort 后 dispose」的路径会让回收被短路。`deactivate` 在回收前先置 `disposing`（`:447`），因为回收副作用会同步广播服务消失、`onServiceChange` 可能重入本方法。

服务消失的后果：`provide` 返回的 Disposable 释放时会把服务从 scope 删除并发内部 `service` 事件（`context.ts:355-361`）→ `onServiceChange` 把所有依赖它的插件（必需**和可选**都算）置回 `pending` 并回收（`runtime.ts:393-404`）。身份判定用 `record.parentCtx.get(name) === record.resolved.get(name)`（`:402`），且**不采信事件里带来的 owner**（`:380`），因此同名服务被其他 Realm 遮蔽不会引发无谓重启。

## 7. 失败路径

| 阶段                | 行为                                                                                                    | 位置                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 配置校验            | `resolveConfig` 抛错 → `fail(record, error, 'config')`；**不进 apply、不计 `attempts`、不写耗时**       | `runtime.ts:344-350`                  |
| apply               | 抛错 → 内部 `error` 事件 + `deactivate(..., 'failed')`，保留 `error` 与 `attempts`，失败同样留下耗时    | `runtime.ts:368-370`、`:420-433`      |
| apply 期间被中止    | 状态已不是 `applying`，或本轮 `abort` 已触发时，不写 `active`、直接丢弃结果                             | `runtime.ts:363`                      |
| 停在 pending/failed | **不自动重试**；由宿主或 devtools 显式调用 `runtime.retry(id)` 重新排程                                 | `runtime.ts:201-211`                  |
| 模块加载/定义名不符 | 诊断 + `plugin:failed`，**不向上抛**，其余插件继续                                                      | `service-loader/src/index.ts:226-240` |
| 画布能力缺失        | 诊断 `scope: 'preset-canvas'` 后 `continue`                                                             | `preset-canvas/src/index.ts:33-48`    |
| 交互处理器抛错      | `diagnostics.report(error, { scope:'interaction', handlerId })`                                         | `pipeline.ts:297-301`                 |
| 面板渲染崩溃        | `PluginBoundary` 只降级该面板                                                                           | `Slot.vue:121`                        |
| 诊断刷屏            | 记录上限 200 条，`console.error` 输出；**不参与生命周期决策**，插件无法伪造状态；订阅者抛错也被单独捕获 | `context.ts:146`、`:160-182`          |
