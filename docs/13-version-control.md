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
| `ProjectRelease`    | 发布快照：`{ projectId, revision, createdAt, assets }`，写后不改；`RELEASE_RETENTION = 5`；`nextRevision`；`validateProjectRelease` 五道闸门；`pruneReleases`（[apps/host/src/projects/release-model.ts:29-270](../apps/host/src/projects/release-model.ts)） | **保留为发布产物角色**，降级为 commit 的一个视图；`revision` 与 `pruneReleases` 被 DAG 取代 |
| `setCurrentRelease` | 回滚 = 只拨 `publishedRevision` 指针，不回写资产（[apps/host/src/projects/release-store.ts:192](../apps/host/src/projects/release-store.ts)）                                                                                                                 | **必须原样继承的不变量**，方案里对应"移动环境绑定"                                          |
| `SchemaMigration`   | `migrateDocument` 显式迁移链，fail-closed（缺路径/有环/高于当前支持一律抛错）（[packages/schema/src/migrate.ts:28-54](../packages/schema/src/migrate.ts)）                                                                                                    | 版本库自身格式也需要一条**同构的**迁移链，但**不能复用同一套版本号**（见 §5.6）             |
| 内核保留服务        | `RESERVED_SERVICES` 含未使用的 `'storage'`，保留服务必须声明 `apiVersion`（[packages/kernel/src/context.ts:69-89](../packages/kernel/src/context.ts)、[:334-339](../packages/kernel/src/context.ts)）                                                         | 版本对象存储直接落位 `'storage'`，版本服务新增保留名 `'version'`                            |
| 宿主入口            | rail 里已存在 `{ id: 'versions', label: '版本管理' }` 且**无 action 即禁用态**（[apps/host/src/views/DesignerView.vue:347](../apps/host/src/views/DesignerView.vue)）；rail 支持 `action.kind: 'command'`（同文件 :335-340 是真实例子）                       | UI 入口已预留，启用它即可，不必新增外壳结构                                                 |

### 1.3 三个必须先修的地基缺陷

这三条不是"锦上添花"，**任一条不修，commit DAG 就是建在沙上**：

**① 序列化不保序 → 内容 hash 不可信。**
现状 `formatJsonValue = JSON.stringify(value, null, 2)`（[packages/shared/src/json.ts:34-37](../packages/shared/src/json.ts)），不排序键。同一个文档经过不同写入路径（`applyPatches` 的 `{ ...current }` 展开、`JSON.parse` 回读、宿主面板逐项提交）产生的对象**键插入顺序可以不同**，而 `JSON.stringify` 按插入顺序输出。后果：内容相同的实体算出不同 hash → diff 全是噪声、合并快路径（`base === ours`）永远不命中、两个客户端对同一份内容互相认为对方有改动。**这是方案的第一优先级，也是最容易被低估的一条。**

**② id 不跨端唯一 → 合并必然撞车。**
`createId(prefix)` 是进程内自增 `prefix-<seq36>`，注释明写"不保证跨刷新/跨端稳定，**不能写入持久化文档**"（[packages/shared/src/id.ts:4-14](../packages/shared/src/id.ts)）——但有两处**正是把它的结果写进了持久化文档**：`plugin-panel-eventflow` 的动作 id（[use-event-flow-store.ts:115-116](../packages/plugins/plugin-panel-eventflow/src/event-flow/composables/use-event-flow-store.ts)）与 `plugin-panel-node-event` 的连接 id（[use-node-event-bindings.ts:111-112](../packages/plugins/plugin-panel-node-event/src/composables/use-node-event-bindings.ts)），两处都只做了"本张文档内查重顺延"，跨设备/跨刷新无从判断。蓝图文档是同一类问题的另一种形态：它没用 `createId`，但前缀候选可重复，靠 [apps/host/src/custom-components/blueprint-document.ts:134-146](../apps/host/src/custom-components/blueprint-document.ts) 的 `taken/wanted` 双重检查顺延，提交 `452cfa0` 修的就是"id 相撞丢节点"。宿主侧资产 id 用 `Date.now + Math.random`（[apps/host/src/pages/page-store.ts:25](../apps/host/src/pages/page-store.ts)、[apps/host/src/workflows/flow-store.ts:166](../apps/host/src/workflows/flow-store.ts)、[apps/host/src/projects/project-store.ts:28](../apps/host/src/projects/project-store.ts)）——同一毫秒批量创建仍可能撞。后果：实体级合并以 id 为主键，id 语义是"全局唯一且永不复用"，不成立时"两侧各加一个节点"会被判成"同一条被两侧改成不同内容"→ 伪冲突，或者更糟——静默覆盖。

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
3. **不承诺历史不可篡改/合规审计链**：`audit` 服务位仍是空的，本方案只提供不可变对象，不提供签名与合规留存。
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
  /** 内容地址，由 canonicalHash(content) 得出 */
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

