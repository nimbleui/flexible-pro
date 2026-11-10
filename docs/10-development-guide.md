# 10 开发指南

面向「要在这个仓库里加东西」的读者。配方全部对照现有插件的真实写法，不引入仓库里不存在的模式。

## 1. 环境与命令

| 项        | 值                                                           | 出处                      |
| --------- | ------------------------------------------------------------ | ------------------------- |
| 包管理    | `pnpm@10.33.0`（`corepack` 可直接对齐）                      | `package.json:13`         |
| Node      | 开发机 v24；仓库未写 `engines`，**不要依赖未声明的版本特性** | 根 `package.json`         |
| workspace | `packages/*`、`packages/*/*`、`apps/*`                       | `pnpm-workspace.yaml:1-4` |

```bash
pnpm install
pnpm dev            # 并行拉起 @lc/host(5173) 与 @lc/designer(5174)，绑 0.0.0.0
                    # 本机 http://localhost:5173，局域网 http://<本机 IPv4>:5173
pnpm dev:host       # 只起主应用；此时画布区域显示「画布模块不可用」提示
pnpm dev:canvas     # 只起画布远程模块（无独立页面，只能被宿主取模块）
pnpm build          # 先 build 远程，再 build 宿主；生产必须带 VITE_DESIGNER_ENTRY
pnpm preview        # 两个应用并行 vite preview，同样绑 0.0.0.0
pnpm typecheck      # vue-tsc --noEmit -p tsconfig.json（全仓）
pnpm test           # vitest run
pnpm test:watch
pnpm format         # prettier --write .
pnpm format:check
```

CI（`.github/workflows/ci.yml:21-34`）依次跑 install / typecheck / test / format:check，并在 `format:check` 之后新增一步 `Build (MF host + remote)`：带 `env.VITE_DESIGNER_ENTRY: http://localhost:5174/remoteEntry.js` 占位地址验证可构建。该值只保证 CI 产出可构建产物，生产部署必须覆盖为部署后的 `remoteEntry.js` 完整地址。

| 变量                  | 作用期 | 说明                                                                                                                                                                                                        | 出处                             |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `LC_DEV_HOST`         | 运行期 | 多网卡时指定 dev 用哪个 IP 作为远程地址基准（默认取第一个非回环 IPv4）；改了要重启 dev                                                                                                                      | `apps/host/vite.config.ts:16-27` |
| `VITE_DESIGNER_ENTRY` | 构建期 | 宿主里远程 `remoteEntry.js` 的地址；`vite build` 下不设置该变量会直接抛错，不再烧 IP；CI 用占位地址 `http://localhost:5174/remoteEntry.js` 验证可构建，生产部署必须显式给部署后的 `remoteEntry.js` 完整地址 | `apps/host/vite.config.ts:29-50` |

没有 lint（仓库未配置 ESLint），质量闸门是 **prettier + vue-tsc + vitest** 三件。

## 2. 加一个画布能力插件

以 `canvas-guides`（最简单的纯消费者）为模板。**四步，零改动宿主**：

### 2.1 建包

```text
packages/canvas-plugins/canvas-<name>/
├─ package.json
└─ src/
   ├─ index.ts        # 插件定义（默认导出）
   ├─ manifest.ts     # export const manifest
   ├─ overlay.ts      # 可选：覆盖层渲染函数
   └─ constants.ts    # 可选：设置 id 与常量
```

`package.json` 的要点（照抄同类包）：`name: "@lc/canvas-plugin-<name>"`、**`exports` 直指 `./src/index.ts` 与 `./src/manifest.ts` 子路径**、依赖只写 `@lc/contracts`、`@lc/kernel`（+ 需要时 `@lc/canvas` / `@lc/schema` / `@lc/vue` / `@lc/shared`）。工作区 glob 会自动收录，无需注册。

### 2.2 manifest

```ts
import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-<name>', // 必须等于 definition.name
  displayName: '中文名',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' }, // assertManifest 必填
  main: './src/index.ts', // 有 apply 才写；纯声明式省略
  activationEvents: ['onCanvasFeature:<featureId>'],
  certification: 'platform',
  executionProfile: 'inline',
  uiReview: 'inline',
  contributes: {
    canvasFeatures: [
      {
        id: '<featureId>',
        title: '中文名',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 60, // 决定装配先后 → 同优先级下的分发顺序
        requires: ['canvas'],
      },
    ],
  },
}
```

