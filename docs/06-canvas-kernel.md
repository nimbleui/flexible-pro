# 06 画布微内核 `@lc/canvas`

12 个源文件的纯算法层。三条自我约束写在代码注释里，决定了这一层的形状：

1. **几何来源是 `layout.rect`，不读 DOM**：「绝对定位画布不需要读 DOM，手势期间也不会触发布局回流」（`packages/canvas/src/scene.ts:17-23`）。
2. **不认识任何具体能力**：引擎不区分候选来源，「网格只吸附不画线」这类语义由 provider 声明（`packages/canvas/src/snap/engine.ts:50-58`）。
3. **不持有选中态**：`CanvasService.selection` 是上层 `SelectionService` 的同一实例（`packages/contracts/src/services/canvas.ts:231-232`），交互由 `canvas-selection` 插件完成（`contracts/src/services/selection.ts:3-8`）。

## 1. 模块清单

| 文件                                | 导出                                                                                                                                             | 职责                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `viewport.ts`                       | `createViewport`、`computeMatrix`（私有）                                                                                                        | 视口状态、坐标换算、矩阵                    |
| `scene.ts`                          | `createScene`                                                                                                                                    | 节点几何索引 + 绘制顺序                     |
| `hitTest.ts`                        | `createHitTest`、`createMeasure`                                                                                                                 | 点选 / 框选 / 容器投递命中；并集测量        |
| `interaction/pipeline.ts`（704 行） | `createInteractionPipeline`                                                                                                                      | 唯一的 DOM 监听入口 + 分阶段分发 + 手势接管 |
| `layers.ts`                         | `createLayerService`                                                                                                                             | 覆盖层注册表与 `band → zIndex → seq` 排序   |
| `menu.ts`                           | `createContextMenuService`                                                                                                                       | 右键菜单项注册表                            |
| `settings.ts`                       | `createSettingsService`                                                                                                                          | 画布设置总线（单层内存）                    |
| `scheduler.ts`                      | `createScheduler`                                                                                                                                | rAF 合帧调度 + 无头/后台兜底                |
| `transaction.ts`                    | `createTransactionService`                                                                                                                       | 手势事务（预览 / 提交 / 取消）              |
| `snap/engine.ts`                    | `createSnapService`                                                                                                                              | 吸附解析引擎 + provider 注册                |
| `geometry.ts`                       | `IDENTITY`、`applyMatrix`、`multiplyMatrix`、`invertMatrix`、`rectContainsPoint`、`rectIntersects`、`normalizeRect`、`unionRects`、`rotatePoint` | 无状态几何                                  |
| `index.ts`                          | 全量 barrel（`:8-30`）                                                                                                                           | 只导出工厂函数与类型，无 class              |

## 2. 视口与坐标模型

### 变换顺序是硬约束

`viewport.ts:45-51` 的注释直接写成规则：

```text
screen = S(zoom) · R(rotation) · (world − origin)
```

先平移到原点、再旋转、最后缩放。**所有插件只能通过该服务换算坐标，不得自行拼接矩阵**，否则旋转视口后手柄/吸附会出现系统性偏移。

`ViewportState = { x, y, zoom, rotation }`（`contracts/src/services/canvas.ts:32-44`），其中 `x/y` 是**屏幕左上角对应的世界坐标**（不是画面位移量），`rotation` 为弧度且不限取值范围。

### 单一写入口 `commit`

`viewport.ts:66-90`：所有写入（`set` / `zoomAt` / `panBy` / `fit` / `setSize`）都经 `commit`，它做三件事——夹紧 zoom 到 `[minZoom, maxZoom]`（默认 `0.1`~`4`，`:41-43`）、按需重算矩阵、按需通知监听。越界值**静默夹紧不抛错**（`:8-20` 的选项注释）。`changed` 判定包含尺寸变化，因此传入越界 zoom 但实际未变时不会触发额外的覆盖层刷新。

`state` 每次都被替换为新对象，所以 `viewport.state` 的引用可作为「一帧快照」传给覆盖层（`LayerHost.vue:63-69`）。

