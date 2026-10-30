# 04 插件内核 `@lc/kernel`

内核不认识任何业务服务名、事件名和框架类型（理由见 [03 设计原理 §8](./03-design-principles.md#8-内核零依赖契约层集中扩展)）。它只实现四件事：**分层的服务作用域、依赖驱动的插件状态机、自动回收的副作用桶、类型化事件总线**。10 个源文件 + 5 个 spec，`packages/kernel/package.json` 无 dependencies。

> 本文按工作区当前源码撰写，包含尚未提交的观测面（`retry`、`monitor`、装配耗时）。文中行号会随改动漂移，长期定位请用「文件 + 符号名」。

## 1. 内核解决的四个问题

| 问题                   | 机制                           | 文件         |
| ---------------------- | ------------------------------ | ------------ |
| 插件按什么顺序启动？   | 依赖驱动状态机 + 微任务批调度  | `runtime.ts` |
| 插件怎么拿到能力？     | 分层服务作用域 + 四道授权闸门  | `context.ts` |
| 插件之间怎么互相通知？ | 公共类型化总线 + 内核私有总线  | `events.ts`  |
| 插件怎么不留垃圾？     | `EffectScope` 逆序回收 + Abort | `effect.ts`  |

一句话原理：**内核只认「某个服务名出现或消失」这一个信号**，其余生命周期行为全部由它推出。

## 2. 文件职责

| 文件              | 行数 | 职责                                                                                                                                                                              |
| ----------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`    | 41   | 唯一公共出口（barrel）；**不导出 `InternalBus`**                                                                                                                                  |
| `src/types.ts`    | 145  | `Disposable`(`:9`)、`PluginState`(`:24`)、`Inject`、`ConfigSchema`、`PluginDefinition`(`:56`)、`PluginRecord`(`:74`)、`Events`（空接口）、`definePlugin`、`normalizeInject`       |
| `src/context.ts`  | 630  | `Context`(`:212`)、`ServiceScope`/`ServiceEntry`、`ServiceGrant`、`RESERVED_SERVICES`(`:67`)、`ServiceObserver`(`:101`)、`Diagnostics`(`:146`)、`installServiceAccessors`(`:617`) |
| `src/runtime.ts`  | 458  | `PluginRuntime`(`:30`)：加载、调度、激活、停用、卸载、授权、晚绑定、重试                                                                                                          |
| `src/app.ts`      | 59   | `createApp`(`:26`)：根 record + 根 Context + Runtime + 预置 grants                                                                                                                |
| `src/events.ts`   | 268  | `EventBus`(`:80`)：5 种分发模式、监听排序、分发监视器                                                                                                                             |
| `src/effect.ts`   | 71   | `EffectScope`(`:15`)：逆序回收                                                                                                                                                    |
| `src/internal.ts` | 47   | `InternalBus`：私有 `service`/`plugin`/`error`                                                                                                                                    |
| `src/config.ts`   | 45   | `deepMerge`(`:16`)、`resolveConfig`(`:35`)                                                                                                                                        |
| `src/service.ts`  | 13   | `abstract class Service`（构造即 provide）——**全仓无使用者**，`extends Service` 命中数为 0                                                                                        |

## 3. 数据结构：三棵树 + 两张全局表

```text
插件实例树   PluginRecord.parent  /  Context.children      ← 谁创建了谁，销毁谁
服务作用域   ServiceScope.parent  →  Map<name, ServiceEntry>  ← 谁能看见谁、谁能遮蔽谁
副作用桶     EffectScope.items    （数组，逆序释放）        ← 回收什么

全局一份：grants（pluginId → 服务名 → override 位，挂在 PluginRuntime 上）
全局一份：ServiceObserver / Diagnostics（子 Context 一律沿用父实例）
```

**最关键的一点：前两棵树可以不对齐。** `activate` 给插件建的 Context 复用 `record.parentCtx.scope`（[runtime.ts:335](../packages/kernel/src/runtime.ts#L335)），只有 `fork()` 才新建一层。于是：

| 关系                       | 结果                                      |
| -------------------------- | ----------------------------------------- |
| 同层（如全部应用级插件）   | 彼此可见，且**同名 `provide` 直接抛冲突** |
| 跨层（Realm 内 vs 应用级） | 不算冲突，是**合法遮蔽**，`get` 就近取    |

这就是每个文档都能持有自己的 `document`/`history` 的前提——它们是保留服务，但各自写在自己那一层，闸门 4 查不到彼此（[runtime.spec.ts:150-161](../packages/kernel/tests/runtime.spec.ts#L150)）。

`Context` 构造器（[context.ts:267](../packages/kernel/src/context.ts#L267)）把继承规则写死在四行赋值里：`bus`、`internalBus`、`services`、`diagnostics` 沿用父实例（保证事件与晚绑定看得到全局）；`scope`、`abort`、`effects` 各自新建（保证能独立遮蔽、独立中止、独立回收）。

## 4. 插件定义与实例元数据

```ts
interface PluginDefinition<S = unknown, C extends Context = Context> {
  name: string // 必须与 manifest.name 一致
  inject?: string[] | Inject // 数组写法 = 全部必需
  provides?: string[] // 仅用于静态依赖图与构建期校验
  schema?: ConfigSchema<S> // 只需实现 parse
  apply(ctx: C, config: S): void | Promise<void>
}
```

出处 [types.ts:56](../packages/kernel/src/types.ts#L56)。三条容易被误读的语义：

- **`provides` 不参与运行时校验**，只是声明；真正生效的是 `apply` 里的 `ctx.provide`。
- `ConfigSchema<S>` 只要求 `parse(input): S`，zod 天然满足。全仓只有两处实现：`service-document`（缺 id/schema 直接抛错）与 `canvas-snap`（逐项回落默认值，注释说明「不让整份配置解析失败」）。注意 `canvas-drag` 等处的 `schema: {}` 是 `CanvasSetting.schema`（设置表单的 JSON Schema），与插件配置解析无关。
- `definePlugin` 是恒等函数，只为推断 `S`。

`PluginRecord`（[types.ts:74](../packages/kernel/src/types.ts#L74)）里 **`id` 才是唯一键**：默认 `${name}#${seq}`（[runtime.ts:115](../packages/kernel/src/runtime.ts#L115)），同一插件可以有多个实例——这是每个 CanvasRealm 各装一份 `canvas-*` 的前提。`record.context` 是可空双向指针：record 是持久元数据，context 是可销毁重建的执行体，「停用再激活」因此成立。新增的 `activatedAt` / `applyMs` 记录装配时刻与耗时，**停用时不清零**，devtools 要看到「上一次尝试」而不是空白。

## 5. 状态机

```text
                 ┌──────────────── 服务出现且依赖齐 ───────────────┐
                 ↓                                                │
load ──→ loading ──→ [schedule] ──→ applying ──→ active ──→ disposing ──→ disposed
                        │                │            │
                        │                │            └─ 依赖服务身份变化 → pending（回收）
              必需依赖缺失 │                │ apply 抛错
                        ↓                ↓
                     pending           failed（保留 error / attempts，可 retry）
```

七状态定义在 [types.ts:24](../packages/kernel/src/types.ts#L24)。值得记住的转移细节：

| 情况                                | 行为                                                                                                      | 位置                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------- |
| `apply` 期间被 abort 或状态已被改动 | 不写入 `active`，直接返回（`state !== 'applying'` 与本地 `abort` 两道检查）                               | `runtime.ts:363`     |
| 配置阶段抛错                        | `fail(record, error, 'config')`，不进 apply，**不计 `attempts`、不写耗时**                                | `runtime.ts:344-350` |
| `unload` 一个实例                   | 先 `deactivate(record, 'pending', emit=false)`，再置 `disposed` 并从 `parent.children` 摘除，只发一次事件 | `runtime.ts:151-161` |
| 同 id 重复加载                      | 抛 `[lowcode] 插件实例 id 重复`                                                                           | `runtime.ts:116-118` |
| `deactivate` 进入时的第一件事       | **先置 `disposing` 再 abort**：回收副作用会同步广播服务消失，`onServiceChange` 可能重入本方法             | `runtime.ts:444-447` |
| `retry(id)`                         | 只接受 `pending` / `failed`；清 `error`、回 `loading`、先发状态事件再排程                                 | `runtime.ts:201-211` |

## 6. 激活算法（`PluginRuntime.activate`，[runtime.ts:302](../packages/kernel/src/runtime.ts#L302)）

按代码顺序：

1. 已 `active/applying/disposing/disposed` → 直接返回。`loading`/`pending`/`failed` 允许进入。
2. **依赖检查读父上下文**，不读自己上次激活残留的服务：`record.parentCtx.get(name)`（`:316-318`）。缺失 → `pending` 返回。
3. 快照 `resolved`：必需 + 可选依赖的当前实例存进 `Map`（`:324-329`），供后续判断「服务身份是否真的变了」。
4. 新建 `AbortController` 与子 `Context`，**共享父 scope、父 bus、父 internalBus**（`:331-339`）。每轮都重建，上一轮的副作用带不过来——依赖变化引起的重启走的是同一条路径。
5. `resolveConfig(definition, rawConfig, context.collectIntercepts())`（`:346`）：原始配置 → 子树 intercept → `schema.parse`。顺序是刻意的，见 §14。
6. `state = 'applying'`、`attempts += 1`、记 `activatedAt`，`await definition.apply(ctx, config)`（`:352-360`）。
7. 成功 → 写 `applyMs` + `active` + 发内部 `plugin` 事件；抛错 → `fail(..., 'apply')`。

### 6.1 调度：微任务批

`schedule`（[runtime.ts:274](../packages/kernel/src/runtime.ts#L274)）把 id 入 `queue`，**仅当队列此前为空**才起一批任务：`await Promise.resolve()` 后取快照、清队列、`Promise.all` 逐个 activate。注释给出原因：`apply` 里同步 `ctx.plugin(...)` 时新实例只进队列，不会在当前调用栈上再激活一轮。

### 6.2 `whenIdle` 的边界

`whenIdle`（`:172`）循环 `await Promise.all([...pending])` 直到集合为空。因为激活过程中新产生的任务也被 `track`（`:289`）进 `pending`，bootstrap 一次 `await` 就能拿到整棵传递依赖树的成果，不需要外部延时。

但**它不等停在 `pending` 的插件**：依赖始终没补齐的实例不在追踪范围内，`whenIdle` 会正常返回。所以「await 之后还缺服务」不是 bug，而是那个插件的依赖本来就没满足。

### 6.3 服务驱动：唯一的生命周期信号

`PluginRuntime` 构造时只订阅一条内部事件（`:57`），`onServiceChange`（`:383`）分两支：

- **服务出现**：遍历所有 `pending` 记录，依赖齐了就重新 `schedule`。
- **服务消失**：遍历 `active/applying` 记录，只要该服务出现在它的必需**或可选**依赖里就考虑停用；再用身份判定 `record.parentCtx.get(name) === record.resolved.get(name)` 决定要不要真的重启。

两个容易忽略的细节：

- **事件里的 `owner` 不采信**（`:380-381` 注释）。判定一律重新按父上下文的作用域链取值，否则别的 Realm 注册同名服务会被误判成本层变化，导致无谓重启。
- **可选依赖也参与停用**（`:396-398`），目的是「避免插件继续持有已失效的服务引用」。`optional` 只意味着不阻塞启动，**不意味着可以拿着失效引用继续跑**。

### 6.4 晚绑定：`ctx.inject(names, cb)`

`runtime.inject`（`:226-264`）：依赖齐 → `ctx.spawn()` 建一个**共享父 scope** 的子上下文并执行 callback；依赖缺失 → 销毁该子上下文，但**不让父插件进入 pending**；再次齐备 → 重新执行。callback 抛错只销毁本轮子上下文并上报诊断（`scope: 'inject'`）。

这给「有 snap 就接吸附，没装就照常拖」提供了不重启主体的接线方式。`canvas-drag` 即声明 `inject: { required: ['canvas','document'], optional: ['snap'] }`（[canvas-drag/src/index.ts:26](../packages/canvas-plugins/canvas-drag/src/index.ts#L26)）。

注意订阅来自全局 `ServiceObserver`，回调里 `queueMicrotask(bind)` 再判定——所以晚绑定的回收比服务消失晚一轮事件循环，测试里需要额外 `setTimeout(0)` 才能观察到（[runtime.spec.ts:222](../packages/kernel/tests/runtime.spec.ts#L222)）。

## 7. Context API 面

`context.ts:212` 起，类注释里的五条不变量逐条对应实现：

| 成员                            | 语义                                                                      | 位置          |
| ------------------------------- | ------------------------------------------------------------------------- | ------------- |
| `get(name)`                     | 沿 scope 链向上找，尊重每层 `filter`（整层跳过），找不到返回 `undefined`  | `:292`        |
| `require(name)`                 | 缺失抛 `[lowcode] 缺少服务 "x"`；只用于硬依赖                             | `:307`        |
| `provide(name, value, opts)`    | 4 道闸门 + 写入 + 双通知，返回 Disposable                                 | `:326`        |
| `effect(factory)`               | 副作用托管；已销毁时工厂不执行                                            | `:370`        |
| `inject(names, cb)`             | 晚绑定，转调 runtime                                                      | `:386`        |
| `on/emit/bail/waterfall`        | 类型化事件；`on` 自动挂 effects 并把 `record` 交给总线做归属              | `:401-435`    |
| `plugin(def, config, opts)`     | 以本 Context 为父加载实例；**返回时还是 `loading`**                       | `:451`        |
| `fork({filter})`                | **新建 scope 层**，用于 Realm 与隔离；不进 `children`                     | `:464`        |
| `isolate(names, overrides)`     | `filter=names` 的 fork + 预置 overrides（自签 grant、`apiVersion:'1.0'`） | `:489`        |
| `intercept(key, patch)`         | 子树级配置覆盖，可嵌套，返回还原句柄                                      | `:508`        |
| `dispose()`                     | abort → 反向卸载 children → 回收 effects；重复调用只生效一次              | `:518`        |
| `spawn()`                       | `@internal`：共享 scope 的子上下文，不进 children                         | `:539`        |
| `collectIntercepts()`           | `@internal`：root→current 链上合并 intercept                              | `:555`        |
| `isGranted`/`isOverrideGranted` | `private`：两条授权来源，提供权与覆盖权分离                               | `:577`/`:594` |

## 8. `provide` 的四道闸门

```text
1. 本层有 filter 且不含该名字   → 抛「不允许在隔离层内提供」
2. 属于 RESERVED_SERVICES 且无 grant → 抛「需要 ServiceGrant」
3. 保留服务未声明 apiVersion    → 抛「保留服务必须声明 apiVersion」
4. 同层已有提供者：未 replace → 抛冲突；replace 但无 override 授权 → 抛「覆盖需要 override 授权」
```

出处 `context.ts:327-344`。授权判断有两条来源（`isGranted` `:577`）：调用方每次传入的 `grant`（loader 逐次签发、`isolate` 自签），或回落到 root runtime 的常驻表（`createApp` 的 grants 预置）。显式 `grant.pluginId` 必须等于当前 `record.name`，否则视为拿别人的授权来注册，直接抛错。

`grant` 的键是**插件逻辑名而非实例 id**（[runtime.ts:66-68](../packages/kernel/src/runtime.ts#L66)），所以同一插件的多个实例共享同一份授权。

**Disposable 的精细语义**：`provide` 的回收函数先比较 `this.scope.services.get(name) !== entry`（`:357`）——只删自己注册的那条，因此 `replace` 场景里被覆盖者的 dispose 不会误删后来者。

**`RESERVED_SERVICES` 当前 24 项**（`context.ts:67-92`）：`material setter renderer dataSource command action document history selection designer canvas snap http storage audit policy quota secrets flags telemetry loader contribution modules workspace`。与契约层 15 个服务名的两处差异都是有意的：

- `http`、`storage`、`telemetry` 等**尚未实现**的名字先占住，避免将来加平台能力时撞上「第三方插件早已提供同名服务」的破坏性变更；
- `expression`、`keybinding` **不在名单内**，允许插件替换实现。它们由 `service-expression`/`service-keybinding` 无 grant 直接 provide，与契约层把两者声明为应用级必选并不矛盾（类型面必选，运行时不保留）。

名单的意义不是防住同 realm 的恶意代码（它做不到），而是把「无意间覆盖 `canvas`/`history`」变成启动即抛错，详见 [03 §9](./03-design-principles.md#9-保留服务--servicegrant防误用不防攻击)。

## 9. 隔离与覆盖：四种手段各解决什么

| 手段                        | 换 scope    | 换 effects/signal | 隔离什么           | 典型用途                  |
| --------------------------- | ----------- | ----------------- | ------------------ | ------------------------- |
| `fork({filter})`            | ✅ 新建层   | ✅                | 服务可见集合       | EditorRealm / CanvasRealm |
| `isolate(names, overrides)` | ✅ 带白名单 | ✅                | 指定服务换成假实现 | 预览、测试替身            |
| `spawn()`（`@internal`）    | ❌ 共享     | ✅                | 只隔离回收边界     | `inject` 回调的作用域     |
| `intercept(key, patch)`     | ❌          | ❌                | 配置，不换实现     | 租户覆盖、灰度、测试注入  |

`fork` 出来的 Context **不进 `children`**（它不是插件实例），创建方必须自己 `dispose`。workspace 的做法是把 Realm 的回收挂回应用树：`ctx.effect(() => ({ dispose: () => realm.dispose() }))`（[service-workspace/src/index.ts:148](../packages/services/service-workspace/src/index.ts#L148)），调用点见 `:78` 与 `:108`。

`isolate` 的授权是个刻意的口子：`overrides` 通常是保留服务，直接 provide 会被闸门 2 拦下，于是它借「fork 复用父 record」这一点，为 `names` 列出的服务自签一张只在本层生效的一次性授权——名单外的保留服务依然过不了校验。仓库内**目前没有生产调用点**，`filter` 分支只有 `fork` 在用；本文按现状登记，不写成既成用法。

`intercept` 的键是 `definition.name` 而不是实例 id（`resolveConfig` 用它查表），且**配置只在激活时解析一次**：对已 `active` 的插件不生效，要等它因依赖变化或重启重新激活后才读得到。同一 key 重复调用是 `deepMerge` 累积，不是整体替换。

## 10. 事件总线

两条总线，一套分发底座：

- **公共 `bus`（`EventBus`）**：`Events` 表类型化。`Context.on` 把 `this.record` 一并交给 `bus.add`（`context.ts:406`），devtools 才能把事件归属到插件上；直接调 `bus.add` 的内核内部注册没有这个归属。
- **私有 `internalBus`（`InternalBus`，`internal.ts:34`）**：只有 `service` / `plugin` / `error`，`index.ts` 不导出该类。注释说明设计意图：这些事件驱动生命周期调度，**插件拿不到总线引用，因此不能伪造服务出生/消失或插件状态变化**。

五种模式（[events.ts:80](../packages/kernel/src/events.ts#L80)）：

| 模式        | 语义                                | 错误隔离 | 位置   | 现有用途                                                                                    |
| ----------- | ----------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------- |
| `emit`      | 同步广播，逐监听器 try/catch        | 有       | `:132` | `document:change`、`selection:change`、`canvas:gestureEnd`、`palette:toggle` 等             |
| `parallel`  | 全执行并等齐，错误逐个上报不 reject | 有       | `:150` | —（尚无调用点）                                                                             |
| `serial`    | 顺序 await，单个失败不阻断后续      | 有       | `:170` | —（尚无调用点）                                                                             |
| `bail`      | 顺序执行，第一个非 `undefined` 生效 | 有       | `:188` | `canvas:drop`（[CanvasStage.vue:230](../packages/vue/src/components/CanvasStage.vue#L230)） |
| `waterfall` | 前一个返回值喂给下一个              | **无**   | `:213` | —（上报监视器后原样抛出）                                                                   |

三个必须知道的差异：

1. **`waterfall` 不隔离错误**，任一监听器抛错会中断整条管线并让 Promise reject，调用方必须自己兜住；其余四种模式只记日志继续。
2. **`bail`/`waterfall` 的 `args` 是 `unknown[]`**：这两个模式为了拿到泛型返回值放弃了参数推断，只有 `on`/`emit` 是全类型化的。
3. `emit` 不等返回值，所以它的观测耗时只含同步部分。

排序：`compareListeners`（`:264`）先看 `prepend`（布尔差值），再按 `priority` 降序；`add` 每次插入后立即 `sort`。存储层监听器写成 `(...args: never[]) => unknown`（`:10`），任意具体签名都能赋值进来，调用点由 `invoke`（`:67`）统一转 `unknown[]`，类型安全由出入口的 `Events` 表保证。`snapshot(name)`（`:259`）在每轮分发前复制数组，因此在监听器里增删监听不会破坏本轮迭代。

## 11. 回收：EffectScope 三条规则与销毁顺序

`effect.ts:7-14` 把规则写在注释里：

1. **后注册先释放**（`:62` 倒序循环），符合「依赖方先于被依赖方销毁」。
2. **关闭后 `add` 立即回收**（`:30-38`），防止异步 apply 在卸载后留下无人认领的资源。
3. **关闭后 `effect(factory)` 不执行工厂**（`:45-48`，返回空 Disposable），防止卸载后再发请求或起定时器。

单个回收函数抛错被捕获上报，不阻断后续回收；`dispose()` 幂等。

销毁顺序三条硬规则：

1. `Context.dispose`（`context.ts:518`）：**先 abort，再反向卸载 children，最后回收 effects**。`disposed` 与 `signal.aborted` 两个守卫必须分开——`runtime.deactivate` 是「先 abort 后 dispose」，若 `dispose` 一开始就看 `aborted`，回收会被短路。
2. `runtime.unload`：先 `deactivate(..., emit=false)`，再显式发一次 `disposed`，避免 `pending → disposed` 双事件（`runtime.ts:155-160`）。
3. `runtime.dispose`（应用销毁）：按 `records` 插入序**反向** `unload`（`:184-189`），尽量让依赖别人服务的实例先停。

实测顺序断言见 [runtime.spec.ts:97](../packages/kernel/tests/runtime.spec.ts#L97)：`['child', 'parent-2', 'parent-1']`——子插件先于父副作用，父副作用按注册逆序。

## 12. 配置合并

`deepMerge`（[config.ts:16](../packages/kernel/src/config.ts#L16)）：仅对**纯对象**递归合并，数组与标量整体替换。理由是配置里的数组通常表示一个完整策略（如 `allowedHosts`），拼接会产出用户无法从任何单项推导的结果。`isPlainObject`（`:3`）只认 `Object.prototype` 或 `null` 原型，所以 `Map`/`Set`/类实例在合并时同样是**整体替换**而非展开。

`resolveConfig`（`:35`）：`deepMerge(rawConfig ?? {}, intercepts.get(definition.name))` → 无 `schema` 直接返回，有则 `schema.parse(merged)`。**intercept 必须排在默认值展开之前**，否则覆盖值会被 schema 的默认值吞掉。

## 13. 观测面（devtools 与错误面板用）

内核为观测加了四个入口，共同约束是**只读不干预生命周期**：

| 能力                          | 位置                                                | 说明                                                                                                    |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Diagnostics.onChange`        | `context.ts:196`                                    | 实时订阅新记录，不必轮询 `list()`；只通知 `report` 新增，回放历史仍走 `list()`                          |
| `Diagnostics.report` 错误隔离 | `context.ts:173-181`                                | 订阅者抛错只记日志，保证 `report` 对外「不抛错」的约定不被展示层破坏                                    |
| `EventBus.monitor`            | `events.ts:126`                                     | 每次监听器执行产生一条 `EventDispatchRecord`（事件名、模式、归属 `pluginId`、耗时、错误、当轮监听器数） |
| 零开销开关                    | `events.ts:237-238`                                 | `tracker()` 在无监视器时返回 `undefined`，热路径不取时间戳、不建记录                                    |
| `PluginRuntime.retry`         | `runtime.ts:201`                                    | 只重排 `pending`/`failed`；`active` 重启会连带重建整棵子树，属宿主级决策，不由本方法承担                |
| `activatedAt` / `applyMs`     | `types.ts:97-104`、`runtime.ts:354-365`、`:423-425` | 成功与失败都留耗时，用于区分「秒失败」与「卡住后被中止」；配置阶段失败发生在装配之前，因此不写耗时      |

`fail` 的写法顺序也是有意的：**先上报 `error`，再改状态**，这样 devtools 收到状态事件时错误与出错阶段已经落定（`runtime.ts:412-418`）。

现状：`packages/devtools/` 只有一个 `package.json`，上述能力**尚无仓内消费者**，但都有测试覆盖（见 §16）。另外 `InternalErrorPayload` 允许 `phase: 'dispose'`，而 `runtime.fail` 只发 `'config' | 'apply'`——`'dispose'` 目前无发送方。

## 14. 一次启动（内核视角骨架）

完整宿主流程见 [02 运行时流程](./02-runtime-flow.md)，这里只留内核视角的七步：

| 步  | 位置                                            | 内核行为                                                                                                                                                 |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `bootstrap.ts:97` → `context.ts:617`            | 在 `Context.prototype` 上装服务 getter，把声明合并接到 `get`（模块级 Set 保证只装一次）                                                                  |
| 2   | `bootstrap.ts:99` → `app.ts:26`                 | 建根 Context（空 scope、两条总线）→ `new PluginRuntime` → **构造即订阅 `service`** → 逐条 `grant(GRANTS)`                                                |
| 3   | `:101` `context.plugin(presetDesigner)`         | 只登记，返回 `loading`；不检查依赖、不建 Context                                                                                                         |
| 4   | `:102` `await whenIdle()`                       | 微任务批里跑 `apply`，九个服务插件并入同一批；依赖齐的激活并 `provide`，缺依赖的停在 `pending`，服务一出现就被重新调度                                   |
| 5   | `:107-113` `createEditorRealm`                  | `ctx.fork()` 出新层，层内挂 document/history/selection（保留服务各写各层，互不冲突）                                                                     |
| 6   | `:115-117` `createCanvasRealm` + `presetCanvas` | 再 `fork()` 一层；`inject: ['canvas','contribution','modules']` 一次 `get` 跨两层——本层取 canvas，沿链穿透到应用层                                       |
| 7   | 关闭文档                                        | `realmCtx.dispose()` → abort → 逆序 unload 画布层插件 → 逆序回收 effects → 每次注销发 `service(undefined)` → 其他 Realm 里身份变了的依赖者退回 `pending` |

**没有一行代码在「通知谁该卸载」，全靠服务消失驱动。**

## 15. 容易踩的点

1. `ctx.plugin()` 返回时服务还不存在，必须 `await whenIdle()`；但 `whenIdle` 不为停在 `pending` 的插件等待。
2. `waterfall` 会 reject，其他四种模式不会。
3. `bail`/`waterfall` 丢了参数类型推断（`unknown[]`）。
4. 契约层声明为必选的应用级服务，运行时 `ctx.xxx` 仍可能是 `undefined`——访问器走 `get` 不走 `require`。真正的硬保证在 bootstrap 的 `context.require('loader')`。
5. `intercept` 对已激活插件无效（配置只在 `activate` 解析一次）。
6. `inject` 的 `optional` 依赖消失同样会停用依赖者，「可选」不等于可以拿着失效引用继续跑。
7. 兄弟插件同层提供同名服务直接抛错，只有跨层才是遮蔽。
8. `get` 对带 `filter` 的层是**整层跳过**，不是逐项比对；隔离层名单外的服务照样能从父层解析到。
9. `isolate` 的 overrides 键必须来自 `names`，否则撞闸门 1。
10. 晚绑定的回收比其他副作用晚一轮事件循环（`queueMicrotask`），测试里要 `setTimeout(0)` 才观察得到。
11. `fail` 的配置阶段失败不计 `attempts`、不写耗时——`attempts` 只统计真正跑过 `apply` 的次数。
12. 观测计时用了全局 `performance.now()`（`events.ts:137`）。仍然零第三方依赖，但 `index.ts` 头注释「不依赖 DOM、Node API」这句在严格意义上需要留意：无 `performance` 全局的环境要加垫片。

## 16. 测试覆盖

`packages/kernel/tests/` 共 5 个 spec，都不依赖任何业务包即可运行——这是「内核零依赖」的直接收益：

- `runtime.spec.ts`：生命周期、装配耗时（`activatedAt`/`applyMs` 四例）、`retry`（三例）、作用域与隔离、保留服务授权、`ctx.inject`。
- `events.spec.ts`：五种分发模式、排序、`dispose` 后不再收到事件、**事件监视器**（归属、错误记录、`waterfall` 上报后继续抛、监视器自身抛错不影响分发）。
- `effect.spec.ts`：逆序回收与关闭后行为。
- `config.spec.ts`：`deepMerge`、`intercept` 与 schema 默认值的先后。
- `diagnostics.spec.ts`：`report` 上限淘汰、`list` 快照、`onChange` 订阅与抛错隔离。

## 17. 内核不做的事

明确划出边界，避免把内核当万能容器：

- **不做依赖图求解 / 拓扑排序**：只有「缺依赖 → pending → 服务出现时重试」这一条规则，顺序由各插件的 `inject` 声明自然收敛。
- **不做异步并发去重**：`loader.activate` 在 `load()` 之后才写 `activated` 表，同一插件被并发激活可能重复装配（[service-loader/src/index.ts:326-329](../packages/services/service-loader/src/index.ts#L326) 的注释承认了这点，建议改为 pending Promise 去重）。
- **不做自动重试**：`apply` 抛错就停在 `failed`，`attempts` 只增不退避；重试是显式 `runtime.retry(id)`，由宿主或 devtools 决定。
- **不做沙箱**：同 realm 的插件在 JS 层面拦不住，`RESERVED_SERVICES` 只防误用。
- **不做配置持久化 / 远程下发**：`intercept` 是进程内的子树覆盖，来源由宿主决定。
- **不管理 DOM**：`Context` 里没有 DOM；画布舞台挂载由 `@lc/canvas` 的 `attach` 完成。
- **不认识业务**：服务名清单、事件名清单、配置结构都在 `@lc/contracts`，内核只提供机制。