对照真实样例：`packages/canvas-plugins/canvas-guides/src/manifest.ts:1-25`。

### 2.3 插件定义

```ts
import { defineCanvasPlugin } from '@lc/contracts'
import { manifest } from './manifest'

export { manifest }

export default defineCanvasPlugin({
  name: 'canvas-<name>',
  inject: { required: ['canvas'], optional: ['snap'] }, // 可选依赖用 optional，别 require

  apply(ctx) {
    // 一切注册都要包进 ctx.effect，卸载自动回收
    ctx.effect(() =>
      ctx.canvas.layers.register({
        id: 'canvas-<name>.overlay',
        band: 'guides',
        pointerEvents: 'none',
        visible: (frame) => (frame.snap?.guides.length ?? 0) > 0,
        load: () => Promise.resolve({ default: Overlay }),
      }),
    )
  },
})
```

可直接抄的注册面（每个都返回 `Disposable`）：

| 想做的事           | 用哪个 API                                                                                | 真实调用点                                                        |
| ------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 响应指针/滚轮/键盘 | `canvas.interaction.register({ id, phase, priority, when, handle })`                      | `canvas-zoom/src/index.ts:70`                                     |
| 接管一段手势       | `canvas.interaction.beginGesture({ onMove, onFinish })`                                   | `canvas-pan/src/index.ts:72`、`canvas-drag/src/index.ts:139`      |
| 画东西             | `canvas.layers.register({ band, visible, load })`                                         | `canvas-grid/src/index.ts:26`                                     |
| 存共享状态/预览    | `canvas.settings.register({ id, title, scope, schema, default })` + `set/get/onDidChange` | `canvas-grid/src/index.ts:16`、`canvas-selection/src/index.ts:53` |
| 右键菜单项         | `canvas.contextMenu.register(item)`                                                       | `canvas-context-menu/src/index.ts`                                |
| 写文档（手势）     | `canvas.transaction.begin({ label, owner })` → `preview` → `commit/cancel`                | `canvas-drag/src/index.ts:128`                                    |
| 写文档（命令）     | `document.apply(patches, { record: true, label })`                                        | `canvas-align/src/index.ts`                                       |
| 提供吸附候选       | `snap.registerProvider({ id, getCandidates })`                                            | `canvas-snap/src/index.ts:61-70`                                  |
| 暴露命令           | `ctx.command.register({ id, title, enabled?, run })`                                      | `canvas-zoom/src/index.ts:123`                                    |
| 绑快捷键           | `ctx.keybinding.register({ id, key, command })`（**先判空**）                             | `canvas-zoom/src/index.ts:171-178`                                |
| 订阅事件           | `ctx.on('canvas:drop', …)`                                                                | `canvas-drop/src/index.ts:56`                                     |

### 2.4 登记进宿主

`apps/designer/src/canvas-plugins.ts:24-40` 的 `CANVAS_PACKAGES` 加一行 `{ manifest: xManifest, load: () => import('@lc/canvas-plugin-<name>') }`，并在 `apps/designer/package.json` 加 `"@lc/canvas-plugin-<name>": "workspace:*"`。宿主侧的业务 / 物料 / 面板包登记在 `apps/host/src/bootstrap.ts:74-95` 的 `BUILTIN_PACKAGES`（12 项）。仓库里**不存在** `apps/designer/src/bootstrap.ts`；该目录只有 `canvas-plugins.ts` 与 `CanvasModule.vue`。

> 这一步是骨架阶段的替代实现：设计稿要求由 Vite 插件扫描 `package.json.lowcode` 生成 `virtual:lowcode-plugins`（`packages/contracts/src/services/loader.ts:5-9`），当前尚未实现。

### 2.5 验收清单