### 换算用闭式公式，不复用矩阵

`screenToWorld`（`:122-129`）与 `worldToScreen`（`:131-140`）各自展开三角函数，注释给出理由（`:120-121`）：单点换算不必构造矩阵，`pointermove` 高频路径上避免每次分配新元组。

代价是**同一套变换有两个实现**：`computeMatrix`（`:252-264`）返回与 CSS `matrix(a,b,c,d,e,f)` 逐项对应的六元组，注释强调「推导必须与 `worldToScreen` 的闭式公式逐项对应；两者不一致时画面与坐标换算会分裂成两套结果」。`packages/canvas/tests/coordinates.spec.ts` 就是钉住这一致性的。

### 三个操作的语义细节

| 操作                      | 位置       | 关键语义                                                                                                                                                              |
| ------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zoomAt(screen, factor)`  | `:142-165` | `factor` 是**倍率**而非目标值，连续滚轮可复合；夹紧后 zoom 未变则直接返回，`origin` 不重算，避免已到上下限时画面仍漂移；保持指针下的世界坐标不动                      |
| `panBy(delta)`            | `:167-182` | `delta` 恒为**屏幕像素**；先逆旋转再除 zoom，并整体取负（画面移动方向与 origin 移动相反）。传世界坐标会双重缩放                                                       |
| `fit(rect, padding = 40)` | `:184-225` | 可用宽高不足 1 时按 1 算，避免极窄视口除零；矩形按未旋转的轴计算，**视口旋转时只保证中心对齐，不保证视觉完整包含**；尺寸为 0 时静默返回（所以 `attach` 必须先写尺寸） |
| `center`                  | `:115-118` | 尺寸未测得时结果就是 `origin` 自身，宿主不应据此 fit                                                                                                                  |
| `setSize`                 | `:231-234` | 负值夹到 0，与「尚未测量」保持同一种表达                                                                                                                              |
| `onDidChange`             | `:236-240` | `listeners` 是 Set：同一函数重复注册只留一份，任一 Disposable 释放即全部失效                                                                                          |

## 3. 场景图：登记顺序即层级

`scene.ts:24-102`。两个结构：`entries: Map<string, { rect }>` 与 `order: string[]`。

- `register(nodeId, rect)`：浅拷贝保存 rect（`:44`），**首次登记才追加到 order，重复登记只替换几何不改变层级**（`:46`）——这正是 `syncScene` 每轮全量重登记也不打乱绘制序的前提。返回的 Disposable 比对 entry 引用（`:53`），重挂载时迟到的 dispose 不会误删新几何。
- `getBounds(nodeId)`：**返回场景内部持有的矩形对象**，调用方要改必须先复制（`:63`）。
- `getBoundsOf(ids)`：未登记 id 被过滤，全部未登记时返回 `undefined` 而不是零尺寸矩形（`:67-73`）。
- `invalidate()`：注释坦承「几何由 register 提供，没有独立测量缓存；这里只广播变化。**契约上的 nodeIds 参数在骨架阶段不生效：无法只失效部分节点**」（`:85-89`）。
- `list()`：**直接暴露内部登记数组**以避免每帧复制，调用方不得 push/splice/sort（`:92-94`）。
- `getRootBounds/getRootSize`：每次实时调用 `options.getRootRect()`，结果不缓存（`:7-15`），因此宿主改完文档尺寸不需要再 invalidate。

命中测试的层级由此而来：**叠放由登记顺序决定，与 rect 面积无关**（`hitTest.ts:50-55`）。

## 4. 命中测试

三个入口，各自的过滤策略不同（`hitTest.ts:46-118`）：

| 方法                  | 过滤           | 说明                                                                                                                                                                        |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `at(screen)`          | `isSelectable` | 逆序扫描 `scene.list()`；`filter` 在读几何**之前**执行，让容器筛选少算一批包围盒（`:53`）。覆盖层不进场景登记，因此天然不参与命中（`:69`）                                  |
| `inRect(screenRect)`  | `isSelectable` | **四角投影取 AABB**（`:75-99`），因为视口旋转时只取两个角会漏选；返回值保持登记顺序（底→顶），不按距离或面积排序                                                            |
| `containerAt(screen)` | `isContainer`  | **故意不受 `isSelectable` 影响**（`:26-32` 注释）：否则锁定容器会变成不可投递的黑洞。非容器节点被跳过并继续向下查找，所以覆盖在容器上的子节点不会挡住拖入判定（`:112-113`） |

已知精度限制（`:40-45`）：节点 AABB 来自 `layout.rect`，**不做旋转精确命中**，旋转节点返回其 AABB 粗命中，最终局部命中留给后续版本。

`createMeasure(scene)`（`:124+`）只提供一个能力：对一组 id 求并集矩形，供对齐/分布与小地图使用。

## 5. 交互管线

### 5.1 一套真实监听

`interaction.attach(element)`（`pipeline.ts:428`、`:652-662`）在舞台元素上注册全部监听：

```text
pointerdown · pointermove · pointerup · pointercancel · pointerleave
wheel { passive: false }
keydown · keyup · contextmenu · dblclick
window resize（仅刷新 stageRect 缓存）
```

`pointerdown` 时会 `setPointerCapture`（`:442`）。解绑时**先摘全部监听再收尾手势**，避免 `onFinish` 里仍收到新的 pointermove（`:665` 注释）。

这意味着整块画布只有一组 DOM 监听器，15 个能力插件全部是逻辑处理器——这是「画布能力即插件」能够成立的技术前提。

### 5.2 事件对象

`CanvasPointerEvent` 由 `createPointerEvent` 组装（`:196-226`），字段见 `PointerInit`（`:85-113`）：`type / phase / modifiers / screen / world / delta / buttons / pointerId / targetNodeId / targetHandleId / originalEvent / preventDefault / stopPropagation`。

三个容易踩的实现细节：

- `phase` 注册时占位 `'bubble'`，由 `dispatch` 在**每个阶段覆写同一个对象**（`:201-202`）：处理器读到的是当前阶段，但事件引用全程唯一，`stoppedEvents` 与原生事件才能对得上。
- `stopPropagation` 除了调原生方法，还把事件记入 `WeakSet stoppedEvents`（`:220-223`）——原生停止传播拦不住同一元素上由管线自己逐个调用的处理器。
- `screen` 是**舞台本地坐标**（已减 stage rect），不是 `clientX/clientY`；`delta` 相对上一次指针事件，首个事件与合成事件均为 0；键盘与非指针事件的 `pointerId` 传 `-1`。

`resolveTarget`（`:315-321`）：先 `closest('[data-handle-id]')` 取手柄 id；**命中手柄时 `targetNodeId` 为 `undefined`**，两者互斥。

### 5.3 分发

`sortedHandlers()`（`:255-269`）：`PHASE_ORDER.indexOf(phase)` → `priority` 降序 → 注册 `seq`。每次调用重新排序并返回副本（处理器数量有限，注册/注销不承担插入成本）；**分发按阶段各取一次快照**，因此处理器在自身回调里注销别人只影响后续阶段。

`dispatch`（`:281-...`）：

```text
for phase of ['capture','target','bubble']:
    if phase === 'target' && (!isPointerEvent(e) || !e.targetHandleId) continue
    for handler of sortedHandlers() where handler.phase === phase:
        e.phase = phase                       # 覆写同一个事件对象
        if handler.when && !handler.when(e, ctx): continue
        result = handler.handle(e, ctx)
        result === 'stop'                      → return true（已消费）
        result === 'handled'                   → return true
        stoppedEvents.has(e)                   → return true（处理器调了 stopPropagation）
        抛错 → diagnostics.report(error, { scope:'interaction', handlerId })（:298）后继续下一个