/** 规范化文本的内容地址。 */
export function canonicalHash(value: unknown): ObjectHash
```

设计要点：

1. **数组保序**，不排序。`children` / `slots` / `actionIds` 的顺序就是语义（视觉顺序、执行顺序），排序会把两个真实不同的版本算成同一个。
2. **数字走 `Number.toString` 最短路**并拒绝 `NaN`/`Infinity`（JSON 里它们会静默变成 `null`，等于内容被改写）；`-0` 归一为 `0`。这两条不处理的话，一个"节点 x 从 0 改成 -0"的 diff 会永远显示成两侧相同却 hash 不同。
3. **`undefined` 键在规范化时删除**，与 `arrayFieldPatch`"清空用 `remove` 而不是留空数组"的既有约定同口径（[packages/schema/src/patch.ts:182-192](../packages/schema/src/patch.ts)）。
4. **hash 用纯 JS SHA-256（新增到 `@lc/shared`），不用 `crypto.subtle`。** 理由即 §1.3② 的实测约束：非安全上下文下 `crypto.subtle` 为 `undefined`，而 dev/局域网预览正是非安全上下文。允许在 `crypto.subtle` 可用时走它提速，但**必须有属性测试断言两条路径同输入同输出**——否则同一份内容在生产（HTTPS）与预览（HTTP）下算出不同地址，历史列表会当场分裂成两套。
5. 地址取摘要的前 160 bit（40 字符十六进制）：够短可以当 IndexedDB 的 key，碰撞概率又低到不需要处理。但**写入仍校验同地址内容一致**——`putObject` 遇到"同 hash 已存在且内容不同"必须 fail-closed 抛错而不是静默覆盖，因为那意味着规范化函数出了 bug，静默去重会把两份不同文档压成一份（与 `CommandService.register` 的"id 冲突抛错而不覆盖"是同一取舍，见 [packages/services/service-command/src/index.ts:25-31](../packages/services/service-command/src/index.ts)）。展示层取前 8 字符加省略号；比较一律用完整字符串，不做前缀或数值比较。
6. `formatJsonValue` 保持原样不动——它是给人看的缩进文本，改成排序输出会让 JSON 输入框的字段顺序变得反直觉。**新能力另开函数，不改现有展示层。**

### 6.2 跨端稳定 id

```ts
/** 生成可持久化的稳定 id：prefix-<时间 base36><随机 base36>，长度对齐现有资产 id 风格。 */
export function createPersistentId(prefix: string): string
```

1. **不用 `crypto.randomUUID`**（同样受非安全上下文限制），也不用引 `nanoid`/`uuid` 依赖——现有 `Date.now + Math.random` 风格（宿主三处 store）其实已经是对的形态，缺的是**集中化 + 熵足够 + 撞名重试统一**。
2. 熵组成：48bit 时间 + 48bit 随机（两次 32bit `Math.random` 拼接），并在模块内维护 `seen` 集合做**同进程去重**（现在 `Date.now()` 在同一 tick 内不变，批量创建 10 个节点确实会撞）。
3. 改造点清单（现有把 `createId` 写进文档的两处 + 蓝图顺延 + 宿主三个私有生成器）：
   - `plugin-panel-eventflow` / `plugin-panel-node-event` 的 `while (used.has(id))` 重试 → 换成 `createPersistentId`，重试循环保留（作为最后一道防线）；
   - [apps/host/src/custom-components/blueprint-document.ts:134-146](../apps/host/src/custom-components/blueprint-document.ts) 的 `taken/wanted` 双重检查 → 同上；
   - 宿主 `page-store` / `flow-store` / `project-store` 三处私有生成器 → 收敛到 `@lc/shared` 一处，语义不变，只消灭"三个文件各写一遍"的漂移风险。
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

- **发布闸门原样复用 `validateProjectRelease` 的五道阻断**（[apps/host/src/projects/release-model.ts:170-239](../apps/host/src/projects/release-model.ts)）：无页面 / 接口引用悬空 / 文档自身阻断 / 已发布流程当前内容阻断 / 页面事件绑了不存在的流程。**不新写一套校验**，否则两处规则必然分叉，这是本项目已经反复强调的口径问题。
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
    expected: ObjectHash,
    next: ObjectHash,
  ): Promise<Ref | undefined>
  listRefs(repoId: string): Promise<Ref[]>
  /** GC 用：全部对象地址，供可达性标记 */
  scanObjectHashes(repoId: string): Promise<ObjectHash[]>
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

### 11.1 挂载方式（严格遵守"先契约常量、再宿主插槽、再插件声明"）

1. `SLOT` 新增 `designerBottomPanel` 已够用（底部停靠区天然支持多面板动态页签、宽度充裕、与事件流并列），**版本面板进这里**，不必新增槽；
2. rail 的 `{ id: 'versions' }` 补 `action: { kind: 'command', commandId: 'version.openHistory' }`（与同列表 `pageFunction.openDialog` 同形态，[apps/host/src/views/DesignerView.vue:335-347](../apps/host/src/views/DesignerView.vue)）；命令内部展开 dock 并激活版本页签；
3. **不给右栏加第 5 页签**：现状 `rightTabs` 四页签全集固定且注明"不做动态注册"（同文件 :395-413），破坏它等于把已确立的产品边界改成可插拔；
4. 新增插件包 `packages/plugins/plugin-panel-version`（`@lc/plugin-panel-version`），manifest 按 `contributes.panels` + `activationEvents: ['onPanel:version']` 声明，注册进 [apps/host/src/bootstrap.ts:86](../apps/host/src/bootstrap.ts) 的懒加载列表（与 `advancedPanelManifest` 同批）。

### 11.2 面板分区

| 区        | 内容                                                                                    | 数据源                      |
| --------- | --------------------------------------------------------------------------------------- | --------------------------- |
| 历史树    | DAG 图（分支为泳道、tag 为节点标记），默认显示第一父链，展开显示合并双亲                | `log` + `listBranches`      |
| Diff 视图 | 按文档分组 → 按 section 分组 → 实体三列（基线/本侧/对侧），实体行显示 `label` 而非裸 id | `diff`                      |
| 分支区    | 列表、切换、新建、合入、删除（受保护项禁用并说明原因）                                  | `listBranches` / `checkout` |
| 发布区    | 发布表单（label + 环境）、闸门结果逐条展示、当前三环境绑定与晋级/回滚                   | `publish` / `getBinding`    |
| 冲突区    | 仅在有冲突时出现，逐条冲突给 `options` 按钮 + 一个"编辑 JSON"入口                       | `mergePreview`              |

冲突解决的严重度分级要显式呈现：`both-modified` / `delete-modify` 是必须裁决的；`order` / `dangling-ref` 可以先"接受默认"再抽查——把不同性质的冲突混在一个列表里等权重展示，用户会一把点"全部采用我的"，等于合并功能形同虚设。

### 11.3 命令与快捷键

新增命令 id：`version.commit`、`version.openHistory`、`version.checkout`、`version.merge`、`version.publish`、`version.rollback`（注册进 `CommandService`，`Ctrl+S` 从"保存"改为"提交"是**有意的语义变更**，需要在 §13 灰度开关下保留旧行为一版）。

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
5. **灰度开关**：`LC_VERSION_MODE=off | shadow | on`
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

| 层         | 内容                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单元       | `canonicalJson`（键序、嵌套、数组保序、`-0`、`NaN` 拒绝、`undefined` 剔除）、`canonicalHash`（纯 JS 与 `subtle` 同结果）、`createPersistentId`（同 tick 批量 1000 个无重复）             |
| DAG        | `log` 第一父链、多 LCA 虚拟基线、分支落后数、ref 移动不改对象（I1/I3）                                                                                                                   |
| Diff       | 黄金夹具：对 `apps/host/src/pages/page-seed.ts`、`event-demo-document.ts` 真实数据断言 diff 结果条数与内容，防止"看起来对但噪声多"                                                       |
| 合并       | §8.7 六条不变式做属性测试（随机生成三方字典/列表 + 断言性质），实体规则表 15 行逐行覆盖，`dangling-ref` 与 `rename` 各一组                                                               |
| 集成       | shadow 模式下「版本库投影 vs `lc.pages.v1`」等价性（这是 §13 第 5 步灰度开关的验证抓手）                                                                                                 |
| 迁移       | 既有 `narrowRelease` 形状兼容、`pruneReleases` 与可达性 GC 并存期行为                                                                                                                    |
| 浏览器实测 | 提交→切分支→合并冲突→解决→发布→回滚全链路；**以及从 `http://<lanIP>:5173` 打开一遍**（专测非安全上下文下 hash/id 是否可用，这一条踩过坑的方向）；面板渲染、rail 入口启用、状态栏分支指示 |

