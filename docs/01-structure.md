# 01 项目结构

## 1. 顶层布局

```text
new-cordis/
├─ apps/
│  ├─ host/                   主应用（MF Host）：外壳、路由、项目工作台与资产存储、文档 Realm
│  └─ designer/               画布模块（MF Remote）：只暴露 ./CanvasModule，不独立运行
├─ packages/
│  ├─ kernel/                   @lc/kernel              应用插件内核（零依赖）
│  ├─ contracts/                @lc/contracts           平台契约：manifest、贡献点、服务接口
│  ├─ schema/                  @lc/schema              文档数据模型 + patch/tree/validate 纯函数
│  ├─ shared/                  @lc/shared              2 个通用工具（createId、clamp）
│  ├─ canvas/                  @lc/canvas              画布微内核（纯算法，不画 DOM）
│  ├─ expression/               @lc/expression          白名单表达式引擎（词法/语法/求值/注册表/预算/Worker 沙箱）
│  ├─ vue/                      @lc/vue                 Vue 适配层 + 舞台/图层/插槽宿主组件
│  ├─ devtools/                 @lc/devtools            宿主级开发者工具：七个自省面板
│  ├─ editor/expression-editor/ @lc/expression-editor   CodeMirror 表达式编辑器（Vue SFC）
│  ├─ services/                 16 个 service-*          核心服务能力（service-version 为纯 Core）
│  ├─ plugins/                  11 个 plugin-*           业务插件：物料 + 面板（含版本面板）
│  ├─ canvas-plugins/           15 个 canvas-plugin-*    画布能力插件
│  └─ presets/                  preset-designer / preset-canvas   装配预设
├─ docs/                        本文档集（as-built）
├─ lowcode-plugin-platform-design.md   v2.1 设计目标稿
└─ AGENTS.md                    开发规范入口（强制 cloud-gate-store Skill）
```

`pnpm-workspace.yaml:1-4` 收录三组 glob：`packages/*`、`packages/*/*`、`apps/*`。因此 `packages/services/service-document` 与 `packages/kernel` 都是独立 workspace 包。

## 2. 包清单与依赖边

按层级排列。「运行时依赖」为 `package.json > dependencies` 实测结果：workspace 共 **55 个**（53 个 `packages/**` 包 + 2 个 `apps/*` 应用，见 `pnpm-workspace.yaml` 的三组 glob）。两个应用之间的 Module Federation 边界见 [12](./12-module-federation.md)。

### L0 基础层（不依赖任何平台包）

| 包           | 目录            | 运行时依赖 |
| ------------ | --------------- | ---------- |
| `@lc/kernel` | packages/kernel | —          |
| `@lc/schema` | packages/schema | —          |
| `@lc/shared` | packages/shared | —          |

`@lc/kernel` 与 `@lc/schema` 都不引入第三方运行时依赖：内核只有 10 个源文件，schema 只有类型与纯函数。`@lc/shared` 提供 `createId`（`id.ts:15`，仅运行时 id，明确不作持久化标识）、`createPersistentId`（`:33`）、`createUniquePersistentId`（`:66`，对已占用键查重）与 `clamp`（`math.ts:6`，区间反转直接抛错）；`canonical` / `hash` / `json` 是内容寻址版本库用的纯函数。

### L1 契约层

| 包              | 运行时依赖                 | 说明                                                                                 |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `@lc/contracts` | `@lc/kernel`、`@lc/schema` | 只做声明与类型合并；唯一的运行时函数是 `installContextServices`（`contexts.ts:123`） |

### L2 引擎层

| 包               | 运行时依赖                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `@lc/expression` | `@lc/schema`                                                                                         |
| `@lc/canvas`     | `@lc/contracts`、`@lc/kernel`、`@lc/schema`、`@lc/shared`                                            |
| `@lc/vue`        | `@lc/contracts`、`@lc/kernel`、`@lc/schema`（另有 devDependency `@lc/expression`，仅渲染接线测试用） |
| `@lc/devtools`   | `@lc/contracts`、`@lc/kernel`（`vue` 为 peer）                                                       |