- [ ] `manifest.name === definition.name`（不一致会在激活时抛错并发 `plugin:failed`）。
- [ ] 所有注册都在 `ctx.effect` 内。
- [ ] `interaction.register` 的 `id` 全局唯一；`layers`/`contextMenu`/`settings` 的 id 重复都会**抛错**，同前缀命名 `<plugin>.<thing>`。
- [ ] 用了 `priority`/`phase` 就在注释里写清为什么是这个数（对齐 `canvas-drag/src/index.ts:86-89` 的写法）。
- [ ] 卸载该插件后画布不报错（可选依赖必须走 `optional` 或 `ctx.get`）。
- [ ] 纯逻辑（几何、变换、解析）抽成独立 `.ts` 并加 spec —— `.vue` 文件不在 vitest 覆盖范围内。

## 3. 加一个面板插件

```text
packages/plugins/plugin-panel-<name>/
├─ package.json                     # exports: "." + "./manifest"
└─ src/
   ├─ manifest.ts                   # contributes.panels: [{ id, title, slot, module, order }]
   ├─ index.ts                      # export { default } from './XxxPanel.vue'
   └─ XxxPanel.vue                  # <script setup> + <style scoped>
```

面板内取服务：

```ts
const ctx = useAppContext() // 拿到的是 ContextScope 注入的 EditorRealm 上下文
const document = ctx.get<DocumentService>('document') // 可空取值，别用 require
const selection = ctx.get<SelectionService>('selection')

const version = ref(0)
const bump = () => {
  version.value += 1
}
onMounted(() => {
  if (document) disposables.push(document.onDidChange(bump))
  if (selection) disposables.push(selection.onDidChange(bump))
})
onUnmounted(() => disposables.forEach((d) => d.dispose()))

const rows = computed(() => {
  version.value
  return buildOutlineTree(document!.model.schema)
})
```

写回只有一个入口：`document.apply(patches, { record: true, label })`，**不允许直接改 `document.model.schema`**。

`activationEvents` 必须写 `onPanel:<panelId>`，否则 `Slot.vue:117` 的懒激活不会触发；`slot` 只能取 `SLOT` 里的九个值之一（`packages/contracts/src/slots.ts:7-55`），要新槽位先按「契约常量 → 宿主插槽 → 插件声明」的顺序加，插件不许自定义宿主不认识的字符串。

一个包只能贡献**一个**面板组件：`collectModules` 把每个 `module` 字符串都登记成 `插件名/模块路径`，但加载器一律指向同一个 `pkg.load`（`service-loader/src/index.ts:322-329`），`Slot.vue` 再取 `module.default`——两条 `panels` 贡献写不同 `module` 也只会拿到同一个组件。右侧四个页签因此是四个包而不是一个包四行贡献。

## 4. 加一个物料包

物料是**纯数据 + 一个组件模块**，最省事：

```ts
// manifest.ts —— 不写 main，不写 apply
contributes: {
  materials: [{
    name: 'Badge',                     // 全局唯一，建议带命名空间
    title: '徽标',
    category: '数据展示',
    props: { type: 'object', properties: { value: { type: 'number', title: '数值' } } },
    module: './src/index.ts',
    snippet: { id: 'badge-1', componentName: 'Badge',
               layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 80, height: 32 } },
               props: { value: 5 } },
    container: false,
    allowedParents: ['Box'],           // 空/省略 = 不限制
    priority: 10,                      // 同名物料冲突时决胜
  }],
}
```

```ts
// src/index.ts —— 名字表，多物料可共享一个模块
export const components = { Badge }
export default { components }
```

要点：`props` 是 JSON Schema，属性面板据此生成控件（`format: 'color' → color`、`enum → select`，其余按 `type`，见 `PropertiesPanel.vue:72-87`）；`snippet` 决定拖入时生成的节点；`container: true` 才会被 `canvas-drop` 判为可投递空容器（`service-canvas-core/src/index.ts:86-92`）。

容器物料还可以声明 `slots: [{ name, title, region?, accepts?, maxChildren? }]`（类型来自 `@lc/schema` 的 `SlotDefinition`，与自定义组件蓝图 `ComponentSchema.slots` 同源），说清「往里放的时候有哪几格可选」。拖入命中该容器时，`canvas-drop` 按 `region`（相对容器矩形的比例，0–1；省略表示覆盖整块）决定写到 `node.slots[<name>]` 还是 `children`，`accepts` 与 `maxChildren` 在这一步生效。渲染层按声明分组（`vue/src/render/slots.ts` 的 `splitSlotChildren`），画布与运行时预览把分组结果作为**具名插槽**传给组件，组件内部放一个 `SlotOutlet` 物料（同样的插槽名）标出接收区；没声明的插槽名与 `children` 继续平铺，不会因为「组件没格子」被吞掉。插槽内容归页面所有，所以组件实例改尺寸时这一层不参与重排。