**验收指标**：200 节点文档一次提交的 hash+写盘 < 120ms（本地 IDB）；shadow 期不一致报警数为 0；干净合并属性测试 10 万随机用例 0 反例。

---

## 16. 分阶段实施计划

> 每阶段末尾的"可停点"是刻意设计的：任一阶段结束都能独立交付价值，不出现"必须做到 P4 才能用"。

### P0 · 地基（前置，不可跳）

| 任务                                                                            | 涉及文件                                                                                                                                                       | 验收                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `canonicalJson` + `canonicalHash`（纯 JS SHA-256 + subtle 快路径 + 一致性测试） | 新增 `packages/shared/src/canonical.ts`、`packages/shared/src/hash.ts`，出口加进 `packages/shared/src/index.ts`                                                | 键序无关同 hash；两路径同结果                                             |
| `createPersistentId` + 两处 createId 入档点与蓝图顺延改造 + `createId` 注释收紧 | `packages/shared/src/id.ts`；`plugin-panel-eventflow`、`plugin-panel-node-event`、`apps/host/src/custom-components/blueprint-document.ts`；宿主三个 store 收敛 | 同 tick 批量创建无重复；现有 78 文件 / 860 条用例全绿（实测于 `e620b20`） |
| 受影响 id 的回归夹具（蓝图 id 相撞丢节点的既有用例）                            | `packages/*/*/tests`                                                                                                                                           | 复现 `452cfa0` 场景不再丢节点                                             |