`@lc/expression` 放引擎层的理由：它只依赖 `@lc/schema`（语法树与求值契约都在那里），不含 Vue、DOM 与内核引用。因此动作执行器（`@lc/service-action`，已落地）、运行时播放器与数据源管道可以直接引用它求值，不必拉起插件内核；把它包进 `@lc/service-expression` 的那一层只负责装配与诊断桥接（见 [07](./07-services.md)）。这也是 Worker 沙箱（设计稿 §19.4）的前置条件——纯数据进出、无全局状态，整包可以搬进独立 realm。

`@lc/canvas` 依赖 contracts 只为拿接口类型与 `ViewportState` 等数据结构；它自己不做任何框架绑定，DOM 挂载点由宿主传入（`interaction.attach(element)`，`packages/canvas/src/interaction/pipeline.ts:428`）。

`@lc/devtools` 挂在引擎层是因为它和 `@lc/vue` 同一性质：只消费内核与契约的公共面，不参与装配。区别是它不提供任何能力，只读——由应用直接渲染，不注册为插件、不占 `SLOT`（详见 [11](./11-devtools.md)）。

另有一个引擎层之外的编辑能力包 `packages/editor/expression-editor`（`@lc/expression-editor`）：它带一个 Vue SFC（`src/ExpressionCodeEditor.vue`）、`vue` peer 与 5 个 `@codemirror/*` 运行时依赖，被 `apps/host`、`plugin-panel-properties`、`plugin-panel-eventflow` 直接依赖。它是被消费的编辑器组件，不是插件、不注册贡献，因此不进 L3/L4 两张表；目录 `packages/editor/` 本身不是 workspace 包，`package.json` 在 `packages/editor/expression-editor/`。

### L3 服务层

| 包                        | 运行时依赖                                         | 提供的服务名                                              |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| `@lc/service-modules`     | contracts、kernel                                  | `modules`（`index.ts:103`）                               |
| `@lc/service-loader`      | contracts、kernel                                  | `contribution`（`:190`）、`loader`（`:354`）              |
| `@lc/service-material`    | contracts、kernel                                  | `material`（`:175`）                                      |
| `@lc/service-command`     | contracts、kernel                                  | `command`（`:91`）                                        |
| `@lc/service-expression`  | expression、kernel、schema                         | `expression`（`:86`）                                     |
| `@lc/service-setter`      | contracts、kernel                                  | `setter`（`:84`）                                         |
| `@lc/service-keybinding`  | contracts、kernel                                  | `keybinding`（`:74`）                                     |
| `@lc/service-document`    | contracts、kernel、schema                          | `document`（`:146`）                                      |
| `@lc/service-history`     | contracts、kernel、schema、shared                  | `history`（`:94`）                                        |
| `@lc/service-selection`   | contracts、kernel                                  | `selection`（`:76`）                                      |
| `@lc/service-canvas-core` | canvas、contracts、kernel、schema                  | `canvas`（`:221`）                                        |
| `@lc/service-datasource`  | contracts、kernel、schema                          | `dataSource`（`index.ts:284`）                            |
| `@lc/service-action`      | contracts、kernel、schema                          | `action`（`index.ts:203`）                                |
| `@lc/service-state`       | contracts、kernel、schema                          | `pageState`（`index.ts:142`）                             |
| `@lc/service-version`     | contracts、shared（纯 Core，不导出插件）           | —（`version` 服务由宿主 `projects/version-host.ts` 装配） |
| `@lc/service-workspace`   | contracts、kernel、schema、shared + **7 个服务包** | `workspace`（`:176`）                                     |

`@lc/service-workspace` 是唯一直接依赖其他服务包的 `service-*`（7 个）：它要在 `createEditorRealm` 内固定装配 `document → history → selection`（`service-workspace/src/index.ts:79-86`），并在 `createCanvasRealm` 内装配 `canvas-core`（`:109`），另外把 `action` / `datasource` / `state` 接进 Realm。这是有意的编排者角色，不是普通消费关系。`@lc/service-version` 不属于插件形态：它是内容寻址版本库的纯 Core 实现（`packages/services/service-version/src/{dag,merge,merge-plan,object,diff,service,tracker,projection}.ts` 与 `src/store/{idb,memory}.ts`），宿主通过 `apps/host/src/projects/version-host.ts` 的 `installVersionHost` 把它装成应用级 `version` 服务，落地范围与剩余提案见 [13](./13-version-control.md)。

