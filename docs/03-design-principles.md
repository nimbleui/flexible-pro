# 03 设计原理

本文只讲**为什么这样设计**，以及每条选择带来的真实代价。每条命题都附源码证据；无法从代码或注释确认的推断不写在这里。

阅读顺序建议：先看 1、2、5、6 这四条（决定平台形态），其余是支撑性约束。

---

## 1. 画布能力是插件，不是普通组件

**命题**：缩放、平移、选择、拖拽、尺寸缩放、旋转、吸附、网格、辅助线、标尺、小地图、对齐、右键菜单、编辑命令、物料拖入这 15 项能力，与面板、物料处在同一套插件机制里，都通过 `canvasFeatures` 贡献装配。

**证据**：

- `packages/presets/preset-canvas/src/index.ts:9-12` 的注释即声明目标：「不硬编码任何画布插件……新增画布能力 = 新包 + 新 manifest，无需改宿主与预设」。
- 该包的 `dependencies` 里没有任何画布插件（见 [01 项目结构](./01-structure.md#l5-预设与应用)）。
- 15 个插件的注册面完全一致：`canvas.interaction.register` / `canvas.layers.register` / `canvas.settings.register` / `canvas.contextMenu.register` / `canvas.transaction.begin` / `snap.registerProvider`。

**为什么值得**：画布是低代码产品里需求最密集、变更最频繁的地方。如果这些能力写成宿主组件的 `if/else` 或 props 开关，每一次「某个租户不要标尺」都会变成宿主代码分支。插件化后裁剪只是 manifest 贡献差异，`defaultEnabled: false` 或换一份 `canvasProfiles` 贡献即可。

**代价**：能力之间的顺序耦合必须显式化。例如 `canvas-drag` 把自己的 `priority` 设为 50，注释写明原因：「低于 canvas-selection(70)：选中集要先更新，本插件才能读到最新一组」（`packages/canvas-plugins/canvas-drag/src/index.ts:86-89`）。这类顺序知识从「代码结构天然决定」变成「必须靠注释和约定维护」。

---

## 2. 声明式贡献优先：入口先到，代码后到

**命题**：插件先以纯数据 `manifest.contributes` 进入贡献表，宿主立刻能渲染入口；入口模块的 `import()` 推迟到真正需要时。

**证据**：

- `service-loader/src/index.ts:246-252`：`register` 的注释明确「只做三件事……此过程不加载任何代码」。
- 五个贡献点是封闭集合（`packages/contracts/src/contribution.ts:57-68`），插件不能新增点，也不能自定义宿主不认识的 slot 字符串——`packages/contracts/src/slots.ts:3-6`：「新增贡献点必须先加契约常量，再加宿主插槽，再允许插件声明；插槽就是平台的产品边界」。
- 面板按 `onPanel:{id}` 懒激活（`packages/vue/src/components/Slot.vue:95`）；纯声明式插件因没有 `main` 而永不激活（`service-loader/src/index.ts:220-221`）。

**为什么值得**：首屏不必等待全部插件代码；`@lc/plugin-materials-basic` 就是极端例子——它只依赖 `@lc/contracts`，`src/index.ts` 只导出组件表，物料清单在启动期就完整可见，组件实现等到文档真的出现该 `componentName` 才解析（`CanvasStage.vue:157-169`）。

**代价**：数据贡献与代码行为是两条独立路径，可能不一致。平台为此加了运行期校验：`manifest.name` 必须等于 `definition.name`，否则激活失败并发 `plugin:failed`（`service-loader/src/index.ts:229-233`）。

---

## 3. 服务用字符串名 + 作用域链，而不是 DI token / 容器

**命题**：`@lc/kernel` 没有 token、没有装饰器、没有容器类。服务是 `Map<string, ServiceEntry>`，解析沿 `ServiceScope` 链向上走。

**证据**：`packages/kernel/src/context.ts:26-34`（`ServiceScope` 结构）、`:292-311`（`get`/`require`）、`:326-362`（`provide`）。`PluginDefinition` 的 `inject` 允许 `string[]` 简写（`packages/kernel/src/types.ts:60`）。

**为什么值得**：

1. **跨 Realm 遮蔽是天然能力**。`fork()` 只是给 scope 加一层 `parent`（`context.ts:464-477`），文档 A 与文档 B 可以各自持有不同的 `document`/`canvas` 实例，而解析规则完全一致。用 token + 全局容器实现同样的隔离需要额外的子容器机制。
2. **调试可直读**。`window.__lc.context.get('canvas')` 与 `ctx.canvas`（由 `installServiceAccessors` 生成的 getter，`context.ts:617-630`）都是同一个名字，不需要反查 token。
3. **零依赖**。内核 `dependencies` 为空（`packages/kernel/package.json`），字符串名是自描述的，不引入 reflect-metadata 之类的运行时。

**代价**：拼错服务名没有编译期保护。平台的缓解手段是把名字集中到 `SERVICE_NAMES`（`packages/contracts/src/contexts.ts:99-115`）并给 15 个名字装上类型化 getter；`require()` 缺失时抛带服务名的错误（`context.ts:309`）。类型层面则靠 `EditorContext` / `CanvasContext` 收窄（`:85-96`）——**类型糖不改变运行时**，只让写错的 `ctx.document` 在编辑器里变红。

---

## 4. Realm 是一等公民：文档级与画布级各有作用域

**命题**：打开文档不是「换个参数」，而是 `fork()` 一个新作用域并在其中装配插件；打开画布视图再 `fork()` 一层。

**证据**：`service-workspace/src/index.ts:66-70` 注释「Realm 不是裸 `fork()`：每个 Realm 拥有独立 service scope 与生命周期记录」；`:78`+`:86` 建 EditorRealm，`:108` 建 CanvasRealm；`:129-138` 关闭文档时反向销毁全部画布再释放 Realm；`:148` 把 Realm 生命周期挂在 workspace 插件的 effect 上——**插件被停用，它管理的文档也随之关闭**。

**为什么值得**：多文档/多画布是编辑器常态。若共享一个作用域，第二个文档的 `document` 服务会与第一个冲突（`provide` 同层冲突直接抛错，`context.ts:338-341`）。Realm 化之后，两个画布视图共享同一个 `document`/`selection`（选中同步）、各自持有 `viewport`/`layers`/`settings`（缩放平移独立），这个语义差异直接体现在两次 fork 的层级上（`service-workspace/src/index.ts:100-105`）。

**代价**：装配顺序变成需要维护的隐性契约。Realm 内固定 `document → history → selection`（`:79-86`），因为 `service-history` 声明 `inject: ['document']`（`service-history/src/index.ts:26`）；顺序错了会先 `pending` 再靠服务事件补救，虽然能自洽但诊断信息更绕。

---

## 5. 文档只有一个写入口，且只接受 patch

**命题**：所有文档变更都经 `document.apply(patches, options)`，写入是拷贝式的（生成新 schema 引用），不存在「拿到 model 直接改」的路径。

**证据**：

- `service-document/src/index.ts:102-121`：`apply` 是唯一写入口；`before` 默认取当前引用，调用方可显式传入更早的快照（手势事务用它记录开始前的状态），`after = applySchemaPatches(before, patches)`。
- `packages/schema/src/patch.ts:160` `applySchemaPatches` 返回新对象；patch 是 RFC6902 子集（同文件 `:103` `applyPatches`）。
- 只读模式在写入口拦截：`:103-105` `mode === 'preview'` 抛错。
- 树操作也不直接改结构，而是「树语义 → patch」的函数集：`packages/schema/src/tree.ts` 里的 `reorderChildren`、`groupNodes`、`ungroupNodes`、`setNodeFlags`、`renameNode`、`collectSubtree`、`detachFromParents` 全部返回 patch。

**为什么值得**：一个写入口同时给出四样东西——历史记录（`before/after` 现成）、预览/提交分界（`record` 标志）、协作与迁移的可重放单元（patch 可序列化）、以及「旧对象不会被就地改动」这条不变量。历史栈因此可以只存引用而不深拷贝（`service-history/src/index.ts:51-53` 的注释正是这么论证的）。

**代价**：每次提交都重建整棵 schema 对象图。文档规模大时内存与 GC 压力线性上升，因此 `service-history/src/index.ts:18-22` 明确写下退路：「骨架阶段优先保证行为正确；大文档可替换为 patch 逆向记录，contracts 中的接口不变」，且当前**不设栈深上限**（`:53`）。

---

## 6. 一次手势 = 一条历史

**命题**：拖拽/缩放/旋转期间每帧都写文档，但这些中间态不进历史；提交时把去重后的最终 patch 直接落在当前文档上，并以手势前的快照作为历史的 `before`。

**证据**：

- `packages/canvas/src/transaction.ts:42-48`：「预览直接写文档但不产生历史；提交时把最终 patch 落在当前文档上，并以手势前的快照作为历史的 before，保证一次拖拽 = 一条历史且不吞掉并发改动。同一时刻只允许一个事务，抢不到 `begin` 的插件应放弃本次手势」。
- 实现细节：`preview` 以 `patch.path` 去重（`:96-99`），提交时 `apply([...pending.values()], { record: true, label, before: base })`（`:103-127`）。`:108-109` 明确写出**不能先 `restore(base)` 再重放**——那会把手势期间别处的写入（属性面板改了同一节点的其它字段、拖入的新节点）整体抹掉，而且不产生任何错误；只有 `pending` 为空时才纯回退 `restore(base)`（`:123-125`）。`cancel` 只 `restore(base)` 且不写历史但仍触发 `onEnd`（`:129-134`）。
- `begin` 在已有活动事务时抛错（`:76-79`），`contracts/src/services/canvas.ts:153-160` 把这条约束写进了接口注释。

**为什么值得**：`base` 直接引用当时的 schema 引用即可作为历史的 `before`（依赖第 5 条的拷贝式不变量），既省一次深拷贝，又保证撤销一次能准确回到手势前；因为提交只写最终 patch 而不回滚整份文档，手势期间别处的写入不会被顺手抹掉。用户视角的「一次拖拽」与历史记录的「一条」严格对齐。

**代价**：单事务意味着两个手势不能并存。当前是「抛错 + 插件放弃手势」的策略，而不是排队或抢占；多指/双画笔类交互要落地时必须先改这条约束。另有一处路径级独占：与本事务同 `path` 的并发写入会被本事务最后一次预览覆盖，撤销回到 `base` 时这条限制同样成立（`transaction.ts:110-111`）。另一份代价在第 5 条：`version` 每次提交都自增，包括 `record: false` 的预览（`service-document/src/index.ts:70-76`），所以预览期间靠 version 失效缓存的消费者每帧都会重来一次——注释判定这是「保持画面跟手的必要代价」。

---

## 7. 副作用只有一条路：`ctx.effect` / `ctx.effects`

**命题**：内核里所有注册（事件、服务、注册表项、图层、DOM 监听、定时器）都必须返回 `Disposable` 并交给当前 Context 托管。

**证据**：

- `packages/kernel/src/types.ts:5-11`：`Disposable` 的注释就是这条规则的成文表述——「否则插件卸载后会泄漏」。
- `Context.on` 内部直接 `this.effects.effect(...)`（`context.ts:401-407`），插件拿不到未托管的监听入口。
- `EffectScope.dispose` 逆序回收且幂等；关闭后再 `add` 的立即 dispose，`effect` 的工厂被跳过（`packages/kernel/src/effect.ts`）。
- 服务提供的 `Disposable` 只删自己注册的那条，避免覆盖场景误删后来者（`context.ts:355-361`）。

**为什么值得**：插件作者不需要写 cleanup 代码，也不需要记住成对的 `on/off`。停用即整棵子树回收：`Context.dispose` 先 `abort()` 再反向卸载 children 最后回收 effects（`context.ts:518-529`），且注释解释了为什么两个守卫必须分开——否则 `deactivate` 的「先 abort 后 dispose」路径会让回收被短路。

**代价**：`effects.add` 这种「注册即托管」的风格要求每个 API 都返回 `Disposable`，接口签名比裸监听更啰嗦；忘记 `return` 的注册会静默泄漏（内核无法检测未被托管的资源）。

---

## 8. 内核零依赖，契约层集中扩展

**命题**：`@lc/kernel` 不认识任何业务服务名、任何事件名、任何框架。业务扩展全部集中在 `@lc/contracts` 一处。

**证据**：

- 内核的 `Events` 是空接口（`types.ts:127-133`），`installServiceAccessors(names)` 由调用方给名单（`context.ts:617-630`，注释写明「内核不内置任何业务服务名」）。
- 服务名与事件名的唯一扩展点在 `packages/contracts/src/contexts.ts:25-58` 与 `packages/contracts/src/events.ts:52-72`，两处注释都明确「插件不得各自 `declare module`」（`contexts.ts:20-23`、`events.ts:49-51`）。
- `RESERVED_SERVICES` 与 `apiVersion` 校验也在内核（`context.ts:67-92`、`:331-336`），但名单内容是平台语义而非业务语义。

**为什么值得**：事件名和服务名散落是插件平台最常见的腐化起点。集中声明让「平台能力清单」变成一个可 grep 的文件，也让内核可以独立测试——`packages/kernel/tests/` 的 5 个 spec（含新增的 `diagnostics.spec.ts`）不需要任何业务包即可跑通。

**代价**：新增一个服务名要改三处（`Context` 接口、`SERVICE_NAMES`、`RESERVED_SERVICES`）。这是有意设置的摩擦。devtools 需要的观测能力（`EventBus.monitor`、`Diagnostics.onChange`、`runtime.retry`、装配耗时字段）也只能进内核，因为事件与状态都在那里产生；判据是它们只携带**机制**而不硬编码任何业务名字，所以不算破坏本条命题。另一处口径需要留意：观测计时用了浏览器与 Node 都提供的全局 `performance.now()`（`events.ts:137`），仍然是零第三方依赖，但 `index.ts` 头注释里「不依赖 DOM、Node API」这句话要按「不依赖框架与平台专有 API」来理解。

---

## 9. 保留服务 + ServiceGrant：防误用，不防攻击

**命题**：`canvas`、`document`、`history` 这类承载内核语义的服务名，必须由平台签发的 `ServiceGrant` 才能提供，且必须声明 `apiVersion`。

**证据**：`context.ts:331-336` 两条抛错；`runtime.grant`/`hasGrant`（`runtime.ts:71-94`）；宿主侧的预置授权表 `apps/designer/src/bootstrap.ts:41-54`。

**为什么这样定位**：注释给出了非常克制的理由（`context.ts:56-66`）——「保留名单存在的意义不是防住同 realm 的恶意代码（它做不到），而是防止普通插件无意间覆盖 `canvas`、`history` 这类内核语义服务」。这是整个仓库里对安全边界最诚实的一句表述：同 realm 的 JS 无法被名单挡住，名单解决的是**事故**而不是**攻击**。真正的攻击面隔离（iframe/worker）在设计稿 Part III，代码未实现。

**代价**：内置服务在开发期也要显式登记 GRANTS，否则启动即抛错。`bootstrap.ts:35-40` 的注释承认这是「保证没有控制面时也能跑通内置能力，同时保留保留服务需要授权的约束」。

---

## 10. 框架无关内核，Vue 只是宿主适配

**命题**：契约层不出现任何框架类型；渲染产物在契约里是 `unknown`，由 Vue 层收窄。

**证据**：

- `packages/contracts/src/services/material.ts:50` `ResolvedMaterial.component`、`packages/contracts/src/services/renderer.ts:12` 的 `resolveMaterial(name): Promise<unknown | undefined>`。
- 收窄点在 `packages/vue/src/components/CanvasStage.vue:166`：`component ? markRaw(component as Component) : null`，注释写明「契约层返回 unknown（不依赖 Vue），宿主在此收窄」。
- `@lc/vue` 是唯一持有 vue 依赖的平台包（`packages/vue/package.json:19-21` 用 `peerDependencies` 声明 vue，避免多实例）。
- 内核与服务包对 Vue 零引用：`packages/services/*` 的依赖表里没有 vue。

**为什么值得**：覆盖层组件、面板组件、物料组件都是「模块默认导出一个组件」这种弱约定，换成其他框架只需要替换宿主适配层，服务与画布内核不动。

**代价**：类型安全在边界处断一次。`markRaw` 与 `as Component` 属于必要的收窄断言；平台把它限制在 3 个宿主组件内，而不是散落到插件里。

---

## 11. 交互分发对齐 DOM 事件模型

**命题**：画布只有一套真实 DOM 监听，其余插件注册的是三段式逻辑处理器（`capture → target → bubble`），同阶段按 `priority` 降序、再按注册序号先到先得。

**证据**：

- `packages/canvas/src/interaction/pipeline.ts:115-116`：「分发顺序：先捕获、再手柄目标阶段、最后冒泡，与 DOM 事件模型保持同一心智」。
- `target` 阶段只在 `event.targetHandleId` 存在时进入（`:286`），handle id 由 `closest('[data-handle-id]')` 解析（`:317`）——所以尺寸手柄、旋转手柄、小地图 viewport、标尺参考线的命中都是同一套机制。
- 返回值语义封闭：`'pass' | 'handled' | 'stop' | void`（`packages/contracts/src/canvas-contributions.ts:97`），`handled` 之后进入手势回调，`stop` 终止分发。
- 处理器抛错只记诊断，不中断分发（`pipeline.ts:297-301`）。

**为什么值得**：插件作者迁移成本几乎为零（心智就是 addEventListener + 优先级），且手柄类交互不需要插件自己去注册 DOM 监听——`canvas-resize` 与 `canvas-rotate` 之间没有任何引用关系，仅靠 handle id 字符串约定（rotate 的 `ROTATE_HANDLE_ID = 'rotate'` 被 resize 的手柄集合排除）。这是第 1 条命题能成立的技术前提。

**代价**：`Escape` 在手势期间被内核保留（`pipeline.ts:603`），插件不能覆盖；`click` 由管线在位移 ≤ `DEFAULT_DRAG_THRESHOLD = 3` 时合成（`:57`、`:526`），而不是原生 click——调试时不能直接看 DevTools 的事件监听器列表来推断插件行为。

---

## 12. 吸附是「候选提供者 + 分层优先级」的解析协议

**命题**：吸附不是一段写死的「对齐网格或对齐兄弟节点」逻辑，而是可注册候选的解析服务。任何插件都能提供候选。

**证据**：

- `packages/canvas/src/snap/engine.ts:59` `createSnapService`；阈值以屏幕像素定义并按 zoom 换算：`threshold = (thresholdScreenPx ?? 6) / max(zoom, 0.0001)`（`:88`）。
- 候选采集逐个 provider try/catch（`:99-105`），x/y 轴独立挑选（`pickAxis`，`:251`），参与比较的边由 `SnapEdgeMode` 决定（`edgesOf`，`:289`），打分规则固定为**优先级分层 → |diff| 升序 → source 字典序**（`isBetter`，`:308`）。
- 现有 provider：`snap.grid`（`packages/canvas-plugins/canvas-snap/src/index.ts:61-66`，只发最近两条线且 `showGuide: false`）、`snap.elements`（同文件 `:68+`，按视口矩形裁剪候选）、`canvas-rulers.guides`（用户参考线，`packages/canvas-plugins/canvas-rulers/src/guides.ts`）。
- 优先级约定 0=grid / 1=elements / 2=用户参考线（`packages/contracts/src/canvas-contributions.ts:202-217` 的 `SnapCandidate.priority` 注释）。

**为什么值得**：`canvas-rulers` 能把自己的参考线插进同一套吸附，靠的是注册 provider 而不是改吸附引擎；`canvas-guides` 则纯粹消费 `frame.snap` 的结果画线（`canvas-snap` 的 `lastResult`），三者之间零引用。

**代价**：阈值、边模式、优先级都是全局协商结果，任何插件改优先级都会影响别人。因此这些取值全部写进契约注释而不是散落在实现里。

---

## 13. 最小抽象：抽象只出现在真有竞争的地方

**命题**：全仓只有 4 处注册表（material / command / setter / contribution + 画布的 layers/contextMenu），没有 Manager、Factory、Builder、Pipeline 这类包装层；画布内核一律用工厂函数而不是 class。

**证据**：

- `packages/contracts/src/services/registry.ts:10` 的 `Registry<T>` 只被 material / command / setter 复用；contribution 用独立的排序规则（`order ↑ → priority ↓ → 插件名`，`service-loader/src/index.ts:48`）而没有硬套 Registry。
- class 只集中在两处。内核共 8 个：`Context`、`ServiceObserver`、`Diagnostics`（`context.ts`）、`PluginRuntime`（`runtime.ts`）、`EventBus`（`events.ts`）、`EffectScope`（`effect.ts`）、`InternalBus`（`internal.ts`）、`Service`（`service.ts`）；其中 `ServiceObserver`/`Diagnostics`/`InternalBus` 存在只是因为要携带私有状态。全仓另一个 class 是 `@lc/devtools` 展示层的 `EventLog`（`packages/devtools/src/core/feed.ts:12`，带环形上限的日志缓冲）。画布内核 12 个文件全是 `create*` 工厂（见 `packages/canvas/src/index.ts:8-45` 的导出面），服务与插件层零 class。
- `packages/kernel/src/service.ts:9` 有一个 `abstract class Service`（构造即 `provide`，注释自己限定「只适用于 class 形态的服务」）。**全仓 `extends Service` 出现 0 次**——12 个服务与 15 个画布插件全部走 `definePlugin` + `ctx.effect(() => ctx.provide(...))`；但它仍然挂在 `packages/kernel/src/index.ts:27` 的公开导出面上。

**为什么保留这份清单**：`service.ts` 是内核里唯一一处「实现了但没人用」的抽象。按 `cloud-gate-store` 规范的「删除该抽象是否让实现明显变差」判据，它应当被移除；本文把它登记在 [10 开发指南的已知边界](./10-development-guide.md#9-已知边界与技术债) 而不是继续默许。

---

## 14. 失败隔离优先于失败传播

**命题**：一个插件坏掉不影响其余插件；诊断信息与生命周期决策严格分离。

**证据**：

- `service-loader/src/index.ts:206-215` 注释：「失败不向上抛……一个坏插件不应中断其余插件的激活流程」；实际行为是 `diagnostics.report` + `emit('plugin:failed')`（`:238-240`）。
- `preset-canvas/src/index.ts:33-48`：单个画布能力缺失或加载失败 → 记诊断 → `continue`。
- `packages/kernel/src/events.ts:132-147`：`emit` 对每个监听器单独 `reportError`，一个监听器抛错不影响其余。
- `context.ts:146-182` `Diagnostics`：记录上限 200 条，注释明确「不参与生命周期决策，因此插件即使伪造内容也无法影响插件状态」。
- 观测层自己也被隔离：诊断订阅者抛错只记日志（`context.ts:173-181`），事件监视器抛错同样不影响正在分发的监听器（`events.ts:249-255`）——展示层坏掉不能反过来拖垮上报方与分发方。
- UI 侧 `PluginBoundary` 只降级单个面板（`Slot.vue:120-121`）。

**代价**：错误容易变静默。`ensureActivated(event)` 未匹配到插件时静默返回，注释自己承认「事件名拼错不会有反馈」（`service-loader/src/index.ts:329`）。因此排查习惯是先看 `window.__lc.context.diagnostics.list()`，而不是等异常抛出。
