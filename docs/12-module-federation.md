# 12 微前端拆分（Module Federation）

> 本篇是 as-built：只描述当前代码里真实存在的东西，引用格式为 `文件路径:行号`（仓库相对路径）。
> 前置阅读 [01 项目结构](./01-structure.md)、[09 Vue 宿主与渲染](./09-vue-host.md)。

## 1. 拆分结果

平台从「一个可运行应用」拆成两个 Vite 应用，用 Module Federation 连接：

```text
apps/host      @lc/host      MF Host   ：外壳、路由、页面列表、文档 Realm、面板、状态栏、开发者工具
apps/designer  @lc/designer  MF Remote ：画布模块，只暴露 ./CanvasModule，无 index.html，不独立运行
```

职责边界（谁持有什么）：

| 归属 | 内容                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主 | 插件内核 `createApp` 与 `preset-designer`、4 个业务插件包（物料 + 3 面板）、`GRANTS`、`EditorRealm` 与 `CanvasRealm` 的创建与释放、路由与外壳 UI、`window.__lc` |
| 远程 | 15 个画布能力插件包 + `preset-canvas`、`CanvasStage` 渲染、画布能力插件的 `loader` 登记与 `canvas-snap` 授权签发                                                |

`service-canvas-core` 仍在宿主侧：`CanvasRealm` 由宿主的 workspace 服务创建（`packages/services/service-workspace/src/index.ts:108-110` 里 `createCanvasRealm()` 同步 `plugin(canvasCorePlugin)`）。远程装载的是**画布能力**，不是画布内核。

## 2. 跨边界的唯一契约

远程暴露一个组件，props 就是契约面（`apps/designer/src/CanvasModule.vue:9-14`）：

```ts
appContext: Context // 宿主的应用根上下文，用于登记插件与等待 runtime 空闲
canvasContext: CanvasContext // 宿主创建的 CanvasRealm 上下文
```

没有 emits、没有回调、没有共享 store：远程不返回 `CanvasRealm`，因为宿主本来就有它。切换文档由宿主换 `key` 重挂载组件完成（`apps/host/src/App.vue:32` 的 `<RouterView :key="route.path">`），`CanvasModule` 内部不监听 props 变化。

宿主侧的类型来自手写声明 `apps/host/src/remotes.d.ts:11-22`，不依赖构建产物：远程类型自动生成需要 per-app `tsconfig.json`，本仓库只有一个根 `tsconfig.json`，因此两侧都显式 `dts: false`（`apps/designer/vite.config.ts:29`、`apps/host/vite.config.ts:32`）。改 props 等于改 `exposes`，两侧要一起动。

## 3. 画布能力如何跨边界进宿主内核

这是本次拆分里唯一不显然的部分。`loader.register({ manifest, load })` 只登记元数据与**一个加载函数**（`packages/services/service-loader/src/index.ts:256-290`），而 `load` 是闭包：

- 远程把 15 个包的 `{ manifest, load: () => import('@lc/canvas-plugin-*') }` 表留在自己包里（`apps/designer/src/canvas-plugins.ts:24-46`）；
- 这些 `import()` 在远程自己的模块图里解析，chunk 由远程源提供；
- 宿主的 `contribution` / `modules` 服务拿到的就是这个函数，`preset-canvas` 按 `canvasFeatures` 贡献逐个 `modules.load()`（`packages/presets/preset-canvas/src/index.ts:22-31`）。

因此宿主不认识任何画布插件 id——`canvas-align` 的工具栏按钮、`canvas-zoom` 的缩放按钮都是远程贡献、由宿主的 `LcSlot` / `ToolbarStock` 渲染出来的。新增画布能力依旧只加包 + 改远程的登记表，宿主零改动。

三点必须同时成立，跨副本才不出事：

1. **`LC_CONTEXT` 用 `Symbol.for`**（`packages/vue/src/context.ts:12`）。宿主与远程各打包一份 `@lc/vue`，`Symbol('lc-context')` 会产生两个不相等的键；远程侧的画布覆盖层组件全部依赖 `useAppContext()`（如 `packages/canvas-plugins/canvas-grid/src/overlay.ts:23`），键不同就注入不到上下文。这是本次唯一的平台代码改动。
2. **服务访问器装在宿主的 `Context.prototype` 上**（`packages/kernel/src/context.ts:617-630`）。所有 Context 实例都由宿主的 kernel 副本创建（根上下文、EditorRealm、CanvasRealm 都是），远程读取 `ctx.canvas` / `ctx.loader` 走的是宿主原型上的 getter，因此远程不必再调 `installContextServices()`。
3. **Vue 单例**。两侧 `shared.vue` 都配 `singleton: true` + `eager: true`（`apps/designer/vite.config.ts:22-25`、`apps/host/vite.config.ts:27-30`），加上原有 `resolve.dedupe: ['vue']`。远程组件产出的 vnode 必须由同一个 Vue 运行时渲染。