### L4 插件层

| 组                          | 数量 | 典型依赖                                                                               |
| --------------------------- | ---- | -------------------------------------------------------------------------------------- |
| `packages/plugins/*`        | 11   | contracts、kernel、schema、vue（部分额外依赖 expression / expression-editor / shared） |
| `packages/canvas-plugins/*` | 15   | contracts、kernel、schema、vue（部分额外依赖 canvas / shared）                         |

只有 4 个画布插件直接依赖 `@lc/canvas`：`canvas-drag`、`canvas-resize`、`canvas-selection`、`canvas-snap`，用于复用内核的几何/事务实现；其余 11 个仅通过 `@lc/contracts` 的 `CanvasService` 接口访问内核。**依赖接口而非实现**是这一层的默认写法。

`@lc/plugin-materials-basic` 是唯一只依赖 `@lc/contracts` 的业务插件——它是纯声明式插件（无 `main`、无 `apply`，`plugin-materials-basic/src/index.ts` 只导出组件表）。

### L5 预设与应用

| 包                    | 运行时依赖                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lc/preset-designer` | kernel、8 个 service-*、vue                                                                                                                                                              |
| `@lc/preset-canvas`   | contracts、kernel（**不依赖任何画布插件**）                                                                                                                                              |
| `@lc/host`            | kernel、contracts、schema、shared、canvas、vue、devtools、expression、expression-editor、preset-designer、11 个 plugin-*、service-action、service-version 与 2 个 `@agile-plus/*` 外部包 |
| `@lc/designer`        | kernel、contracts、vue、preset-canvas、15 canvas-plugins                                                                                                                                 |

宿主不再依赖 `preset-canvas`，远程不依赖 `preset-designer`：两边只共享 `@lc/contracts` 里的类型与字符串常量，边界见 [12](./12-module-federation.md#1-拆分结果)。

`preset-canvas` 没有画布插件依赖是结构上的关键约束：它只读 `contribution.list('canvasFeatures')` 并 `modules.load()`（`presets/preset-canvas/src/index.ts:22-31`），新增画布能力不需要改预设、不需要改宿主。

## 3. 分层规则

```text
apps/host ────MF────→ apps/designer
   ↓                        ↓
preset-designer        preset-canvas
   ↓                        ↓
     plugins / canvas-plugins ──→ services
   ↓                        ↓
        vue（宿主适配）    canvas（画布内核）
   ↓                        ↓
              contracts（唯一的公共契约面）
                        ↓
        kernel ────────┼──────── schema
                     shared
```

允许与禁止（依据上文依赖边实测）：

- **只允许自上而下**：低层包不得 import 高层包。`@lc/kernel`、`@lc/schema`、`@lc/shared` 三个包不引入任何平台包依赖。
- **插件之间不互相 import**：15 个画布插件、11 个业务插件的依赖列表里没有兄弟插件（业务插件依赖的是 `expression-editor` 这类编辑能力包，不是插件）。协作只能通过服务（如可选 `ctx.get('snap')`）、事件、`settings` 总线或 handle-id 字符串约定。
- **跨层通信只走契约**：画布层读写文档必须经过 `canvas` 服务里注入的 `document` 实例，不允许 canvas-plugin 直接 import `service-document`。
- **框架绑定主要收在 `@lc/vue`**：contracts 里 `ResolvedMaterial.component` 与 `RendererService.resolveMaterial()` 的类型是 `unknown`（`contracts/src/services/material.ts:46`），由宿主层收窄。`packages/editor/expression-editor` 也带一个 Vue SFC 与 `vue` peer，但它是被面板/宿主直接消费的编辑器组件，不参与平台层的注入与收窄。

## 4. 工程链路

### 包解析：源码级 workspace，无构建产物

- 依赖一律写成 `"workspace:*"`（`apps/host/package.json:13-25`、`apps/designer/package.json:11-31`）。
- 每个包的 `exports` **直接指向 `.ts` 源码**（例：`packages/vue/package.json:6-13`），没有 `dist`、没有预构建步骤。`plugin-materials-basic/package.json:8-17` 额外暴露 `./manifest` 子路径，供宿主在启动期只引清单不引实现。
- 结果：改任何包立即在 `pnpm dev` 中生效；代价是宿主 Vite 需要能编译全部 workspace 源码（本仓库确实如此，见下）。

### TypeScript

- `tsconfig.base.json:5-15`：`moduleResolution: "Bundler"`、`strict`、`verbatimModuleSyntax`、`noEmit`。
- **没有 `paths` 别名**：类型解析完全依赖 pnpm workspace 链接 + 包的 `exports`。
- `tsconfig.json:6-15` 的 include 覆盖 `packages/**/src/**`、`apps/**/src/**`、`packages/**/tests/**`，一次 `pnpm typecheck`（`vue-tsc --noEmit -p tsconfig.json`）检查全仓。

### Vite

两个应用都是 `@vitejs/plugin-vue` + `resolve.dedupe: ['vue']` + `@module-federation/vite` 的 `federation()`，**没有任何 alias**。`dedupe` 与 MF 的 `shared.vue: { singleton: true, eager: true }` 是同一件事的两道保险：多个 workspace 包各自声明 vue 依赖、或宿主与远程各带一份 Vue 时，单例被破坏会导致 `provide/inject` 与远程 vnode 渲染同时失效。宿主按 `VITE_DESIGNER_ENTRY` 解析远程地址，默认 `http://<本机第一个非回环 IPv4>:5174/remoteEntry.js`（`apps/host/vite.config.ts:16-51`）：**该默认只在 dev/preview 生效，`vite build` 下缺该变量会直接抛错，不再烧 IP**。dev/preview 监听 `0.0.0.0`，地址不能写 localhost，否则非本机浏览器会把 localhost 解析到自己。多网卡用 `LC_DEV_HOST` 指定。差异与必需项见 [12](./12-module-federation.md#6-运行与部署)。

### 测试

`vitest.config.ts:6-10`：`plugins: [vue()]`、`include: ['packages/**/tests/**/*.spec.ts', 'apps/**/tests/**/*.spec.ts']` **双 glob**、`environment: 'node'`。`:5` 注释说明为什么 node 环境仍要 `vue()` 插件：宿主 store 的依赖链会经 `@lc/vue` 入口带到 `.vue` 文件，需要 SFC 插件才能解析。