## 5. 扩展平台契约（**有摩擦，是故意的**）

| 要加的东西  | 必须同时改的位置                                                                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务名      | `Context` 接口（`contracts/src/contexts.ts:25-58`）+ `SERVICE_NAMES`（`:99-115`）+ 若属内核语义则加 `RESERVED_SERVICES`（`kernel/src/context.ts:56-92`）+ 宿主 `GRANTS`（`apps/host/src/bootstrap.ts:28-40`）；画布插件的授权由远程自签（`apps/designer/src/canvas-plugins.ts:49-52`） |
| 业务事件    | 只允许改 `contracts/src/events.ts`（头注释禁止插件自行 `declare module`）                                                                                                                                                                                                              |
| 宿主插槽    | 先加 `SLOT` 常量 → 再加宿主渲染点 → 才允许插件声明（`contracts/src/slots.ts:3-6`）                                                                                                                                                                                                     |
| 贡献点      | 加 `ContributionValueMap` 条目 + 消费方；若该贡献带模块，还要检查 `collectModules`（`service-loader/src/index.ts:165-174`）是否覆盖到新的点                                                                                                                                            |
| `LayerBand` | 契约联合类型 + `BAND_ORDER` **两处必须同时改**，否则 sort 得到 NaN（`canvas/src/layers.ts:4-19`）                                                                                                                                                                                      |

## 6. 编码规范（本项目实际遵循的）

以下不是新约定，是从代码里归纳出的既有纪律，改代码时请保持一致：

1. **注释解释「为什么」**。仓库里几乎所有常量与私有函数都带一条说明取舍或踩坑的注释（例：`viewport.ts:149-150` 为什么不复用矩阵、`context.ts:521-522` 为什么两个守卫要分开、`scheduler.ts:54-55` 为什么不能用真值判断）。interface 与 type 的**每个字段**都要有中文注释，写类型表达不了的约束（`@default` 必须与实现核对过）。
2. **不重复造抽象**。注册表只在真有「同 id 冲突 + 排序 + 变化通知」需求时出现（material / command / setter / contribution / layers / contextMenu，共 6 处）；其余用 `Map` + `Set` + `sorted()` 函数。画布内核一律工厂函数，不用 class。
3. **DOM 与算法分离**。几何/变换/解析逻辑写成纯函数并单测：`canvas-align/src/align.ts`、`canvas-commands/src/operations.ts`、`canvas-rotate/src/rotate.ts`、`canvas-minimap/src/geometry.ts`、`canvas-rulers/src/guides.ts`、`canvas-selection/src/hierarchy.ts`、`vue/src/render/tree.ts`。渲染函数只负责把结果写进 DOM。
4. **依赖方向不可逆**。低层包不得 import 高层；插件不得 import 插件；跨层协作走服务/事件/设置/handle-id。物料语义（`container`）不下沉进画布内核。
5. **失败降级优先于抛错**，但装配错误要抛错。二者分界：`ensure`/`resolveMaterial`/`execute` 返回 undefined 或静默并记诊断；`provide` 冲突、`settings.set` 未注册 id、`transaction.begin` 已有活动事务、`beginGesture` 已有手势——**抛错**。
6. **不绕过类型系统**。生产代码里的收窄断言是 `as Component` **4 处**（`packages/vue/src/components/CanvasStage.vue:177`、`PageRuntime.vue:255`、`SchemaPreview.vue:191`、`Slot.vue:129`）与 `as CanvasContext` **2 处**（`service-canvas-core/src/index.ts:122`、`service-workspace/src/index.ts:136`），另有 `JsExpression` 逃生门的 `new Function` 返回值（`service-expression/src/index.ts:51`，仅在 `allowUnsafeJs` 开启时构造，注释写明授权前提）、3 个 spec 里的 `as unknown as CanvasContext`，以及 `canvas-drag/tests/drag.spec.ts:130` 的测试上下文构造。新增断言必须说明为什么类型无法表达。实质约定未变：收窄只落在 `@lc/vue` 宿主层与服务装配层，没有散落进插件。
7. **样式走语义变量 + 兜底值**：`var(--lc-accent, #2563eb)`。可复用组件一律 `<style scoped>`；画布覆盖层是渲染函数，用内联 `style`。