内核的服务名、贡献点、插槽名、事件名全是字符串（`packages/contracts/src/slots.ts`、`SERVICE_NAMES` `packages/contracts/src/contexts.ts:99-115`），所以跨副本传纯对象与纯数据没有身份问题；平台里唯一的 Vue 注入键就是上面第 1 条。

## 4. 授权：远程自签画布插件

保留服务必须授权才能 `provide`（`packages/kernel/src/context.ts:573-585` 回落到 root runtime 的常驻授权表）。宿主只授予它认识的内置服务（`apps/host/src/bootstrap.ts:28-40`），`canvas-snap` 需要 `snap` 提供权，由远程在登记前自己签发（`apps/designer/src/canvas-plugins.ts:49-51、69-71`）：

```ts
context.runtime.grant('canvas-snap', ['snap'])
```

`grant` 是 runtime 的公开 API（`packages/kernel/src/runtime.ts:71-80`），重复签发按名字累积、幂等。真实生产环境这一步应由控制面校验签名后签发，而不是由模块自签——现在这样写是为了在没有控制面时保住「提供保留服务必须先被授权」这条约束的形状。

登记同时必须是**应用级一次**：`loader.register` 对同名插件重复登记直接抛错（`packages/services/service-loader/src/index.ts:259-261`），而画布实例是文档级创建/释放的。`canvas-plugins.ts:54` 用 `WeakSet<Context>` 记住已登记的应用上下文，切文档只换 Realm，不重复登记。

## 5. 装配时序

```text
宿主 main.ts
└ bootstrapHost()                            apps/host/src/bootstrap.ts:70
  ├ installContextServices()                 :72
  ├ createApp({ id: 'host', grants })        :74
  ├ plugin(presetDesigner) + whenIdle()      :76-77
  ├ loader.register(4 个宿主侧包)             :79-80
  └ 注册 app.commandPalette + Mod+K          :83-92

路由 /design/:documentId → DesignerView      apps/host/src/views/DesignerView.vue
├ workspace.getEditor ?? createEditorRealm   :43-49
├ editor.createCanvasRealm()                 :52   （canvas-core 在这里排队装配）
├ onMounted: await runtime.whenIdle()        :68-73  就绪门，之后才渲染子树
└ <CanvasModule :app-context :canvas-context>  :105  defineAsyncComponent 拉远程

远程 CanvasModule setup                       apps/designer/src/CanvasModule.vue
├ installCanvasCapabilities(appContext)       :27   登记 15 包 + 自签授权（幂等）
├ canvasContext.plugin(presetCanvas)          :28   按 canvasFeatures 装配能力
├ await appContext.runtime.whenIdle()         :29
└ ready → <CanvasStage :context>              :40
```

**就绪门为什么必要**：`Context.plugin()` 只做登记，服务要到 runtime 的微任务批里才 `apply`（`packages/kernel/src/context.ts:442-452` 的注释）。拆分前 `bootstrapDesigner()` 在 `createApp` 之后统一 `await whenIdle()` 才渲染；拆分后 Realm 由路由创建，若不同步等待，`StatusBar` 在 setup 里 `canvasContext.require('canvas')` 就会抛「未找到服务」——这次实现真的踩过一次，门加在 `DesignerView.vue:68-73`。

## 6. 运行与部署

| 场景     | 命令                                                                          | 端口与地址                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 开发     | `pnpm dev`（= `pnpm --parallel --filter @lc/host --filter @lc/designer dev`） | 宿主 5173、远程 5174，均监听 `0.0.0.0`；宿主按 `http://<本机 IPv4>:5174/remoteEntry.js` 拉远程，局域网设备用 `http://<本机 IPv4>:5173` 访问 |
| 只起一个 | `pnpm dev:host` / `pnpm dev:canvas`                                           | 单起宿主时画布区域显示「画布模块不可用」提示（`DesignerView.vue:25-35` 的 `errorComponent`），不是白屏                                      |
| 构建     | `VITE_DESIGNER_ENTRY=<远程线上地址> pnpm build`（先远程后宿主，串行）         | 远程产出 `apps/designer/dist/`（`remoteEntry.js` + `mf-manifest.json` + `mf-stats.json` + `assets/`），宿主产出 `apps/host/dist/`           |
| 预览     | `pnpm preview`                                                                | 两个 `vite preview` 并行，端口同 dev，同样监听 `0.0.0.0`                                                                                    |

