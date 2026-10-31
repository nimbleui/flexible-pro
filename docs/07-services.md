# 07 服务层 `packages/services/*`

12 个包，每个导出一个匿名 `definePlugin` / `defineEditorPlugin`。**没有 token、没有命名常量**：服务身份就是 `ctx.provide(name, impl, { apiVersion: '1.0' })` 里的那个字符串，全部集中在 `RESERVED_SERVICES`（`packages/kernel/src/context.ts:67-92`）与 `SERVICE_NAMES`（`packages/contracts/src/contexts.ts:99-115`）两处名单里。

## 总览

| 服务                      | 包                  | 层级            | `inject`                                 | `provide` 位置                           |
| ------------------------- | ------------------- | --------------- | ---------------------------------------- | ---------------------------------------- |
| `modules`                 | service-modules     | 应用            | —                                        | `index.ts:103`                           |
| `loader` + `contribution` | service-loader      | 应用            | `modules`                                | `:190`（contribution）、`:354`（loader） |
| `material`                | service-material    | 应用            | `modules`、`contribution`                | `:175`                                   |
| `command`                 | service-command     | 应用            | —                                        | `:91`                                    |
| `expression`              | service-expression  | 应用            | —（`provides: ['expression']`）          | `:86`                                    |
| `setter`                  | service-setter      | 应用            | —                                        | `:84`                                    |
| `keybinding`              | service-keybinding  | 应用            | —（`provides: ['keybinding']`）          | `:76`                                    |
| `document`                | service-document    | **EditorRealm** | —（`defineEditorPlugin`）                | `:147`                                   |
| `history`                 | service-history     | EditorRealm     | `document`                               | `:94`                                    |
| `selection`               | service-selection   | EditorRealm     | —                                        | `:76`                                    |
| `canvas`                  | service-canvas-core | **CanvasRealm** | `document`、`selection`（`ctx.require`） | `:233`                                   |
| `workspace`               | service-workspace   | 应用            | —（内部装配上面四个 Realm 服务）         | `:176`                                   |

Realm 级服务在 `Context` 类型上是**可选属性**（`contexts.ts:48-57`），因为 AppContext 没有它们；Realm 内通过 `EditorContext` / `CanvasContext` 收窄为必选。

`expression` 与 `keybinding` **不在 `RESERVED_SERVICES` 名单里**（`context.ts:67-92` 未列），因此提供它们不需要 `ServiceGrant`；其余 11 个内置服务都需要宿主在 `apps/designer/src/bootstrap.ts:41-54` 预置授权。

---

## `modules` — 模块懒加载与并发去重

`packages/services/service-modules/src/index.ts`

```ts
loaders: Map<string, ModuleEntry> // :15  key → 加载器
cache: Map<string, Promise<unknown>> // :18  key → 进行中的 Promise（缓存的是 Promise 而非结果）
```