## 7. 测试

- 位置与命名：`<package>/tests/<topic>.spec.ts`。现有 **110 个 spec 文件**（89 个在 `packages/**`、21 个在 `apps/host`）、**1136 条用例，默认并行 `pnpm test` 实跑 EXIT=0**；`release-store.spec.ts` 的 5s 超时抖动已由本轮把该 suite `timeout` 放宽到 `20_000` 治理（用例体与断言未改），`--no-file-parallelism` 仅作对照、不再是回归基线（详见 README 基线；本次按路径静态清点 spec 数）。`vitest.config.ts:6-10` 是 `plugins: [vue()]` + `include: ['packages/**/tests/**/*.spec.ts', 'apps/**/tests/**/*.spec.ts']` **双 glob** + `environment: 'node'`；`:5` 的注释解释 node 环境仍要 SFC 插件（宿主 store 会经 `@lc/vue` 入口带到 `.vue` 文件）。
- 因此**被测对象必须不依赖 DOM**。需要视口/场景时构造最小 fake（参考 `packages/canvas/tests/snap.spec.ts`、`hitTest.spec.ts`）。
- 优先为「容易错且难在 UI 里发现」的部分写测试：坐标一致性（`coordinates.spec.ts` 钉住闭式公式与矩阵同源）、事务历史语义（`transaction.spec.ts`）、键位匹配（`keys.spec.ts`）、渲染树规则（`renderTree.spec.ts`）。
- `.vue` 组件与交互链路只能**在浏览器里验证**：`pnpm dev` 后按 `docs/02` 的三条数据流逐条走一遍，并检查 `window.__lc.context.diagnostics.list()` 为空。

## 8. 调试

```js
// 非 production 构建下可用（apps/host/src/bootstrap.ts:95-97）
__lc.context // AppContext（宿主根上下文）
__lc.canvas // 当前活动 CanvasRealm，随路由切换写入/清空；未进设计器时 undefined
__lc.context.workspace.listEditors() // 已打开的 EditorRealm 列表
__lc.context.workspace.getEditor('demo-doc').context // EditorContext（含 document / history / selection）
__lc.canvas.context.canvas.viewport.state // { x, y, zoom, rotation }
__lc.canvas.context.document.model // { version, dirty, schema }
__lc.context.diagnostics.list() // 最近 200 条诊断
__lc.context.command.list() // 命令表
__lc.context.loader.scan() // 27 个包 = 宿主侧 BUILTIN_PACKAGES 12 个 + 远程 CANVAS_PACKAGES 15 个
__lc.context.contribution.list('canvasFeatures') // 画布能力装配了什么
```