return false   # 无人消费
```

`InteractionResult = 'pass' | 'handled' | 'stop' | void`（`contracts/src/canvas-contributions.ts:97`）。`handled` 的语义是「本处理器接管，手势后续由 `beginGesture` 自己承接」，与 `stop` 一样终止本轮分发（`pipeline.ts:295-297`）；区别只在意图表达，管线行为相同。

### 5.4 手势接管

`beginGesture(callbacks)`（`:407-416`）：**同一时刻只允许一个手势，已有则抛 `[canvas] 已存在活动手势`**。返回的 Disposable 比对回调引用——手势已被 pointerup 结束时，迟到的 dispose 不再回调一次 `onFinish`。

`finishGesture(commit)`（`:330-339`）：**先把 `gesture` 置空再回调**，因为 `onFinish` 里常常紧接着 `beginGesture`，否则会被旧手势以「已存在活动手势」挡掉。无手势时是空操作，所以 pointerup、Escape、pointercancel 与卸载都无条件调用。`onMove`/`onFinish` 抛错分别记为 `scope: 'gesture'`（`:337`、`:490`）。

两条内建规则：

- `Escape` 是**管线级保留键**：有手势时优先取消并吞掉事件，处理器收不到这次按键（`:601-606`）。
- `click` 由管线合成：仅当 `pointerdown` 与 `pointerup` 位移 ≤ `DEFAULT_DRAG_THRESHOLD = 3`（`:57`、`:522-528`），**拖拽结束不再补 click**。

## 6. 覆盖层

`layers.ts`：`BAND_ORDER`（`:10-19`）把八个 band 映射为 0~7 权重，注释警告「必须覆盖 `LayerBand` 全部成员：漏一项会在比较时取到 undefined，使 sort 得到 NaN 而退化成不稳定的图层顺序。新增 band 时两处要同时改」。

- `register(layer)`：**id 冲突抛错**（`:65-68`）——两个插件用同一 id 会让先注册的一方永远无法被替换或清理。
- `list()`：每次重新排序返回新数组（`band → zIndex ?? 0 → seq`），图层数量小，不做增量维护。
- 契约侧的约束（`contracts/src/canvas-contributions.ts:126-143`）：覆盖层在**屏幕空间**渲染，通过 `frame.viewport` 投影，不要套 `scale(zoom)`；`visible(frame)` 是每帧调用的廉价纯函数；`pointerEvents` 三态 `none`（整层穿透）/ `children`（容器穿透、子元素可命中）/ `auto`（整层命中）。
- 宿主实现给出的限制（`packages/vue/src/components/LayerHost.vue:88-103`）：每层 `position:absolute; inset:0`，`zIndex = (index+1)*10 + (layer.zIndex ?? 0)`，因此 **`zIndex` ≥ 10 会与下一层撞到同一 z**，只适合做同 band 内微调。

15 个能力里有 **10 个各注册 1 个覆盖层**（`layers.register` 调用点各 1 处；`align`、`commands`、`pan`、`snap` 不注册图层）。band 分布实测：

| band         | 图层                                                    | zIndex                                                                                    |
| ------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `background` | grid（CSS 渐变实现，不用 svg）                          | —                                                                                         |
| `selection`  | canvas-selection（框选与选中框）                        | —                                                                                         |
| `guides`     | canvas-guides（吸附辅助线，svg）                        | —                                                                                         |
| `handles`    | canvas-resize（8 手柄）、canvas-rotate（旋转手柄，svg） | —                                                                                         |
| `preview`    | canvas-drag（拖拽徽标）、canvas-drop（落点预览）        | —                                                                                         |
| `hud`        | canvas-rulers / canvas-minimap / canvas-context-menu    | 1 / 5 / 9（`minimap` 与 `context-menu` 的注释都强调 hud 内部次序与 `zIndex < 10` 的限制） |

## 7. 设置总线

`settings.ts:4-9` 注释给出生产环境的合并顺序：**平台默认 → 租户锁定 → 工作区 → 用户 → 文档**，当前只保留注册与当前值，`scope` 字段是为后续接入持久化与策略锁定预留的。

| 方法                  | 行为                                                                                                                                                                    | 位置     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `register(setting)`   | 写入 `default`；**同 id 重复注册抛错**，避免两个插件互相覆盖同名设置                                                                                                    | `:25-41` |
| `get(id)`             | 未注册返回 `undefined`；**不做 schema 校验**，`T` 由调用方保证与注册时一致                                                                                              | `:43-50` |
| `set(id, value)`      | **未注册 id 抛错**（视为装配错误，防止把拼错的 key 写成永远读不到的孤儿状态）；相同值也照常通知，不做相等性判断；当前不校验 `setting.schema`、不检查 `scope`/`lockable` | `:52-68` |
| `onDidChange(id, cb)` | id 未注册不报错，只是永远收不到通知；按 id 分桶，快照后回调                                                                                                             | `:70-81` |

设置总线是插件间解耦通信的主要通道，现有用法：`canvas-drop` 的落点预览（`CANVAS_DROP_PREVIEW_SETTING`）、`canvas-selection` 的 hover/框选态、`canvas-rulers` 的用户参考线与草稿、`canvas-context-menu` 的开合状态（`CANVAS_CONTEXT_MENU_STATE`）、`canvas-drag` 的拖拽徽标。

## 8. 右键菜单注册表

`menu.ts:4-10`：排序与图层一致（`order ?? 0` 升序 → `seq` 先到先得）；**注册表只存项目，不存目标**——`visible`/`enabled` 由渲染方带着「菜单开在哪个节点上」求值（`CanvasMenuTarget`，`contracts/src/canvas-contributions.ts:161-169`），注册方不需要知道菜单此刻的状态，插件卸载时项目自动消失。开合状态放在设置总线（`CANVAS_CONTEXT_MENU_STATE`）。相邻两项 `group` 不同会自动插分隔线（契约注释 `:170-175`）。

## 9. rAF 调度器

`scheduler.ts:21-27` 的目标：一帧最多执行一批任务 + 一次帧通知，避免 pointermove 期间多次写 DOM。

- `requestFrame()`（`:57-84`）：同一帧内重复调用只保留一个待执行请求。有 rAF 时**同时挂 `RAF_GUARD_MS = 120` 兜底定时器**，谁先触发谁执行 tick、另一个立刻取消——因此后台标签页被节流到 0 帧时状态仍会收敛，前台不会重复执行。无 rAF（Node 测试）退化为 `FALLBACK_FRAME_MS = 16`。
- 判空统一用 `!== null` 而非真值判断（`:54-55`）：帧句柄是规范允许的非负数，取 0 时真值判断会误认为「尚未排队」而重复申请一帧。
- `tick()`（`:93-113`）：先跑排队的写任务再通知帧监听；任务集合执行前已快照并清空，所以任务内再 `nextFrame` 排到下一帧，不会同帧自旋。单个任务/监听抛错只 `console.error`，同批其余与后续帧不受影响。
- `nextFrame(task)`：`tasks` 是 Set，同一函数重复登记只执行一次；返回的 Disposable **只撤销本次登记，撤销同一函数会影响其它登记方**（`:126-136`）。
- `invalidateLayer(id)`：**当前忽略 id**——所有覆盖层共用一次帧通知，单层脏标记保留给后续按层重绘（`:120-124`）。
- `SchedulerHandle.dispose()`（契约之外的额外入口，`:4-13`）：取消未执行的帧任务并清空监听，幂等；销毁后 `nextFrame`/`onFrame` 仍可调用但任务不再执行。

## 10. 手势事务

见 [03 §6](./03-design-principles.md#6-一次手势--一条历史) 与 [02 §3.1](./02-runtime-flow.md#31-拖拽一个节点一次手势--一条历史)。实现要点：

- `begin({label, owner})`：已有活动事务**抛错**（`transaction.ts:76-79`）；`base` 直接引用当时 schema（`:81-87`，靠拷贝式写入免深拷贝）。
- `preview(patches)`：`state.pending.set(patch.path, patch)` 按 path 去重 + `document.apply(patches, {record:false})`（`:95-101`）；事务已结束后静默忽略，避免迟到的回调再改文档。
- `commit()`：先 `document.restore(base)` 再 `apply(去重后的 pending, {record:true, label})`（`:110-121`）；`pending` 为空时只回退不写历史，等于把预览完全撤销。
- `cancel()`：`restore(base)`，不写历史但仍触发 `onEnd(committed:false)`（`:123-128`）。
- `close()` 幂等：先清 `active` 再回调，保证 `onEnd` 里可以立即开始下一次手势（`:60-65`）。

## 11. 吸附引擎

`createSnapService`（`snap/engine.ts:59`）。

**阈值单位是屏幕像素**：`threshold = (thresholdScreenPx ?? DEFAULT_THRESHOLD = 6) / Math.max(input.zoom, 0.0001)`（`:82-88`），保证 10% 与 400% 下手感一致。zoom 下限取 `0.0001` 而不是直接相除（`:75-77`）：视口未测量阶段可能是 0，放大后的阈值会变成 `Infinity` 把所有候选判成命中。

**短路条件**：`!enabled` 或 `rects` 为空 → 返回共享的 `NO_RESULT`（`:42-48`、`:83-85`）。`NO_RESULT` 是单例，注释警告调用方不得就地修改其 `delta`/`guides`，否则会污染后续所有「未命中」判定。

**候选采集**：逐个 provider `try/catch`，失败只跳过该 provider（`:98-105`）；`onError` 未传时异常被静默丢弃——「吸附失败属于体验降级，不应打断拖拽主流程，但排查候选缺失时必须先接上这个回调」（`:30-36`）。

**两轴独立选优**（`pickAxis`，`:247-281`）：

```text
对每个候选（axis 必须匹配、value 必须有限）
  对每个参与边 edge：
    diff = candidate.value − edge；|diff| > threshold → 跳过
    构造 AxisHit{value, source, diff, priority ?? 0, showGuide ?? true, range}
    isBetter(hit, best) 则替换