- 现有 **110 个 spec 文件**（89 个在 `packages/**`、21 个在 `apps/host`），**1136 条用例，默认并行 `pnpm test` 实跑 EXIT=0**；`release-store.spec.ts` 的 5s 超时抖动已由本轮把该 suite `timeout` 放宽到 `20_000` 治理（用例体与断言未改），`--no-file-parallelism` 仅作对照、不再是回归基线（详见 README 基线；本次按文件路径静态清点 spec 数）。按包分布：kernel 5、contracts 2、schema 10、shared 4、canvas 6、vue 5、expression 6、devtools 3、services 29、plugins 7、canvas-plugins 12、apps/host 21。规模最大的一组是 `service-version`（10 个 spec，含 `merge.spec.ts` 的十万次序列 + 两万次树属性测试）。
- **`.vue` 组件没有自动化测试**，结论不变，但理由不再是「只 glob `packages/**`」：`vitest.config.ts:8` 的配置注释自述「apps 侧只跑纯逻辑（草稿映射、校验、几何计算）：页面组件仍靠浏览器实测覆盖」。这是有意的取舍：可测的逻辑都被抽成了纯函数模块（`*-align/src/align.ts`、`*-commands/src/operations.ts`、`*-rotate/src/rotate.ts` 等），交互行为靠浏览器验证。

### 质量闸门

| 命令                           | 实际执行                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| `pnpm dev`                     | `pnpm --parallel --filter @lc/host --filter @lc/designer dev` |
| `pnpm build`                   | 先 `--filter @lc/designer build` 再 `--filter @lc/host build` |
| `pnpm preview`                 | 两个应用并行 `vite preview`                                   |
| `pnpm typecheck`               | `vue-tsc --noEmit -p tsconfig.json`                           |
| `pnpm test`                    | `vitest run`                                                  |
| `pnpm format` / `format:check` | prettier（配置见 `.prettierrc`）                              |