**面板优先于控制台**：设计器头部「开发者工具」按钮打开 `@lc/devtools`（覆盖式抽屉，不挤压画布）。七个标签页——插件树、服务表、依赖图、事件日志、配置、诊断、画布——数据来自内核观测面（[04 §13](./04-plugin-kernel.md#13-观测面devtools-与错误面板用)），动作只有重试（`pending`/`failed`）、卸载、清空日志。`pending` 先看依赖图（缺哪个服务、候选提供者是谁、有没有环），`failed` 看插件树上的错误行与 `attempts`；事件日志能看出「事件发了但没人监听」（`listenerCount = 0`）与超过单帧预算（16ms）的监听器。接入与边界见 [11](./11-devtools.md)。

排查顺序建议：

| 症状             | 先看                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 某能力没生效     | `contribution.list('canvasFeatures')` 有没有该条；`defaultEnabled`；`order`；`diagnostics` 里 `scope: 'preset-canvas'`        |
| 插件停在 pending | 它的 `inject.required` 是否都在**父上下文**可见（`runtime.ts:316` 读 parent，不读自己）                                       |
| 快捷键没反应     | 焦点是否在可编辑元素（`service-keybinding/src/index.ts:8-18`）；舞台是否 `focus()`；`keybinding` 是否为该插件的可选依赖而未装 |
| 拖拽不进历史     | 是否用了 `record: false`；事务 `commit` 是否被调用（`cancel` 不写历史）                                                       |
| 画面与命中不一致 | `scene.list()` 顺序是否等于 `paintOrder(schema)`；插件是否自行拼了矩阵而没走 `viewport`                                       |
| 覆盖层位置错     | 是否给图层套了 `scale(zoom)`（禁止）；`band`/`zIndex` 是否 ≥10                                                                |

## 9. 已知边界与技术债

诚实清单，评审与排期时按此判断。**这些不是「待优化的好主意」，而是当前实现确实不做的东西**。

### 9.1 设计稿有、代码无

| 项                                                                           | 现状                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 租户/权限/审计/审批、插件市场与签名校验、`iframe`/`worker`/`server` 执行隔离 | 仅有契约字段（`manifest.certification` / `executionProfile` / `uiReview` / `permissions`），**无实现**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 控制面签发 `ServiceGrant`、`engines.lowcode` 版本比较                        | GRANTS 由 `bootstrap.ts` 手工预置；`engines.lowcode` 只校验存在性                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Vite 插件扫描 `package.json.lowcode` 生成 `virtual:lowcode-plugins`          | 仍是两张手工数组：宿主 `apps/host/src/bootstrap.ts:74-95` 的 `BUILTIN_PACKAGES`（12 项）与远程 `apps/designer/src/canvas-plugins.ts:24-40` 的 `CANVAS_PACKAGES`（15 项）                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `canvasProfiles` 贡献点                                                      | 契约完整（`canvas-contributions.ts:343-361`），**无贡献者、无消费方**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 设置持久化与 `lockable` 策略锁定                                             | `settings.ts` 单层内存；`scope` 字段只登记不使用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 项目成员与鉴权、物料与全局函数的运行时按项目隔离、跨项目复制与导入导出       | 项目侧已实现：路由带 `projectId`、五类列表按项目过滤、流程图按项目取已发布版本、发布闸门 + 不可变快照 + 版本指针回滚（`projects/release-model.ts`、`projects/release-store.ts`、`views/ProjectReleaseView.vue`、`views/ProjectRunView.vue`）；接口引用在装载端展开、写回端剥离，发布时定版成字面地址（`apis/api-load.ts`、`packages/schema/src/api.ts`）。仍未实现：成员鉴权（运行时 `permission` 服务是空的）；自定义组件注册进的是应用级物料表、全局函数注册进应用级表达式引擎，所以同名组件跨项目仍被拒、B 项目的页面仍能调到 A 项目的函数；快照只存 localStorage，没有服务端持久化与导出格式 |
| 面板 `when` 条件求值                                                         | 字段保留，宿主注释已声明「骨架阶段暂未求值」（`contribution.ts:28-29`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 表达式/数据源/事件动作的运行时执行                                           | 设计态求值只有 props/condition/loop/directives。运行态有一条已打通的纵切：`@lc/service-action` 执行动作链、`@lc/service-state` 持页面状态、`@lc/vue` 的 `PageRuntime` 在预览页（`/preview/:documentId`）把组件事件接给执行器；`datasources` 与 `functions` 参与运行。设计器画布刻意不接事件、只读声明的默认值                                                                                                                                                                                                                                                                                    |
| `migrateDocument` 接入                                                       | 函数与环检测已实现，无调用点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**版本控制不再属于「设计稿有、代码无」**：`@lc/service-version`（`packages/services/service-version/src/{dag,merge,merge-plan,object,diff,service,tracker,projection}.ts`、`src/store/{idb,memory}.ts`）与宿主 `apps/host/src/projects/version-host.ts`、版本面板 `plugin-panel-version` 均已落地，契约见 [05 §5 版本服务](./05-contracts-and-schema.md)，服务层与插件层见 [07](./07-services.md) / [08](./08-plugins.md)，宿主 rail 与资产 store 见 [09](./09-vue-host.md)。仍未实现的是服务端与环境绑定（P5）、治理接缝、软锁与可达性 GC，逐条见 [13](./13-version-control.md)（**已落地 P1–P3 + 剩余提案**）。默认档位仍为 `off`，删掉 `VITE_LC_VERSION_MODE` 即完整回退。

### 9.2 实现与注释/契约不一致

2026-11-10 逐条复核：4 条**全部仍成立**（标「现状」，按源码符号名重新定位过），没有已修项，也没有描述不准项。

| 不一致                                                                | 两边出处                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 【现状】「覆盖层模块首次可见时加载」                                  | 契约 `canvas-contributions.ts:141`、`canvas-guides/src/index.ts:22-23` 都这么写；实现 `LayerHost.vue` 的 `ensureLayer` 仍由 `:148` 对 `canvas.layers.list()` 全量调用，注释承认代价 |
| 【现状】「主画布、每文档一个」                                        | 契约 `services/workspace.ts:25-26`；实现 `service-workspace/src/index.ts` 的 `createCanvasRealm()`（`:129`）仍不限制调用次数                                                        |
| 【现状】`InternalErrorPayload.phase` 允许 `'dispose'`                 | `internal.ts:18` 的联合类型含 `'dispose'`（`:15` 注释亦自述只在 config / apply 两阶段发出）；`runtime.fail` 仍无 `'dispose'` 发送方                                                 |
| 【现状】`scene.invalidate(nodeIds)` / `scheduler.invalidateLayer(id)` | 参数存在但被忽略（`scene.ts:101` 的 `invalidate()`、`scheduler.ts:120` 的 `invalidateLayer()` 均为无参实现）                                                                        |

### 9.3 结构性技术债

2026-11-10 逐条复核，每条给出状态标签：**「现状」**=仍成立；**「已修」**=代码与回归测试都已落地；**「描述不准」**=问题仍在但原措辞与实现不符，已按源码改写。

1. 【现状】**`layout.mode: 'flow'` 无实现**：`packages/schema/src/styles.ts:122` 的 `mode?: 'flow' | 'absolute'` 仍是契约字段，渲染树不处理 flow 分支，宿主一律绝对定位，`loop` 实例共用同一 rect——**流式布局与真实运行时渲染尚未打通**。
2. 【描述不准】**历史栈无上限，但不是「全量快照」**：`packages/schema/src/patch.ts:63-97` 的 `applyAt` 只克隆 patch 路径上的容器，其余分支保持引用共享；`service-history/src/index.ts:51-53` 的 `before` / `after` 存的是引用，不是深拷贝，`packages/services/service-version/src/tracker.ts:46-48` 的 `createSectionTracker` 还靠 `===` 判等。当前内存增量是 O(路径深度)，**不设栈深上限**（`service-history/src/index.ts:53`）才是长会话待治理点，`service-history/src/index.ts:18-23` 已为 patch 逆向记录留好退路。按「全量快照」引入深拷贝 / immer 会直接破坏引用判等。
3. 【现状】**预览期间 version 每帧自增**：`service-document/src/index.ts` 的 `commitSchema(next, dirty)`（`:83`）无条件 `version: model.version + 1`，`apply` / `restore` 两处调用都不再传 `versioned` 实参（P1 清理死参数，行为不变）；注释自述 version 兼任提交版本号与渲染帧失效信号，「不要改成按 record 决定是否自增」，这是「保持画面跟手的必要代价」；所有靠 version 失效的消费者（大纲、属性、状态栏、覆盖层）每帧重来一次。拖大文档时这是主要开销来源。
4. 【已修】**loader 并发激活重复装配**：`packages/services/service-loader/src/index.ts:244` 已有 `pending = new Map<string, Promise<void>>()`；`activate` 在 `await pkg.load()` **之前** `pending.set`（`:302`）、并发命中直接复用同一 Promise（`:270`），`:297` / `:365` 分别在这些路径清理。回归用例是 `packages/services/service-loader/tests/loader.spec.ts` 的「并发触发同一事件只装配一次」（三个 `ensureActivated` 并发、断言 `load` 只调用一次）。原「修法注释里已给出但未做」已失效。
5. 【现状】**`ensureActivated` 拼错事件名无反馈**：`service-loader/src/index.ts:389` 的注释仍写「未匹配到任何插件时静默返回，事件名拼错不会有反馈」，`:393` 的实现未改变。
6. 【现状】**`Registry` 与 `Service` 两处冗余**：`kernel/src/service.ts:9` 的 `abstract class Service` 全仓 `extends Service` 0 次（仍被 `kernel/src/index.ts:27` 导出）；`useService`（`vue/src/context.ts:78`）仅定义与再导出、无消费者。`useRegistryList`（`vue/src/context.ts:101`）**有 2 处消费者**（`views/ComponentListView.vue:23`、`views/ComponentBlueprintView.vue:125`），删掉它会让宿主编译失败。按「删除该抽象是否让实现变差」判据，前两处可删或标注为公共 API 承诺。
7. 【现状】**业务事件无 `ctx.on` 消费者**：`document:change`、`selection:change`、`canvas:gestureEnd`、`plugin:activated/failed` 在仓库内没有任何 `ctx.on` 订阅；`service-version/src/tracker.ts` 消费 `document:change` 走的是 `DocumentChangeSource.onDidChange`（服务通知），不是事件总线，其余刷新也走各自的 `onDidChange`（见 [02 §4](./02-runtime-flow.md#4-两套通道业务事件-vs-服务通知)）。保留是对的（外部订阅面），但要防止误以为「监听事件就能刷新 UI」。
8. 【描述不准】**hover 描边仍硬编码，但媒体查询不是全仓缺失**：`canvas-selection/src/overlay.ts` 的 `renderHoverBox` 仍写死 `rgba(37, 99, 235, 0.55)`，与 token 规范不一致（选中框 `renderSelectionBox` 已改用 `var(--lc-accent, #2563eb)`）；但 `prefers-color-scheme` / `prefers-reduced-motion` 已在 devtools、物料、code/data/eventflow/version 等面板的 `.vue` / `states.css` 里落地，不能再写成「无适配」。
9. 【现状】**`.vue` 无自动化测试**：110 个 spec / 1136 条用例全是纯逻辑（默认并行 `pnpm test` 实跑 EXIT=0；`release-store.spec.ts` 的抖动已由 suite `timeout: 20_000` 治理，`--no-file-parallelism` 仅作对照，见 README 基线），`vitest.config.ts:8` 的配置注释自述「apps 侧只跑纯逻辑（草稿映射、校验、几何计算）：页面组件仍靠浏览器实测覆盖」；`renderTreeExpression.spec.ts` 覆盖「真实表达式引擎接入渲染树」这条接线，但仍不挂载组件。面板与舞台的行为回归依赖人工浏览器验证。沙箱侧同理：协议与客户端行为由回环 transport 覆盖，**跨 realm 的隔离强度只能在浏览器里验**（本仓源码用无扩展名相对导入，Node ESM 加载不了，所以 CI 里没有真 worker 线程的用例）。
10. 【现状】**无 ESLint**：仅有 prettier + vue-tsc，风格之外的规则（如 `no-new-func`）没有工具执行。仓库现存 0 处行内 disable——原来唯一的一处随 `new Function` 从表达式引擎移出而删除，`JsExpression` 的执行改由「是否注入 `jsRunner`」这一结构性开关控制。

## 10. 提交前检查清单

```bash
pnpm format && pnpm typecheck && pnpm test
```

- [ ] 改动是否触及稳定契约面（`PluginDefinition` / `PluginManifest` / 贡献点 / `SLOT` / `SERVICE_NAMES` / `RESERVED_SERVICES` / `LayerBand`+`BAND_ORDER` / 事件表 / 视口常量）？触及则**同步 `docs/` 对应文档**（见 [README 维护约定](./README.md#维护约定)）。
- [ ] 是否引入低层包→高层包、插件→插件的依赖？
- [ ] 新增 `interaction` 处理器是否说明了 `phase`/`priority` 的取值理由？
- [ ] 是否有 `as`、`@ts-ignore`、`unknown` 收窄没写原因？
- [ ] 浏览器里跑过对应交互链路了吗？没跑过就在结论里明确说明未验证，而不是声称已验证。
- [ ] 与 CI 对齐：CI 已在 `format:check` 之后新增 `Build (MF host + remote)`（`.github/workflows/ci.yml:31-34`）；本地跑 `pnpm build` 必须显式给 `VITE_DESIGNER_ENTRY`，`vite build` 缺该变量直接抛错。
