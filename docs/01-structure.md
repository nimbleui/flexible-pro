# 01 项目结构

## 1. 顶层布局

```text
new-cordis/
├─ apps/
│  └─ designer/                 唯一可运行应用：设计器宿主（Vue 3 + Vite）
├─ packages/
│  ├─ kernel/                   @lc/kernel              应用插件内核（零依赖）
│  ├─ contracts/                @lc/contracts           平台契约：manifest、贡献点、服务接口
│  ├─ schema/                  @lc/schema              文档数据模型 + patch/tree/validate 纯函数
│  ├─ shared/                  @lc/shared              2 个通用工具（createId、clamp）
│  ├─ canvas/                  @lc/canvas              画布微内核（纯算法，不画 DOM）
│  ├─ vue/                      @lc/vue                 Vue 适配层 + 舞台/图层/插槽宿主组件
│  ├─ services/                 12 个 service-*          核心服务能力，每个 = 一个插件
│  ├─ plugins/                  4 个 plugin-*            业务插件：物料 + 3 个面板
│  ├─ canvas-plugins/           15 个 canvas-plugin-*    画布能力插件
│  └─ presets/                  preset-designer / preset-canvas   装配预设
├─ docs/                        本文档集（as-built）
├─ lowcode-plugin-platform-design.md   v2.1 设计目标稿
└─ AGENTS.md                    开发规范入口（强制 cloud-gate-store Skill）
```

`pnpm-workspace.yaml:1-4` 收录三组 glob：`packages/*`、`packages/*/*`、`apps/*`。因此 `packages/services/service-document` 与 `packages/kernel` 都是独立 workspace 包。

## 2. 包清单与依赖边

按层级排列。「运行时依赖」为 `package.json > dependencies` 实测结果（39 个包 + 1 个应用 = 40）。

### L0 基础层（不依赖任何平台包）

| 包           | 目录            | 运行时依赖 |
| ------------ | --------------- | ---------- |
| `@lc/kernel` | packages/kernel | —          |
| `@lc/schema` | packages/schema | —          |
| `@lc/shared` | packages/shared | —          |

`@lc/kernel` 与 `@lc/schema` 都不引入第三方运行时依赖：内核只有 10 个源文件，schema 只有类型与纯函数。`@lc/shared` 只有 `createId`（`id.ts:11`，仅运行时 id，明确不作持久化标识）和 `clamp`（`math.ts:6`，区间反转直接抛错）。

### L1 契约层

| 包              | 运行时依赖                 | 说明                                                                                 |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `@lc/contracts` | `@lc/kernel`、`@lc/schema` | 只做声明与类型合并；唯一的运行时函数是 `installContextServices`（`contexts.ts:123`） |

### L2 引擎层

| 包           | 运行时依赖                                                |
| ------------ | --------------------------------------------------------- |
| `@lc/canvas` | `@lc/contracts`、`@lc/kernel`、`@lc/schema`、`@lc/shared` |
| `@lc/vue`    | `@lc/contracts`、`@lc/kernel`、`@lc/schema`               |

`@lc/canvas` 依赖 contracts 只为拿接口类型与 `ViewportState` 等数据结构；它自己不做任何框架绑定，DOM 挂载点由宿主传入（`interaction.attach(element)`，`packages/canvas/src/interaction/pipeline.ts:428`）。

### L3 服务层

| 包                        | 运行时依赖                                         | 提供的服务名                                 |
| ------------------------- | -------------------------------------------------- | -------------------------------------------- |
| `@lc/service-modules`     | contracts、kernel                                  | `modules`（`index.ts:103`）                  |
| `@lc/service-loader`      | contracts、kernel                                  | `contribution`（`:190`）、`loader`（`:354`） |
| `@lc/service-material`    | contracts、kernel                                  | `material`（`:175`）                         |
| `@lc/service-command`     | contracts、kernel                                  | `command`（`:91`）                           |
| `@lc/service-expression`  | kernel、schema                                     | `expression`（`:78`）                        |
| `@lc/service-setter`      | contracts、kernel                                  | `setter`（`:84`）                            |
| `@lc/service-keybinding`  | contracts、kernel                                  | `keybinding`（`:74`）                        |
| `@lc/service-document`    | contracts、kernel、schema                          | `document`（`:146`）                         |
| `@lc/service-history`     | contracts、kernel、schema、shared                  | `history`（`:94`）                           |
| `@lc/service-selection`   | contracts、kernel                                  | `selection`（`:76`）                         |
| `@lc/service-canvas-core` | canvas、contracts、kernel、schema                  | `canvas`（`:221`）                           |
| `@lc/service-workspace`   | contracts、kernel、schema、shared + **4 个服务包** | `workspace`（`:176`）                        |

