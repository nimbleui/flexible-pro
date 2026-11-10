# 13 · 版本控制设计方案（提案，未实现）

> **状态**：提案稿。本文分两类陈述，务必区分——
> **现状**（可在源码逐条核对，引用格式 `文件路径:行号`）与 **提案**（标 `[提案]`，代码里还不存在）。
> 按 [README 维护约定](./README.md) 第 2、3 条，本目录其余文档只写已实现事实；提案类内容单列在本文件，
> 落地某阶段后应把该阶段的事实回填到 05 / 07 / 08 / 09 对应章节，本文件只保留未实现部分。
>
> **基线与核对范围**：`main` @ `e620b20`（2026-11-06）为参照，但**行号取自工作区当前内容而非 HEAD**——
> `apps/host/src/projects/`、`apps/host/src/pages/`、`apps/host/src/apis/`、`packages/plugins/plugin-panel-code`、
> `plugin-panel-data` 等在本轮核对时仍是**未提交的新增文件**（`git status` 里的 `??`），
> 与 [README 基线表](./README.md) 记录同类情况的做法一致。改动这批文件前先复核本文引用行号。
> 核对方式：逐文件读取源码 + 依赖边检索 + `pnpm test` 实测。

---

## 0. 一页结论

| 决策点   | 选择                                                                                     | 核心理由                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 版本模型 | **内容寻址 commit DAG**（git 式 plumbing），不是快照列表                                 | 现有 `ProjectRelease` 是"深拷贝全量 + 指针回滚"，无 diff / 分支 / 合并能力，且按份数剪枝会丢历史          |
| 合并单元 | **实体级三方合并**（按 id 寻址的 `nodes` / `actions` / `edges` 条目）                    | 文档本来就是 `{ [id]: Entity }` 字典，比 JSON 文本行合并的语义准确一个量级                                |
| 版本粒度 | **双层**：文档级（page/flow/function/component/api）+ 项目级（commit 树）                | 单文档回滚和整体发布是两个真实需求，缺任一侧都会逼用户做全量覆盖                                          |
| 存储     | **本地优先 + 适配器预留服务端**：`MemoryVersionStore` → `IndexedDB` → `HttpVersionStore` | 仓库当前无后端，所有持久化在 `apps/host` 的 localStorage；契约先稳定，实现可换                            |
| 协同     | **提交 + CAS 冲突**（乐观），非实时 CRDT；同文档软锁作为过渡                             | CRDT 要替换 id 生成与 patch 寻址方式，代价远大于收益；实体合并已覆盖并行开发主场景                        |
| 环境晋级 | 环境 = **ref 到 commit 的绑定**，发布 = commit 打 tag + 过闸门，回滚 = 只移动绑定        | 沿用已被验证的既有不变量："回滚只移指针不回写资产"                                                        |
| 编号系统 | **只允许一套权威编号 = commit hash**；`revision` / semver 降级为人读标签                 | 现在同时存在 `ProjectRelease.revision`（单调递增）与 `FlowDefinition.version`（semver），三套并行必然漂移 |
| 前置条件 | **必须先修三项地基**：确定性序列化、跨端稳定 id、历史持久化                              | 见 [§1.3](#13-三个必须先修的地基缺陷)，任一未修则 hash 不可信、合并会撞 id、DAG 存不住                    |
| 交付节奏 | P0 地基 → P1 对象存储/commit → P2 提交链路 → P3 diff/合并 → P4 UI → P5 服务端契约        | 每阶段独立可验收、可回滚，不出现"半成品悬空"                                                              |

**这一版方案的取舍底线**：宁可不支持"多人同时拖同一张页面的像素级实时协同"，也要保证"两个人各改各的页面/节点，合并时不丢任何一方且不产生悬空引用"。后者是低代码协同的真实主场景，且用现有数据结构可以低成本做对。

---

## 1. 现状盘点

### 1.1 可以被版本化的对象

平台里"可持久化产物"分两个层级，两层都已经在用 id 寻址的字典或数组：

**文档层** —— `PageSchema`（[packages/schema/src/page.ts:85-149](../packages/schema/src/page.ts)）：

| 字段                                               | 形状                                | 是否按 id 寻址                                                          |
| -------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `nodes`                                            | `{ [nodeId]: NodeSchema }`          | 是，`children: string[]` / `slots: Record<string, string[]>` 存 id 引用 |
| `actions`                                          | `Record<string, ActionDeclaration>` | 是                                                                      |
| `connections`                                      | `Record<string, EventConnection>`   | 是，内含 **有序** `actionIds: string[]`                                 |
| `components`                                       | `ComponentSchema[]`                 | 数组，靠 `meta.name` 定位                                               |
| `datasources` / `apis` / `variables` / `functions` | 数组                                | 数组，靠 `id` / `name` 定位                                             |
| `route` / `metadata`                               | 单对象                              | 叶子字段                                                                |

**流程层** —— `FlowDefinition`（[packages/schema/src/flow.ts:151-176](../packages/schema/src/flow.ts)）：`nodes: Record<string, FlowNode>`、`edges: Record<string, FlowEdge>`、`settings`、`status: 'draft' | 'published'`、`version: string`（semver）。

**项目层** —— 五类资产的归属容器（[apps/host/src/projects/project-model.ts:19-36](../apps/host/src/projects/project-model.ts)）：`PageRecord`（[apps/host/src/pages/page-model.ts:15-25](../apps/host/src/pages/page-model.ts)）、`FlowDefinition`、`GlobalFunction`、`CustomComponent`、`ProjectApi`，每条只带 `projectId` 外键，项目记录不反向存资产清单——**这个设计对版本控制是白捡的**：commit 树天然可以按"资产 id → 内容 hash"表达，不必维护第二份成员列表。

> **结论**：文档已经是"JSON 可序列化 + patch 不可变 + 顶层字段即寻址路径"的提交友好形态。版本控制不需要新数据模型，需要的是**把现有形态补上确定性、唯一性和持久化**。

### 1.2 已有的相邻能力（可复用，不可混淆）

| 能力                | 现状                                                                                                                                                                                                                                                          | 与版本控制的关系                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `service-history`   | 纯内存全量快照双栈，`SnapshotEntry { meta, before, after }`，无持久化、无分支、无栈深上限（[packages/services/service-history/src/index.ts:30-63](../packages/services/service-history/src/index.ts)）                                                        | **不同轴**：history 是"会话内撤销"，版本是"跨会话历史"。保留原样，不复用为 commit 存储      |
| `service-document`  | 唯一写入口 `apply(patches, { record, label, before })` → `commitSchema()` 自增 `model.version`、置 `dirty`、写 history（[packages/services/service-document/src/index.ts:77-121](../packages/services/service-document/src/index.ts)）                        | **提交链路的接入点**：`apply` 已经是 patch 流，commit 只是把这条流聚合成一个不可变对象      |
| `SchemaPatch`       | `add / replace / remove` + JSON Pointer，不可变且**只克隆路径上的容器**（[packages/schema/src/patch.ts:103](../packages/schema/src/patch.ts)，结构化共享见同文件 95-101 注释）                                                                                | 让"哪些顶层 section 变了"可以用 `===` 引用比较判定，hash 成本可控                           |
| `ProjectRelease`    | 发布快照：`{ projectId, revision, createdAt, assets }`，写后不改；`RELEASE_RETENTION = 5`；`nextRevision`；`validateProjectRelease` 四道闸门；`pruneReleases`（[apps/host/src/projects/release-model.ts:29-270](../apps/host/src/projects/release-model.ts)） | **保留为发布产物角色**，降级为 commit 的一个视图；`revision` 与 `pruneReleases` 被 DAG 取代 |
| `setCurrentRelease` | 回滚 = 只拨 `publishedRevision` 指针，不回写资产（[apps/host/src/projects/release-store.ts:192](../apps/host/src/projects/release-store.ts)）                                                                                                                 | **必须原样继承的不变量**，方案里对应"移动环境绑定"                                          |
| `SchemaMigration`   | `migrateDocument` 显式迁移链，fail-closed（缺路径/有环/高于当前支持一律抛错）（[packages/schema/src/migrate.ts:28-54](../packages/schema/src/migrate.ts)）                                                                                                    | 版本库自身格式也需要一条**同构的**迁移链，但**不能复用同一套版本号**（见 §5.6）             |
| 内核保留服务        | `RESERVED_SERVICES` 含未使用的 `'storage'`，保留服务必须声明 `apiVersion`（[packages/kernel/src/context.ts:69-89](../packages/kernel/src/context.ts)、[:334-339](../packages/kernel/src/context.ts)）                                                         | 版本对象存储直接落位 `'storage'`，版本服务新增保留名 `'version'`                            |
| 宿主入口            | rail 里已存在 `{ id: 'versions', label: '版本管理' }` 且**无 action 即禁用态**（[apps/host/src/views/DesignerView.vue:347](../apps/host/src/views/DesignerView.vue)）；rail 支持 `action.kind: 'command'`（同文件 :335-340 是真实例子）                       | UI 入口已预留，启用它即可，不必新增外壳结构                                                 |

### 1.3 三个必须先修的地基缺陷

这三条不是"锦上添花"，**任一条不修，commit DAG 就是建在沙上**：

**① 序列化不保序 → 内容 hash 不可信。**
现状 `formatJsonValue = JSON.stringify(value, null, 2)`（[packages/shared/src/json.ts:34-37](../packages/shared/src/json.ts)），不排序键。同一个文档经过不同写入路径（`applyPatches` 的 `{ ...current }` 展开、`JSON.parse` 回读、宿主面板逐项提交）产生的对象**键插入顺序可以不同**，而 `JSON.stringify` 按插入顺序输出。后果：内容相同的实体算出不同 hash → diff 全是噪声、合并快路径（`base === ours`）永远不命中、两个客户端对同一份内容互相认为对方有改动。**这是方案的第一优先级，也是最容易被低估的一条。**

**② id 不跨端唯一 → 合并必然撞车。**
`createId(prefix)` 是进程内自增 `prefix-<seq36>`，注释明写"不保证跨刷新/跨端稳定，**不能写入持久化文档**"（`packages/shared/src/id.ts`）——但全仓复核后确认有**四处**把它的结果写进了持久化文档：`use-event-flow-store.ts` 的 `nextId`、`use-node-event-bindings.ts` 的 `nextId`（两处都只做"本张文档内查重顺延"，跨设备/跨刷新无从判断），以及 `canvas-drop/src/index.ts` 的 `buildDropNode`、`canvas-commands/src/index.ts` 的 `duplicate` / `paste` / `groupSelected`（页面节点与复制/组合产生的新节点 id，是 `PageSchema.nodes` 的键）。初次核对只记为两处，完整清单与更正理由见 [§18.1](#181-现状复核本轮新增可源码核对)。蓝图文档是同一类问题的另一种形态：旧 id 靠 `blueprint-document.ts` 的 `renameMap`（`taken/wanted` 双重检查）做确定性前缀迁移，提交 `452cfa0` 修的就是"id 相撞丢节点"——但 `renameMap` 是**存量迁移而非 id 生成**，必须保持幂等，不能用随机 id 替换。宿主侧资产 id 用 `Date.now + Math.random`，同类私有生成器共 7 处，同一毫秒批量创建仍可能撞。后果：实体级合并以 id 为主键，id 语义是"全局唯一且永不复用"，不成立时"两侧各加一个节点"会被判成"同一条被两侧改成不同内容"→ 伪冲突，或者更糟——静默覆盖。

> **补充约束（实测得出，容易踩）**：dev/preview 监听 `0.0.0.0` 且远程地址用局域网 IPv4（[apps/host/vite.config.ts:26-28](../apps/host/vite.config.ts)、[:56-57](../apps/host/vite.config.ts)），也就是**页面运行在非安全上下文**。浏览器只在安全上下文暴露 `crypto.subtle` 与 `crypto.randomUUID`，因此**方案不能把 hash 和 id 生成建立在这两个 API 上**，否则用局域网 IP 打开设计器时直接不可用。全仓当前零 `crypto` 引用，属新增能力。

**③ 历史不落盘 → 没有可查询的历史。**
`service-history` 栈纯内存（§1.2），宿主保存只在"手动点保存"时把整份 `PageRecord.schema` 写回 localStorage（`save()`，[apps/host/src/views/DesignerView.vue:280-288](../apps/host/src/views/DesignerView.vue)），脏判据用 `model.version` 与"最后一次写回的版本"对比而非 `dirty`（同文件 :102-110）。也就是说：**现在"改了什么、谁改的、什么时候"这三问一条都答不出来**。

---

## 2. 目标与非目标

**目标**

1. 任意时刻可回答：这份文档/这个项目在历史上任一节点长什么样，两处之间差异是什么。
2. 并行开发不互相覆盖：两个分支改不同实体自动合并；改同一实体给出可操作的冲突，而不是"用我的还是用你的"一把梭。
3. 回滚代价可控：回滚一个页面不等于放弃别人这段时间的所有工作。
4. 发布可判定：某次发布对应一组不可变内容 + 一份校验凭据，线上行为不随后续配置漂移（继承 `ProjectReleaseAssets.environment` 冻结这一既有设计）。
5. 契约面小：上层 API 与底层存储解耦，localStorage → IndexedDB → 服务端三级换床不换代码。

**非目标**

1. **不做像素级实时协同**（两人同时拖同一节点的每帧同步）。过渡方案是软锁 + 合并（§12）。
2. **不做代码/文档之外的资产版本化**：物料包、插件 remote 的版本属于供应链（manifest 已有 semver + `engines.lowcode`，[packages/contracts/src/manifest.ts:39-69](../packages/contracts/src/manifest.ts)），本方案不重复发明；两者接口只在"发布快照记录用到的插件版本"处交汇。
3. **不承诺历史不可篡改/合规审计链**：`audit` 服务位仍是空的，本方案只提供不可变对象，不提供签名与合规留存。[§18](#18-企业治理接缝-提案) 只定义与企业控制面之间的事件、凭据与权限接口形状，不改变本条边界。
4. **不做 Git 兼容的 packfile / 双向推送第三方仓库**（列为 §17 的远期可选互逆项）。

---

## 3. 方案选型

| 方案                                                                                                                   | 做法                                    | 判定                                | 理由                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. 自建内容寻址 commit DAG + 实体级合并**                                                                            | 本文方案                                | ✅ **采纳**                         | 文档已是 id 寻址字典，实体合并成本低、语义准；模型与 git 同构，服务端可后置；不引第三方运行时依赖                                                                                                                                                                                            |
| B. 只做快照 + 发布流（主流企业低代码：OutSystems/Mendix 的发布流水线，葡萄城 Master/Develop/Hotfix 分支 + 对象签出锁） | 里程碑、逐实体 diff、指针回滚、环境晋级 | ⚠️ **作为 A 的子集**                | 这是主流低代码的公共最大集，工程量约为 A 的一半。用户已选"要做到合并档"，因此把它实现为 P0-P2 的中间产物，而不是终点                                                                                                                                                                         |
| C. CRDT 实时协同（Yjs / Automerge / Loro）                                                                             | 文档改成 CRDT 原生结构，多人同屏        | ❌ **当前拒**                       | 需要重写 id 方案（CRDT 用因果 id 而非外部生成 id）与 patch 寻址（JSON Pointer 与 CRDT path 不同构），并新增依赖。收益集中在"同屏实时"这一非目标上                                                                                                                                            |
| D. 嵌 `isomorphic-git` + 虚拟 FS                                                                                       | 文档序列化成 JSON 文件提交              | ❌ **拒**                           | ① 浏览器无 FS，要带一套 MEMFS/indexeddb FS，包体积大；② git 的合并单位是**文本行**，对 `{node-3: {...}}` 字典行做行合并会产生语义错误的"自动成功"（同一行两侧都改只能报冲突，而实体级本可自动合并）；③ 拿不到 `ProjectRelease` 的资产级校验。**保留**：导出/导入 git 仓库作为远期互逆（§17） |
| E. JSON 文本级 diff（`jsondiffpatch` / RFC 6902 全量）                                                                 | 逐路径 diff + patch 变换                | ❌ **拒为主方案**（可作展示层补充） | 现有 `SchemaPatch` 就是 RFC 6902 子集，够用；文本级合并对 id 字典没有增益，还引入 operational transform 的复杂度                                                                                                                                                                             |

**参考的业界做法（用于校准，不是照抄）**

- **Appsmith / Mendix**：把应用模型映射到真实 Git 仓库，走分支 + PR + 合并。启示：**外部 Git 作交付与审阅层，内部另有结构化 diff**；本方案取"内部实体 diff 为权威，Git 为可选导出"。
- **OutSystems**：Service Studio 提交 → 流水线（Build/Deploy per environment）+ 环境间晋级。启示：**版本 ≠ 环境**，环境是部署绑定。本方案的 `EnvironmentBinding` 即对应。
- **葡萄城 / LowcodeEngine 实践**：Master 受保护、Develop 迭代、Hotfix 从 Master 出；对象级签出锁（小锁图标）；"创建应用 → 建分支 → 提交 → 形成里程碑"。启示：**软锁是被验证过的低成本协同手段**，直接进 §12 的阶段 A。
- 上述方案的共同点是**都没有把 undo 栈当版本库**。本方案同样严格区分（§5.7）。

---

## 4. 概念模型

```
项目 (ProjectDefinition)
  └── 版本库 Repo ────────────── 一个项目一个 repo（repoId = projectId）
        ├── Ref（可变指针）
        │     ├── branch: main / feature/* / release/* / hotfix/*
        │     ├── tag:    发布标签（人读名，指向 commit）
        │     └── head:   当前检出指针（指向 branch 名）
        ├── Commit（不可变，内容寻址）
        │     ├── parents[]      0 个 = 根提交，1 个 = 普通，≥2 个 = 合并提交
        │     ├── tree: DocEntry 项目内全部文档的「id → section hash」清单（= git 的 root tree）
        │     ├── meta           作者、时间、消息、意图（重命名等）
        │     └── publish?       发布凭据（校验结果摘要 + 冻结的环境）
        └── Object（不可变，内容寻址）
              ├── section  一个文档顶层字段（nodes / actions / edges / …）的规范化 JSON  ← 去重与增量的单位
              └── document 一个文档的 section 清单（= git 的 tree）
```

三层指针与两层对象的关系，就是"分支可移动、提交不可变、内容可寻址"这三条 git 性质的直译。**section 对象是刻意保留的最小粒度**：它正好等于 `SchemaPatch` 路径的第一段（`/nodes/...`、`/actions/...`），因此 diff、合并、去重、hash 跳过都能沿同一边界走，不需要再发明一套切分规则。

**术语对照**

| git                | 本平台                                | 主流低代码对应说法     |
| ------------------ | ------------------------------------- | ---------------------- |
| repository         | `Repo`（按项目）                      | 应用/工程              |
| blob               | `SectionObject`                       | —                      |
| tree               | `DocumentObject` / `CommitTree`       | —                      |
| commit             | `Commit`                              | 提交记录、检查点       |
| HEAD               | `HeadRef`（指向分支名）               | 当前编辑版本           |
| branch             | `Branch`                              | 开发分支 / 版本线      |
| tag                | `Tag`                                 | 版本 / 里程碑 / 发布号 |
| checkout           | `checkout(ref)` + Realm 换装          | 进入某版本编辑         |
| merge conflict     | `Conflict`（实体级）                  | 冲突解决               |
| stash              | 不做（内存 history 已覆盖会话内需求） | —                      |
| environment deploy | `EnvironmentBinding`                  | 发布到 dev/test/prod   |

---

## 5. 数据模型与类型 `[提案]`

新增包 `packages/services/service-version`（`@lc/service-version`），纯 Core 无 Vue、无浏览器 API，符合 Monorepo 依赖方向：可依赖 `@lc/contracts`、`@lc/schema`、`@lc/kernel`、`@lc/shared`，**不得**反向依赖 `apps/host`（现状快照与发布数据都在 host，见 §13 的下沉安排）。

### 5.1 对象与引用

```ts
/** 版本对象的种类，判别位。 */
export type VersionObjectKind = 'section' | 'document'

/** 可写入对象存储的两类不可变对象，判别位是各自的 `kind`。 */
export type VersionObject = SectionObject | DocumentObject

/** 内容寻址得到的地址：SHA-256 摘要前 160 bit 的 40 字符小写十六进制。 */
export type ObjectHash = string

/**
 * 一个 section 的内容对象。
 *
 * 存规范化 JSON 文本而不是 JS 对象：文本才是 hash 的输入，
 * 反序列化成对象再序列化会引入键序差异，等于自己破坏自己的寻址依据。
 */
export interface SectionObject {
  /** 对象种类，判别位 */
  kind: 'section'
  /** 内容地址 = hashText(canonicalJson({ docId, section, content }))；命名空间必须入 hash */
  hash: ObjectHash
  /** 所属文档 id */
  docId: string
  /** 文档顶层字段名，与 SchemaPatch 路径首段一致；如 nodes、actions、edges */
  section: string
  /** 规范化 JSON 文本 */
  content: string
  /** 字节数，供容量统计与 GC 排序，不参与 hash */
  size: number
}

/**
 * 一个文档的对象清单（git tree 的对应物）。
 *
 * 只存 section → hash，不存内容：同一份 nodes 在 100 个提交里只有一份字节。
 * 缺键表示「该 section 在此版本不存在」，而不是空值——与 arrayFieldPatch
 * 「清空即 remove 键」的既有约定同口径，避免 diff 里积出无意义噪声。
 */
export interface DocumentObject {
  /** 对象种类，判别位 */
  kind: 'document'
  /** 内容地址 */
  hash: ObjectHash
  /** 文档种类，决定校验与 diff 的实体规则 */
  docKind: VersionDocKind
  /** 各 section 的内容地址 */
  sections: Record<string, ObjectHash>
  /**
   * 文档结构版本（PageSchema.version / SCHEMA_VERSION 同源）。
   *
   * 与版本库自身格式版本是两个轴，必须各存一份（§5.6）：
   * 读一个老提交时，先按 repoFormat 迁移版本库结构，再按 docSchemaVersion 迁移文档内容。
   */
  docSchemaVersion: string
}

/** 可版本化的文档种类，与项目五类资产一一对应。 */
export type VersionDocKind = 'page' | 'flow' | 'function' | 'component' | 'api'
```

### 5.2 提交与指针

```ts
/** 提交树：项目内全部文档的当前内容地址。 */
export interface CommitTree {
  /** 文档 id → DocumentObject 的 hash；缺键即该文档在此提交中不存在 */
  docs: Record<string, ObjectHash>
}

/**
 * 一次提交的意图记录。
 *
 * 存在的唯一理由：重命名对内容 diff 不可见（旧键消失 + 新键出现 = 一删一增），
 * 但语义是「同一条被改名」。不显式记录，合并时就会把改名当成删除，把改名后
 * 的编辑判成「向一条已删除的实体写入」。除重命名外不设其他意图类型。
 */
export interface CommitIntent {
  /** 被改名的实体 id（改名前的值） */
  from: string
  /** 改名后的实体 id；对 `name` 型实体（变量、绑定名）from/to 都是名字 */
  to: string
  /** 改名发生的文档 id */
  docId: string
  /** 实体所属 section，用于定位改名范围 */
  section: string
}

/** 一个不可变提交。 */
export interface Commit {
  /** 提交地址，由 canonicalHash(提交头) 得出；即权威编号 */
  id: ObjectHash
  /** 归属版本库 id，等于 projectId */
  repoId: string
  /**
   * 父提交。
   * 长度 0 = 根提交；1 = 普通提交；≥2 = 合并提交，约定第 0 个为被合入的目标分支。
   */
  parents: ObjectHash[]
  /** 项目全量文档树 */
  tree: CommitTree
  /** 提交消息，用户输入 */
  message: string
  /** 提交人标识；本地无鉴权时来自宿主注入的当前用户名 */
  author: string
  /** 提交时间（ISO 字符串），不参与 hash 计算 */
  createdAt: string
  /**
   * 相对于第一父提交的意图清单（可选）。
   * 缺省即无重命名，合并走通用规则。
   */
  intents?: CommitIntent[]
  /** 发布凭据（可选）；有值即该提交是一次正式发布 */
  publish?: PublishReceipt
}

/** 发布凭据：把「这次发布当时能不能跑」钉死在提交上。 */
export interface PublishReceipt {
  /** 人读发布号，兼容既有 revision 与 semver 两套口径的显示位 */
  label: string
  /** 发布闸门结果，逐条留痕 */
  issues: ValidationIssue[]
  /**
   * 冻结的请求环境内容地址。
   *
   * 环境值不入文档（`requestDefaults` 属于环境不属于文档，见 docs/05），
   * 但发布必须把它一起定版：否则「v3 昨天还能跑」取决于当前配置。
   * 沿用 ProjectReleaseAssets.environment 的既有语义。
   */
  environmentHash: ObjectHash
  /** 发布人 */
  publishedBy: string
}

/** 可变引用。ref 表是版本库里唯一允许原地更新的地方。 */
export interface Ref {
  /** 引用全名，如 refs/heads/main、refs/tags/v12 */
  name: string
  /** 指向的对象地址 */
  target: ObjectHash
  /** 更新时间 */
  updatedAt: string
  /** 最后移动者 */
  movedBy: string
}

/** 分支元数据，与 Ref 分开存：分支可以删、可以保护，tag 不需要这些。 */
export interface BranchMeta {
  /** 分支名 */
  name: string
  /** 受保护分支禁止直接提交，只接受合并与发布（main、release/*） */
  protected: boolean
  /** 从哪个提交切出，用于展示「落后主干多少」 */
  base: ObjectHash
}

/** 环境部署绑定：环境不是版本，是「环境当前认哪个提交」。 */
export interface EnvironmentBinding {
  /** 环境名，与 api-config-model 的 isEnvironment 口径一致 */
  env: 'dev' | 'test' | 'prod'
  /** 绑定的提交地址 */
  commit: ObjectHash
  /** 是否跟随分支自动前移；只有 dev 允许 true */
  autoFollow?: string
}
```

### 5.3 Diff 结果（实体级）

```ts
/** 一个实体在两侧的取值，unknown 而非省略：冲突解决 UI 必须能看到基线内容。 */
export interface EntityChange {
  /** 文档 id */
  docId: string
  /** section 名 */
  section: string
  /** 实体 id；叶子字段类 section（route、metadata）用 JSON Pointer 作 id */
  entityId: string
  /** 变更类型 */
  change: 'added' | 'removed' | 'modified'
  /** 实体展示名，由物料元数据/文档标题解析，UI 用它而不是裸 id（可选） */
  label?: string
  /** 基线值，added 时为 undefined */
  base?: unknown
  /** 本侧值，removed 时为 undefined */
  ours?: unknown
  /** 对侧值，仅合并场景有值 */
  theirs?: unknown
}
```

> `base/ours/theirs` 三格而不是只存 hash 是刻意的：冲突解决的最低可用形态是"看清三方各是什么"。若这里只留地址，UI 必须回头查对象表才能显示，等于把三方合并降级成两方对比。

### 5.4 合并计划与冲突

```ts
/** 合并的可执行计划：先算，再让用户确认，最后落盘。 */
export interface MergePlan {
  /** 使用的合并基线（LCA）地址 */
  base: ObjectHash
  /** 可自动合并的实体变更 */
  clean: EntityChange[]
  /** 需要人工裁决的实体 */
  conflicts: Conflict[]
  /** 合并后的文档树（已含自动合并结果，冲突项按 resolution 填充后才是最终值） */
  tree: CommitTree
}

/** 一个冲突。 */
export interface Conflict {
  /** 冲突形态 */
  kind: 'both-modified' | 'delete-modify' | 'add-add' | 'order' | 'rename' | 'dangling-ref'
  /** 涉及的实体 */
  entity: EntityChange
  /** UI 可给的处置选项 */
  options: Array<'ours' | 'theirs' | 'manual' | 'keep-both'>
}
```

`dangling-ref` 是低代码特有的一类：实体级合并后 `nodes` 自身没冲突，但 `children` 里指向了另一侧被删掉的 id。这类冲突**不可能由文本合并发现**，正是选方案 A 而非 D 的实证理由。

### 5.5 不变量（实现与测试都必须钉住）

| 编号 | 不变量                                                                              | 现有代码里谁在守                                            |
| ---- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| I1   | commit / section / document 对象一经写入永不修改                                    | 新增；沿用 `ProjectRelease`"能改的快照就不是快照"的既有论述 |
| I2   | 同一内容在任何设备上得到同一 hash                                                   | 依赖 §6 确定性                                              |
| I3   | 分支只是指针，移动分支不改任何对象                                                  | 新增                                                        |
| I4   | 实体 id 全局唯一、永不复用、改名不换 id                                             | 依赖 §6.2；现状 `PageRecord.id` 已满足"改名不影响"          |
| I5   | 合并后不得凭空丢失：任一侧存在的实体，要么进结果、要么进冲突清单                    | 属性测试（§15）                                             |
| I6   | 自动合并结果必须通过 `validateDocument` / `validateFlow`，不过则降级为冲突          | 复用现有校验                                                |
| I7   | 回滚/切环境只移动绑定或 ref，不回写资产记录                                         | 现状 `setCurrentRelease` 已如此                             |
| I8   | 权威编号只有 commit hash；`revision` / semver 只是显示标签                          | 与 §9.4 配套，**必须**明确否则三套并行                      |
| I9   | `dirty` 与工作区状态由「working copy vs HEAD」判定，不再由 `model.version` 自增判定 | 现状宿主用 version 对比，需换（§7.3）                       |
| I10  | 历史可达性：GC 只能删除从所有 ref 都不可达的对象                                    | 取代 `pruneReleases` 的按份数剪枝（见 §14「可达性 GC」行）  |
| I11  | 版本库任何一次写入失败不得留下半提交（对象写失败 → 提交不可见）                     | 沿用 `publishProject`"先落快照后移指针"的既有顺序思路       |
| I12  | 环境值不入文档，但发布必须冻结环境                                                  | 现状 `collectProjectAssets` 已如此                          |

### 5.6 两个"版本"轴，不许混用

现状已经存在三处 `version` 语义（`PageSchema.version` = 结构版本 / `DocumentModel.version` = 会话内自增计数 / `ProjectRelease.revision` = 发布号 / `FlowDefinition.version` = semver），本方案**不新增第四种编号**，而是明确分工：

| 轴             | 承载                                     | 谁改               |
| -------------- | ---------------------------------------- | ------------------ |
| 文档结构版本   | `docSchemaVersion`（= `SCHEMA_VERSION`） | 平台发版时         |
| 版本库格式版本 | `repoFormat`（`lc.version.v1` → v2 …）   | 版本存储结构演进时 |
| 会话内提交计数 | `DocumentModel.version`（不动）          | 每次 `apply`       |
| 权威历史编号   | commit hash                              | 每次提交           |
| 人读标签       | `PublishReceipt.label` / `Tag`           | 发布时             |

`repoFormat` 的迁移链照 `migrateDocument` 的三条 fail-closed 规则写（高于支持、缺路径、有环一律抛错），但**独立注册表**——把两个轴挤进同一个 `SCHEMA_VERSION`，后果是"升级文档结构"会连带要求重写全部历史对象，版本库还没做完一次备份就先坏。

### 5.7 undo ≠ commit

`service-history` 保持纯内存、不动契约（[packages/contracts/src/services/history.ts:30-45](../packages/contracts/src/services/history.ts)）。它的 `SnapshotEntry` 存整份 schema 引用，靠 `applyPatches` 的结构化共享来降内存——这恰好**不能**直接当 commit：撤销栈是线性的、会话局部的、会被丢弃的，而 commit 必须是 DAG、跨会话、被 ref 可达性保护。两者唯一交集是"提交时可以用 history 的聚合结果作为 patch 来源"（§7.2）。

---

## 6. 确定性与唯一性（P0 前置）

### 6.1 规范化与 hash

```ts
/** 把任意 JSON 值规范化为字符串：对象键按 Unicode 码点升序、数组保序、undefined 剔除。 */
export function canonicalJson(value: unknown): string

/** 对已规范化的文本取内容地址（SectionObject 存的是文本，不二次规范化）。 */
export function hashText(text: string): ObjectHash

/** 规范化任意值再取地址，等价于 hashText(canonicalJson(value))。 */
export function canonicalHash(value: unknown): ObjectHash

/**
 * 异步加速路径：crypto.subtle 可用时走原生，否则回退纯 JS。
 * 单独开一个 API 是因为 subtle.digest 是异步的，无法塞进同步的 canonicalHash 签名；
 * 两条路径同输入同输出必须属性测试钉住，否则生产 HTTPS 与局域网 HTTP 会算出两套地址。
 */
export function canonicalHashAsync(value: unknown): Promise<ObjectHash>
```

设计要点：

1. **数组保序**，不排序。`children` / `slots` / `actionIds` 的顺序就是语义（视觉顺序、执行顺序），排序会把两个真实不同的版本算成同一个。
2. **数字走 `Number.toString` 最短路**并拒绝 `NaN`/`Infinity`（JSON 里它们会静默变成 `null`，等于内容被改写）；`-0` 归一为 `0`。这两条不处理的话，一个"节点 x 从 0 改成 -0"的 diff 会永远显示成两侧相同却 hash 不同。
3. **`undefined` 键在规范化时删除**，与 `arrayFieldPatch`"清空用 `remove` 而不是留空数组"的既有约定同口径（[packages/schema/src/patch.ts:182-192](../packages/schema/src/patch.ts)）。
4. **hash 用纯 JS SHA-256（新增到 `@lc/shared`），不用 `crypto.subtle`。** 理由即 §1.3② 的实测约束：非安全上下文下 `crypto.subtle` 为 `undefined`，而 dev/局域网预览正是非安全上下文。允许在 `crypto.subtle` 可用时走它提速，但**必须有属性测试断言两条路径同输入同输出**——否则同一份内容在生产（HTTPS）与预览（HTTP）下算出不同地址，历史列表会当场分裂成两套。
5. 地址取摘要的前 160 bit（40 字符十六进制）：够短可以当 IndexedDB 的 key，碰撞概率又低到不需要处理。但**写入仍校验同地址内容一致**——`putObject` 遇到"同 hash 已存在且内容不同"必须 fail-closed 抛错而不是静默覆盖，因为那意味着规范化函数出了 bug，静默去重会把两份不同文档压成一份（与 `CommandService.register` 的"id 冲突抛错而不覆盖"是同一取舍，见 [packages/services/service-command/src/index.ts:25-31](../packages/services/service-command/src/index.ts)）。展示层取前 8 字符加省略号；比较一律用完整字符串，不做前缀或数值比较。
6. `formatJsonValue` 保持原样不动——它是给人看的缩进文本，改成排序输出会让 JSON 输入框的字段顺序变得反直觉。**新能力另开函数，不改现有展示层。**
7. **`SectionObject.hash` 的输入是 `{ docId, section, content }` 的规范化文本，而非裸 `content`。** 这是 P2b 接入真实五类资产后由运行时断言逼出来的一处修正：`SectionObject` 自带来源元数据，而 `putObject` 的 fail-closed 要求"同地址即同对象"；只按 content 取址时，两张页面的同值 section（如空对象 `{}`、空数组 `[]`）会算出同一地址却写出两个不同对象，第一次提交就被误判为"规范化失效"。把命名空间入 hash 后，跨提交的同名同值 section 仍共享一份字节（容量收益不变），跨文档各自独立。`object.spec.ts` 已加对应回归用例。P1 未上线、默认档位 `off`，不存在需迁移的存量对象。

### 6.2 跨端稳定 id

```ts
/** 生成可持久化的稳定 id：prefix-<时间 base36><随机 base36>，长度对齐现有资产 id 风格。 */
export function createPersistentId(prefix: string): string
```

1. **不用 `crypto.randomUUID`**（同样受非安全上下文限制），也不用引 `nanoid`/`uuid` 依赖——现有 `Date.now + Math.random` 风格（宿主三处 store）其实已经是对的形态，缺的是**集中化 + 熵足够 + 撞名重试统一**。
2. 熵组成：48bit 时间 + 48bit 随机（两次 32bit `Math.random` 拼接），并在模块内维护 `seen` 集合做**同进程去重**（现在 `Date.now()` 在同一 tick 内不变，批量创建 10 个节点确实会撞）。
3. 改造点清单（本轮源码复核后的完整口径，依据见 [§18.1](#181-现状复核本轮新增可源码核对)；以符号名定位，P0 落地后行号需复核）：
   - **写进文档的 `createId` 调用共四处，不止两处**：`use-event-flow-store.ts` 的 `nextId`、`use-node-event-bindings.ts` 的 `nextId`、`canvas-drop/src/index.ts` 的 `buildDropNode`（页面节点 id）、`canvas-commands/src/index.ts` 的 `duplicate` / `paste` / `groupSelected`（复制与组合产生的新节点 id，经 `insertSubtrees` / `groupNodes` 的 `createId` 注入点）。四处全部换成 `createPersistentId`，`nextId` 的 `while (used.has(id))` 重试保留为最后一道防线。
   - `service-workspace` 的 `realm.id` / `canvas.id` 与 `service-history` 的 `meta.id` 是运行时标识，不落文档，保持 `createId` 不变。
   - `apps/host/src/custom-components/blueprint-document.ts` 的 `renameMap` **不改**：它不是新 id 生成器，而是旧蓝图 id 的确定性前缀迁移（`node-1` → `bp-node-1`，候选相撞按 `-2` 顺延），要求同一输入恒得同一输出、二次载入幂等；换成随机 id 会每次载入都重写节点与引用。`apps/host/tests/blueprint-document.spec.ts` 已把 `bp-root` / `bp-node-1` 写成断言。真正需要修的是「新拖入蓝图的节点用了 `createId('node')`」，即上一条的 `canvas-drop`。
   - 宿主私有生成器共 **7 处同形态**（`page-store` / `flow-store` / `project-store` / `api-store` / `api-config-model` 的 `createEnvironmentId` / `global-functions` / `custom-components`），全部收敛到 `@lc/shared`；`use-flow-debug.ts` 的 `exec_` 是一次调试执行 id，不落文档，保持不动。
4. **存量 id 不做迁移**：它们是字符串，唯一性只对"新建"有意义。`createId` 的注释同步改成"运行时对象标识专用，禁止用于文档实体"，并加一条 lint 级约束（约定：`createId` 的结果不得出现在 `apply(patches)` 的 value 里）——注释里那句话已经写了，是两处调用点违反了它。

---

## 7. 提交链路：与现有 `document.apply` 的接缝

### 7.1 三层工作模型

```
working copy   = Realm 里当前 model.schema（用户正在看的）
index（暂存）  = 该分支上"最后一次提交之后"累积的 patch 聚合
commit         = 不可变对象 + ref 前移
```

不引入 git 的 staging area **语义**（用户不必理解"add"），但保留其**数据结构**，理由很实际：设计器里一次"保存"可能对应几十个 patch 批次（拖拽手势、面板失焦、属性逐键提交），逐个成 commit 会让历史不可读，逐次写对象会打满存储。

### 7.2 时序

```
用户操作
  → DocumentService.apply(patches, { record: true })       [现有，不改]
      → history.record(...)                                 [现有，不改]
      → VersionService.observePatches(docId, patches)       [新增订阅]
          → 累积进 index（不写对象）
保存/提交触发（显式 or 自动 checkpoint）
  → 受影响 section 规范化 → canonicalHash
      ↳ 未变 section 用引用比较直接跳过（applyPatches 的结构化共享在此白捡）
  → 写变化的 section/document 对象（幂等：同 hash 已存在即跳过）
  → 写 commit 对象，tree = 上一提交 tree + 变化项
  → 前移分支 ref
  → index 清空，dirty = false
```

**接入方式**：`VersionService` 订阅 `document:change` 事件（`service-document` 已在每次提交时 `ctx.emit('document:change', { model })`，见 [packages/services/service-document/src/index.ts:64-68](../packages/services/service-document/src/index.ts)）并对比 `model.schema` 与上次快照的 section 引用。**不改 `DocumentService` 契约**——它是稳定契约面且被大量插件依赖。

### 7.3 保存语义的重新定义（必须显式决策的点）

现状：宿主"保存"按钮把整份 schema 覆盖写回 `lc.pages.v1`，脏判据用 `model.version` 对比（§1.3③）。提案：

| 现状                                | 提案                                                                 | 迁移期兼容                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 保存 = 覆盖资产记录                 | 保存 = 提交（写对象 + 前移 ref），资产记录变成"当前分支 HEAD 的投影" | `lc.pages.v1` 继续写（作为 working copy 与旧运行态读取路径），版本库并行写；灰度期以旧路径为准，见 §13 |
| 脏 = version 变了                   | 脏 = `index` 非空（I9）                                              | 保留 version 自增供缓存失效，不动                                                                      |
| 从未发布的 `publishedRevision` 缺省 | `prod` 无绑定即"从未发布"                                            | 由旧 `publishedRevision` 反查导入                                                                      |

---

## 8. Diff 与三方合并

### 8.1 section 快路径

对每个 `(docId, section)` 三元组：

```
hash(base) === hash(ours)  → 取 theirs            # 本侧没碰，白送
hash(base) === hash(theirs) → 取 ours             # 对侧没碰，白送
hash(ours) === hash(theirs) → 取任一侧             # 两侧改成一样，无冲突
否则 → 进入实体级合并
```

这三条是 §1.3① 那笔账的直接兑现：**只要序列化不保序，第一条快路径永远不命中**，每次保存后所有 section 都"看起来变了"。

### 8.2 实体级三方规则

section 是字典（`nodes` / `actions` / `edges` / `connections`）时，按 id 取三方并集逐条判定：

| base | ours          | theirs         | 结果                             |
| ---- | ------------- | -------------- | -------------------------------- |
| 无   | 无            | 无             | 跳过                             |
| 有   | 同 base       | 同 base        | 保留（快路径已拦）               |
| 有   | 改            | 同 base        | 取 ours                          |
| 有   | 同 base       | 改             | 取 theirs                        |
| 有   | 改            | 改（相同内容） | 取任一                           |
| 有   | 改            | 改（不同内容） | **冲突** `both-modified`         |
| 有   | 删            | 同 base        | 删                               |
| 有   | 同 base       | 删             | 删                               |
| 有   | 删            | 改             | **冲突** `delete-modify`         |
| 有   | 改            | 删             | **冲突** `delete-modify`         |
| 有   | 删            | 删             | 删                               |
| 无   | 加            | 无             | 加 ours                          |
| 无   | 无            | 加             | 加 theirs                        |
| 无   | 加（id 相同） | 加（内容不同） | **冲突** `add-add`               |
| 无   | 加（id 不同） | 加（id 不同）  | **都保留** ← I4 唯一性在这里兑现 |

`route` / `metadata` / `settings` 是单对象，退化为**字段级**三方（叶子路径逐个套同一张表）；`components` / `datasources` / `apis` / `variables` / `functions` 是数组，先按稳定键（`id`，缺 `id` 时按 `meta.name` / `name` / `binding`）转成字典再套表。

> **转成字典只是合并期的内部表示，输出必须还原成数组并保序**（实现口径，2026-11-09 数组重排轮补）：键序按「基线序 → 本侧新增 → 对侧新增」，与嵌套数组走的 `mergeArray` 同一条规则（`mergedKeys()`）。曾经 `mergeSection` 在字典分支上多了一个 `.sort()` 并被数组分支复用，于是两侧都改过同一个数组 section 时元素被按 name / id 静默重排，违反 §6.1「数组保序，顺序就是语义」。字典分支保留排序——键序对字典无语义（`canonicalJson` 会排序），排一下只为让冲突清单的顺序不随工作区的键插入序而变。

> **为什么不直接对整份数组做集合 diff**：数组索引进 patch 路径（`/components/0/...`），换序会让每个元素的指针路径全变，等于所有元素都"被修改"。先按键转字典是必要的，这也解释了为什么 `SchemaPatch` 的数组下标语义在版本控制下是有害的——**新增的实体级 patch 应优先用 id 键路径**（`arrayFieldPatch` 整体替换的模式在页面数据弹框与接口绑定两处已经是"整数组 replace"，合并时按整段实体集合处理即可，不需要下标）。

### 8.3 有序 id 列表的合并（本方案最难的一小块）

`nodes[x].children`、`nodes[x].slots[k]`、`connections[k].actionIds` 都是**有序 id 数组**。规则：

```
输入 base/ours/theirs 三个 id 序列（元素本身是 id，天然可作对齐键）
1. 集合层：套用 §8.2 的增删改表 → 得到存活 id 集与删除集
2. 顺序层：以 ours 为基准序列；把 theirs 独有的 id 插回
   「它在 base 中的前一个存活 id」之后（前驱锚定）
3. 同一前驱后两侧各插了新元素 → 顺序 ours 先，记 order 冲突（低严重度）
4. 两侧把同一 id 挪到不同位置 → 取 ours，记 order 冲突
```

元素本身就是 id，所以不需要 LCS 相似度算法——**这是 id 字典带来的免费午餐**，也是不用文本 diff（方案 E）的第二个实证好处：git 处理行序列要 LCS/直推、要猜"哪些行是同一实体"，这里没有这个问题。代价是顺序类误判只能标为低严重度：视觉顺序错了可以一眼看到并手动拖动修正，不是数据损坏。

### 8.4 引用完整性

合并**不能**只看实体本身。跨节引用清单（本方案的"引用图"，全部来自现有 schema，不新增约定）：

| 引用方                            | 被引用                                       | 位置                                       |
| --------------------------------- | -------------------------------------------- | ------------------------------------------ |
| `nodes[a].children` / `slots[k]`  | `nodes[b].id`                                | page.ts / node.ts                          |
| `connections[k].actionIds`        | `actions[m].id`                              | page.ts:107-115                            |
| `nodes[a]` 的表达式 `data.<name>` | `datasources[].binding` / `variables[].name` | 表达式引擎                                 |
| `PageSchema.apis[].apiId`         | `ProjectApi.id`                              | page.ts:121-128 + `findUnresolvedBindings` |
| `FlowEdge.source/target`          | `FlowNode.id`                                | flow.ts:77-93                              |
| `FlowTriggerConfig.sourceNodeId`  | 页面文档 id + 节点 id                        | flow.ts:106-119                            |

合并产物先跑 `validateDocument` / `validateFlow`（复用，不另写一套），再补一条**悬空引用检查**（`findUnresolvedBindings` 只覆盖 api 绑定这一类，其余需新增），命中即生成 `dangling-ref` 冲突，处置选项是"恢复被删实体 / 清除引用"。**不做自动删除级联**：合并的默认责任是保守，自动级联删会在一次冲突误判里连坐一批节点。

### 8.5 重命名

由 `CommitIntent` 承载（§5.2）。合并时：

- 单侧改名、另一侧未碰该实体 → 直接应用改名，并重写该文档内所有 §8.4 引用（改名器已有等价逻辑：`PageRecord` 改标题会同步写 `schema.metadata.title`，说明"改名要连带"是既有事实）。
- 单侧改名、另一侧改了同一实体 → `rename` 冲突，默认建议"改名 + 内容改动"合并（因为改的内容通常更值得留），但必须显式让用户确认。
- 两侧改成不同名 → `rename` 冲突。
- 从未记录 intent（存量数据、旧提交）→ 退化为"删 + 加"，诚实告知用户该提交的重命名不可识别。**不假装能做到**：不记录 intent 又想让合并发现改名，只能靠相似度猜测，猜错的代价是把两个人各自新建的同名节点当成一次改名，静默合并掉一条真实实体。

### 8.6 LCA 与多基线

`mergeBase(a, b)` = a、b 祖先集的交里的极大元。多个 LCA 时按 git 的 recursive 思路：两两合并基线生成**虚拟基线**，直至唯一。虚拟基线只在内存里存在，不落盘（不落盘的理由：它不是"曾经发生过的状态"，落盘会让 `log` 出现用户从未创建的提交，破坏历史的可解释性）。

### 8.7 合并不变式（可直接转成属性测试）

1. **无冲突可交换**：`merge(a, b) === merge(b, a)`（干净合并的结果不应取决于谁主动合谁）。
2. **幂等**：`merge(x, x) === x`。
3. **单向改动全收**：若 `a` 与基线相同，结果等于 `b`（不丢 `b` 的任何改动）。
4. **不凭空消失**（I5）：任一侧存在的实体，在结果中或存活、或出现在冲突清单里。
5. **合并产物通过校验**（I6），否则不产出结果。
6. **顺序确定性**：§8.3 对同一输入恒得同一输出（否则每次合并结果不同，diff 与 hash 都无法稳定）。

> 实现口径（2026-11-09 P3 落地）：第 1/2/3/4/6 条由 `tests/merge.spec.ts` 的十万次随机序列 + 两万次随机树属性测试直接转成断言；第 5 条通过 `VersionServiceOptions.validate` 注入既有校验器实现（未注入时 `MergePlan.validation` 为 `skipped`，不谎报通过），由 `tests/service-merge.spec.ts` 覆盖。规则表的字段级下钻、`manual` 值粒度、虚拟基线折叠深度与 `keep-both` 的取舍见 §16 P3「实现细化与明确边界」。

---

## 9. 分支、保护与环境晋级

### 9.1 分支模型（对齐主流低代码实践 + git）

```
refs/heads/main          受保护。只接受来自 release/* 的合并与 hotfix/* 的合并
refs/heads/feature/<名>  个人特性分支，从 main 切出
refs/heads/release/<号>  发布分支，从 main 切出；只允许修问题，不加功能
refs/heads/hotfix/<名>   从 main（= 线上）切出，修完合回 main 与 release
refs/tags/v<号>          发布标签，指向 main 或 release 的一次发布提交
```

对应用户可感知的三个动作，命名刻意避开 git 术语：

| 面向用户的说法     | 实际动作                                        |
| ------------------ | ----------------------------------------------- |
| 「开始新版本编辑」 | 从当前提交建 `feature/*` 并检出                 |
| 「合入主干」       | `feature → main` 合并（走 §8，有冲突进解决 UI） |
| 「发布」           | 打 tag + 写 `PublishReceipt` + 前移 `dev` 绑定  |

### 9.2 受保护分支的执行位置

`protected` 判定必须在 **`VersionService` 写入路径上拦**，而不是只在 UI 禁用按钮——UI 禁了，命令仍可被 keybinding 或插件调用。现状同类做法可参照 `CommandService.execute` 吞错并记诊断的写法（[packages/services/service-command/src/index.ts:25-91](../packages/services/service-command/src/index.ts)）：拒绝时产出结构化诊断，不抛裸错把面板带崩。

### 9.3 发布与回滚

- **发布闸门原样复用 `validateProjectRelease` 的四道阻断**（[apps/host/src/projects/release-model.ts:170-239](../apps/host/src/projects/release-model.ts)）：无页面 / 接口引用悬空 / 文档自身阻断（含页面事件绑了不存在的流程）/ 已发布流程当前内容阻断。**不新写一套校验**，否则两处规则必然分叉，这是本项目已经反复强调的口径问题。
- **发布 = 内容冻结**：把 commit 的 tree 展开为运行态可读的资产清单，等价于现 `collectProjectAssets` 的"接口引用展开 + 环境定版"，产出 `PublishReceipt` 挂在 commit 上。展开结果**不重复存储**：它是 commit tree 的纯函数，运行态按需展开即可（`environmentHash` 才是必须存的那一份，因为它不在文档里）。
- **回滚 = 移动环境绑定**（I7），语义与 `setCurrentRelease` 完全一致；区别是绑定指向 commit hash 而非 `revision` 数字。
- **切版本预览**：`checkout(commit)` 建只读 Realm（`DocumentPluginConfig.mode = 'preview'` 已支持只读拦截，见 [packages/services/service-document/src/index.ts:22](../packages/services/service-document/src/index.ts)）——**这条能力已经存在，白捡**。

### 9.4 编号归一（I8，必须做的事）

现状两套人读编号并行：`ProjectRelease.revision`（单调递增，且 `nextRevision` 的注释里记着一条真实踩坑：只看指针会撞号）与 `FlowDefinition.version`（semver，`nextFlowVersion` 走 `1.0.0 → 1.1.0`）。提案：

- 权威编号 = commit hash；
- `revision` 与 semver 降为 `PublishReceipt.label` / tag 名的**显示字符串**，由"该项目第 N 次发布"或用户输入推导，**不再参与任何寻址与状态判定**；
- 好处是把 `nextRevision` 那条双输入取 max 的规则彻底删掉——编号一旦不参与寻址，撞号只影响显示、不再影响"运行页取到哪份内容"。这条注释里记录的 bug 属于寻址类 bug，正是并行编号的直接后果。

---

## 10. 服务契约与存储适配

### 10.1 `VersionService`（放 `packages/contracts/src/services/version.ts`）

> **P1 / P3 落地差异（2026-11-09）**：下面是 P1–P5 的**目标**接口。实际契约按阶段拆成 `VersionServiceCore`（P1：`commit` / `log` / `diff` / `listBranches` / `createBranch` / `checkout` / `restoreDoc` / `onDidChange` / `refreshHead`）与 `VersionServiceMerge`（P3：`mergePreview` / `merge`），`VersionService` 是两者的组合、也是 `createVersionService(store, options)` 当前的返回类型——提前写满接口会逼出 `Not implemented` 伪实现。`publish` / `getBinding` / `setBinding`（P5）仍未加入。`options` 提供 `readWorkingTree` / `writeWorkingTree` 两个宿主桥接函数，以及可选的 `initialRef` / `author` / `now` / `validate`（P3 校验器注入）/ `workingTreeReplaceable`（宿主能否真正替换工作区，缺省 `true`；宿主当前传 `false`，见 §17 已知边界第 7 条）。空仓库时 `head.commit` 为 `''`（尚无提交）。`VersionHead.hasUncommitted` 由 working copy 与 HEAD 提交树比较得出（I9），P2 的 tracker 每次 patch 后调 `refreshHead()` 刷新。**`VersionHead` 比下面的目标稿多三个字段**（按钮置灰轮补）：`workingTreeReplaceable`（宿主写权限，等于同名 option）、`viewOnly`（只读查看态，此时 `commit` 被拒）、`draftBranch`（工作区实际归属的分支，供 UI 说出「检出回哪条才能提交」）。判据由内核给出、UI 不得自行从 `branch` 推导——两条分支指向同一提交时只比分支会漏判。

```ts
/** 版本服务：项目级历史、分支、diff、合并、发布绑定。 */
export interface VersionService {
  /** 当前检出：版本库 id、HEAD 指向、所在分支 */
  readonly head: VersionHead

  /** 提交当前工作区；无变化时返回 undefined 且不产生对象 */
  commit(input: CommitInput): Promise<Commit | undefined>
  /** 从根到 head 的历史，按第一父链；limit/offset 分页 */
  log(query?: LogQuery): Promise<Commit[]>
  /** 两个提交之间的实体级差异 */
  diff(from: ObjectHash, to: ObjectHash): Promise<DiffResult>

  /** 分支列表（含保护标记与落后主干数） */
  listBranches(): Promise<BranchMeta[]>
  /** 建分支；name 已存在即拒绝，不覆盖 */
  createBranch(name: string, from: ObjectHash): Promise<BranchMeta>
  /** 切检出：换 Realm 文档内容；工作区有未提交内容时需 force */
  checkout(ref: string, options?: { force?: boolean }): Promise<VersionHead>

  /** 只算不合，供 UI 预览 */
  mergePreview(target: string): Promise<MergePlan>
  /** 按用户裁决落一次合并提交 */
  merge(plan: MergePlan, resolutions: ConflictResolution[]): Promise<Commit>

  /** 把单个文档恢复到某提交（不产生全局回滚） */
  restoreDoc(docId: string, commit: ObjectHash): Promise<void>

  /** 发布：打 tag + 冻结环境 + 校验 */
  publish(input: PublishInput): Promise<Commit>
  /** 环境绑定当前指向 */
  getBinding(env: EnvName): Promise<EnvironmentBinding | undefined>
  /** 切换环境指向（回滚与晋级共用这一个动作） */
  setBinding(env: EnvName, commit: ObjectHash): Promise<void>

  /** 历史或 ref 变化通知 */
  onDidChange(listener: (event: VersionEvent) => void): Disposable
}
```

**支撑类型**（同文件，接口用到的都在这，不留空洞）：

```ts
/** 当前检出状态。 */
export interface VersionHead {
  /** 版本库 id，等于 projectId */
  repoId: string
  /** HEAD 指向的分支名；游离态（直接检出提交）时为 undefined */
  branch?: string
  /** HEAD 当前提交地址 */
  commit: ObjectHash
  /** 工作区是否有未提交内容（I9：由 index 非空判定，不看 model.version） */
  hasUncommitted: boolean
}

/** 一次提交的输入。 */
export interface CommitInput {
  /** 提交消息，用户输入，空白即拒绝 */
  message: string
  /** 提交人标识；缺省由宿主注入的当前用户名补齐 */
  author?: string
  /**
   * 相对上一提交的改动，缺省由 VersionService 从工作区与 index 自行推导。
   * 允许显式传入只为「宿主已经知道改了哪些文档」的场景（如批量导入存量），
   * 不提供绕过 ref CAS 的入口。
   */
  changes?: DocChangeSet
}

/** 一次提交涉及的文档改动集合。 */
export interface DocChangeSet {
  /** 文档 id → 该文档变化的 section 名列表；文档整体消失时值为空数组 */
  sections: Record<string, string[]>
}

/** 历史查询条件。 */
export interface LogQuery {
  /** 起点提交，缺省为 HEAD */
  from?: ObjectHash
  /** 返回条数 @default 50 */
  limit?: number
  /** 偏移，供「加载更多」使用 */
  offset?: number
  /** 只看第一父链（true）还是展开全部祖先（false） @default true */
  firstParent?: boolean
  /** 按分支过滤（可选） */
  branch?: string
}

/** 两个提交之间的差异。 */
export interface DiffResult {
  /** 对比的两端 */
  from: ObjectHash
  /** 对比的两端 */
  to: ObjectHash
  /** 实体级变更，按 docId → section 分组顺序输出，UI 不必再排序 */
  changes: EntityChange[]
  /** 新增文档 id 列表 */
  addedDocs: string[]
  /** 删除文档 id 列表 */
  removedDocs: string[]
  /** 内容完全未变的文档 id 列表，供 UI 折叠 */
  unchangedDocs: string[]
}

/** 一条冲突的人工裁决。 */
export interface ConflictResolution {
  /** 对应 Conflict.entity */
  entity: EntityChange
  /** 选用的处置；manual 时 manual 字段必填 */
  option: 'ours' | 'theirs' | 'manual' | 'keep-both'
  /** 手工编辑后的最终值；仅 option 为 manual 时有值 */
  manual?: unknown
}

/** 发布输入。 */
export interface PublishInput {
  /** 发布自哪个分支或提交，缺省 HEAD */
  ref: string
  /** 人读发布号（label），如 v13；权威编号仍是 commit hash（I8） */
  label: string
  /** 发布后前移到哪个环境；缺省只打 tag 不动绑定 */
  promote?: EnvName
}

/** 环境名，与 api-config-model 的 isEnvironment 口径一致。 */
export type EnvName = 'dev' | 'test' | 'prod'

/** 版本库变化事件。 */
export type VersionEvent =
  | { kind: 'commit'; commit: Commit }
  | { kind: 'ref'; name: string; target: ObjectHash }
  | { kind: 'head'; head: VersionHead }
  | { kind: 'binding'; env: EnvName; commit: ObjectHash }
```

契约风格与 `DocumentService` / `HistoryService` 一致（只读快照 + `Disposable` 反注册 + `Promise` 用于一切 IO）。**所有 IO 方法一律 async**：IndexedDB 与服务端都是异步的，现在写成同步将来必改契约面。

### 10.2 `VersionStore`（存储适配器，Core 侧接口）

```ts
/** 版本对象存储的最小读写面。实现可以是内存、IndexedDB 或服务端。 */
export interface VersionStore {
  hasObject(repoId: string, hash: ObjectHash): Promise<boolean>
  getObject(repoId: string, hash: ObjectHash): Promise<VersionObject | undefined>
  /**
   * 内容寻址写入：同 hash 且同内容视为已存在，跳过（幂等）；
   * 同 hash 但内容不同即抛错——那是 §6.1 确定性失效的信号，静默覆盖会让两份文档压成一份。
   */
  putObject(repoId: string, object: VersionObject): Promise<void>
  getCommit(repoId: string, id: ObjectHash): Promise<Commit | undefined>
  putCommit(repoId: string, commit: Commit): Promise<void>
  getRef(repoId: string, name: string): Promise<Ref | undefined>
  /**
   * 比较并交换：仅当 ref 当前值等于 expected 时才写入。
   * @returns 成功时返回新 Ref；不匹配时返回 undefined，由调用方发起拉取-合并重试
   */
  casRef(
    repoId: string,
    name: string,
    /** undefined 表示「不存在 → 首次写入」，用于初始化与 tag 的 create-only（§18.5）；P1 落地补充 */
    expected: ObjectHash | undefined,
    next: ObjectHash,
  ): Promise<Ref | undefined>
  listRefs(repoId: string): Promise<Ref[]>
  /** GC 用：全部对象地址，供可达性标记 */
  scanObjectHashes(repoId: string): Promise<ObjectHash[]>
  /** 分支元数据与 Ref 分开存；P1 落地时补入（初稿遗漏） */
  getBranchMeta(repoId: string, name: string): Promise<BranchMeta | undefined>
  putBranchMeta(repoId: string, meta: BranchMeta): Promise<void>
}
```

三个实现 + 一个空壳：

| 实现                   | 用途                   | 关键约束                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryVersionStore`   | 单测、CI、preview 模式 | 属性测试的主力                                                                                                                                                                                                                               |
| `IdbVersionStore`      | 本地默认               | IndexedDB，两个 object store（`objects` 按 hash、`refs` 按 name）+ 一个 `commits`；**不用 localStorage**：现有 `lc.*` 各键合计已在使用，DAG 是追加型海量数据，5MB 配额与同步 API 都不合适。**这是新增能力，仓库现在没有任何 IndexedDB 代码** |
| `HttpVersionStore`     | 服务端预留             | 走 §10.3 契约；`casRef` 对应 HTTP `If-Match`                                                                                                                                                                                                 |
| `LegacyReleaseAdapter` | 只读迁移               | 把既有 `ProjectRelease` 快照读成 tag + commit（§13）                                                                                                                                                                                         |

**内核落位**：对象存储注册为保留服务 `'storage'`（已在 `RESERVED_SERVICES`，且当前无人使用），版本领域服务新增保留名 `'version'`（需同时改 `RESERVED_SERVICES`，属契约面变更 → 按 README 维护约定 1 同步 docs/05）。两者都按 [:337-339](../packages/kernel/src/context.ts) 的要求声明 `apiVersion`。

### 10.3 服务端契约（设计，不含后端实现）

```
GET    /version/repos/:repoId/refs            → 全部 ref + 各自 target
GET    /version/repos/:repoId/objects/:hash   → 单个对象（404 = 客户端需先 fetch）
POST   /version/repos/:repoId/objects         → 批量上传，服务端按 hash 幂等去重
POST   /version/repos/:repoId/commits         → 同上，提交对象
PATCH  /version/repos/:repoId/refs/:name      → 移动 ref，带 If-Match: <expectedHash>
                                              200 成功 / 409 返回当前 target（CAS 失败）
POST   /version/repos/:repoId/merge           → 可选：服务端预计算 MergePlan
GET    /version/repos/:repoId/since?have=h1,h2→ 增量：返回本地缺的对象集合
```

协同的并发控制靠 **CAS**（`casRef` → 409 → 客户端 fetch → 本地合并 → 重试），这是 git 的中心化用法，不依赖服务端理解文档结构。实时通知阶段 A 用 `BroadcastChannel`（同源多标签页，零依赖），阶段 B 再谈 WebSocket/SSE——**当前仓库零 ws 依赖**（`pnpm-lock` 里的 `ws` 是 vitest 等包的传递依赖，代码无引用），因此 ws 一律列为后置项，不写进 P5 之前的任何验收。

---

## 11. UI 与交互

> 本节初稿是提案；P4 落地后按实际形态回填，未实现的部分逐条标注，避免把设计当成现状。

### 11.1 挂载方式（严格遵守"先契约常量、再宿主插槽、再插件声明"）

1. `SLOT.designerBottomPanel` 在 P4 之前就已存在，**没有新增槽**：底部停靠区天然支持多面板动态页签、宽度充裕、与事件流并列，版本面板直接声明 `slot: 'designer.bottomPanel'`；
2. rail 的 `{ id: 'versions' }` 补 `action: { kind: 'command', commandId: 'version.openHistory' }`（与同列表 `pageFunction.openDialog` 同形态）；命令内部展开 dock、激活 `version` 页签，并广播 `version:open` 让面板聚焦指定分区；
3. **不给右栏加第 5 页签**：`rightTabs` 四页签全集固定且注明"不做动态注册"，破坏它等于把已确立的产品边界改成可插拔；
4. 新增插件包 `packages/plugins/plugin-panel-version`（`@lc/plugin-panel-version`），manifest 按 `contributes.panels` + `activationEvents: ['onPanel:version']` 声明，登记进 `apps/host/src/bootstrap.ts` 的 `BUILTIN_PACKAGES` 懒加载列表；
5. 版本库会话由宿主通过 **应用级 `version` Context 服务**（`VersionHostService`）提供，授权来自 `GRANTS['host-version']`。面板插件与状态栏不 import 宿主任何模块——插件包反向依赖 `apps/host` 会破坏包边界。装配必须在 `whenIdle()` **之前**完成：视图 setup 同步 `ctx.get('version')`，装晚了会把「还没注入」误判成「宿主未接入」。注意这是应用 Context，不是 P2 设想的 Realm 级注入。

### 11.2 面板分区

| 区   | 内容                                                                                            | 数据源                                                        |
| ---- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 历史 | 提交列表（默认第一父链，可展开合并双亲），合并提交显示父数、发布凭据显示 label                  | `log` / `head`                                                |
| 差异 | 选中提交 vs 其第一父；按文档 → section 分组，实体三列（基线 / 当前）                            | `diff`                                                        |
| 分支 | 列表、新建、检出、合入目标预览；受保护项有标记                                                  | `listBranches` / `createBranch` / `checkout` / `mergePreview` |
| 冲突 | 三方值（基线 / 本侧 / 对侧）、`options` 按钮、`manual` 的 JSON 输入、结构校验问题与悬空引用清单 | `mergePreview` / `merge`                                      |
| 发布 | 发布闸门结果、快照列表、发布与「切回此版本」                                                    | `VersionHostService`（宿主 `release-store`）                  |

**未按初稿实现**：DAG 泳道图与 tag 节点标记（历史区是有序提交列表，不是图）、实体行显示 `label`（`EntityChange.label` 在现有 diff 里未产出，展示裸 id）、分支删除、发布表单的 label + 环境选择、三环境绑定与晋级（属 P5）、`keep-both`（P3 未提供该选项，P4 也不擅自分配新 id）。检出仍是**只读版本视图**：`writeWorkingTree` 不回写五类资产，UI 明确写出这一点。

冲突区按严重度分两块：`both-modified` / `delete-modify` / `add-add` 归「必须裁决」，`order` / `dangling-ref` / `rename` 归「建议抽查」——把不同性质的冲突混在一份等权列表里，用户会一把点"全部采用我的"，等于合并功能形同虚设。

内核仍要求**所有**冲突裁决完才允许落盘，所以「建议抽查」这一档由 `withReviewDefaults()` 预填 `ours`（与内核 `decide()` 无裁决时的 `ctx.prefer` 同值，不另立策略），用户改过就不覆盖；分级因此不只是展示，它决定了哪些冲突需要用户显式表态。**预填不等于放行坏数据**：`dangling-ref` 接受默认后若引用仍然悬空，注入的 `validateWorkingTree` 会经 `checkNodeChildRefs` / `validateConnections` 报错，`MergePlan.status` 变成 `invalid`，`merge()` 一个对象都不写。（实现口径，2026-11-09 裁决预填轮补：此前分级纯展示、review 档无预填，只有顺序冲突的用户点「应用裁决并合并」会直接吃到「尚未裁决」。）

### 11.3 命令与快捷键

命令 id：`version.commit`、`version.openHistory`、`version.checkout`、`version.merge`、`version.publish`、`version.rollback`。注册进 `CommandService`，与设计器视图同生命周期（沿用 `registerDialogCommands` 的既有约定，卸载由 `disposables` 回收）。

口径修正：**只有 `version.commit` 直接执行写操作**——它没有参数、内容不变时不产生提交，是唯一适合无确认触发的命令；其余 5 条打开对应分区让用户选目标，因为切分支、合并、发布、回滚都需要参数或不可逆确认。**初稿写的「`Ctrl+S` 从保存改为提交」没有实施**：灰度期保留既有保存路径与浏览器语义，版本提交绑 `Mod+Alt+S`、打开历史绑 `Mod+Alt+H`。`dirty` 改由 index 判定（I9）仍属未做。

---

## 12. 多人协同（分阶段，每阶段可停）

| 阶段          | 机制                                                                                                 | 覆盖场景                                 | 不覆盖                                               |
| ------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| A（本地）     | **同文档软锁**（advisory）：进入编辑申请锁，他人打开该文档为只读并显示持有者。锁只是提示，不阻止读写 | 单浏览器多标签页、导出导入、演示         | 两个人真的同时编辑（无提示）                         |
| B（有服务端） | 锁 + **提交 CAS**：CAS 失败即拉取-合并，冲突走 §11.2 冲突区                                          | 不同页面、同页面不同节点、同节点不同字段 | 同字段并发（报冲突，属正确行为）                     |
| C（可选）     | presence（在线状态，谁在编辑哪个节点）+ 服务端合并预计算                                             | 减少 B 的冲突发生率                      | —                                                    |
| D（远期）     | 实时协同（CRDT）                                                                                     | 同屏逐键/逐拖拽                          | 需要重写 §6.2 与 patch 寻址，见 §3 方案 C 的否决理由 |

软锁在业界是被验证过的（葡萄城的对象签出小锁标志）。落地成本很低：一个 `lock:{docId}` ref + `BroadcastChannel` 心跳；服务端阶段改为带 TTL 的资源。**注意别把它做成硬锁**：硬锁会让一个人离开页面就锁死一张页面，业界翻车点集中在这。

---

## 13. 存量数据迁移

**原则**：新增并行写、双读校验、可回退。不出现"某次刷新后历史突然从空开始"。

1. **初始化 repo**：首次进入某项目时，把当前五类资产全量写成一个**根提交**（message「导入存量」），`main` ref 指向它。
2. **导入既有发布**：`lc.releases.v1` 里每份 `ProjectRelease` → 一个 commit + tag，`label` 用 `v{revision}`，`PublishReceipt.environmentHash` 指向新写的 section 对象。**注意只能得到"快照之间的差异"**，无法还原快照内的逐次编辑——这是既有数据的事实，UI 必须标注「导入的历史，粒度为发布」而不是伪装成细粒度历史。
3. **`publishedRevision` → `prod` 绑定**：一一对应；缺省即无绑定。
4. **保留份数与剪枝**：`pruneReleases` 的"留最近 5 份"在 DAG 下必须换成**可达性 GC**（I10），因为按份数删会切断父链、把分支变成孤儿；迁移期两条规则并存时，**以可达性为准**，`pruneReleases` 只对未导入的旧表继续生效。
5. **灰度开关**：`VITE_LC_VERSION_MODE=off | shadow | on`（Vite 只向客户端暴露 `VITE_` 前缀的变量，`parseVersionMode` 对空值、拼错、未注入一律回落 `off`）
   - `off`：完全现状（默认，直到 P2 验收通过）；
   - `shadow`：版本库并行写，读取与运行态仍走旧路径 —— **这一档是主要风险缓冲带，也是验证 diff 是否准确的最佳窗口**（shadow 期对比"版本库投影"与"旧 `lc.pages.v1`"不一致即报警）；
   - `on`：版本库为权威。
6. **回退路径**：`on` 回 `shadow` 只改读取来源；`shadow/off` 不删任何对象。IDB 库独立命名（不与 `lc.*` 复用），删除即回到现状。

---

## 14. 容量与性能

**估算口径**（按 section 去重后）：一张 200 节点的页面文档规范化约 60–120KB；一次只动几个节点的手势提交，新增对象 = 变化的 `nodes` section（≈60KB）+ 若干 document/commit 头（<2KB）。**未变的 `actions`/`connections`/其他文档一律 0 字节**——这正是 section 级内容寻址换来的收益，也是为什么切分粒度必须落在"顶层字段"这一既有边界。

| 手段                 | 说明                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 引用比较跳过 hash    | `applyPatches` 只克隆路径上的容器（[packages/schema/src/patch.ts:95-101](../packages/schema/src/patch.ts)），未变 section 引用不变 → `===` 判等即可跳过规范化与 hash，**hash 成本随改动量而非文档大小增长** |
| 自动 checkpoint 节流 | 提交触发用「显式保存 + 空闲 5 分钟 + 最长未提交 200 个 patch 批次」三条阈值，避免每帧一个 commit                                                                                                            |
| 分页 log             | `LogQuery { limit, offset, from }`，UI 默认 50 条                                                                                                                                                           |
| 可达性 GC            | 从全部 ref 标记可达，清扫未引用对象；带 grace period（对象年龄 > 24h 才清），防止与并发写入互踩；触发时机为 IDB 用量阈值，而非每次提交                                                                      |
| 增量同步             | 服务端 `since?have=` 握手，客户端只补缺失 hash                                                                                                                                                              |
| hash 成本            | 纯 JS SHA-256 约 MB/s 量级，section 通常 <200KB，一次提交 1–3 个 section；`crypto.subtle` 可用时走原生加速，属性测试保证两条路径同结果                                                                      |

**明确不做**：不压缩（IndexedDB 已有透明压缩，再加一层 LZ 会把 hash 与内容的对应关系复杂化）、不做 packfile、不在浏览器里维护倒排索引。

---

## 15. 测试策略

沿用项目现状（Vitest，`packages/**/tests` + `apps/**/tests`，node 环境只测纯逻辑，无 ESLint 配置、Prettier 无分号单引号宽 96）。每阶段的收尾命令即根 `package.json` 的现有脚本：`pnpm test`、`pnpm typecheck`（`vue-tsc --noEmit`）、`pnpm format:check`。

| 层         | 内容                                                                                                                                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单元       | `canonicalJson`（键序、嵌套、数组保序、`-0`、`NaN` 拒绝、`undefined` 剔除、码点排序、循环引用）、`hashText`（SHA-256 标准向量、多块与 UTF-8 对齐 `node:crypto`）、`canonicalHashAsync`（纯 JS 与 `subtle` 同结果、`subtle` 不可用回退）、`createPersistentId`（同 tick 批量 1000 个无重复、时间+随机固定时仍不死循环） |
| DAG        | `log` 第一父链、多 LCA 虚拟基线、分支落后数、ref 移动不改对象（I1/I3）                                                                                                                                                                                                                                                 |
| Diff       | 黄金夹具：对 `apps/host/src/pages/page-seed.ts`、`event-demo-document.ts` 真实数据断言 diff 结果条数与内容，防止"看起来对但噪声多"                                                                                                                                                                                     |
| 合并       | §8.7 六条不变式做属性测试（随机生成三方字典/列表 + 断言性质），实体规则表 15 行逐行覆盖，`dangling-ref` 与 `rename` 各一组                                                                                                                                                                                             |
| 集成       | shadow 模式下「版本库投影 vs `lc.pages.v1`」等价性（这是 §13 第 5 步灰度开关的验证抓手）                                                                                                                                                                                                                               |
| 迁移       | 既有 `narrowRelease` 形状兼容、`pruneReleases` 与可达性 GC 并存期行为                                                                                                                                                                                                                                                  |
| 浏览器实测 | 提交→切分支→合并冲突→解决→发布→回滚全链路；**以及从 `http://<lanIP>:5173` 打开一遍**（专测非安全上下文下 hash/id 是否可用，这一条踩过坑的方向）；面板渲染、rail 入口启用、状态栏分支指示                                                                                                                               |

**验收指标**：200 节点文档一次提交的 hash+写盘 < 120ms（本地 IDB）；shadow 期不一致报警数为 0；干净合并属性测试 10 万随机用例 0 反例。

---

## 16. 分阶段实施计划

> 每阶段末尾的"可停点"是刻意设计的：任一阶段结束都能独立交付价值，不出现"必须做到 P4 才能用"。

### P0 · 地基（前置，不可跳）

| 任务                                                                                                   | 涉及文件                                                                                                                                           | 验收                                                 |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `canonicalJson` + `canonicalHash` / `canonicalHashAsync`（纯 JS SHA-256 + subtle 快路径 + 一致性测试） | 新增 `packages/shared/src/canonical.ts`、`packages/shared/src/hash.ts`、`packages/shared/tests/*.spec.ts`，出口加进 `packages/shared/src/index.ts` | 键序无关同 hash；同步与异步两条路径同结果            |
| `createPersistentId` + 四处 `createId` 入档点改造 + `createId` 注释收紧                                | `packages/shared/src/id.ts`；`plugin-panel-eventflow`、`plugin-panel-node-event`、`canvas-drop`、`canvas-commands`；宿主 7 处私有生成器收敛        | 同 tick 批量 1000 个无重复；新增 spec 与现有测试全绿 |
| 受影响 id 的回归夹具（蓝图 id 相撞丢节点的既有用例）                                                   | `packages/*/*/tests`                                                                                                                               | 复现 `452cfa0` 场景不再丢节点                        |

**可停点**：单看就修了"同内容不同 hash"和"id 撞车"两个真实 bug，与版本控制解耦也有价值。

### P1 · 对象存储与提交内核（无 UI、无宿主接线）

| 任务                                                   | 涉及文件                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `VersionService` / `VersionStore` 契约                 | 新增 `packages/contracts/src/services/version.ts`，出口进 `contracts/src/index.ts` |
| Core：对象写入、commit DAG、`log`、`diff`、`mergeBase` | 新增 `packages/services/service-version/src/**`                                    |
| `MemoryVersionStore` + `IdbVersionStore`               | `service-version/src/store/{memory,idb}.ts`                                        |
| `RESERVED_SERVICES` 增 `'version'`（`storage` 沿用）   | `packages/kernel/src/context.ts`，同步 docs/05                                     |
| 单测 + 属性测试（§15 的 DAG/Diff 两栏）                | `packages/services/service-version/tests/**`                                       |

**落地状态（2026-11-09）**：P1 已实现，见 `packages/services/service-version/src/{object,dag,diff,service}.ts`、`src/store/{memory,idb}.ts` 与 `tests/*.spec.ts`；`RESERVED_SERVICES` 与 docs/05 已同步。契约按阶段拆分为 `VersionServiceCore`，见 §10.1。**合并属于 P3**，本阶段刻意不提供 `merge` / `mergePreview`。

**验收**：纯 node 环境跑通"建库 → 3 个提交 → 分支 → diff → 检出 / 单文档恢复"，UI 零依赖；灰度开关与宿主接线仍在 P2。

### P2 · 提交链路（写进设计器）

| 任务                                                                              | 涉及文件                                                        |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 订阅 `document:change`，patch 聚合进 index，引用比较跳过未变 section              | `service-version/src/tracker.ts`                                |
| Realm 装配：每个 Realm 注入 `version`（按项目而非按文档，需跨 Realm 共享 repoId） | `packages/services/service-workspace/src/index.ts`              |
| 保存 → 提交；`Ctrl+S` 语义切换；`dirty` 改为 index 非空（I9）                     | `apps/host/src/views/DesignerView.vue`、`release-store.ts`      |
| `VITE_LC_VERSION_MODE=off \| shadow \| on` 与 shadow 一致性报警                   | `apps/host/src/projects/version-host.ts`、`.env.example`        |
| 存量迁移（§13 第 1–4 步）+ `LegacyReleaseAdapter`                                 | `service-version/src/legacy.ts`；资产投影在 `src/projection.ts` |
| 软锁（阶段 A）+ `BroadcastChannel`                                                | `apps/host/src/**`                                              |

**落地状态（2026-11-09，拆成 P2a / P2b）**：P2a 已完成内核适配层——`tracker.ts`（`document:change` → section index，引用比较）、`projection.ts`（`VersionAssetSnapshot` ↔ `WorkingTree`，刻意不引用宿主 `ProjectReleaseAssets` 类型）、`version-mode.ts`（档位解析 + `compareProjection` 双读比对）、`legacy.ts`（既有发布 → commit 链 + `v{revision}` tag，幂等且 main 不覆盖），各带单测。

**P2b 已落地「旁路接线」，范围收敛为不改任何 Vue 组件、不改五类资产的持久化实现**——上一轮因无法回归验证而搁置用户可见改动，本轮把接线全部放进旁路模块与两个汇聚点的一行广播，从而在不碰 `DesignerView.vue` 的前提下把数据流打通：

- `apps/host/src/projects/version-assets.ts`：`ProjectReleaseAssets` → `VersionAssetSnapshot` 纯适配器。文档 id 用 `kind:id` 命名空间防跨类别覆盖；页面按 `PageSchema` 顶层字段摊平（section 与 `SchemaPatch` 路径首段对齐）；剔除 `createdAt` / `updatedAt` 本地时间（I2）；`environment` 按 I12 不入文档。
- `apps/host/src/projects/version-activity.ts`：零依赖活动信号，打断 `page-store` / `release-store` → `project-assets` → 版本桥接的循环依赖。
- `apps/host/src/projects/version-bridge.ts`：按项目懒创建 `VersionServiceCore`，Promise 链串行化连续活动（否则 `casRef` 会撞同一个旧 HEAD），`shadow` 双写 + 双读比对，`on` 只双写。`readAssets` / `createStore` 由装配层注入，Core 不认识任何 store 或 Vue，可在纯 node 环境测试。`readAssets` 在任务执行时才调用，因此是 checkpoint 语义：一串快速编辑合成一次最终状态，不还原中间步骤。
- `apps/host/src/projects/version-host.ts`：读 `VITE_LC_VERSION_MODE` 并装配 `IdbVersionStore`。`off`（含未配置、拼错）时直接返回空句柄，不构造 IndexedDB、不订阅、不产生任何行为变化；带 HMR `dispose` 防重复订阅。
- 两个汇聚点各加一行旁路广播：`pages/page-store.ts` 的 `savePageSchema()`、`projects/release-store.ts` 的 `publishProject()`，都在旧路径落盘之后发出；广播同步执行且不向调用方抛错，版本库故障不影响保存/发布。回滚 `setCurrentRelease()` 只移指针，刻意不发信号。
- `apps/host/package.json` 加 `@lc/service-version` workspace 依赖，`pnpm-lock.yaml` 的 host importer 同步（否则 `--frozen-lockfile` 会失败），`.env.example` 补档位说明。

**P2b 明确未做**（不写伪实现，也不假装已完成）：`Ctrl+S` 语义切换、`dirty` 改由 index 判定（I9）、Realm 级注入 `version`（P4 补的是**应用级** Context 服务，配合 `RESERVED_SERVICES` 与 `GRANTS['host-version']`，不是 Realm 级）、`on` 档位的运行态权威读取、检出结果回写五类资产、软锁与 `BroadcastChannel`、存量发布导入的宿主入口。`writeWorkingTree` 目前只把检出树交给 `onCheckout` 供 P4 只读版本视图消费，**绝不回写宿主草稿**——静默覆盖用户工作区等于一次数据丢失；真正的资产替换需要各 store 提供替换 API 与冲突确认。另有两个口径仍留给后续（P4 未做检出回写）：`collectProjectAssets()` 返回的是接口绑定已展开的发布视角，检出回写必须先 `stripApiBindings`，不能把展开态倒回 `lc.pages.v1`；存量导入的 `ProjectRelease.assets` 是发布快照，与新提交的草稿视角混在同一条 commit 链上会产生一次假 diff，P5 迁移时需统一。`LC_VERSION_MODE` 在 Vite 下必须带 `VITE_` 前缀，本方案表格初稿写成裸名，本轮已修正。

**验收**：`shadow` 模式下全量对齐一个晚上，报警数 0；`on` 模式能提交、能 `log`、能切分支读历史（只读 Realm）。P2a 由 7 项运行时断言覆盖（含 P1 链路回归）；P2b 由 13 项运行时断言覆盖（档位回落、五类投影、时间与环境边界、双读比对、父子链、连续活动串行化、故障隔离、检出边界），`tsc --strict` 对 4 个新增源文件 + 2 个 spec 零诊断。**`shadow` 全量对齐一晚仍未执行**，见 §19；浏览器实测与 `IdbVersionStore` 真实路径已在补执行轮完成；`on` 的"运行态权威读取"仍未完成，留待后续。
**可停点**：此时已有"完整历史 + 逐次提交 + 回滚到任意提交"，diff 可文本级展示。多数团队到 P2 就够用。

### P3 · 三方合并（本方案的技术核心）

任务：实体规则表 + 列表前驱锚定 + 引用完整性检查 + `rename intent` 采集（改名入口在宿主：页面改名、变量改名、绑定改名）+ `MergePlan` 预览 API + 六条不变式属性测试。
**验收**：§8.7 全部通过；随机用例 10 万 0 反例；真实数据上"两人各加一页 + 同页各改不同节点"零冲突自动合并。

**落地状态（2026-11-09）**：P3 已完成，全部落在 `@lc/service-version` 内核与 `packages/contracts` 契约层，不碰 Vue / 宿主：

- `src/merge.ts`（纯函数，不认识 store）：`mergeOrderedIds()` 按 §8.3 前驱锚定；`mergeTrees()` 做 `section → 实体 → 字段` 三层受控递归并套 §8.2 规则表；`findDanglingRefs()` 按集中的 `REFERENCE_RULES` 表查 `children` / `slots` / `actionIds` / `edges.source/target` / `flowId` / `apiId` / `pageId`；`CommitIntent` 自动迁移另一侧并重写 `ID_SCALAR_FIELDS` 与有序 id 数组里的旧 id。引用规则表与有序字段表都在文件顶部，新增一类引用只改表。
- `src/merge-plan.ts`（编排层）：`resolveTarget` / `treeOf` / `collectIntents` / `virtualBaseTree`（§8.6 递归折叠多个 LCA，**不落盘**）/ `computeMergePlan` / `mergeRelation`（`up-to-date` / `fast-forward` / `merge`）/ `writeMergeCommit`（双亲提交 + CAS 移动 ref）。
- `src/service.ts` 新增 `mergePreview()` 与 `merge()`，返回类型由 `VersionServiceCore` 扩为 `VersionService`（两者组合）。合并前要求工作区干净；冲突未裁决完或校验不通过时**一个对象都不写**；受保护分支仍拒绝 `commit()` 但接受合并提交；`fast-forward` 移动 ref 而不造多余提交。
- 契约新增 `MergePlan` / `MergeConflict` / `MergeResolution` / `MergeResult` / `DanglingRef` / `MergeValidate` 与 `VersionServiceMerge`。

**实现细化与明确边界**（写在这里避免把方案描述当成实现描述）：

1. §8.2 的"实体"在实现里继续下钻到顶层字段：同一实体改**不同字段**可自动合并，改**同一字段**才报 `both-modified`。这比把实体当整块比较更贴合低代码的实际编辑形状，且不会丢任一侧内容；规则表其余行（删/改、加/加、双向改）不变。
2. `MergeResolution.value` 是**冲突 `location` 处的值**（`section` + `entityId` + `fieldPath` 三段定位），不是整个实体。例如两侧改同一个节点的 `x`，`fieldPath` 是 `['x']`，手工裁决应给字段值。
3. §8.4 的 I6 校验走 `VersionServiceOptions.validate` 注入，P4 已由 `apps/host/src/projects/version-validation.ts` 包装既有 `validateDocument` / `validateFlow` 落地，内核不另写一套 schema 规则。未注入时 `MergePlan.validation === 'skipped'`，`status` 不会谎报通过；内核自带的 `dangling-ref` 检查始终执行，所以"引用指向被删实体"这条防线不依赖注入。
4. §8.6 的虚拟基线用「多个 LCA 依次折叠」实现，递归深度上限 3，超过后退回单个 LCA；畸形 DAG 不会把合并拖成无限递归，但极深的 criss-cross 不保证与 git recursive 逐字节一致。
5. §5.4 列的 `keep-both` 处置**未提供**：两侧同时新增不同实体时给 `ours` / `theirs` / `manual` 三种选择，内核不擅自分配新 id（那还要连带重写引用，属于 P4 冲突 UI 的显式操作）。
6. 改名意图只沿第一父链收集；跨合并链的改名需要在合并提交上重新声明，不靠相似度猜测（§8.5 的诚实边界不变）。

**验收结果**：§8.7 的第 1/2/3/4/6 条由 10 万次随机序列 + 2 万次随机树属性测试覆盖，零反例；第 5 条（I6）由注入校验器的 `passed` / `failed` 两条端到端路径覆盖。`tsc --strict` 对内核源码、契约与 2 个新增 spec 零诊断；CJS 编译产物跑通 20 项运行时断言，含两人各加一页 / 同页各改不同节点零冲突、冲突不落盘后裁决、保护分支合并、快进、脏工作区拒绝、改名迁移与 criss-cross 虚拟基线。**补执行轮已补上**：项目 `vitest` 套件与浏览器实测均已通过，见 §19。

**P3 明确未做**：宿主侧的改名 intent 采集入口（页面/变量/绑定改名时写 `CommitIntent`）、发布与环境绑定（P5）。P4 已补上冲突 UI 与命令、把 `validateDocument` / `validateFlow` 接进 `VersionServiceOptions.validate`；改名 intent 采集与 P5 仍是缺口。

### P4 · UI 与命令（本轮已落地）

任务：`plugin-panel-version`（manifest + 面板 + 五区）、`SLOT` 复用 bottomPanel、rail `versions` 启用、6 个命令 + keybinding、状态栏分支指示。
**依赖**：必须在 P3 之后，否则冲突 UI 只能做成"二选一"，把实体级合并的价值全丢掉。

**落地清单**：

1. 契约层：`VersionMode` 上移到 `@lc/contracts`（面板、状态栏、宿主共用一份联合，不让它们为三个字符串反向依赖内核包）；新增 `VersionHostService` / `VersionPanelSection` / `VersionOpenPayload` / `VersionReleaseSummary`，`events.ts` 加 `version:open`，`contexts.ts` 把 `version` 声明为可选服务并加入 `SERVICE_NAMES`。`@lc/service-version` 的 `version-mode.ts` 改为 re-export 契约类型，原包出口保持兼容。
2. 宿主装配：`installVersionHost(context)` 通过 `host-version` 插件把服务挂到应用 Context（`GRANTS` 授权）；`off` 档位仍提供 `mode === 'off'` 的服务，让 UI 显示明确提示而不是空白。`version-bridge.ts` 的会话类型升级到 `VersionService`（含 P3 合并），新增 `onChange` 广播与订阅回收；`validate` 注入由 `version-validation.ts` 包装既有 `validateDocument` / `validateFlow`，校验对象是**合并产物候选树**而不是宿主当前资产，问题路径带版本库 docId 前缀。**P3 遗留的 I6 注入至此补齐**。
3. 插件包：`packages/plugins/plugin-panel-version` 的 `model.ts`（纯分组 / 严重度 / 裁决规则）、`use-version-panel.ts`（Vue 状态与 IO）、`VersionPanel.vue`（五区 + scoped token 样式），manifest `order: 20` 复用 bottomPanel。
4. 宿主接线：`DesignerView` 启用 rail、注册 6 命令与 2 快捷键、把 `projectId` 下发给 `LcSlot`；`StatusBar` 增加分支指示；`bootstrap.ts` 登记 manifest 与懒加载，并把 `installVersionHost` 提到 `whenIdle()` 之前；`apps/host/package.json` 与 `pnpm-lock.yaml` 同步新包。

**口径修正**（与 §11 一致）：6 个命令中只有 `version.commit` 直接写版本库，其余打开对应分区；`Ctrl+S` 未改；发布 / 回滚复用宿主既有 `release-store`，不是 P5 的环境绑定；检出是只读版本视图，不回写五类资产。

**验收结果**：`tsc --strict` 对契约、内核、`model.ts`、`use-version-panel.ts`、`version-bridge.ts`、`version-host.ts` 与 2 个新增 spec 零诊断（用临时 tsconfig + 类型桩绕过本机 pnpm junction 缺失）；3 个 `.vue` 通过 `@vue/compiler-sfc` 的 script / template 编译；CJS 编译产物跑通 **16 项运行时断言**（冲突分级与分组、三方值格式化、裁决整批拒绝、diff 确定性分组、合并产物校验的页面 / 流程 / 异常兜底）；`prettier --check` 对全部改动文件通过。**运行时断言暴露并修掉一个真实缺陷**：`groupDiff` 跨 `addedDocs` / `removedDocs` / `changes` 三个来源时文档顺序不稳定，改为按 docId 确定性排序后重跑通过。

**补执行轮（2026-11-09）追加验收**：`vitest` 全量 101 文件 / 1031 测试通过，`vue-tsc --noEmit` 全量零诊断（含所有 `.vue` 模板表达式），`vite build` 对 designer 与 host 均成功（host 按约定带 `VITE_DESIGNER_ENTRY`）。浏览器实测在 `shadow` 档位走完提交→分支→冲突→裁决→合并→发布→回滚全链路，详见 §19；其中暴露并修掉 P1 内核的 HEAD 持久化缺陷（见下）。

**P4 明确未做**（不写伪实现）：DAG 泳道图、宿主改名 intent 采集、`Ctrl+S` 语义切换与 I9 dirty 改造、`on` 档位运行态权威读取、检出结果回写五类资产（需各 store 提供替换 API 与冲突确认）、环境绑定 / 审批 / 审计 / 灰度（P5）、软锁与 `BroadcastChannel`、从 `http://<lanIP>:5173` 打开以专测非安全上下文下 hash / id。浏览器实测与 `IdbVersionStore` 真实路径已在补执行轮完成（§19），不再列为未做。另：`VersionHostService` 暴露的发布 / 回滚只是宿主既有能力的薄桥接，未改 `release-store` 的存储与闸门规则。

**补执行轮修复的 P1 内核缺陷**：`checkout()` 原本只改内存 `branch`，服务重建（页面刷新）后静默回到 `main`，用户以为在 feature 上的下一次提交实际会落到主干。现由 `HEAD_REF`（`refs.ts`）记录当前分支短名，游离 HEAD 记 `detached:<commit>`；`checkout` 在切工作区前用 `casRef` 先持久化，CAS 失败即报错、不留「内存已切、磁盘未切」的半状态；`createVersionService` 初始化时优先用显式 `initialRef`，否则从 `HEAD_REF` 恢复。`tests/service.spec.ts` 新增 2 条回归用例（分支检出重建、游离 HEAD 重建）。另观察到分支列表显示的是 `BranchMeta.base`（创建基线）而非当前 ref target，属展示语义差异，**本轮未改**，留待后续统一。

**可停点**：此时用户已有可见、可操作的历史 / 差异 / 分支 / 冲突 / 发布界面，默认档位仍是 `off`，删掉环境变量即完整回退。

### P5 · 服务端契约与环境晋级

任务：`HttpVersionStore`、REST 契约（§10.3）、CAS 冲突协议、环境绑定 UI（dev/test/prod 三条 + 晋级/回滚）、编号归一（I8，删 `revision` 寻址语义）。
**验收**：两个客户端并发提交同一 ref → 一方 409 → 自动拉取合并 → 成功，且全程无覆盖丢失。

### 阶段依赖与工作量级

```
P0 ─→ P1 ─→ P2 ─────────────┐
              └─→ P3 ─→ P4    ├─→ P5
```

量级（相对，非承诺）：P0 小 / P1 中大 / P2 中 / P3 大 / P4 中 / P5 中。**P0 与 P1 无 UI，可并行于其他功能开发；P3 是唯一的"难"阶段，也是决定这套系统可信不可信的阶段。**

---

## 17. 被拒方案与已知边界

**被拒（含代价，避免后人重复评估）**

| 方案                           | 拒因                                                                                                     | 代价                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| CRDT 实时协同                  | 要重写 id 与 patch 寻址；引第三方运行时；收益集中在非目标场景                                            | 放弃同屏逐拖拽协同，用软锁 + 合并替代 |
| `isomorphic-git` + MEMFS       | 行级合并对 id 字典**语义劣化**（同一行两侧都改只能冲突，实体级本可自动合并）；包体积；无资产级校验钩子   | 放弃现成的 blame/bisect 工具链        |
| 沿用 `ProjectRelease` 加长历史 | 无分支无合并；按份数剪枝会丢历史；深拷贝全量随发布次数线性膨胀（`pruneReleases` 注释自己就写了这条约束） | 无                                    |
| 文本级 JSON diff               | 顺序噪声大、合并结果不可解释                                                                             | 放弃成熟文本 merge 算法复用           |
| 给右栏加第 5 个固定页签        | 破坏 `rightTabs`「四页签全集固定、不做动态注册」的既有边界                                               | 版本面板进底部停靠区，宽度换稳定性    |

**已知边界（诚实清单）**

1. 版本化对象只有五类资产文档；**运行态数据、用户配置、`requestDefaults` 的当前值不入版本**（环境按发布冻结，非按编辑冻结）——I12。
2. `order` 冲突的自动合并结果可能不符合视觉预期，属可接受的软错误（可手动拖动修正），不承诺顺序零误判。
3. 重命名识别依赖 intent 记录，P3 之前的存量提交一律退化为"删 + 加"。
4. 服务端契约（P5）只是设计，未实现，未验证。
5. 表达式字符串里的引用（`data.<binding>`、变量名）靠 §8.4 清单做悬空检测，**不做跨字符串的语义改名**（正则式改表达式风险高于收益，改名要连带更新表达式的能力本仓当前也不具备）。
6. 本文最初是提案稿，P0–P4 已陆续落地（各轮改动清单见 §19）；仍未实现的是 §18 治理接缝、P5 服务端与环境绑定、§12 软锁与 §14 可达性 GC。按 [README 维护约定](./README.md)，已落地部分的事实应回填 05 / 07 / 08 / 09，本文只保留未实现部分——**这条回填尚未做完**，本文标题与状态块仍写着「提案，未实现」，与源码不符。
7. **检出是只读查看，不是 git 的 checkout**。宿主还没有资产替换 API，`writeWorkingTree` 只把树投影给版本视图，草稿不动；因此宿主以 `workingTreeReplaceable: false` 创建服务，内核把查看态下的 `commit` / `restoreDoc` / `merge` 一律拒绝（错误码 `read-only-view`），也不持久化 HEAD。代价是：宿主当前**无法真正切分支继续编辑，也无法落合并提交**，合并只能用 `mergePreview` 看结果。解除条件是给五类资产 store 补替换 API（含冲突确认），届时把该选项改回 `true` 即可，内核行为与 git 对齐。

---

## 18. 企业治理接缝 `[提案]`

> 本章全部为提案。依据：根目录 `lowcode-plugin-platform-design.md` v2.1 的 §16 / §17 / §22 / §25 是**设计目标稿**（`docs/README.md` 第 5 行规定两者冲突时以本目录 + 源码为准）。本章只定义版本控制与该目标稿之间的**接口**，不改变 [§2](#2-目标与非目标) 的非目标 3：本方案仍只产生不可变对象与审计事件，不提供签名、不可篡改存储与合规留存，那部分属于控制面，代码里也还不存在。

### 18.1 现状复核（本轮新增，可源码核对）

P0 落地前重新检索了全仓，[§1.3](#13-三个必须先修的地基缺陷)② 与 [§6.2](#62-跨端稳定-id) 的初次描述有三处不精确，以本节为准：

| 项                   | 初次描述                | 复核结果                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createId` 入档点    | 2 处（两个面板插件）    | **4 处**：`use-event-flow-store.ts` 的 `nextId`、`use-node-event-bindings.ts` 的 `nextId`、`canvas-drop/src/index.ts` 的 `buildDropNode`、`canvas-commands/src/index.ts` 的 `duplicate` / `paste` / `groupSelected`。后两处生成的是 `PageSchema.nodes` 的键，同样会落盘 |
| 宿主私有 id 生成器   | 3 个 store              | **7 处同形态**：`page-store` / `flow-store` / `project-store` / `api-store` / `api-config-model`（`createEnvironmentId`）/ `global-functions` / `custom-components`                                                                                                     |
| 蓝图 `renameMap`     | 「顺延逻辑需改造」      | **不是 id 生成器**，是旧 id 的确定性前缀迁移，必须保持幂等，改造会破坏 `apps/host/tests/blueprint-document.spec.ts` 的 `bp-root` / `bp-node-1` 断言                                                                                                                     |
| `EnvName` 与现有口径 | 与 `isEnvironment` 一致 | `apps/host/src/apis/api-config-model.ts` 的 `isEnvironment` 校验的是 `RequestEnvironment`（`id` / `name` / `baseUrl` 对象），**不是三元枚举**；环境由用户自定义并可增删，见 [§18.2](#182-环境命名与绑定口径)                                                            |

`service-workspace` 的 `realm.id` / `canvas.id`、`service-history` 的 `meta.id`、`use-flow-debug.ts` 的 `exec_` 均为运行时标识，不落文档，**不参与** `createPersistentId` 改造。

### 18.2 环境命名与绑定口径 `[提案]`

[§5.2](#52-提交与指针) 的 `EnvironmentBinding.env: 'dev' | 'test' | 'prod'` 与 [§10.1](#101-versionservice放-packagescontractssrcservicesversionts) 的 `EnvName` 应修订为「**绑定用环境 id，策略用环境类别**」两个字段：前者关联宿主既有的 `RequestEnvironment.id`（用户自定义，改名/增删不影响绑定语义），后者承载 v2.1 §17.2 的审批与通道策略。这样既不用改宿主稳定 API，也不必让版本库认识 `sandbox` 这类策略标签。

```ts
/** 策略类别：决定审批、通道、审计强度，不参与存储寻址。 */
export type EnvClass = 'dev' | 'staging' | 'prod' | 'sandbox'

/** 环境绑定（修订 §5.2 的版本）。 */
export interface EnvironmentBindingV2 {
  /** 关联 RequestEnvironment.id；与配置层的环境同名，不改现有 isEnvironment 契约 */
  envId: string
  /** 策略类别，缺省由宿主配置推导 */
  envClass: EnvClass
  /** 默认绑定的提交地址 */
  commit: ObjectHash
  /** 是否跟随分支自动前移；只有非 prod 允许 true */
  autoFollow?: string
  /** 灰度变体，见 §18.6；为空即全量绑定 */
  variants?: BindingVariant[]
  /** 指标门禁，见 §18.6 */
  gate?: RollbackGate
}
```

迁移期 `getBinding` / `setBinding` 仍接受 `EnvName` 三值，由适配器映射到 `envId`；**不新增第四套编号**，环境 id 只是既有配置对象的键。

### 18.3 发布凭据：审批单、插件 pin 与变更摘要 `[提案]`

v2.1 §17.4 要求审批单含制品 digest、变更内容、影响范围、回滚方案、测试证据；[§2](#2-目标与非目标) 非目标 2 也约定「发布快照记录用到的插件版本」，但 [§5.2](#52-提交与指针) 的 `PublishReceipt` 只有 `label` / `issues` / `environmentHash` / `publishedBy`。补齐为三个可选字段：

```ts
/** 发布时钉死的插件制品；供应链口径见 v2.1 §18.1，digest 即内容地址。 */
export interface PluginPin {
  pluginId: string
  version: string
  digest: string
}

/** 发布审批凭据。 */
export interface PublishApproval {
  ticketId: string
  /** 制品 digest：本平台即 commit id（I8），不引入第二套权威编号 */
  artifactDigest: ObjectHash
  /** 变更摘要；完整差异由 diff(from, to) 按需重算，凭据里不复制实体值 */
  changeSummary: {
    addedDocs: number
    removedDocs: number
    changedEntities: number
  }
  /** 回滚目标：本次发布前该环境的绑定（对应 v2.1 §17.6 的 N-1） */
  rollbackTarget: ObjectHash
  /** 测试/扫描报告引用，不内联报告内容 */
  evidence: string[]
  approvers: string[]
  approvedAt: string
}

/** 扩展 §5.2 的 PublishReceipt（以下为新增字段，其余不变）。 */
export interface PublishReceiptExtensions {
  /** 本次发布用到的插件制品 */
  plugins?: PluginPin[]
  /** prod 晋级必填；dev / staging 可缺省 */
  approval?: PublishApproval
}
```

规则：`VersionService.publish` 在 `promote` 指向 `envClass: 'prod'` 且 `approval` 缺失时拒绝，判定位置与 [§9.2](#92-受保护分支的执行位置) 的 protected 相同（写入路径，不是 UI）；`artifactDigest` 必须等于本次提交的 `commit.id`，`rollbackTarget` 必须等于 `getBinding(env)` 的当前值，二者不一致即 fail-closed，避免审批单指向另一份内容。

### 18.4 权限模型与审计事件 `[提案]`

[§9.2](#92-受保护分支的执行位置) 只定义了「受保护分支」，其余写入动作没有主体约束。版本服务应接受一个可选的策略判定器与审计出口，**本地模式注入 no-op 实现**，不改变 [§10.1](#101-versionservice放-packagescontractssrcservicesversionts) 的方法签名：

```ts
export type VersionAction =
  | 'commit'
  | 'checkout'
  | 'merge'
  | 'publish'
  | 'move-binding'
  | 'delete-branch'
  | 'delete-tag'
  | 'gc'
  | 'resolve-conflict'

export interface VersionAuthContext {
  tenantId: string
  actorId: string
  roles: readonly string[]
  envClass: EnvClass
}

/** 版本服务外抛的唯一审计形状；存储与不可篡改性由控制面承担（§2 非目标 3）。 */
export interface VersionAuditEntry {
  tenantId: string
  actorId: string
  action: VersionAction
  repoId: string
  commit?: ObjectHash
  /** ref / binding 移动前的值，用于还原「谁把生产指到哪」 */
  before?: ObjectHash
  /** ref / binding 移动后的值 */
  after?: ObjectHash
  at: string
}

export interface VersionPolicy {
  /** 拒绝时返回结构化原因，由 VersionService 转成诊断，不抛裸错（同 §9.2） */
  authorize(
    action: VersionAction,
    ctx: VersionAuthContext,
  ): Promise<{ allowed: boolean; reason?: string }>
}

export interface VersionAuditSink {
  write(entry: VersionAuditEntry): Promise<void>
}
```

| 动作                                              | 约束                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `commit` / `checkout`                             | 工作区成员；`checkout(force)` 丢弃未提交内容时必须记 `resolve-conflict` |
| `merge` → 受保护分支                              | 至少一名 reviewer；冲突裁决逐条记 `resolve-conflict` + 裁决结果 hash    |
| `publish` / `move-binding`（prod）                | 双人审批 + `PublishApproval`（§18.3），审批记录进 `PublishReceipt`      |
| `delete-branch`（受保护）/ `delete-tag`（已发布） | 禁止，见 §18.5                                                          |
| `gc`                                              | 平台管理员，且必须带 §14 的 24h grace period                            |

`VersionEvent`（§10.1）是**进程内通知**，用于面板刷新；`VersionAuditEntry` 是**跨会话留痕**，二者不合并：前者可以丢，后者必须带 `tenant_id` 且由控制面持久化。这与 v2.1 §16「隔离单位是 Tenant」一致。

### 18.5 ref 与 tag 的不可变规则 `[提案]`

[§5.2](#52-提交与指针) 说「ref 表是版本库里唯一允许原地更新的地方」，但没有约束哪些 ref 能移动。补齐三条，全部落在 `VersionStore.casRef` 的实现契约上：

```ts
/** 见 §10.2 的 casRef：expected 为 undefined 时仅允许「不存在 → 首次写入」。 */
export type RefUpdateRule =
  { kind: 'create-only' } | { kind: 'fast-forward' } | { kind: 'any-cas' }
```

1. `refs/tags/*` 采用 `create-only`：tag 一旦指向带 `PublishReceipt` 的提交即**永不移动**，重复发布同名 label 必须换 label 或指向新提交新建 tag。`casRef` 对已存在的 tag 名一律拒绝，不给 `expected` 覆盖的口子。
2. 受保护分支采用 `fast-forward`：`next` 必须能从 `expected` 沿 `parents` 反向可达（新增 `isAncestor(expected, next)` 判定），禁止 force 前移；`checkout(force)` 只影响工作区，不获得绕过该规则的能力。
3. 其余分支采用 `any-cas`，但 `expected` 必须显式传入——CAS 是 [§10.3](#103-服务端契约设计不含后端实现) 协同协议成立的前提，不允许「不带 expected 的覆盖写」。
4. 删除分支只删 `BranchMeta` 与 ref，**不删对象**；对象只能由 [§14](#14-容量与性能) 的可达性 GC 清扫（I10），且 GC 结果不进 `VersionEvent`。

### 18.6 灰度绑定与指标门禁 `[提案]`

`setBinding` 目前是整环境一切换，v2.1 §17.6 要求按租户/用户/会话百分比灰度 + 指标越界自动回滚。**作为 P5 之后的扩展点，不进 P0–P5 主链**：

```ts
export interface BindingVariant {
  /** 命中优先级按数组顺序；都不命中时用 EnvironmentBindingV2.commit */
  selector: {
    tenantIds?: string[]
    userPercent?: number
    sessionPercent?: number
  }
  commit: ObjectHash
}

/** 指标门禁：越界时把该环境绑定移回 rollbackTo，不改任何对象（I7）。 */
export interface RollbackGate {
  maxErrorRate?: number
  maxP95Ms?: number
  rollbackTo: ObjectHash
}
```

只增加「一个环境可有多个绑定」这一处表达能力，运行态按请求上下文选 commit；**不引入流量编排、不复制数据、不做百分比动态调整**。自动回滚仍然只是 `setBinding`，与 [§9.3](#93-发布与回滚) 的指针语义完全相同。

### 18.7 版本轴对照 `[提案]`

v2.1 §25.1 有「三层版本」，本文 [§5.6](#56-两个版本轴不许混用) 有五个轴，需要一张对照表防止再长出第五套编号：

| v2.1 §25.1                    | 本文 §5.6                          | 是否参与寻址     |
| ----------------------------- | ---------------------------------- | ---------------- |
| 内核 API（`engines.lowcode`） | —（插件供应链，不在版本库内）      | 否               |
| 插件版本（`package.json`）    | `PublishReceipt.plugins[].version` | 否（仅冻结记录） |
| 文档 schema 版本              | `docSchemaVersion`                 | 迁移用，非寻址   |
| —                             | `repoFormat`                       | 存储结构迁移用   |
| —                             | **commit hash**                    | **唯一权威**     |
| —                             | `PublishReceipt.label` / tag       | 人读标签         |

`DocumentModel.version`（会话内自增计数）不在表内：它是缓存失效位，不是版本（I9）。插件版本与内核版本属于供应链，v2.1 §22.1 要求「跨环境只提升 digest」，与本方案的「跨环境只移动 commit 绑定」是同构的两层，不互相代入。

### 18.8 RPO / RTO 边界 `[提案]`

v2.1 §1.3 承诺「文档数据 RPO ≤ 5 min、RTO ≤ 1 h」。**本地优先的 IndexedDB 模式不提供该保障**：对象只在一台设备的一个浏览器 profile 里，清缓存即全丢。因此明确：

- P0–P4 定位为**单机开发**，存储可靠性由用户自行导出/备份，UI 不显示「已备份」之类暗示；
- P5 服务端落地后才谈 RPO/RTO，需要对象存储多副本 + 定期快照 + [§10.3](#103-服务端契约设计不含后端实现) 的 `since?have=` 增量补传；
- 回滚（RTO 的操作部分）在 P2 起即可用，因为它只移动绑定，不依赖备份。

本方案不承诺合规留存期限；保留策略由控制面按租户策略决定，版本库只保证「从任一 ref 可达的对象不被 GC」（I10）。

### 18.9 落地位置

| 章节 | 落在哪个阶段                                                                                                         | 依赖                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 18.1 | **P0（本轮已复核）**                                                                                                 | 无                                              |
| 18.3 | P2 定类型，P5 填 `approval` / `plugins`                                                                              | `PublishReceipt`、闸门 `validateProjectRelease` |
| 18.4 | P2 挂 `VersionAuditSink` 空实现，P5 接控制面（P1 未落地）                                                            | `VersionService` 写入路径、§9.2 诊断风格        |
| 18.5 | P1 已落 `casRef(expected: undefined)` 首次写入；P3 已落保护分支的合并路径与双亲提交；tag create-only / 环境晋级随 P5 | `VersionStore`、`isAncestor`                    |
| 18.2 | P5（与 `RequestEnvironment` 对齐）                                                                                   | 宿主配置模型                                    |
| 18.6 | **P5 之后可选**                                                                                                      | P5 服务端、指标采集                             |
| 18.7 | 文档约定，随 P5 编号归一（I8）一并生效                                                                               | 无                                              |
| 18.8 | 文档约定，P5 验收时重新评估                                                                                          | 服务端存储                                      |

---

## 19. 验证记录

**读过的规范**：初稿读了 `references/architecture.md`、`typescript.md`、`anti-patterns.md`；2026-11-09 补 §18 治理接缝并落地 P0 时，按渐进式读取要求**读齐 7 个**：`architecture.md`（Monorepo 边界、Core/Adapter 分离）、`typescript.md`（公共类型注释、命名、JSDoc、依赖判断）、`vue.md`（宿主 store 与 Composable 边界）、`anti-patterns.md`（不必要抽象、循环依赖、禁止伪实现）、`performance.md`、`styles.md`、`testing.md`（测试维度与"未执行须说明"）。P4 轮（Vue 组件、Composable、样式、Context 契约与单测）同样在编码前读齐 7 个 references 并列出清单，按 `vue.md` / `styles.md` 复核了组件职责边界与 Token / scoped 样式约束，未触发免除项。P2b 轮（宿主旁路接线、Composable 与包边界）同样在编码前读齐 7 个 references 并列出清单，未触发免除项。P3 轮（Core 纯算法、公共契约、单测 / 属性测试）同样在编码前读齐 7 个 references 并列出清单，未触发免除项。

**逐条源码核对**（本文所有现状引用都来自实际读取，非记忆）：`PageSchema` 与 `FlowDefinition` 字段表、`SchemaPatch` 应用与结构化共享、`createId` 的两处入档调用点与蓝图顺延逻辑、宿主三个 store 的私有 id、`formatJsonValue` 无排序、`service-history` 内存栈、`service-document` 的 `commitSchema` / `document:change`、`RESERVED_SERVICES` 与保留服务 `apiVersion` 强制、`SLOT` 全部插槽与"右栏四页签固定"注释、rail 的 `versions` 禁用项、`ProjectRelease` 全链（`nextRevision` / 四道闸门 / `pruneReleases` / `narrowRelease`）、`setCurrentRelease` 的指针语义、host vite 的 `0.0.0.0` + 局域网 IPv4 远程地址（非安全上下文结论的依据）、`vitest.config.ts` 与 `.prettierrc`、根 `package.json` 脚本、无 ESLint 配置、全仓零 `crypto` 引用。**本轮复核修正了初稿三处口径**：`createId` 入档点为四处（非两处）、宿主私有生成器为七处（非三处）、`blueprint-document.ts` 的 `renameMap` 是确定性存量迁移而非 id 生成器，逐项证据见 §18.1。P2b 轮另核对了：`currentAssetLists()` / `collectProjectAssets()` 的归属过滤与接口绑定展开、`PageRecord` / `FlowDefinition` / `GlobalFunction` / `CustomComponent` / `ProjectApi` 五类记录的字段与 `updatedAt` / `createdAt`、`page-store.ts` 的 `savePageSchema()` 与 `release-store.ts` 的 `publishProject()` 落盘顺序、`bootstrap.ts` 的 `GRANTS` 与启动流程、`vite.config.ts` 无 `define` / `envPrefix`（故档位名必须带 `VITE_` 前缀）、`IdbVersionStore` 构造签名、`MemoryVersionStore.putObject` 的完整性比对、`createVersionService` 的 `commitId` 更新与 `checkout` 调用 `writeWorkingTree` 的时序、`.env.example` 既有变量、`vitest.config.ts` 的 `environment: 'node'`、以及 `pnpm-lock.yaml` 中 host importer 与 `packages/services/service-version` 条目。核对结论直接决定了 `kind:id` 命名空间、时间元数据剔除、零依赖信号模块与 `readAssets` 注入这几处设计。

P3 轮另核对了 `VersionStore` 的 `getRef` / `casRef` / `getCommit` / `putObject` / `putBranchMeta` 签名、`dag.ts` 的 `collectCommits` / `isAncestor` / `mergeBases` 参数（尤其 `isAncestor` 吃的是内存 commit Map 而不是 store）、`object.ts` 的 `buildTree` / `commitIdOf` / `readTreeAt`、`diff.ts` 的 `entityMapOf` 稳定键与叶子 section 前缀、`service.ts` 的 `commit()` 写对象顺序与 protected 分支判定、`Commit.intents` / `CommitInput.intents` 契约、`ValidationIssue.severity` 的字段形状，以及 `service.spec.ts` 的 setup / workspace 惯例。核对结论决定了「编排层不循环 import `service.ts` 的 `resolveRef`」「虚拟基线只操作树、不落盘」「`manual` 值按 `fieldPath` 粒度给」这三处设计。

P4 轮另核对了 9 个 `plugin-panel-*` 包「纯声明式 manifest + `index.ts` 默认导出 Vue 组件」的骨架（`definePlugin` / `activate` 生命周期并不存在）、`LcSlot` 把 `context` 作为 prop 原样下发的约定、`SLOT.designerBottomPanel` 已存在且无需新增槽、`DesignerView` 的 `bottomTabs` 由 `listSlot` 生成而 `rightTabs` 固定四页签、`registerDialogCommands` 在 `onMounted` 里注册并用 `disposables` 回收的既有写法、`CommandService.execute` 吞错上报、`KeybindingService` 修饰键精确匹配、`StatusBar` 的订阅清理、`context.plugin` 的 `apply` 是异步任务而 `whenIdle()` 会等待它、`RESERVED_SERVICES` 对 `version` 需要 `GRANTS` 授权与 `apiVersion`、`@lc/schema` 的 `validateDocument` / `validateFlow` 签名、`pnpm-workspace.yaml` 的 `packages/*/*` 已覆盖新插件包。核对结论决定了「版本能力必须走应用级 Context 服务而不是让插件反向 import 宿主」「命令注册在 `DesignerView` 内以闭包捕获 `projectId`」「`installVersionHost` 必须前移到 `whenIdle()` 之前」这三处设计。

**实际执行的命令与结果**：

| 命令                                                             | 结果                                               |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `npx vitest run`                                                 | **78 个测试文件 / 860 条用例全部通过**，耗时 7.65s |
| `npx prettier --write docs/13-version-control.md docs/README.md` | 通过，无告警                                       |

**2026-11-09 本轮（补 §18 + 落地 P0）实际执行**：

| 命令                                                                                                                                                                   | 结果                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prettier --write`（19 个改动文件，用 store 内 `prettier@3.9.10` CLI）                                                                                                 | 全部处理；`prettier --check` 复跑输出 `All matched files use Prettier code style!`                                                                                                                                                          |
| `tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable`（`typescript@5.9.3`，`packages/shared/src` 四个入口） | 通过，无诊断                                                                                                                                                                                                                                |
| 三个 P0 模块编译为 CJS 后运行 `node .tmp-p0-verify/verify.cjs`（临时脚本，已删除）                                                                                     | **10 项断言全部通过**：键序/嵌套/数组保序/`undefined`/`-0`/异常/码点排序、SHA-256 标准向量与 `node:crypto` 多块及 UTF-8 一致、内容寻址语义、同步与异步路径一致、`crypto.subtle` 不可用回退、批量 1000 个 id 唯一、时间+随机固定时仍不死循环 |
| 临时目录清理                                                                                                                                                           | `.tmp-p0-verify` 已删除                                                                                                                                                                                                                     |

**2026-11-09 P1 轮（对象存储与提交内核）实际执行**：

| 命令                                                               | 结果                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -p .tmp-p1-verify/tsconfig.json`（契约 + 内核源码，strict）   | 通过，无诊断                                                                                                                                                                                                                            |
| `tsc -p .tmp-p1-verify/tsconfig.tests.json`（含 4 个 spec）        | 通过，无诊断；并据此发现并修掉 `putBranchMeta` 三参数误用                                                                                                                                                                               |
| 编译为 CJS 后 `node .tmp-p1-verify/build/verify.cjs`（临时，已删） | **10 项断言全部通过**：确定性建树、根提交 / 无变化不落盘 / 父链与 log、时间不入 hash、实体 diff 与数组换序、分支隔离、`restoreDoc` 不产生提交、脏检出需 force / 受保护分支拒绝、并发 CAS 冲突、幂等写入与完整性冲突、criss-cross 多 LCA |
| `prettier --write`（19 个改动文件）                                | 全部处理；临时产物未纳入检查                                                                                                                                                                                                            |
| 临时目录清理                                                       | `.tmp-p1-verify` 已删除                                                                                                                                                                                                                 |

**2026-11-09 P2a 轮（内核适配层）实际执行**：

| 命令                                                                 | 结果                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -p .tmp-p2-verify/tsconfig.json`（P2 源码 + 8 个 spec，strict） | 通过，无诊断；首次跑出 `VersionAssetSnapshot` 导入来源错误，修正后通过                                                                                                                   |
| 编译为 CJS 后 `node .tmp-p2-verify/build/verify.cjs`（临时，已删）   | **7 项断言全部通过**：tracker 引用比较与索引清空、资产投影往返、灰度三档语义、shadow 双读比对（键序无关 / 漂移分类）、存量导入链与 receipt、重跑幂等 / main 保护 / tag 冲突、P1 链路回归 |
| `prettier --write` + `--check`（10 个改动文件）                      | `All matched files use Prettier code style!`                                                                                                                                             |
| 临时目录清理                                                         | `.tmp-p2-verify` 已删除                                                                                                                                                                  |

**2026-11-09 P2b 轮（宿主旁路接线）实际执行**：

| 命令                                                                                                                 | 结果                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -p .tmp-p2b-verify/tsconfig.json`（4 个新增源文件 + 2 个 spec + 间接依赖，`strict` / `verbatimModuleSyntax`）   | **通过，零诊断**。本机顶层 `vue` / `vitest` / `vite` 链接缺失，临时目录内补最小类型桩 `env-stubs.d.ts`，并显式引用 `.pnpm` 内的 `@types/node` 与 `vite/client.d.ts`；桩只服务被间接拉进 program 的宿主模块，新增源码仍按 strict 全量检查                                                                                                                                            |
| `tsc -p .tmp-p2b-verify/tsconfig.build.json --noCheck` 编译为 CJS 后 `node .tmp-p2b-verify/verify.cjs`（临时，已删） | **13 项断言全部通过**：档位解析与未知值回落 `off`、文档 id 命名空间与反解、五类资产投影不互相覆盖、section 内容与本地时间/环境凭据边界、投影确定性、重复 id fail-closed、`off` 零接线、`shadow` 双写与双读比对一致、重复保存不产生空提交且内容变化形成父子链、连续活动串行化无 CAS 冲突、旁路故障隔离不回抛保存路径、`checkout` 只投影不回写草稿、空库比对报告 `missing-in-version` |
| `prettier --check`（12 个改动文件）→ 对 6 个不合规新文件 `--write` → `--check` 复跑                                  | 全部符合 Prettier 风格；用户已改动的文件与 `object.ts` / `object.spec.ts` 原本即合规                                                                                                                                                                                                                                                                                                |
| 临时目录清理                                                                                                         | `.tmp-p2b-verify` 已删除                                                                                                                                                                                                                                                                                                                                                            |

**2026-11-09 P3 轮（三方合并）实际执行**：

| 命令                                                                                                                                       | 结果                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -p .tmp-p3-verify/tsconfig.json`（`service-version/src/**` + `tests/**` + `contracts/version.ts`，`strict` / `verbatimModuleSyntax`） | **通过，零诊断**。本机顶层 `vue` / `@lc/vue` / `vitest` / `vite` 链接仍缺失，临时目录补最小类型桩 `env-stubs.d.ts` 并显式引用 `.pnpm` 内的 `@types/node`；桩只服务被间接拉进 program 的宿主模块，新增源码仍按 strict 全量检查                                                                   |
| `tsc -p .tmp-p3-verify/tsconfig.build.json --noCheck` 编译 CJS 后 `node .tmp-p3-verify/verify.cjs`                                         | **20 项运行时断言全部通过**：§8.3 前驱锚定 / 同锚点双插 / 删除与双移、§8.2 三类冲突与两类裁决、§8.4 悬空引用检出与裁决、§8.5 改名迁移、干净合并双亲提交、冲突不落盘、`up-to-date` / `fast-forward`、保护分支合并、脏工作区拒绝、校验器 `passed` / `failed`、端到端改名、criss-cross 两 LCA 折叠 |
| 随机属性用例（同一脚本内）                                                                                                                 | **10 万次随机 id 序列 + 2 万次随机树，共 12 万组，§8.7 第 1/2/3/4/6 条零反例**。固定 LCG 种子 `20261109` / `0x5eed`，失败会打印前 5 条具体反例；第 5 条（I6）走注入校验器的两条端到端路径                                                                                                       |
| `prettier --check`（改动文件）→ 对不合规新文件 `--write` → `--check` 复跑                                                                  | 全部符合 Prettier 风格                                                                                                                                                                                                                                                                          |
| 临时目录清理                                                                                                                               | `.tmp-p3-verify` 已删除                                                                                                                                                                                                                                                                         |

**2026-11-09 P4 轮（版本面板 UI 与命令）实际执行**：

| 命令                                                                                                                                                              | 结果                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -p .tmp-p4-verify/tsconfig.json`（契约 / `version-mode` / `model.ts` / `version-validation.ts` + 2 个 spec，`strict`）                                       | **通过，零诊断**                                                                                                                                                                                                                                                                                   |
| `tsc -p .tmp-p4-verify/tsconfig.host.json`（`use-version-panel.ts` / `version-bridge.ts` / `version-host.ts` 及被间接拉进 program 的宿主模块，`strict` / ES2022） | **通过，零诊断**。本机顶层 `vue` / `@lc/vue` / `vitest` 链接缺失，临时目录补最小类型桩并把 `vue` 映射到 `.pnpm` 内真实声明文件；桩只服务间接依赖，新增源码仍按 strict 全量检查                                                                                                                     |
| `@vue/compiler-sfc` 对 3 个 `.vue` 做 `parse` / `compileScript` / `compileTemplate`                                                                               | **3/3 编译通过**：`VersionPanel.vue`、`DesignerView.vue`、`StatusBar.vue`                                                                                                                                                                                                                          |
| `tsc -p .tmp-p4-verify/tsconfig.emit.json` 编译 CJS 后 `node .tmp-p4-verify/verify.cjs`                                                                           | **16 项运行时断言全部通过**：冲突分级 / 分组、三方值与循环引用格式化、`manual` JSON 解析、历史行双亲与发布标记、diff 按文档确定性分组、裁决整批拒绝、合并产物校验的页面 / 流程 / 组件噪声 / 异常兜底。首轮断言暴露 `groupDiff` 跨 `addedDocs` / `removedDocs` / `changes` 顺序不稳，修复后复跑通过 |
| `prettier --check`（19 个改动文件）→ 对 9 个不合规新文件 `--write` → 类型检查 / SFC / 运行时断言复跑                                                              | 全部符合 Prettier 风格；三项验证复跑均通过                                                                                                                                                                                                                                                         |
| 临时目录清理                                                                                                                                                      | `.tmp-p4-verify` 已删除                                                                                                                                                                                                                                                                            |

**历史未执行项（保留当时排查记录；补执行轮已全部补上，见下文）**：P0 轮、P1 轮、P2a 轮、P2b 轮与 P3 轮的 `pnpm test`（`npx vitest run`）、全量 `pnpm typecheck`（`vue-tsc`）、`pnpm build` 与浏览器实测**均未执行**。原因是本机 `node_modules` 的 pnpm junction 被 Windows 判为"不受信任装入点"（os error 448）：corepack shim 报 `ERR_PNPM_PACKAGE_MANAGER_INSPECT_OPTIONAL_DEPENDENCY`；改跑缓存中的 `pnpm.exe 10.33.0` 后，`install --offline --force` 报 `ERR_PNPM_EPERM`（esbuild.exe / rollup native 被占用），`--config.node-linker=hoisted` 报 `UNKNOWN: open ... @lc/kernel/package.json`，`npx vitest run` 报 `ERR_MODULE_NOT_FOUND @vitest/utils`。**因此五轮均不声称全量测试或全量类型检查通过**；五轮各自的核心链路断言是对编译产物的独立运行时校验，不等价于项目 vitest 套件。README 基线表的 303 条与初稿记录的 860 条均为历史数据，均未复现。P1 轮另试了一次标准 `pnpm install --offline --force`，报 `ERR_PNPM_NO_OFFLINE_TARBALL`（缺 `@rollup/rollup-android-arm64` 离线包），`npx vitest run` 改为报 `Cannot find package 'vite'`。P1 的 Core 已在纯 node 环境跑通，但 `IdbVersionStore`（浏览器 IndexedDB 路径）、P2 宿主接线与 P4 UI 均未实测。P2a 轮改为联网执行 `pnpm install --ignore-scripts`（成功，`Already up to date`）与 `pnpm install --ignore-scripts --force`（成功，下载 23 个缺失包、重建 166 个包），但 `npx vitest run` 仍报 `Cannot find package 'vite'`、`npx vue-tsc` 仍报 `Cannot find module 'typescript/lib/tsc'`——说明 `.pnpm/*/node_modules/` 内部 junction 整体不可遍历，不是缺包问题，故本轮把 P2 拆成 P2a / P2b。P2b 轮又试了一次联网 `pnpm install --ignore-scripts --force --config.node-linker=hoisted`，仍报 `UNKNOWN: open 'E:\ai-design\new-cordis\packages\canvas-plugins\canvas-align\node_modules\@lc\kernel\package.json'`，确认 junction 遍历问题与链接模式无关；因此本轮把 P2b 收敛为「不改 Vue 组件、不改五类资产持久化实现」的旁路接线，并用独立 `tsc` 与 CJS 编译产物做离线验证。`IdbVersionStore` 的浏览器路径、`shadow` 全量对齐一晚、HMR 重复订阅的实际表现均未实测。上述结论只对当时成立：补执行轮换了一条路径绕过 junction 限制，把全量测试、类型检查、构建与浏览器实测都跑通了，见下文。

P3 轮未再尝试修复依赖（junction 问题已在 P2a / P2b 两轮分别用离线重装与 `hoisted` 模式确认与链接模式无关），直接沿用独立 `tsc` + CJS 编译产物做验证；P3 不碰 Vue 组件与浏览器 API，因此没有引入新的未验证面。

**2026-11-09 补执行轮（把此前所有未执行项逐项跑一遍）实际执行**：

环境前提：本机 Windows 无法遍历 pnpm 符号链接 / junction（`fs.readdirSync` 报 `UNKNOWN`，现场新建 junction 同样不可读），但链接目标目录都完整可读。因此把 `node_modules` 下 498 个（中途被重建一次后为 504 个）不可遍历链接替换成**目标目录的真实副本**，只改依赖布局、不动任何源码。Vite / vitest / vue-tsc 用临时配置把 53 个 `@lc/*` workspace 包别名到真实源码，等价于正常 pnpm 链接的解析结果且保证单实例；这些临时配置不进入项目文件，验证后清理。浏览器驱动为全局安装的 `playwright-cli 0.1.23`。

| 验证项                                                                    | 结果                                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 坏链修复                                                                  | 498/498 与 504/504 全部替换为可读目录副本，`missing=0 / failed=0`                                                                                 |
| `vitest run`（临时配置：workspace 别名 + `@vitejs/plugin-vue`）           | 首轮 990 测试中 9 失败、6 个 suite 加载失败；定位并修正 5 处 spec 自身缺陷后 **101 文件 / 1029 测试通过**；补 2 条 HEAD 回归后 **1031/1031 通过** |
| `vue-tsc --noEmit -p .tmp-tsconfig.json`（53 包别名，含全部 `.vue` 模板） | **exit 0，零诊断**。顺带暴露 `StatusBar` 新必填 prop 在 `ComponentBlueprintView` 未传的真实类型错误，已修                                         |
| `vite build`（designer）                                                  | `✓ built in 3.06s`，产出 `remoteEntry.js`                                                                                                         |
| `vite build`（host，按约定带 `VITE_DESIGNER_ENTRY`）                      | `✓ built in 5.16s`，仅 chunk size 警告                                                                                                            |
| `prettier --check` / `--write`                                            | 全部改动文件符合项目风格                                                                                                                          |
| 临时目录与脚本清理                                                        | 全部删除；dev server 与浏览器进程已关闭                                                                                                           |

**修正的 5 处 spec 自身缺陷**（这些 spec 此前从未真跑过，均非产品代码问题，且断言强度未降低）：

1. `tracker.spec.ts`：`doc()` 每次新建 `actions` / `route` 与 `{}` 字面量，违反 tracker 刻意采用的引用判等设计 → 改共享常量、复用 `nodes` 引用。
2. `merge.spec.ts`：「前驱被删」用例两侧都删了 `a`，新元素 `x` 锚在未被删的 `b` 上，按「单向改动全收」本就不该冲突 → 改为 theirs 保留 `a` 并在其后插 `x`，仍断言 `conflict === true` 与元素不丢失。
3. `events.spec.ts`：`emit` 不等 async 监听器，同步监听器先记录，测试却假定错误记录是 `records[0]` → 改为校验「恰好一条带错误、一条不带」。
4. `loader.spec.ts`：`ensureActivated` 在微任务里才调用 `load`，测试在加载开始前就 `resolveLoad` → 加 `vi.waitFor` 等待加载真正启动。

**浏览器实测（`VITE_LC_VERSION_MODE=shadow`，host 5175 / designer 5174）**：

- 首页 → 项目列表 → 设计器：画布与 16 个画布插件正常渲染，状态栏显示「分支 main」，控制台最终 **0 error**。
- rail「版本管理」触发 `version.openHistory`：dock 展开、版本面板激活、五区 tab 齐全，头部显示 `档位 shadow` / 分支 / HEAD / dirty；`IdbVersionStore` 真实路径全程落盘并在刷新后读回。
- 历史 / 差异：首次提交 `93f3570a`；根提交空态正确；合并提交后查看真实 diff（`2991eba3 → 52208222 · 1 处变更`，`page:demo-doc / metadata / description`，基线 B 值 → 当前 A 值）。
- 分支 / 合并：新建 `feature` 与 `conflict-a`、检出、刷新后保持分支（HEAD 持久化修复生效）；两分支各有独有提交后执行三方合并，得到 `8a489785`「合并 · 2 父」；`up-to-date` 路径返回「目标已是当前祖先，无需合并」。
- 冲突 / 裁决：在两分支把 `page:demo-doc / metadata / description` 改成不同值，预览得到真实 `both-modified`，UI 显示三方值与「必须裁决（1）/ 建议抽查（0）」及四个 options；未裁决点合并报「冲突 both-mod 尚未裁决」且 HEAD 未移动（一个对象都没写）；选「采用对侧」后合并提交 `52208222`，diff 确认裁决值已落盘。预览状态 `clean` 时显示 `validation: passed`，证明 `version-validation.ts` 注入生效。
- 发布 / 回滚：发布 v1、v2，闸门无阻断；回滚 v2→v1 后「当前线上」标记正确切换，提示「草稿未改动」。

**补执行轮仍未覆盖**：`shadow` 全量对齐一晚、`on` 档位运行态权威读取、非安全上下文（`http://<lanIP>`）下 hash / id 退化路径、HMR 重复订阅长跑、`Ctrl+S` 语义切换与 I9、宿主改名 intent、P5 环境绑定 / 审批 / 审计 / 灰度；6 条命令与 2 条快捷键未逐条手动触发（仅经 rail 验证了 `version.openHistory`），`manual` JSON 裁决与 `dangling-ref` 冲突卡未由真实数据驱动。分支列表展示 `BranchMeta.base` 而非当前 ref target 的语义差异也未改。

**补执行轮改动清单**：内核 `packages/services/service-version/src/refs.ts` 新增 `HEAD_REF` / `DETACHED_PREFIX`，`src/service.ts` 初始化从 `HEAD_REF` 恢复、`checkout` 先 CAS 持久化再切工作区；`tests/service.spec.ts` 新增 2 条回归；修正 `tests/{tracker,merge}.spec.ts`、`packages/kernel/tests/events.spec.ts`、`packages/services/service-loader/tests/loader.spec.ts`；`apps/host/src/components/StatusBar.vue` 的 `projectId` 改为可选并用局部变量收敛；本文件同步 §16 P2b / P3 / P4 与 §19。**未改**项目 `vitest.config.ts` / `tsconfig*.json` / `vite.config.ts` / `package.json` / `pnpm-lock.yaml`；`node_modules` 里的链接副本属本机环境修复，不进版本控制，其他机器正常 `pnpm install` 不受影响。

**本文的内部一致性核对**：§16 各阶段涉及的文件路径全部指向仓库现有文件（新增文件已标 `[提案]` 或写"新增"）；§5 类型之间的引用（`ObjectHash` / `VersionDocKind` / `ValidationIssue` / `EnvName`）在同一节内自洽定义或由 `@lc/schema` 提供；§8.4 引用清单逐项回对了字段声明位置；全部 `§n` 交叉引用都指向本文实际存在的章节。

**P0 轮（2026-11-09）改动清单**：文档侧只改本文件（新增 §18、校正 §1.3② / §2 / §6.2 / §16，原 §18 顺延为 §19）；代码侧落地 P0——新增 `packages/shared/src/{canonical,hash}.ts` 与 `packages/shared/tests/{canonical,hash,id}.spec.ts`，改 `packages/shared/src/{id,index}.ts`，四处 `createId` 入档点（`use-event-flow-store` / `use-node-event-bindings` / `canvas-drop` / `canvas-commands`）与宿主 7 处私有生成器收敛到 `createPersistentId`。`blueprint-document.ts` 的 `renameMap` 按 §18.1 结论**未改**。所有现状引用在 P0 落地后行号需重新核对，新增引用已尽量改用符号名。

**P1 轮（2026-11-09）改动清单**：新增 `packages/contracts/src/services/version.ts`（数据模型、`VersionServiceCore` / `VersionStore` / `VersionServiceOptions`）与 `packages/contracts/src/index.ts` 出口；新增包 `packages/services/service-version`（`package.json`、`src/{errors,refs,object,dag,diff,service,index}.ts`、`src/store/{memory,idb}.ts`、`tests/{object,dag,diff,service}.spec.ts`）；`packages/kernel/src/context.ts` 的 `RESERVED_SERVICES` 加 `'version'`，`docs/05` 补版本服务小节；本文件同步 §10.1 / §10.2 / §16 P1 / §18.9 / §19。P1 刻意未做：合并（P3）、发布与环境绑定（P5）、tag / 受保护分支的完整规则（依赖 P3/P5 的合并路径）、可达性 GC（§14）、tracker 与 Realm 接线（P2）。

**P2a 轮（2026-11-09）改动清单**：只改 `packages/services/service-version`——新增 `src/{tracker,projection,version-mode,legacy}.ts` 与 `tests/{tracker,projection,version-mode,legacy}.spec.ts`，`src/index.ts` 加四个出口；本文件同步 §16 P2 与 §19。**未改任何 Vue 组件、宿主 store、vite 配置或 Realm 装配**；宿主资产适配器（`ProjectReleaseAssets` → `VersionAssetSnapshot`）、灰度开关注入（初稿写作裸名 `LC_VERSION_MODE`，P2b 落地时按 Vite 规则改为 `VITE_LC_VERSION_MODE`）、`Ctrl+S`、软锁均属 P2b。

**P2b 轮（2026-11-09）改动清单**：宿主侧新增 `apps/host/src/projects/version-{assets,activity,bridge,host}.ts` 与 `apps/host/tests/version-{assets,bridge}.spec.ts`；`pages/page-store.ts`、`projects/release-store.ts` 各加一行旁路广播；`bootstrap.ts` 加一行装配调用；`apps/host/package.json`、`pnpm-lock.yaml`、`.env.example` 同步依赖与档位说明。内核侧修 `packages/services/service-version/src/object.ts` 的 section 取址（见 §6.1 第 7 点），`tests/object.spec.ts` 加回归用例，`packages/contracts/src/services/version.ts` 同步 `SectionObject.hash` 注释。本文件同步 §2 / §6.1 / §16 P2 / §19。**未改任何 `.vue` 组件**，`GRANTS` 未加 `service-version`（Context 注入未做），`vite.config.ts` 未加 `define`（档位用 `VITE_` 前缀由 Vite 原生注入）。

**P3 轮（2026-11-09）改动清单**：契约层 `packages/contracts/src/services/version.ts` 新增 P3 合并类型与 `VersionServiceMerge` / `VersionService`；内核新增 `packages/services/service-version/src/{merge,merge-plan}.ts`，`src/service.ts` 接入 `mergePreview()` / `merge()`，`src/index.ts` 补出口；新增 `tests/{merge,service-merge}.spec.ts`。本文件同步 §8.7 / §10.1 / §16 P3 / §19，`docs/05-contracts-and-schema.md` 同步版本服务小节。**未改任何 `.vue` 组件、宿主 store 与 `apps/host`**，P2b 的旁路接线与默认 `off` 行为一字未动。

**P4 轮（2026-11-09）改动清单**：契约层改 `packages/contracts/src/services/version.ts`（`VersionMode` 上移 + `VersionHostService` / `VersionPanelSection` / `VersionOpenPayload` / `VersionReleaseSummary`）、`events.ts`（`version:open`）、`contexts.ts`（可选 `version` 服务 + `SERVICE_NAMES`）；`packages/services/service-version/src/version-mode.ts` 改为 re-export 契约类型。宿主新增 `apps/host/src/projects/version-validation.ts` 与 `apps/host/tests/version-validation.spec.ts`；改 `version-bridge.ts`（`VersionService` / `validate` / `onChange` / 订阅回收）、`version-host.ts`（Context 服务装配 + 发布回滚桥接）、`bootstrap.ts`（`GRANTS` / `BUILTIN_PACKAGES` / 装配时机）、`views/DesignerView.vue`（rail / 6 命令 / 2 快捷键 / `projectId` 下发）、`components/StatusBar.vue`（分支指示）、`package.json`；`pnpm-lock.yaml` 加 host importer 与新包 importer。新增插件包 `packages/plugins/plugin-panel-version`（`package.json` / `src/manifest.ts` / `src/index.ts` / `src/version-panel/{model.ts,use-version-panel.ts,VersionPanel.vue}` / `tests/model.spec.ts`）。本文件同步 §11 / §16 P2b / §16 P3 / §16 P4 / §19，`docs/05-contracts-and-schema.md` 同步版本服务小节。**未改** `@lc/service-version` 的合并内核、五类资产持久化实现、`release-store` 的闸门与存储规则、任何 `.vue` 之外的既有插件包。

**修复轮（2026-11-09，检出改道 + 数组悬空引用 + 提交地址冲突）改动清单**：起因是 P4 落地后的 code review 复核，三条都是「内核能力正确、但接线或适配器让它可以被误用」的问题。

- **检出改道**：P4 的面板能检出分支了，但宿主的 `writeWorkingTree` 只投影不回写，内核却在检出后无条件 `dirty = false`。于是「检出看一眼历史」之后的一次保存，会把切出前的草稿提交到刚检出的分支上；HEAD 持久化让这个状态还能跨刷新存活。修法是让宿主显式声明能力、由内核在写入路径拦截（与 §9.2 受保护分支同一位置口径）：契约新增 `VersionServiceOptions.workingTreeReplaceable`（缺省 `true`，不影响既有实现与测试），`errors.ts` 新增 `read-only-view`；`service.ts` 用 `draftBranch` / `draftBase` 记录工作区归属，`settleWorkingTree()` 统一收尾，查看态下拒绝 `commit` / `restoreDoc` / `merge`（`mergePreview` 是只读的，保留），且**不持久化 HEAD**——否则重启会落在一个与草稿不同源的分支上。判据同时看分支与提交：两条分支指向同一提交时只比提交会漏掉改道。`version-bridge.ts` 传 `false`，面板 `checkoutHint` 与两处 docblock 同步如实说明。
- **数组 section 的悬空引用漏检**：`merge.ts` 的 `findDanglingRefs()` 原本 `if (!isRecord(value)) continue`，把 `components` / `datasources` / `apis` / `variables` / `functions` 五个数组 section 整段跳过，§8.4 表里明确要查的 `PageSchema.apis[].apiId → ProjectApi.id` 因此永远查不到。改为统一走 `entityMapOf()` 摊平（与 diff 同一口径，entityId 一致）。配套修 `valueAt()` / `setValueAt()`：新增 `entityAt()` 把数组 section 的稳定键换回下标，否则数组里的悬空引用能被检出、裁决却读不到也写不回原处（`manual` 会静默失效）。

- **提交地址冲突时两个适配器行为相反**：`commitIdOf()` 刻意排除 `createdAt`（§6.1 未单列，理由写在函数注释里），于是「同父 + 同树 + 同消息 + 同作者」的两次提交撞同一 id 而对象内容不同。`MemoryVersionStore.putCommit` 抛 `integrity`，`IdbVersionStore.putCommit` 却直接 `put` 覆盖——**同一份数据在单测里失败、在浏览器里悄悄改写既有提交的时间，违反 I1**。修法是让 IDB 版照 `putObject` 的形状把「读 + 校验 + 写」放进同一个 readwrite 事务并 fail-closed，冲突文案抽到 `errors.ts` 的 `commitConflictMessage()` 由两个适配器共用，保证不会再分叉；`VersionStore.putCommit` 的契约 JSDoc 补上这条要求，未来的 `HttpVersionStore` 同样受约束。**注意这没有消除撞地址本身**：该场景下提交仍会失败，只是从静默改写变成显式报错并提示改消息。是否把 `createdAt` 纳入寻址（git 的做法）是另一个决策，会改变 §6.1 的既有口径并使已存对象地址失效，本轮未动。

改动文件：`packages/contracts/src/services/version.ts`、`packages/services/service-version/src/{errors,service,merge}.ts`、`src/store/{memory,idb}.ts`、`apps/host/src/projects/version-bridge.ts`、`packages/plugins/plugin-panel-version/src/version-panel/use-version-panel.ts`，测试 `packages/services/service-version/tests/{service,merge}.spec.ts`（+7 条）与 `apps/host/tests/version-bridge.spec.ts`（把原本只检出游离提交的用例改成检出分支，否则它命中的是 `invalid-input` 而不是改道路径）。本文件同步 §17 已知边界第 6 / 7 条，`docs/05-contracts-and-schema.md` 同步版本服务小节。**未改**合并规则表、diff、DAG、`commitIdOf` 的寻址口径与任何 `.vue` 模板。

**本轮实际执行**：

| 命令                                    | 结果                                                                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vue-tsc --noEmit -p tsconfig.json` | **通过，零诊断**（首次跑出 `merge.spec.ts` 两处 `unknown` 上取 `map` 的错误，改为先窄化再断言后通过）                                                                                                                             |
| `npx vitest run --no-file-parallelism`  | **101 个测试文件 / 1038 条用例全部通过**，耗时 37.9s                                                                                                                                                                              |
| `npx vitest run`（默认并行）            | 首跑 1035 通过 / 2 失败，失败项是 `apps/host/tests/release-store.spec.ts` 首条用例 5s 超时并连带第二条；该用例单独跑 1.4s、`apps/host` 全量跑 2.9s，属并行 CPU 竞争下的**既有抖动**，与本轮改动无关（本轮未触碰 `release-store`） |
| `npx prettier --check`（改动文件）      | 除 `contracts/version.ts` 外全部合规；该文件的告警在第 259 行 `MergeConflictKind` 联合类型，是本轮改动之外的既有问题，未顺手改                                                                                                    |

**IndexedDB 路径仍未实测**：`IdbVersionStore.putCommit` 的 fail-closed 分支在 node 环境跑不到（无 `indexedDB`，且本轮未引入 `fake-indexeddb` 依赖）。它与 `putObject` 是同形状代码、共用同一条文案，并由契约 JSDoc 约束，但**浏览器实测未执行**。撞地址的端到端行为由 `service.spec.ts` 走 `MemoryVersionStore` 覆盖。

**依赖环境已恢复**：P2a–P4 各轮记录的 junction 不可遍历问题（`Cannot find package 'vite'` / `ERR_MODULE_NOT_FOUND`）在本轮已不存在，`npx vitest run` 与 `npx vue-tsc` 都能直接在仓库根执行，不再需要临时 tsconfig 与 CJS 编译产物做离线验证。

**浏览器实测仍未执行**：查看态的拦截路径由 `service.spec.ts` 4 条与 `version-bridge.spec.ts` 1 条覆盖（纯 node），但「面板点检出 → 再点提交 → 看到 `read-only-view` 文案」这条 UI 链路未在浏览器里走过。

**刷新放大轮（2026-11-09）改动清单**：修「一次保存触发多轮全量刷新」。

**先更正一处 review 口径**：初判说「面板刷新 3~4 轮」是**错的**。一次 `commit()` 确实同步连发 commit / ref / head 三个事件（本轮实测：不合并时 bridge 的 `onChange` 被调 3 次，两次保存 6 次），但面板那侧是 `revision.value += 1` 配 `watch`，Vue 的调度器对同一 tick 内的多次自增只排一个 job，**实测 watcher 只执行 1 次**。真正被放大的是另外两处：

- **状态栏跑三遍**：`StatusBar.vue` 直接在监听器里调 `refreshBranch()`，没有 watcher 去重。修法是在 bridge 收敛事件——`scheduleChange()` 用 `queueMicrotask` 按 projectId 合并同一批事件再调 `options.onChange`。选 bridge 而不是宿主 `notify()`：bridge 是内核事件进入宿主的唯一边界，且在 node 环境可测（`version-host.ts` 依赖 `import.meta.env`，测不到）。用微任务而不是 rAF：三个事件本来就同步连发，微任务足够收敛，node 也没有 rAF。
- **每次刷新都跑一遍全项目发布校验**：面板 `refresh()` 无条件调 `host.checkRelease()`，即 `collectProjectAssets`（含对每张页面跑 `applyApiBindings`）+ `validateProjectRelease` 四道闸门，而这份数据只在「发布」区渲染。改为 `activeSection === 'releases'` 时才读，切进发布区由 `setSection()` 补一次，`version:open` 命令也改走 `setSection` 而不是直接赋值 `activeSection`（否则命令打开发布区会显示上一次的旧值）。这是本轮的主要收益：保存一次页面不再顺带把整个项目校验一遍。

**刻意没做**：面板动作末尾的显式 `await refresh()` 与事件驱动的那一轮仍会各跑一次（共 2 轮）。加在途合并也压不到 1 轮——事件在显式刷新的 await 期间到达，只会排成尾随的一轮，复杂度换不到收益，按「不创建当前不需要的复杂度」略过。`log()` 仍是遍历全历史再 slice 的假分页（§14 待办），本轮未动。

改动文件：`apps/host/src/projects/version-bridge.ts`、`packages/plugins/plugin-panel-version/src/version-panel/use-version-panel.ts`，测试 `apps/host/tests/version-bridge.spec.ts`（+2 条，harness 补 `onChange` 采集）。**未改任何契约**，故 docs/05 本轮无需同步。`dispose()` 里的 `pendingChange.clear()` 是生命周期边界的防御性清理，通知微任务必然先于 dispose 发出，无法在 node 环境构造出可断言的时序，因此**没有为它写测试**。

**本轮实际执行**：

| 命令                                    | 结果                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npx vue-tsc --noEmit -p tsconfig.json` | 通过，零诊断                                                                                         |
| `npx vitest run --no-file-parallelism`  | **101 个测试文件 / 1040 条用例全部通过**，耗时 49.7s                                                 |
| `npx prettier --check`（3 个改动文件）  | 全部合规                                                                                             |
| 反向验证（临时去掉合并后复跑）          | 两条新用例**如期失败**：单次提交收到 3 次通知、两次保存收到 6 次，确认测试非空转；随后还原源码并复核 |
| Vue watcher 去重实测                    | 临时脚本 `.tmp-vue-dedup.mjs`（已删除）：同一 tick 内 `revision` 三连自增，watcher 只执行 1 次       |

**浏览器实测仍未执行**：「保存一次页面 → 面板不再触发发布闸门校验」这条只在 node 环境由代码路径保证，未在浏览器里用 Performance 面板量过实际耗时；`collectProjectAssets` + 四道闸门在真实项目规模下的开销因此仍是估算。

**数组重排轮（2026-11-09）改动清单**：修 §8.2 数组 section 被静默重排。

`mergeSection()` 在字典分支上对键做 `.sort()`，而数组分支复用同一份键序再按 `map.values()` 输出，于是 `variables` / `functions`（按 `name`）、`datasources` / `apis`（按 `id`）、`components`（按 `meta.name`）在「两侧都改过同一个数组 section」时被字母序重排——违反 §6.1「数组保序，顺序就是语义」。而嵌套数组走的 `mergeArray()` 从来不排序，两处各写一份键序规则正是分叉的来源。

修法是把共用的那部分抽出来：新增 `mergedKeys(base, ours, theirs)` = 「基线序 → 本侧新增 → 对侧新增」，`mergeSection` 与 `mergeArray` 都调它；是否再排序留给调用方按形状决定——数组原样使用，字典 `[...merged].sort()`。字典保留排序不是冗余：section 存进对象库再读回来时 `canonicalJson` 已经排过序，而直接来自宿主工作区的树没有，排序才能让冲突清单的顺序不随工作区键插入序而变（新增用例 4 钉住这条）。

**刻意没做**：`mergeSection` 与 `mergeArray` 未进一步合并成一个函数。两者对 MISSING 哨兵的处理不同（section 级要先走四条快路径，嵌套数组由 `mergeValue` 分派进来），强行统一要引入形状判定与类型窄化，复杂度高于收益；共用键序规则已经消除了本次分叉的根因。

改动文件：`packages/services/service-version/src/merge.ts`，测试 `tests/merge.spec.ts`（+4 条，新增 `sectionArrayAt()` 辅助以避免类型断言）。**未改任何契约与宿主代码**，docs/05 无需同步；本文件同步 §8.2 与 §19。

**本轮实际执行**：

| 命令                                                      | 结果                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npx vue-tsc --noEmit -p tsconfig.json`                   | 通过，零诊断                                                                            |
| `npx vitest run --no-file-parallelism`                    | **101 个测试文件 / 1044 条用例全部通过**，含十万次随机序列 + 两万次随机树属性测试零反例 |
| `npx prettier --check` → `--write` → 复跑                 | `merge.spec.ts` 已格式化，两个文件均合规                                                |
| 反向验证 A（把 `.sort()` 恢复成无条件排序，即修复前行为） | 用例 1、2 **如期失败**，其余 17 条通过                                                  |
| 反向验证 B（字典分支也去掉排序）                          | 用例 4 **如期失败**，其余 18 条通过                                                     |

**用例 3（一侧删元素时其余保持相对顺序）在两种回退下都通过**，它钉的是删除路径而不是排序，作为文档性用例保留。浏览器实测仍未执行：数组重排是纯函数行为，已由 node 环境用例覆盖，不依赖浏览器。

**冲突文案轮（2026-11-09）改动清单**：修 §11.2 冲突区把 `conflictId` 当内容地址截断。

`MergeConflict.id` 不是 hash，而是 `merge.ts` 的 `conflictId()` 拼出来的 `kind:docId:section:entityId:fieldPath` 定位串，用途是按 `MergeResolution.conflictId` 对号入座。面板却用 `shortHash()` 截前 8 位展示，于是用户看到的是 `both-mod` / `dangling` 这种碎片。共四处误用：`model.ts` 的 `buildResolutions()` 两条拒绝文案、`VersionPanel.vue` 冲突头部的一个 span（与紧邻的 `conflictLocation()` 重复）、以及手工裁决 textarea 的 `aria-label`（读屏同样只拿到碎片）。改为统一用 `conflictLocation()`，文案加「」与内核 `decide()` 的消息风格一致；重复的 span 直接删掉。`conflictLocation()` 的 JSDoc 补上「不要展示 `conflict.id`」及原因。

**这个 bug 之所以没被测出来**：`model.spec.ts` 的 `makeConflict()` 夹具用 `'c1'` / `'c2'` 当 id，`shortHash('c1')` 得到 `'c1'`，看起来完全正常。新增用例改用真实形态的 id（`both-modified:page:p1:nodes:n1:x`）并断言文案里**不出现** `both-mod`，这样退回 `shortHash` 会立刻失败。其余 `shortHash` 调用点（`commit.id` / `head.commit` / `diffBase` / `branch.base`）都是真内容地址，未动。

改动文件：`packages/plugins/plugin-panel-version/src/version-panel/{model.ts,VersionPanel.vue}`，测试 `tests/model.spec.ts`（+1 条）。**未改契约、内核与宿主**，docs/05 无需同步。

**本轮实际执行**：

| 命令                                            | 结果                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `npx vue-tsc --noEmit -p tsconfig.json`         | 通过，零诊断（含 `.vue` 模板）                                   |
| `npx vitest run --no-file-parallelism`          | **101 个测试文件 / 1045 条用例全部通过**                         |
| `npx prettier --check`（3 个改动文件）          | 全部合规                                                         |
| 反向验证（把文案改回 `shortHash(conflict.id)`） | 新用例**如期失败**，其余 15 条通过；随后还原源码并复核两处调用点 |

**浏览器实测仍未执行**：`VersionPanel.vue` 删掉的那个 span 与改过的 `aria-label` 只在模板层，node 环境测不到渲染结果；`conflictLocation()` 本身已有既有用例覆盖（`model.spec.ts` 断言 `page:p1 / nodes`）。

**裁决预填轮（2026-11-09）改动清单**：兑现 §11.2「`order` / `dangling-ref` 可以先接受默认再抽查」这条承诺。

此前分级是纯展示：内核要求所有冲突裁决完才落盘，而 review 档没有任何预填，于是只有顺序冲突的用户点「应用裁决并合并」会直接吃到「尚未裁决」——UI 一边说可以先接受默认、一边把他挡住。`model.ts` 的 `BLOCKING_KINDS` 注释当时甚至明写「分级只影响展示」，与 §11.2 互相矛盾。

修法：新增 `REVIEW_DEFAULT_CHOICE = 'ours'` 与 `withReviewDefaults(conflicts, choices)`，只给 review 档预填、已有选择不覆盖、入参不就地改。取 `ours` 是为了与内核 `decide()` 无裁决时返回的 `ctx.prefer` 同值，不另立一套策略。`use-version-panel.ts` 在 `previewMerge()` 与 `applyMerge()` 的失败分支各调一次（后者用于裁决后重算出的新 plan，保留用户已改的选择），预览提示改成分别报「N 处必须裁决 / M 处已预填」；`VersionPanel.vue` 的「建议抽查」标题与底部说明如实标注已预填。

**预填不等于放行坏数据**（这是本轮唯一需要论证的安全问题）：`dangling-ref` 接受默认后引用可能仍然悬空，但宿主已注入 `validateWorkingTree`，`validateDocument` 经 `checkNodeChildRefs` 与 `validateConnections` 会把它报成 `error`，`MergePlan.status` 变 `invalid`，`merge()` 一个对象都不写。已逐条读 `packages/schema/src/validate.ts` 确认这两处检查存在，不是推测。

**刻意没做**：没有把 `dangling-ref` 上调到 blocking 档。一度考虑过（理由是「合并的默认责任是保守」，§8.4），但那会同时推翻 §11.2 的分级表与 `model.spec.ts` 既有用例，且上面那条校验兜底已经成立；改分级属于产品决策，不在本轮范围。

改动文件：`packages/plugins/plugin-panel-version/src/version-panel/{model.ts,use-version-panel.ts,VersionPanel.vue}`，测试 `tests/model.spec.ts`（+5 条）。**未改契约、内核与宿主**，docs/05 无需同步；本文件同步 §11.2 与 §19。

**本轮实际执行**：

| 命令                                           | 结果                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npx vue-tsc --noEmit -p tsconfig.json`        | 通过，零诊断（含 `.vue` 模板）                                                                                        |
| `npx vitest run --no-file-parallelism`         | **101 个测试文件 / 1050 条用例全部通过**                                                                              |
| `npx prettier --check`（4 个改动文件）         | 全部合规                                                                                                              |
| 反向验证（把 `withReviewDefaults` 改成空操作） | 3 条新用例**如期失败**（预填内容、不覆盖已有选择、只有 review 冲突时可直接落盘），其余 18 条通过；随后还原源码并复核  |
| `packages/schema/src/validate.ts` 逐条核对     | `validateDocument` → `validateNode` → `checkNodeChildRefs`、以及 `validateConnections` 确实覆盖悬空引用，校验兜底成立 |

**浏览器实测仍未执行**：预填后的按钮高亮（`lc-version__button--active`）与新文案只在模板层，node 环境测不到渲染结果。

**按钮置灰轮（2026-11-09）改动清单**：把修复轮的 `read-only-view` 从「点了才报错」改成「提前置灰并说明原因」。

修复轮之后，宿主声明 `workingTreeReplaceable: false`，于是面板的「执行合并」必然报错、「提交」在查看态也必然报错。内核拦在写入路径是对的（不能被 keybinding 或插件绕过），但 UI 让人点了才失败，等于把一个稳定的产品限制伪装成一次操作失误。

难点是面板**无从判断**这两种状态：`viewOnly` 的判据是「分支或提交与工作区归属不同源」，只有内核知道 `draftBranch` / `draftBase`。所以契约给 `VersionHead` 补三个字段：`workingTreeReplaceable`、`viewOnly`、`draftBranch`。判据一律由内核给出，UI 不得自行从 `branch` 推导——两条分支指向同一提交时只比分支会漏判（这正是修复轮踩过的坑）。`VersionHead` 全仓只有一个构造点（`service.ts` 的 `currentHead()`）、且既有测试都是逐字段断言而非整体 `toEqual`，加字段无破坏面，已 grep 确认。

判定规则落在 `model.ts` 的 `commitAvailability()` / `mergeAvailability()`，返回 `{ allowed, reason }`——**刻意不放 composable**：`useVersionPanel` 要 `useAppContext()`，node 环境测不到；放 model.ts 才能单测，也符合本插件「分组 / 裁决规则在 model.ts，composable 只做 Vue 状态与 IO」的既有分工。`VersionPanel.vue` 三处按钮接上 `disabled`，原因用可见文本而不是 `title`（置灰按钮的 `title` 读屏拿不到）。

**刻意没做**：受保护分支不置灰。内核仍会拒绝，但当前没有任何入口能把分支设成 `protected`（§17 已知边界外的既有缺口），提前置灰会是永远不触发的死 UI。脏工作区也不置灰提交——那正是有待提交内容的状态；`merge` 要求工作区干净，但那是用户先提交就能解除的临时状态，交给内核报错更准确。

改动文件：`packages/contracts/src/services/version.ts`、`packages/services/service-version/src/service.ts`、`packages/plugins/plugin-panel-version/src/version-panel/{model.ts,use-version-panel.ts,VersionPanel.vue}`，测试 `packages/services/service-version/tests/service.spec.ts`（+2 条）与 `packages/plugins/plugin-panel-version/tests/model.spec.ts`（+6 条，含 `makeHead()` 夹具）。本文件同步 §10.1 与 §19，`docs/05-contracts-and-schema.md` 同步 `VersionHead` 三字段。

**本轮实际执行**：

| 命令                                                          | 结果                                                                                                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vue-tsc --noEmit -p tsconfig.json`（重定向取真实退出码） | **`TSC_EXIT=0`，输出 0 行**                                                                                                                                                      |
| `npx vitest run --no-file-parallelism`                        | **`VITEST_EXIT=0`，101 个测试文件 / 1058 条用例全部通过**                                                                                                                        |
| `npx prettier --check`（7 个改动文件）                        | 6 个合规；`contracts/version.ts` 仍只有第 279 行 `MergeConflictKind` 联合类型那一条**既有**告警（行号因本轮加字段从 259 位移到 279），用 `diff` 逐行确认过不是本轮引入，未顺手改 |
| 反向验证 A（`commitAvailability` 忽略 `viewOnly`）            | 「只读查看态下提交置灰」**如期失败**，其余 26 条通过                                                                                                                             |
| 反向验证 B（`mergeAvailability` 恒返回 allowed）              | 「宿主写不回工作区时合并置灰」**如期失败**，其余 26 条通过                                                                                                                       |

**浏览器实测仍未执行**：三处按钮的 `disabled` 渲染与原因文案只在模板层，node 环境测不到；`commitAvailability` / `mergeAvailability` 的判定与文案已由 model 层用例覆盖，内核三字段由 service 层用例覆盖（含 `replaceable: true` 的对照路径）。

**环境残留**：修复依赖时把 `node_modules/.pnpm/` 下 9 个 Windows 原生包目录临时改名为 `*.bak`，P0 轮尝试清理后仍有 3 个因文件占用/回收站策略删除失败（`@esbuild+win32-x64@0.28.2.bak`、`@rollup+rollup-win32-x64-msvc@4.66.0.bak` 及一个嵌套 `.bak`）。P1 轮新增的临时目录 `.tmp-p1-verify` 已删除；P2a 轮的 `.tmp-p2-verify` 也已删除，并成功联网重建了依赖（见上），但 junction 遍历问题依旧。它们只位于依赖缓存内、不参与源码构建，建议在其他机器上重新 `pnpm install` 时一并清除这些缓存目录。**更正（修复轮）**：junction 遍历问题在修复轮已不复现，`npx vitest run` 与 `npx vue-tsc` 可直接在仓库根执行，见该轮的「依赖环境已恢复」。

**工作区状态提醒**：`git status` 显示宿主项目/发布/接口模块与两个面板插件在初稿时仍是**未提交内容**；P0 / P1 / P2a / P2b / P3 / P4 与补执行轮、修复轮、刷新放大轮、数组重排轮、冲突文案轮、裁决预填轮、按钮置灰轮共十三轮又新增/修改了上列文件，现状引用只对当前工作区成立。