必需的配置细节，不是装饰：

- **远程没有 index.html**，Vite 默认以 `index.html` 为构建入口会报 `Could not resolve entry module`，因此显式把暴露的组件设为入口：`apps/designer/vite.config.ts:54-57`。
- **远程必须放开跨源**：`server.cors` + `preview.cors` + `server.origin`（`apps/designer/vite.config.ts:59-68`），否则宿主跨源取 chunk 失败。`server.origin` 同时保证 dev 下资源 URL 带上远程自己的源；它取的是宿主入口里的同一个地址，因此监听 `0.0.0.0` 后仍能被局域网客户端解析。
- 两个应用的 dev/preview 都绑 `0.0.0.0`，dev 的远程地址默认取第一个非回环 IPv4（两个 config 各自的 `lanIPv4()`）。本机有多块网卡时，浏览器实际用的 IP 与烧进宿主的远程地址可能不在同一子网，此时用 `LC_DEV_HOST` 指定后重启。
- 生产环境的远程地址在构建期烧进宿主，用环境变量覆盖：`VITE_DESIGNER_ENTRY`（`apps/host/vite.config.ts:28-29`）。

### 6.1 部署要点

1. **远程地址是构建期常量，共烧进三处**：`apps/host/dist/index.html`、`dist/assets/mf-entry-bootstrap-*.js`、`dist/assets/_virtual_mf-localSharedImportMap-*.js`。换远程域名必须**重新构建宿主**，只改反向代理指向改不动已烧进产物的字符串。
2. **生产构建必须显式给 `VITE_DESIGNER_ENTRY`**。不带它直接 `pnpm build`，默认值取的是**构建机**的第一个非回环 IPv4：实测三处全写成 `http://10.143.189.88:5174/remoteEntry.js`，既把内网地址泄进公开产物，又让产物随构建机网卡而不可复现。给定时同三处同步替换为给定 URL（实测 `https://cdn.example.com/designer/remoteEntry.js`，无 IP 残留）。
3. **远程目录可以整体搬到任意路径**：`mf-manifest.json` 的 `publicPath` 是 `auto`，15 个画布插件的懒加载 chunk 按 `remoteEntry.js` 自身地址解析，把 `apps/designer/dist/` 挂到 `https://<域名>/<任意路径>/` 下不需要重新构建远程。
4. **远程静态托管必须回跨源头**：`remoteEntry.js` 与它带出的每个 chunk 都要带 `Access-Control-Allow-Origin`。`vite preview` 实测回 `Access-Control-Allow-Origin: *`；换成 nginx / CDN 要自己补，缺头的表现是画布区域显示「画布模块不可用」，不是白屏（`DesignerView.vue:25-35` 的 `errorComponent`），且不会自动重试。
5. **Vue 只能有一份**：`shared.vue` 是 `singleton + eager`，宿主侧的 `loadShare-eager` chunk（128.40 kB）已经带上 Vue，部署时不要再让远程壳层额外加载一份，否则远程组件的 vnode 挂载即失效。

## 7. 验证记录