`@lc/service-workspace` 是唯一直接依赖其他服务包的 `service-*`：它要在 `createEditorRealm` 内固定装配 `document → history → selection`（`service-workspace/src/index.ts:79-86`），并在 `createCanvasRealm` 内装配 `canvas-core`（`:109`）。这是有意的编排者角色，不是普通消费关系。

### L4 插件层

| 组                          | 数量 | 典型依赖                                                       |
| --------------------------- | ---- | -------------------------------------------------------------- |
| `packages/plugins/*`        | 4    | contracts、kernel、schema、vue                                 |
| `packages/canvas-plugins/*` | 15   | contracts、kernel、schema、vue（部分额外依赖 canvas / shared） |

只有 4 个画布插件直接依赖 `@lc/canvas`：`canvas-drag`、`canvas-resize`、`canvas-selection`、`canvas-snap`，用于复用内核的几何/事务实现；其余 11 个仅通过 `@lc/contracts` 的 `CanvasService` 接口访问内核。**依赖接口而非实现**是这一层的默认写法。

`@lc/plugin-materials-basic` 是唯一只依赖 `@lc/contracts` 的业务插件——它是纯声明式插件（无 `main`、无 `apply`，`plugin-materials-basic/src/index.ts` 只导出组件表）。

### L5 预设与应用

| 包                    | 运行时依赖                                                                   |
| --------------------- | ---------------------------------------------------------------------------- |
| `@lc/preset-designer` | kernel、8 个 service-*、vue                                                  |
| `@lc/preset-canvas`   | contracts、kernel（**不依赖任何画布插件**）                                  |
| `@lc/designer`        | kernel、contracts、schema、vue、2 presets、4 plugins、15 canvas-plugins、vue |

`preset-canvas` 没有画布插件依赖是结构上的关键约束：它只读 `contribution.list('canvasFeatures')` 并 `modules.load()`（`presets/preset-canvas/src/index.ts:22-31`），新增画布能力不需要改预设、不需要改宿主。

## 3. 分层规则

```text
apps/designer
   ↓
presets ──→ plugins / canvas-plugins ──→ services
   ↓                                        ↓
        vue（宿主适配）                  canvas（画布内核）
   ↓                                        ↓
              contracts（唯一的公共契约面）
                        ↓
        kernel ────────┼──────── schema
                     shared
```

允许与禁止（依据上文依赖边实测）：

- **只允许自上而下**：低层包不得 import 高层包。`@lc/kernel`、`@lc/schema`、`@lc/shared` 三个包不引入任何平台包依赖。
- **插件之间不互相 import**：15 个画布插件、4 个业务插件的依赖列表里没有兄弟插件。协作只能通过服务（如可选 `ctx.get('snap')`）、事件、`settings` 总线或 handle-id 字符串约定。
- **跨层通信只走契约**：画布层读写文档必须经过 `canvas` 服务里注入的 `document` 实例，不允许 canvas-plugin 直接 import `service-document`。
- **框架绑定收在一个包**：`@lc/vue` 是唯一持有 Vue 运行时的平台层；contracts 里 `ResolvedMaterial.component` 与 `RendererService.resolveMaterial()` 的类型是 `unknown`（`contracts/src/services/material.ts:46`），由宿主层收窄。

## 4. 工程链路

### 包解析：源码级 workspace，无构建产物

- 依赖一律写成 `"workspace:*"`（`apps/designer/package.json:11-38`）。
- 每个包的 `exports` **直接指向 `.ts` 源码**（例：`packages/vue/package.json:6-13`），没有 `dist`、没有预构建步骤。`plugin-materials-basic/package.json:8-17` 额外暴露 `./manifest` 子路径，供宿主在启动期只引清单不引实现。
- 结果：改任何包立即在 `pnpm dev` 中生效；代价是宿主 Vite 需要能编译全部 workspace 源码（本仓库确实如此，见下）。

### TypeScript