| API                     | 位置  | 语义                                                                                                                                                          |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register({key, load})` | `:29` | **key 重复抛错**（`:31`）；登记时清掉该 key 的旧缓存（`:34`），Disposable 比对 entry 引用后同时摘 `loaders` 与 `cache`（`:39-41`）                            |
| `load<T>(key)`          | `:53` | 命中缓存直接返回同一 Promise（`:54-55`）→ **同一模块并发只 import 一次**；未登记 key 直接 reject；失败时 `cache.delete(key)`（`:64`）即**失败不缓存，可重试** |
| `preload(keys)`         | `:77` | 批量预热，单个失败只上报诊断，不影响其余                                                                                                                      |
| `evict(plugin)`         | `:93` | 按 `${plugin}/` 前缀清掉该插件全部模块登记与缓存                                                                                                              |

模块 key 的规范拼法在 `packages/contracts/src/services/modules.ts:28-36`，注释给出动机：贡献里只写包内模块名，拼出全局 key 以免两个插件声明同一个 `module` 字符串时相互覆盖。

**没有做的事件**：无按需最小集分析、无模块预取调度、无 external 共享（当前 `dedupe: ['vue']` 由 Vite 保证，`apps/designer/vite.config.ts:5-12`）。

## `contribution` — 声明式贡献注册表

由 service-loader 创建并提供（`createContributionRegistry`，`packages/services/service-loader/src/index.ts:33-120`），**故意早于 `loader` 本身 provide**（`:190` vs `:354`），因为 `material` 等消费者只依赖贡献表而不依赖装载器。

```ts
items: StoredContribution[]   // :34  异构数组，读取时按 point 泛型收窄
```

| 语义             | 位置      | 说明                                                                                                                                                                                                                             |
| ---------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 排序             | `:42-58`  | `order ↑ → priority ↓ → plugin.localeCompare`。注释指出 `order`/`priority` 是**从贡献对象上动态读取**的，缺失按 0；三级键全同时依赖 `Array.sort` 稳定性落到登记先后。`StoredContribution.seq` 字段（`:23-24`）**当前排序未使用** |
| 批量注册         | `:61-86`  | 一次 `register` 返回一个 Disposable 撤掉整批；**同 id 的贡献允许重复出现，注册表不去重**，由消费方按 id 自行处理                                                                                                                 |
| `list(point)`    | `:88-95`  | 每次调用重新过滤 + 排序，**不做结果缓存**                                                                                                                                                                                        |
| `listSlot(slot)` | `:97-113` | 只筛 `panels`；注释解释为什么不做成 `list(point, filter)`（避免把过滤协议扩散到所有贡献点）；**未声明 `slot` 的面板不会出现在任何插槽里**                                                                                        |

## `loader` — 安装 ≠ 启用

`packages/services/service-loader/src/index.ts:176-356`

三张表：`packages`（插件名 → 包，`:193`）、`registrations`（插件名 → 登记产生的 Disposable[]，`:196`）、`activated`（插件名 → 实例记录，`:199`，**同时是「已激活」的唯一判据**）。

### `register(pkg)`（`:246-312`）

```text
assertManifest(:128)   name / version / engines.lowcode 缺任一即抛错
                       注释理由：清单是安装期数据，越早拒绝越能让上层安装流程给出准确提示
重复登记抛错（:259-261）
逐点 contribution.register(manifest.name, point, entries)（:267-277）
collectModules(pkg)（:165-174）→ 只覆盖 materials / panels / canvasFeatures 三类带 module 的
                       贡献；同一 module 被多条贡献引用时只登记一次
ctx.modules.register({ key: `${name}/${module}`, load: pkg.load })（:279-286）
返回的 Disposable：逆序释放贡献与模块注册 → ctx.root.runtime.unload(record.id) → modules.evict → 摘表
```

**登记过程不加载任何代码**（`:246-252` 注释）。

### `activate(pkg)`（`:206-244`）

1. `activated.has(name)` → 直接返回（幂等）。
2. `!manifest.main` → 直接返回，且**不写入 `activated`**：纯声明式插件每次激活事件都会走到这里再快速返回。
3. `await pkg.load()` → `extractDefinition(module)`（`:144-157`）：模块是外部构建产物，只能用鸭子类型判断（有 `apply` 函数即视为定义），兼容 `default` 与 `plugin` 两种导出别名；取不到返回 `undefined` 由调用方转诊断，**不在这里抛错打断整条加载链**。
4. `definition.name !== manifest.name` → 抛错 → 诊断 + `plugin:failed`（`:229-233`）。
5. `ctx.plugin(definition)` → 写 `activated` → 发 `plugin:activated`。

### `ensureActivated(event)`（`:323-341`）

- `event.startsWith('onCanvasFeature:')` → **直接 return**（`:334-335`）：画布能力必须由 CanvasHost 按文档实例化，装载器只负责提供模块加载能力。
- 命中 `activationEvents` 的包并行 `Promise.all` 激活。
- 注释自曝一个并发缺陷（`:326-329`）：`activated` 表在 `load()` **之后**才写入，所以同一插件被并发激活时两个调用都会通过检查，**可能重复装配**——需要严格去重时应改为登记 pending Promise。另外**未匹配到任何插件时静默返回，事件名拼错不会有反馈**。

## `material` — 元数据注册 + 组件懒加载

`packages/services/service-material/src/index.ts:30-177`

三张表（`:35-47`）：`entries`（**生效表**：贡献与运行时注册的合并结果，读取只走这一张）、`manual`（运行时注册表，单独保存以免一次 rebuild 丢掉宿主手工注册的物料）、`resolved`（物料名 → 解析中的 Promise）。

### `rebuild()`（`:56-83`）

```text
entries.clear()
for item of ctx.contribution.list('materials'):
    existing && (existing.priority ?? 0) >= (value.priority ?? 0) → 跳过
    ⇒ 后一条只有 priority 严格更高才替换；同优先级保留先出现的那条
      （贡献表已按 order↑ priority↓ 排，所以同一份清单每次装配结果一致）