```

**参与哪些边**由 `edgesOf`（`:283-300`）按 `SnapEdgeMode` 决定：`both` 收 start、end、中点三条；`start`/`end` 只收一条。注释解释原因：缩放只拖一条边时另一条是固定锚点，拿它比较会把尺寸修到用户没拖的方向上。

**优劣比较**（`isBetter`，`:302-314`）：`priority` 降序 → `|diff|` 升序 → `source` 字典序（保证结果可复现）。分层的理由写在注释里（`:303-307`）：网格候选由被拖元素自身的边推导，距离天然占优；若按距离优先，元素对齐会被自身几何挤掉。

**辅助线**：`axis 'x'` 画的是**竖线**（value 取世界 x，range 补成视口的 y 跨度），`axis 'y'` 相反；provider 未给 `range` 时用整个视口跨度补齐（`:113-135`）。`delta = { x: x?.diff ?? 0, y: y?.diff ?? 0 }`，`matched = Boolean(x ?? y)`（`:137-141`）。`SnapAxis` 允许 `'angle' | 'distance'`，但 `resolve` 只应用 x/y 两轴（`:76-78`）——角度与距离吸附尚未接入。

**provider 侧的自我约束**（`packages/canvas-plugins/canvas-snap/src/providers.ts`）：`snap.grid` 只发最近的上下两条线且 `showGuide: false`；`snap.elements`（`priority: 1`，`:62`、`:81-84`）用 `rectIntersects(rect, viewportRect)` 剪掉视口外候选；`canvas-rulers` 的用户参考线 `priority: 2`（`canvas-rulers/src/guides.ts:101-115`，同样 `showGuide: false`，线由 rulers 自己画）。

## 12. 与上层服务的桥：`service-canvas-core`

内核不自动接线，唯一的装配点是 [service-canvas-core](./07-services.md#service-canvas-core提供-canvas)（CanvasRealm 插件，`inject: ['document','selection']`）：

| 接线                               | 位置                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建全部工厂并聚合为 `canvas` 服务 | `service-canvas-core/src/index.ts:53-114` → `ctx.provide('canvas', service, {apiVersion:'1.0'})`（`:221`）                                  |
| 根包围盒来源                       | `createScene({ getRootRect })` 实时读 `document.model.schema.nodeId` 的 rect（`:68-72`）                                                    |
| 文档 → 场景                        | `syncScene()`：`nodeFlags = resolveNodeFlags(schema)` + 按 `paintOrder(schema)` 重登记几何，增量路径复用已登记 token（`:129-157`）          |
| 脏来源汇聚                         | `document.onDidChange → syncScene`、`viewport.onDidChange → invalidateViewport`、`selection.onDidChange → invalidateViewport`（`:165-167`） |
| 写回文档                           | `createTransactionService({ document, onEnd: info → ctx.emit('canvas:gestureEnd', info) })`（`:111-114`）                                   |
| 容器判定策略                       | `isContainer` 咨询 `ctx.get('material')?.get(componentName)?.container`（`:91`）——**物料语义不下沉到内核**                                  |
| 可选判定策略                       | `isSelectable` 咨询继承锁定标志（`:99`）                                                                                                    |
| DOM 挂载                           | `attach()`：ResizeObserver + `viewport.setSize`（`:197`），由 `CanvasStage.vue:242` 调用                                                    |

`nodeFlags` 用派生只读集合而不是每帧重算，注释给出原因（`contracts/src/services/canvas.ts:245-251`）：覆盖层 `visible` 每帧求值，这里给已算好的集合，查一次 O(1)；手势起始处的批量过滤另有 `transformableIds`。

## 13. DOM 契约（内核与宿主的分工）

内核**完全不创建 DOM**，只约定宿主提供：

```html
<div class="lc-stage" tabindex="0" data-lc-stage>
  <!-- CanvasStage.vue:272-280，attach 的目标 -->
  <div class="lc-stage__content" :style="{ transform: matrix }">
    <!-- :282，唯一一次 transform -->
    <div class="lc-node" data-node-id="…"><!-- :122-137，absolute + 父级原点补偿 --></div>
  </div>