- `tsconfig.base.json:5-15`：`moduleResolution: "Bundler"`、`strict`、`verbatimModuleSyntax`、`noEmit`。
- **没有 `paths` 别名**：类型解析完全依赖 pnpm workspace 链接 + 包的 `exports`。
- `tsconfig.json:6-15` 的 include 覆盖 `packages/**/src/**`、`apps/**/src/**`、`packages/**/tests/**`，一次 `pnpm typecheck`（`vue-tsc --noEmit -p tsconfig.json`）检查全仓。

### Vite

`apps/designer/vite.config.ts:5-12` 极简：只有 `@vitejs/plugin-vue`、`resolve.dedupe: ['vue']`、`server.port 5173`，**没有任何 alias**。`dedupe` 是必要的：多个 workspace 包各自声明 vue 依赖时，单例被破坏会导致 `provide/inject` 失效。

### 测试

`vitest.config.ts:5-6`：`include: ['packages/**/tests/**/*.spec.ts']`，`environment: 'node'`。

- 现有 26 个 spec 文件，覆盖：kernel 4（config/effect/events/runtime）、contracts 2（drag/nodes）、schema 2（patch/tree）、canvas 6（coordinates/hitTest/menu/scheduler/snap/transaction）、vue 1（renderTree）、services 2（expression/keys）、canvas-plugins 9（align/operations/drag/minimap-geometry/resize/rotate/guides/hierarchy/snap-providers）。
- 因为是 node 环境且 glob 只吃 `.spec.ts`，**`.vue` 文件不在单测范围内**。这是有意的取舍：可测的逻辑都被抽成了纯函数模块（`*-align/src/align.ts`、`*-commands/src/operations.ts`、`*-rotate/src/rotate.ts` 等），交互行为靠浏览器验证。

### 质量闸门

| 命令                             | 实际执行                            |
| -------------------------------- | ----------------------------------- |
| `pnpm dev` / `build` / `preview` | `pnpm --filter @lc/designer …`      |
| `pnpm typecheck`                 | `vue-tsc --noEmit -p tsconfig.json` |
| `pnpm test`                      | `vitest run`                        |
| `pnpm format` / `format:check`   | prettier（配置见 `.prettierrc`）    |

### 文件规模（实测）

| 层                      | src 文件 | tests 文件 |
| ----------------------- | -------- | ---------- |
| packages/kernel         | 10       | 4          |
| packages/contracts      | 25       | 2          |
| packages/schema         | 19       | 2          |
| packages/shared         | 3        | 0          |
| packages/canvas         | 12       | 6          |
| packages/vue            | 10       | 1          |
| packages/services       | 13       | 2          |
| packages/plugins        | 11       | 0          |
| packages/canvas-plugins | 53       | 9          |
| packages/presets        | 2        | 0          |
| apps/designer           | 9        | 0          |

平台核心（kernel + contracts + schema + shared + canvas + vue）共 79 个 src 文件；服务与插件共 79 个。规模最大的文件依次是 `packages/canvas/src/interaction/pipeline.ts`（704 行）、`plugin-panel-outline/src/OutlinePanel.vue`（472）、`packages/schema/src/tree.ts`（465）、`packages/kernel/src/context.ts`（441）、`plugin-panel-properties/src/PropertiesPanel.vue`（435）。服务包中最长为 `service-loader/src/index.ts`（356 行）。

## 5. 命名约定

| 前缀                                                                               | 用途           | 例                           |
| ---------------------------------------------------------------------------------- | -------------- | ---------------------------- |
| `@lc/kernel`、`@lc/contracts`、`@lc/schema`、`@lc/shared`、`@lc/canvas`、`@lc/vue` | 平台基础设施   | —                            |
| `@lc/service-*`                                                                    | 核心服务插件包 | `@lc/service-document`       |
| `@lc/canvas-plugin-*`                                                              | 画布能力插件包 | `@lc/canvas-plugin-snap`     |
| `@lc/plugin-panel-*`                                                               | 面板插件包     | `@lc/plugin-panel-outline`   |
| `@lc/plugin-materials-*`                                                           | 物料包         | `@lc/plugin-materials-basic` |
| `@lc/preset-*`                                                                     | 装配预设       | `@lc/preset-canvas`          |
| `@lc/designer`                                                                     | 宿主应用       | —                            |

包名用 kebab-case，目录名与 `package.json > name` 后缀严格一致。插件内部 `manifest.name` 必须等于 `definition.name`（`service-loader/src/index.ts:229-233` 在激活时校验，不一致直接失败并发 `plugin:failed`）。