for [name, entry] of manual: if !entries.has(name) → 补位
      ⇒ 贡献始终高于运行时注册
resolved.clear()   // 让已加载组件在下一次读取时按新实现重新解析
notify()           // version += 1
```

**先订阅再建表**（`:85-87`）：插件是逐个装载的，晚到的物料贡献也必须触发重建。

### `ensure(name)`（`:132-172`）

`extractComponent`（`:20-22`）：先看 `module.components[name]`（一个模块可导出多个物料），取不到才用 `module.default` 兜底，让只导出单组件的物料包不必再写一层名字表。

- 名字未登记 → `Promise.resolve(undefined)`；模块加载失败 → `.catch` 里 `resolved.delete(name)` + 诊断，**返回 undefined 而不 reject**。注释说明理由：渲染层要的是「拿不到就画占位」，把装配错误变成异常会让每个调用点都得写 catch。
- `register`（`:98-113`）：只允许 manual 表内一次同名注册（`:99-101` 抛错）；贡献里已有同名条目时仍会收下，但 rebuild 后生效的仍是贡献那条。Disposable 比对引用（`:108`）。
- `list()` 返回 `[...entries.values()]`（**Map 迭代序 = 物料名首次进入生效表的顺序**，不是 `order`）；`get` 直接查 `entries`。

## `command` — 唯一执行入口

`packages/services/service-command/src/index.ts`

- `commands: Map<id, Command>`，**id 重复抛错**（`:35`）。
- `list()`：**按注册顺序，不做排序**——注释写明「展示顺序由工具栏等贡献点的 `order` 决定」（`:54-57`）。
- `version`（`:59`）随每次注册/注销自增（`:18-21`），供 Vue 适配层触发重渲染。
- `execute(id, args)`（`:75-88`）三条退出路径都不向调用方抛错：命令不存在 → 诊断；`enabled()` 为 false → **静默跳过（置灰本身就是预期，不该刷诊断）**；`run` 抛错 → 捕获后上报。异步命令被 await，调用方可串接后续操作。

## `expression` — 求值服务（装配层）

语言实现已移出本插件，在 `packages/expression`（词法 / 语法 / 求值 / 白名单方法表 / 函数注册表 / 缓存 / 三重预算）。本插件只剩三件事：读配置、把诊断桥到 `ctx.diagnostics`、注册服务。分成两层的原因是动作执行器与运行时播放器不需要插件内核也能求值。

`packages/services/service-expression/src/index.ts`

```ts
createJsRunner() // :45   JsExpression 执行器；全仓库唯一的 new Function 在 :51
schema.parse // :65   allowUnsafeJs 默认 false；timeBudgetMs 非负或 Infinity，否则配置阶段失败
apply(ctx, config) // :79   createExpressionEngine({ jsRunner, timeBudgetMs, onDiagnostic })
ctx.provide('expression', engine, { apiVersion: '1.1' }) // :86
```

`jsRunner` **就是**能力开关本身，而不是配一个布尔位：不传执行器就没有任何路径能执行 `JsExpression`，因此不存在「开了开关但没有运行器」的非法状态。`@lc/expression` 自身不持有 `new Function`，搜索全仓库只能命中 `:51` 一处，且它只在显式开启 `allowUnsafeJs` 后才构造。这条分层的意义是让「字符串变成可执行代码」的站点可被直接审计。

**安全边界必须原样记录**：白名单解释器限制的是「语言能表达什么」（无原型链、无全局对象、`call/apply/bind` 不可得、`constructor` 被拒），**不是**「代码能碰到什么」。同 realm 的 JS 无法被沙箱化（设计稿 §19.2 明示）；§19.4 要求的 Worker 求值后端已作为**可选旁路**实现（`packages/expression/src/sandbox/`，细节见 [05](./05-contracts-and-schema.md) 的沙箱条目），但它**不经本插件装配**：本插件只 provide 同步 `expression`，沙箱由消费方按需用 `createExpressionSandbox` 自建——没有调用方却常驻一个线程是纯开销。两个残留的非隔离面：宿主注入到求值作用域的函数是真 JS（沙箱强度 = min(语言白名单, 注入的函数面)，且这样的作用域无法结构化克隆进 worker），以及开启后的 `JsExpression` 完全等同物料代码。

## `setter` — 属性类型 → 控件种类

`packages/services/service-setter/src/index.ts`

- `BUILTIN_SETTERS`（`:6-20`）**覆盖全部 13 种 `PropType`**（`packages/schema/src/props.ts:18-31`），映射到 5 种 `SetterKind`：`text | number | color | toggle | select`（`:6`）。
- `setters: Map<id, SetterEntry>` + `version`（`:32-37`）；**id 重复抛错**（`:44`）。
- `resolve(propType)`（`:75-79`）：按类型过滤后 `sort((a,b) => (b.priority ?? 0) - (a.priority ?? 0))[0]`，即同类型优先级最高者胜出。
- 扩展路径写在 `:25` 的注释：「内置映射覆盖全部 PropType；插件可注册更高 `priority` 的同类型设置器覆盖」。
- **没有 `setters` 贡献点**：注册只能通过 `ctx.setter.register(...)` 命令式调用，因此第三方包无法在 manifest 里声明设置器。
- 类型未命中时由**调用方**兜底成文本控件（`packages/plugins/plugin-panel-properties/src/PropertiesPanel.vue:108`：`setter?.resolve(propType)?.kind ?? 'text'`），服务本身不返回兜底值。

## `keybinding` — 全局快捷键

`packages/services/service-keybinding/src/index.ts` + `src/keys.ts`

- `bindings: Keybinding[]`（`:33`），**id 重复抛错**（`:37-39`）；`list()` 返回浅拷贝（`:49-51`）。
- 监听注册有环境守卫：`typeof window !== 'undefined'` 才挂 `keydown`（`:71-74`），并把解绑挂到插件 effect 上。
- 可编辑目标判定 `isEditableTarget`（`:8-18`）：`INPUT` / `TEXTAREA` / `SELECT`，以及 `isContentEditable` 或 `closest('[contenteditable="true"]')`——**命中即整个快捷键通道让位给输入**。
- 匹配循环（`:61-68`）：按注册顺序遍历，`binding.when()` 为假跳过（`:62`，**既不触发也不阻止默认行为**，契约 `packages/contracts/src/services/keybinding.ts:19-20`），`matchesKeybinding` 命中则 `preventDefault()` + `ctx.command.execute(...)` 后 **`return`**——**首个匹配即独占，一条按键最多触发一个命令**（`:65-67`）。
- `keyFor(command)`（`:53-55`）：`bindings.find(item => item.command === command)?.key`，返回**注册序里的第一条**绑定，供命令面板显示。
- 匹配逻辑抽成纯函数便于测试：`matchesKeybinding`（`keys.ts:26`）、`normalizeEventKey`（`:55`）、`detectPlatform`（`:14`）；`index.ts:5-6` 再导出。规范见契约注释（`contracts/src/services/keybinding.ts:5-9`）：`Mod` 在 macOS 是 ⌘，其余平台是 Ctrl；**修饰键必须精确一致**，避免 `ArrowUp` 与 `Shift+ArrowUp` 相互误触发。
- 与画布键盘事件是两条路：舞台 `keydown` 由交互管线分发给画布处理器（`packages/canvas/src/interaction/pipeline.ts:601-607`），窗口 `keydown` 由本服务处理。`canvas-zoom` 同时用了两者（键盘 STEP 缩放走画布 handler，命令走 command + keybinding）。

## `document` — schema 唯一写入口

`packages/services/service-document/src/index.ts`（Realm 级，`defineEditorPlugin<DocumentPluginConfig>`）

### 配置

`schema.parse`（`:25-43`）要求 `id` 与 `schema` 同时存在，缺任一抛错——注释的理由：「文档没有初始 schema 时后续所有读取都会返回半成品，早失败比让空文档进入编辑更省事」；`mode` 缺省 `'edit'`。

`createDocument` 会**整体克隆**传入的 schema（`:11` 注释 + `packages/schema/src/document.ts:43-52`），宿主之后改原对象不影响文档内容。

### 状态与通知

```ts
model: DocumentModel { id, title, schema, version, dirty }   // :57
notify(): 本地监听先收到，再向事件总线广播（:64-68）           // 同一轮里监听方早于事件消费者
commitSchema(next, dirty, versioned)                          // :70-85
```

`commitSchema` 的注释是理解预览行为的关键（`:70-76`）：**`version` 每次提交都自增，包括 `record: false` 的手势预览**——靠 version 做缓存失效的消费者因此每帧都会重来一次，这是预览期间保持画面跟手的必要代价；**`dirty` 只在正式提交时置 `true`**，预览不会把文档标记成未保存。

### `apply(patches, options)`（`:102-121`）

```text
mode === 'preview' → 抛「只读文档不允许写入」（:103-105）
record = options.record ?? true        // 默认写历史
before = model.schema                  // 拷贝式 patch ⇒ 旧引用可安全作为历史快照
after  = applySchemaPatches(before, patches)
commitSchema(after, record ? true : model.dirty, true)
if (record) ctx.get<HistoryService>('history')?.record({ label: options.label ?? '编辑文档', before, after })
```

最后一行的**懒取**是刻意的（`:114` 注释）：「历史服务在 Realm 中晚于文档装载，这里按需解析避免循环依赖」。因此 `history` 缺席时文档仍能写，只是不留痕。

### `restore` / `validate` / `onDidChange`

- `restore(next)`（`:123-132`）：递增 version、**不写历史、不动 dirty**。注释明确「撤销一次编辑后文档仍是已修改状态，是否符合预期由调用方判断，服务不做猜测」。这也是事务 `commit` 的实现基础。
- `validate()`（`:134-137`）：只返回 `validateDocument(schema)` 的结果，**不拦截任何已发生的写入**。
- `onDidChange`（`:139-144`）：`listeners` 是 Set，同一函数重复注册只保留一份，任一 Disposable 释放即全部失效。

## `history` — 全量快照栈

`packages/services/service-history/src/index.ts`（Realm 级，`inject: ['document']`）

```ts
undoStack / redoStack: SnapshotEntry[]   // :30-31  { meta: HistoryEntry, before: PageSchema, after: PageSchema }
```

- 类注释（`:18-23`）把取舍写得很直白：**以全量 schema 快照记录，骨架阶段优先保证行为正确；大文档可替换为 patch 逆向记录，contracts 中的接口不变**。
- `record(input)`（`:55-63`）：`meta.id = createId('history')`（来自 `@lc/shared`，运行时 id、不作持久化标识）、**清空 `redoStack`**（撤销后再改一笔，原来的重做分支即失效）、`before/after` 存引用（`:51-53` 的论证：schema 只能被拷贝式 patch 整体替换，旧对象不会被就地改动，因此全量快照不需要深拷贝）。**不设栈深上限**（`:53`）——长会话内存占用需要在接入持久化时治理。
- `undo()`（`:65-72`）/ `redo()`（`:75-81`）：`pop` → `document.restore(对应快照)` → 反向入另一栈 → `notify`。栈空时**静默返回**，调用方应先用 `canUndo/canRedo` 决定按钮状态。
- `list()`（`:83-86`）：只返回 `undoStack` 的 `meta`，**顺序从旧到新**（栈底到栈顶）；重做分支不暴露。

## `selection` — 有序选中集

`packages/services/service-selection/src/index.ts`（Realm 级，无依赖）

```ts
let ids: readonly string[] = [] // :15  整体替换而不是就地修改：引用变化即「选区变了」
```

`update(next)`（`:18-34`）是唯一写入口：

1. `[...new Set(next)]` 去重——同一 id 传两次不会多出口一条记录。
2. 与当前 `ids` **逐项按序比较**：`['a','b']` 与 `['b','a']` 视为变化，因为 `primary` 取末位，**顺序本身有语义**（`:22-23` 注释）。
3. 相同则直接返回，不通知、不发事件。
4. 否则替换引用 → 本地监听 → `ctx.emit('selection:change', ids)`。

API 语义（`:47-68`）：`set` 覆盖；**`add` 会把新 id 移到集合末尾，因此也改变 `primary`**；`remove` 过滤；`toggle`（Shift 点选用：已选则取消，未选则追加成为主选中）；`clear`。`ids` getter 返回内部数组引用，调用方不得 push/splice（`:37`）。

职责边界由契约注释固定（`packages/contracts/src/services/selection.ts:3-8`）：**本服务只保存选中，不负责点击/框选交互**（那是 `canvas-selection` 插件），视觉由覆盖层读取本服务绘制。

## service-canvas-core（提供 `canvas`）

`packages/services/service-canvas-core/src/index.ts`，Realm 级（CanvasRealm）。它是**内核与上层之间唯一的桥**，接线细节见 [06 §12](./06-canvas-kernel.md#12-与上层服务的桥service-canvas-core)。本层独有的产品决策：

| 决策                                | 位置       | 说明                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 缩放区间写死 `0.1 ~ 4`              | `:52-53`   | 与视口默认值相同，「放在这里是为了让产品调整只改一处」                                                                                                                                                                                                                               |
| 无 `layout` 的兜底尺寸 `100×40`     | `:27-36`   | `nodeRect` 拷贝一份矩形给场景，避免调用方后续改动写回 schema                                                                                                                                                                                                                         |
| 根矩形取 `schema.nodeId` 指向的节点 | `:68-75`   | 根不存在时回落兜底尺寸；注释判定这是「文档损坏下的可观察降级而不是抛错」                                                                                                                                                                                                             |
| 容器判定：先孩子后物料              | `:77-92`   | `locked` 直接 false（锁定容器不接收拖入，命中测试会继续向下寻找未锁定的容器）；`children` 非空即为容器（省一次物料表查询）；空容器取决于 `material.get(componentName).container`；**物料服务是可选的**，未安装时只有带子节点的节点算容器                                             |
| `isSelectable`                      | `:110-111` | 只查上一次文档同步算出的 `nodeFlags.locked`，处理器在指针事件里同步调用                                                                                                                                                                                                              |
| `syncScene` 增量策略                | `:131-172` | 只在**绘制顺序变化**时整表撤下重登记；顺序没变时逐节点覆盖矩形（场景按 nodeId 复用首次登记的位置），因此拖拽期间每帧重同步不会打乱层级；节点被删或转隐藏后必须显式注销，否则矩形会一直留在场景里参与命中；末尾只标一次视口脏                                                         |
| 调度器所有权                        | `:181-182` | 「残留的 rAF 与兜底定时器会跨文档泄漏」，所以 `scheduler.dispose()` 挂在本插件 effect 上                                                                                                                                                                                             |
| `attach` 顺序                       | `:202-230` | 先绑监听再同步量一次尺寸（`clientWidth/clientHeight`，舞台 `overflow:hidden` 所以内容尺寸=可视尺寸），保证第一次 pointerdown 时 `viewport.size` 已可用；Node 环境无 `ResizeObserver` 时只有首次测量；销毁顺序：停观察 → 解绑交互 → 尺寸归零（卸载后残留尺寸会让 `fit` 算出错误缩放） |
| `nodeFlags` 用 getter               | `:197-200` | `syncScene` 整体替换对象，读取方每次拿到的都是最新集合                                                                                                                                                                                                                               |

## `workspace` — Realm 工厂

`packages/services/service-workspace/src/index.ts`（应用级，唯一直接依赖其他服务包的 `service-*`）

### 空文档模板

`createEmptySchema(documentId)`（`:19-42`）：根节点固定 id `root`、`componentName: 'Container'`、`layout.mode: 'absolute'`、尺寸 **1200×800**、`components: []`、`metadata.title = documentId`。注释强调 `nodeId` 与 `nodes` 的键必须同为 `root`——**画布靠它取根包围盒**。

### `createEditorRealm(options)`（`:65-151`）

```text
realms.has(documentId) → 抛「文档已打开」（:74-76，避免两个 Realm 写同一份文档）
realmCtx = ctx.fork()                             // :78 独立 service scope
realmCtx.plugin(documentPlugin, {id, schema, title, mode})   // :79-84
realmCtx.plugin(historyPlugin)                    // :85
realmCtx.plugin(selectionPlugin)                  // :86
      // :68-69 注释：装配顺序 document → history → selection，history 依赖 document 必须先完成注册
realm.id = createId('editor')                     // :93
createCanvasRealm()                               // :107-126：再 fork 一次 + canvasCorePlugin
                                                  // 一个文档可有多个画布视图；文档/选中共享，
                                                  // 视口、图层、交互管线、设置各自独立
dispose()                                         // :129-138：幂等；反向销毁 canvases → realmCtx.dispose()
                                                  // → realms.delete → active 置空 → notify
active = realm                                    // :143-145：最近创建即 active；
                                                  // 关闭 active 文档后 active 变 undefined，
                                                  // 不会自动回退到上一篇（当前没有用户切换入口）
ctx.effect(() => ({ dispose: () => realm.dispose() }))   // :148：workspace 插件停用 → 级联关闭文档
```

`WorkspaceService` 的 `listEditors()` 返回 `[...realms.values()]`（**打开顺序**，同一文档只会有一条）；`onDidChange` 对打开与关闭都通知但**不区分事件类型**，订阅者需自行比对前后状态（`:169-173` 注释）。

`RealmOptions.schema` 注释（`packages/contracts/src/services/workspace.ts:11`）写明：骨架阶段由宿主注入，生产环境由持久化服务加载——**当前仓库没有持久化服务**。