**可停点**：单看就修了"同内容不同 hash"和"id 撞车"两个真实 bug，与版本控制解耦也有价值。

### P1 · 对象存储与提交内核（无 UI、无宿主接线）

| 任务                                                   | 涉及文件                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `VersionService` / `VersionStore` 契约                 | 新增 `packages/contracts/src/services/version.ts`，出口进 `contracts/src/index.ts` |
| Core：对象写入、commit DAG、`log`、`diff`、`mergeBase` | 新增 `packages/services/service-version/src/**`                                    |
| `MemoryVersionStore` + `IdbVersionStore`               | `service-version/src/store/{memory,idb}.ts`                                        |
| `RESERVED_SERVICES` 增 `'version'`（`storage` 沿用）   | `packages/kernel/src/context.ts`，同步 docs/05                                     |
| 单测 + 属性测试（§15 的 DAG/Diff 两栏）                | `packages/services/service-version/tests/**`                                       |

**验收**：纯 node 环境跑通"建库 → 3 个提交 → 分支 → diff → 干净合并"，UI 零依赖。

### P2 · 提交链路（写进设计器）

| 任务                                                                              | 涉及文件                                                   |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 订阅 `document:change`，patch 聚合进 index，引用比较跳过未变 section              | `service-version/src/tracker.ts`                           |
| Realm 装配：每个 Realm 注入 `version`（按项目而非按文档，需跨 Realm 共享 repoId） | `packages/services/service-workspace/src/index.ts`         |
| 保存 → 提交；`Ctrl+S` 语义切换；`dirty` 改为 index 非空（I9）                     | `apps/host/src/views/DesignerView.vue`、`release-store.ts` |
| `LC_VERSION_MODE=off                                                              | shadow                                                     | on` 与 shadow 一致性报警 | `apps/host/src/**` |
| 存量迁移（§13 第 1–4 步）+ `LegacyReleaseAdapter`                                 | `service-version/src/legacy.ts`                            |
| 软锁（阶段 A）+ `BroadcastChannel`                                                | `apps/host/src/**`                                         |

**验收**：`shadow` 模式下全量对齐一个晚上，报警数 0；`on` 模式能提交、能 `log`、能切分支读历史（只读 Realm）。
**可停点**：此时已有"完整历史 + 逐次提交 + 回滚到任意提交"，diff 可文本级展示。多数团队到 P2 就够用。