</div>
```

加上 `LayerHost` 的覆盖层容器（`:286`）。三个约定：

- `tabindex` 必需：管线把 keydown/keyup 挂在舞台上，不可聚焦就收不到快捷键（`:271` 注释）。
- `transform-origin: 0 0`：矩阵以舞台左上角推导，改成 `center` 会让视口换算与画面分裂（`:306-307`）。
- 节点 `left/top` 写的是 `rect − 父级 origin`，而 schema 里永远是**世界坐标**：容器渲染用坐标补偿而不是相对坐标模型，视觉与扁平渲染一致，缩放到 400% 也不重算节点样式（`:91-96`、`:281`）。

## 14. 测试

`packages/canvas/tests/` 共 6 个 spec：`coordinates`（闭式换算与矩阵一致性）、`hitTest`、`menu`、`scheduler`、`snap`、`transaction`。全部在 node 环境运行——这要求被测逻辑不依赖 DOM，也正是内核坚持「几何来自 `layout.rect`」的收益。

## 15. 内核当前不做的事

| 未做                      | 现状出处                                                |
| ------------------------- | ------------------------------------------------------- |
| 旋转节点的精确命中        | `hitTest.ts:40-45`（AABB 粗命中）                       |
| 按节点粒度的场景失效      | `scene.ts:85-89`（`nodeIds` 参数不生效）                |
| 按图层粒度的重绘          | `scheduler.ts:120-124`（`invalidateLayer(id)` 忽略 id） |
| 设置持久化与策略锁定      | `settings.ts:4-9`（合并顺序只是注释）                   |
| `flow` 布局模式           | 宿主一律按 absolute 渲染（`CanvasStage.vue:97-110`）    |
| `angle` / `distance` 吸附 | `engine.ts:76-78`（只有 x/y 轴被应用）                  |
| 多手势并发                | `pipeline.ts:407-408`（第二个 `beginGesture` 抛错）     |