| 检查                   | 结果                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`       | 无错误（全仓 vue-tsc）                                                                                                                                                                                                                                                                                             |
| `pnpm test`            | 35 个测试文件 / 303 条用例全部通过，与拆分前同一套件，未新增用例                                                                                                                                                                                                                                                   |
| `pnpm build`           | 远程与宿主均通过；远程 `dist/remoteEntry.js` 21.69 kB，宿主含 `loadShare-eager` 128.40 kB（Vue 作为 eager 共享）                                                                                                                                                                                                   |
| `npx prettier --check` | 通过                                                                                                                                                                                                                                                                                                               |
| dev 双进程             | `remoteEntry.js` 与 `mf-manifest.json` 均 200，响应头 `Access-Control-Allow-Origin: *`                                                                                                                                                                                                                             |
| dev 浏览器（结构）     | `/design/demo-doc` 渲染完整：远程贡献的工具栏按钮（缩小/放大/100%/适应画布 + 8 个对齐 + 6 个层级 + 隐藏/锁定）、大纲与物料面板、舞台节点、小地图覆盖层、状态栏「缩放 100% / 未选中 / 已同步」；console 无错误，`__lc.context.diagnostics.list()` 为空                                                              |
| dev 浏览器（多文档）   | SPA 内切换 demo-doc → blank-doc → demo-doc：两次舞台均挂载，`listEditors()` 返回两条，`loader.scan()` 恒为 19 个包（4 宿主 + 15 画布），无重复登记异常                                                                                                                                                             |
| 生产 preview           | 构建产物在同一浏览器路径下结构一致，console 零消息                                                                                                                                                                                                                                                                 |
| dev 局域网（IP 访问）  | 两个 server 绑 `0.0.0.0`；`http://10.143.189.88:5173/design/demo-doc` 实测 74 个 `:5174` 资源全 200、`.lc-stage` 已挂载、83 个按钮、状态栏「缩放 51% / 未选中 / 已同步」、无「画布模块不可用」，console 无 error/warn；换 `http://192.168.0.88:5173` 同样通过（72 个远程资源，无失败）                             |
| preview 局域网         | `pnpm preview` 亦绑 `0.0.0.0`，`remoteEntry.js` 响应头 `Access-Control-Allow-Origin: *`；经 IP 访问构建产物 37 个远程资源全 200，舞台与状态栏表现同 dev，console 零消息                                                                                                                                            |
| 构建地址烧写           | 不带 `VITE_DESIGNER_ENTRY` 时 `pnpm build` 的宿主产物三处（`index.html` / `mf-entry-bootstrap-*.js` / `_virtual_mf-localSharedImportMap-*.js`）均为 `http://10.143.189.88:5174/remoteEntry.js`；带 `VITE_DESIGNER_ENTRY=https://cdn.example.com/designer/remoteEntry.js` 重新构建后三处同步替换，`grep` 无 IP 残留 |

**未验证**：早先记录的 in-app 浏览器 0×0（`window.innerWidth === 0`）在最近的局域网复核里已是 1165，但**指针与几何类断言仍未做过**——拖拽、框选、缩放、吸附与像素级样式需要在真实窗口里人工复核。

## 8. 已知边界

1. **远程不可达时只有提示，没有重试**：`errorComponent` 只给文案，不会自动重连，也没有降级到静态占位画布。
2. **文档 Realm 只增不减**：`EditorRealm` 由路由创建、只在应用销毁时级联回收；页面列表会显示「已打开」，但没有关闭文档的入口。`CanvasRealm` 则随视图释放（`DesignerView.vue:57-60`）。
3. **画布内核仍在宿主**：`@lc/canvas` 与 `service-canvas-core` 通过 `service-workspace` 的依赖进入宿主 bundle。要做到「宿主完全不含画布代码」，得把 Realm 工厂也搬进远程，那会让 `workspace` 服务分裂成两侧——当前不划算。
4. **`@lc/*` 平台包在两个 bundle 里各有一份**：`@lc/vue`、`@lc/contracts` 都双副本，只靠 `Symbol.for` + 字符串服务名 + 宿主原型访问器三点保证一致。若将来要共享整个内核层，需要给每个包配 MF `shared` 与真实版本号，属于另一件事。
5. **主题令牌由宿主提供**：`--lc-*` 定义在 `apps/host/src/styles/tokens.css`，远程的画布样式只消费变量。远程被别的宿主复用时，那个宿主必须自带同一套令牌。
6. **`window.__lc` 只剩 `{ context, canvas? }`**：`editor` 字段没了（Realm 随路由创建），改从 `__lc.context.workspace.listEditors()` / `getEditor(id)` 取；`__lc.canvas` 由设计器视图写入当前活动画布，未进设计器时为 `undefined`，不参与任何运行时逻辑。

## 9. 加一个远程模块的配方

照 `apps/designer` 的形状：

1. `apps/<name>/` 建 Vite 应用，`federation({ name, exposes, shared: { vue: { singleton: true, eager: true } }, dts: false, manifest: true })`，`server.host` + `server.cors` + `server.origin` + `build.rollupOptions.input` 指向暴露文件。
2. 暴露**一个组件**，契约走 props；需要向宿主内核贡献能力时，自己拿 `appContext` 调 `loader.register`，并自签该模块的保留服务授权。
3. 宿主侧加 `declare module '<remoteName>/<Expose>'` 的手写声明 + `remotes` 条目 + `defineAsyncComponent`。
4. 根 `package.json` 的 `dev` / `build` / `preview` 脚本把新应用并进并行/串行序列。