### P3 · 三方合并（本方案的技术核心）

任务：实体规则表 + 列表前驱锚定 + 引用完整性检查 + `rename intent` 采集（改名入口在宿主：页面改名、变量改名、绑定改名）+ `MergePlan` 预览 API + 六条不变式属性测试。
**验收**：§8.7 全部通过；随机用例 10 万 0 反例；真实数据上"两人各加一页 + 同页各改不同节点"零冲突自动合并。

### P4 · UI 与命令

任务：`plugin-panel-version`（manifest + 面板 + 五区）、`SLOT` 复用 bottomPanel、rail `versions` 启用、6 个命令 + keybinding、状态栏分支指示。
**验收**：浏览器实测走完提交→分支→冲突→解决→发布→回滚；冲突区严重度分级可见。
**依赖**：必须在 P3 之后，否则冲突 UI 只能做成"二选一"，把实体级合并的价值全丢掉。

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
6. 本文是提案：除 §1 引用的现状事实外，代码里还不存在 `@lc/service-version`、`SLOT` 新增项、IndexedDB 库与任何版本面板。落地某阶段后须按 README 约定把事实回填 05/07/08/09，并复核本文引用行号。

---

## 18. 验证记录

**读过的规范**（`cloud-gate-store` Skill 渐进式读取要求）：`references/architecture.md`（Monorepo 边界、Core 与 Adapter 分离、Module Federation）、`references/typescript.md`（公共类型注释、命名、依赖判断）、`references/anti-patterns.md`（不必要抽象与循环依赖的红线）。本方案是设计而非实现，故未读 `styles.md`；`vue.md` / `performance.md` / `testing.md` 中的实现期约束在 §15 以现状事实形式引用，落 P4 时需补读。

**逐条源码核对**（本文所有现状引用都来自实际读取，非记忆）：`PageSchema` 与 `FlowDefinition` 字段表、`SchemaPatch` 应用与结构化共享、`createId` 的两处入档调用点与蓝图顺延逻辑、宿主三个 store 的私有 id、`formatJsonValue` 无排序、`service-history` 内存栈、`service-document` 的 `commitSchema` / `document:change`、`RESERVED_SERVICES` 与保留服务 `apiVersion` 强制、`SLOT` 全部插槽与"右栏四页签固定"注释、rail 的 `versions` 禁用项、`ProjectRelease` 全链（`nextRevision` / 五道闸门 / `pruneReleases` / `narrowRelease`）、`setCurrentRelease` 的指针语义、host vite 的 `0.0.0.0` + 局域网 IPv4 远程地址（非安全上下文结论的依据）、`vitest.config.ts` 与 `.prettierrc`、根 `package.json` 脚本、无 ESLint 配置、全仓零 `crypto` 引用。

**实际执行的命令与结果**：

| 命令                                                             | 结果                                               |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `npx vitest run`                                                 | **78 个测试文件 / 860 条用例全部通过**，耗时 7.65s |
| `npx prettier --write docs/13-version-control.md docs/README.md` | 通过，无告警                                       |

**未执行**（说明原因，不虚构）：`pnpm typecheck` 与 `pnpm build` 未跑——本轮只新增/修改 markdown，无任何 `.ts` / `.vue` 变更；UI 与浏览器实测无法进行——方案未实现，不存在可运行对象。README「基线」表里的 303 条用例是 2026-10-30 的旧数据，本文按当前 HEAD 实测值改写。

**本文的内部一致性核对**：§16 各阶段涉及的文件路径全部指向仓库现有文件（新增文件已标 `[提案]` 或写"新增"）；§5 类型之间的引用（`ObjectHash` / `VersionDocKind` / `ValidationIssue` / `EnvName`）在同一节内自洽定义或由 `@lc/schema` 提供；§8.4 引用清单逐项回对了字段声明位置；全部 `§n` 交叉引用都指向本文实际存在的章节。

**工作区状态提醒**：`git status` 显示本轮涉及的宿主项目/发布/接口模块与两个面板插件仍是**未提交内容**（新增文件与大量改动），因此本文的现状引用只对当前工作区成立；这些文件若被改动，行号需重新核对。本文只新增了自己这一个文件与 `docs/README.md` 的三处索引/约定改动，未触碰任何其他文件。