CI（`.github/workflows/ci.yml:21-34`）跑 install / typecheck / test / format:check，并在 `format:check` 之后新增 `Build (MF host + remote)`（`:31-34`）：带 `env.VITE_DESIGNER_ENTRY: http://localhost:5174/remoteEntry.js` 占位地址验证可构建，该值只用于 CI 产出可构建产物，生产部署必须覆盖为部署后的 `remoteEntry.js` 完整地址。本地 `pnpm build` 本次未执行。

### 文件规模（实测）

统计口径：`src` 列数 `**/src/**` 下的 `.ts` + `.vue`（不含 `.css`），`tests` 列数 `**/tests/*.spec.ts`。

| 层                                | src 文件 | tests 文件 |
| --------------------------------- | -------- | ---------- |
| packages/kernel                   | 10       | 5          |
| packages/contracts                | 33       | 2          |
| packages/schema                   | 25       | 10         |
| packages/shared                   | 6        | 4          |
| packages/canvas                   | 12       | 6          |
| packages/vue                      | 20       | 5          |
| packages/expression               | 29       | 6          |
| packages/editor/expression-editor | 2        | 0          |
| packages/devtools                 | 21       | 3          |
| packages/services                 | 37       | 29         |
| packages/plugins                  | 70       | 7          |
| packages/canvas-plugins           | 54       | 12         |
| packages/presets                  | 2        | 0          |
| apps/host                         | 112      | 21         |
| apps/designer                     | 2        | 0          |

全仓 `packages/**` + `apps/**` 共 **435 个 `.ts` / `.vue` 源文件**（360 个 `.ts` + 75 个 `.vue`），另有 31 个 `.css` 未计入；`packages/plugins` 与 `apps/host` 另有 17 / 14 个 `.css`。平台核心（kernel + contracts + schema + shared + canvas + vue）共 106 个 src 文件；服务、插件与预设共 163 个。几个体量较大的文件（行数实测）：`packages/schema/src/flow.ts`（833）、`packages/canvas/src/interaction/pipeline.ts`（796）、`apps/host/src/views/FlowListView.vue`（764）、`apps/host/src/components/functions/FunctionEditorForm.vue`（703）、`packages/plugins/plugin-panel-style/src/StylePanel.vue`（682）、`apps/host/src/views/DesignerView.vue`（631 行，script `1-282` / template `284-631`；P1 把 script 拆成 `views/composables/use-designer-*.ts` 四个 composable，template 逐字节未改）。服务包中最长为 `service-version/src/merge.ts`（930 行），其次是 `service-version/src/service.ts`（440）与 `service-loader/src/index.ts`（416）。

## 5. 命名约定

| 前缀                                                                               | 用途                      | 例                                  |
| ---------------------------------------------------------------------------------- | ------------------------- | ----------------------------------- |
| `@lc/kernel`、`@lc/contracts`、`@lc/schema`、`@lc/shared`、`@lc/canvas`、`@lc/vue` | 平台基础设施              | —                                   |
| `@lc/service-*`                                                                    | 核心服务插件包            | `@lc/service-document`              |
| `@lc/canvas-plugin-*`                                                              | 画布能力插件包            | `@lc/canvas-plugin-snap`            |
| `@lc/plugin-panel-*`                                                               | 面板插件包                | `@lc/plugin-panel-outline`          |
| `@lc/plugin-materials-*`                                                           | 物料包                    | `@lc/plugin-materials-basic`        |
| `@lc/preset-*`                                                                     | 装配预设                  | `@lc/preset-canvas`                 |
| `@lc/expression-editor`                                                            | 编辑器组件包              | `packages/editor/expression-editor` |
| `@lc/host`                                                                         | 主应用（MF Host）         | `apps/host`                         |
| `@lc/designer`                                                                     | 画布远程应用（MF Remote） | `apps/designer`                     |

包名用 kebab-case，目录名与 `package.json > name` 后缀严格一致（`packages/editor/expression-editor` 是 `packages/*/*` glob 收录的二级包）。插件内部 `manifest.name` 必须等于 `definition.name`（`service-loader/src/index.ts:283-287` 在激活时校验，不一致直接失败并发 `plugin:failed`）。
