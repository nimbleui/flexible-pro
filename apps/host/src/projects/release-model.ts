import type { FlowDefinition, ProjectApi, ValidationIssue } from '@lc/schema'
import {
  applyApiBindings,
  findUnresolvedBindings,
  validateDocument,
  validateFlow,
} from '@lc/schema'
import type { ProjectRequestDefaults } from '@lc/contracts'
import { isEnvironment } from '../apis/api-config-model'
import type { CustomComponent } from '../custom-components/custom-components'
import type { GlobalFunction } from '../functions/global-functions'
import type { PageRecord } from '../pages/page-model'
import { isPageRecord } from '../pages/page-model'
import type { ProjectOwnedRecord } from './project-model'
import { resolveProjectId } from './project-model'

/**
 * 项目发布快照。
 *
 * 快照是「某个时刻这个项目作为应用的全部内容」，写进去之后不再修改：运行态读它、
 * 回滚也只是把指针移回它，而不是回头改资产记录。这条不可变约束是让回滚可以说得清的
 * 前提——能改的快照就不是快照。
 *
 * 纯逻辑集中在本文件（校验、剪枝、读档收窄），localStorage 读写在 `release-store.ts`。
 */

/** 一次发布锁定的五类资产内容 */
export interface ProjectReleaseAssets {
  /** 页面记录，含各自的文档快照；运行态真正消费的就是这一项 */
  pages: PageRecord[]
  /** 流程图（草稿也在内，运行态只匹配已发布的） */
  flows: FlowDefinition[]
  /** 全局函数定义 */
  functions: GlobalFunction[]
  /** 自定义组件定义 */
  components: CustomComponent[]
  /**
   * 当时登记的项目接口（可选）。
   *
   * 页面对接口的引用在收集快照时就已展开成完整地址，运行态读的是上面的 `pages`，
   * 这一项不参与渲染，只留作「v3 用的是哪批接口」的事后凭据。写成可选是因为
   * 接口管理之前的快照里没有它。
   */
  apis?: ProjectApi[]
  /**
   * 发布时生效的那套请求环境（可选）。
   *
   * 运行页把它当作 `requestDefaults` 传给 Realm，而不是去读当前的项目配置：环境后来改了
   * 域名或 token，线上版本必须还按发布时那一套跑。字段可选是因为接口管理之前的快照没有它。
   */
  environment?: ProjectRequestDefaults
}

/** 一个项目的发布快照 */
export interface ProjectRelease {
  /** 归属项目 id */
  projectId: string
  /** 项目内单调递增的发布号，从 1 开始；跨项目互不相干 */
  revision: number
  /** 发布时间（ISO 字符串） */
  createdAt: string
  /** 当时的资产内容 */
  assets: ProjectReleaseAssets
}

/** 每个项目保留的快照份数上限；再旧的版本被剪掉 */
export const RELEASE_RETENTION = 5

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 收集快照的输入：五类资产的当前全量清单，外加接口地址拼接要用的项目前缀。
 *
 * 与 `ProjectAssetLists`（计数用的宽松形状）分开的理由很直接：快照要把内容原样带进
 * 运行态，收集函数得知道每类记录真正的类型，否则返回给调用方的是被抹平成
 * `ProjectOwnedRecord[]` 的数组，运行页拿不到 `schema`。
 *
 * `apis` 与计数侧的 `ProjectAssetLists` 保持同样的必填形状：两条链路都从
 * `currentAssetLists()` 取「现在这一瞬间的五类资产」，一侧可缺一侧必填就会让计数与
 * 快照口径分叉。缺省即视为这个项目没登记过接口，页面文档里若还有绑定，收集之后由发布
 * 校验报成阻断问题。
 */
export interface ProjectReleaseSources {
  /** 全部页面记录 */
  pages: readonly PageRecord[]
  /** 全部流程记录 */
  flows: readonly FlowDefinition[]
  /** 全部全局函数记录 */
  functions: readonly GlobalFunction[]
  /** 全部自定义组件记录 */
  components: readonly CustomComponent[]
  /** 全部项目接口记录 */
  apis: readonly ProjectApi[]
}

/**
 * 下一个发布号：现存最大号与当前指针两者中较大的那个再加一。
 *
 * 两个输入都必要，缺一个就会撞号：
 * - 只看指针：线上切回 v1 后再发布会算出 v2，而 v2 那份快照还在表里，同一个号两份内容，
 *   运行页取到哪份看遍历顺序——这条是浏览器实测里真踩到的。
 * - 只看现存快照：把指针可能领先于快照表的情况漏掉（存储被手改、或快照被删过），
 *   算出的号会指回一份已经存在的内容。
 * 剪枝只删最旧的份，所以现存最大号永远等于历史最高号，这一条保证单调递增。
 */
export function nextRevision(
  existingRevisions: readonly number[],
  publishedRevision: number | undefined,
): number {
  const highest = existingRevisions.reduce((max, item) => (item > max ? item : max), 0)

  return Math.max(highest, publishedRevision ?? 0) + 1
}

/**
 * 从五类资产的全量清单里挑出属于某个项目的部分，并把页面里的接口引用定版。
 *
 * 与 `countProjectAssets` 共用同一个归属解释（缺省即默认项目），所以「卡片上显示的数量」
 * 与「实际进快照的内容」不会是两套口径。
 *
 * 草稿态的页面只存绑定（路径也不带域名，域名在发请求时才拼），而快照必须自己就能跑：引用在
 * 这里展开成完整配置，当时生效的那套环境整体记进 `environment`。线上版本因此不会跟着后来
 * 改动的域名或 token 一起漂——「v3 昨天还能跑」这件事必须是可判定的，不能取决于当前配置。
 */
export function collectProjectAssets(
  sources: ProjectReleaseSources,
  projectId: string,
  environment?: ProjectRequestDefaults,
): ProjectReleaseAssets {
  const inProject = <T extends ProjectOwnedRecord>(list: readonly T[]): T[] =>
    list.filter((item) => resolveProjectId(item.projectId) === projectId)

  const apis = inProject(sources.apis)

  // 没有绑定的文档原样带过去：快照不因为一次无关的展开而换掉页面记录的引用
  const pages = inProject(sources.pages).map((page) => {
    const schema = applyApiBindings(page.schema, apis)

    return schema === page.schema ? page : { ...page, schema }
  })

  return {
    pages,
    flows: inProject(sources.flows),
    functions: inProject(sources.functions),
    components: inProject(sources.components),
    apis,
    ...(environment === undefined ? {} : { environment }),
  }
}

/**
 * 发布前的汇总校验。
 *
 * 只判「这个项目能不能作为一个应用被打开」这件事，五道阻断：
 * 1. 一张页面都没有——没有可运行的入口；
 * 2. 页面引用的项目接口不存在——展开不出数据源，线上会静默缺数据，表达式里只剩
 *    一个永远「未取数」的 `data.<绑定名>`；
 * 3. 页面文档自身有阻断问题——设计器允许保存半成品，发布不允许；
 * 4. 已发布的图当前内容仍有阻断问题——发布之后又被改坏的图不该进快照；
 * 5. 两张已发布的图抢同一个项目内事件键——运行时选哪张是不确定的。
 *
 * 草稿流程只给 warning：写一半的图是正常状态，把它算成「不能发布」会让人
 * 以为发布闸门坏了。函数体语法与组件蓝图不在这里复检——它们分别在注册阶段
 * 和保存阶段已被判定，抄第二遍只会让两处规则各自漂移。
 */
export function validateProjectRelease(assets: ProjectReleaseAssets): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (assets.pages.length === 0) {
    issues.push({
      path: '/pages',
      message: '项目里还没有页面，发布后没有可打开的入口',
      severity: 'error',
    })
  }

  for (const page of assets.pages) {
    // 引用悬空要在发布前炸出来：展开不出来的数据源进了快照，等于线上页面少一块数据
    const unresolved = findUnresolvedBindings(page.schema.apis ?? [], assets.apis ?? [])
    for (const binding of unresolved) {
      issues.push({
        path: `/pages/${page.id}`,
        message: `页面「${page.title}」引用的接口 ${binding.apiId} 已不存在，发布后 data.${binding.id} 取不到数据`,
        severity: 'error',
      })
    }

    // 图清单一起交给校验：页面 connection.flowId 指向的是另一份存储里的文档，
    // 校验层自己看不见，不传就会把「引用了草稿」和「引用了不存在」都漏掉。
    for (const issue of validateDocument(page.schema, { flows: assets.flows })) {
      // 绑定了草稿图是 warning：页面本身没坏，只是这条事件暂时唤起不了流程；
      // 发布前值得说一次，但不足以拦下整次发布。其余 warning 与改造前一样不外泄。
      const keep = issue.severity === 'error' || issue.path.endsWith('/flowId')
      if (!keep) continue
      issues.push({
        path: `/pages/${page.id}`,
        message: `页面「${page.title}」：${issue.message}`,
        severity: issue.severity,
      })
    }
  }

  for (const flow of assets.flows) {
    if (flow.status !== 'published') {
      issues.push({
        path: `/flows/${flow.id}`,
        message: `流程「${flow.name}」还是草稿，页面事件不会调用它`,
        severity: 'warning',
      })
      continue
    }

    for (const issue of validateFlow(flow)) {
      if (issue.severity !== 'error') continue
      issues.push({
        path: `/flows/${flow.id}`,
        message: `流程「${flow.name}」：${issue.message}`,
        severity: 'error',
      })
    }
  }

  return issues
}

/**
 * 每个项目只保留最近 `keep` 份快照。
 *
 * 快照装的是整份资产内容，全留会让 localStorage 随发布次数线性膨胀；而线上版本由
 * 项目记录上的指针决定，剪掉最旧的几份不会让指针指向空——只有把用户正在看的那份
 * 剪掉才算 bug，所以按 revision 从新到旧保留。
 *
 * 输出顺序稳定：按项目首次出现的顺序，项目内按 revision 升序，便于列表直接渲染。
 */
export function pruneReleases(
  releases: readonly ProjectRelease[],
  keep: number = RELEASE_RETENTION,
): ProjectRelease[] {
  const byProject = new Map<string, ProjectRelease[]>()

  for (const release of releases) {
    const list = byProject.get(release.projectId)
    if (list) list.push(release)
    else byProject.set(release.projectId, [release])
  }

  const pruned: ProjectRelease[] = []

  for (const list of byProject.values()) {
    const sorted = [...list].sort((a, b) => a.revision - b.revision)
    pruned.push(...sorted.slice(Math.max(0, sorted.length - keep)))
  }

  return pruned
}

/**
 * 把快照里真正会被渲染的字段收紧到可用形状。
 *
 * 运行态读两处：`assets.pages[documentId].schema` 与 `assets.environment`。页面坏一条丢一条
 * （整体拒绝会让一次手改把整个版本抹掉）；环境按 `api-config-model` 的同一套判据收窄——
 * 判不过就当这个版本没有环境（请求退回无前缀），而不是另写一份更松的规则，两处口径分叉的
 * 后果是「设计期能跑的域名，线上拼不出来」。其余几类只用于发布页展示数量，不解析内容，因此
 * 只校验到「数组且每项是对象」。这是 JSON 边界上的断言：深字段由各自的 store 在写入时保证，
 * 在这里再抄一份完整校验，等于让几个 store 的规则各有一个会漂移的副本。
 */
export function narrowRelease(value: unknown): ProjectRelease | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.projectId !== 'string' || value.projectId === '') return undefined
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision)) return undefined
  if (value.revision < 1) return undefined
  if (typeof value.createdAt !== 'string') return undefined
  if (!isRecord(value.assets)) return undefined

  const assets = value.assets
  const isObjectArray = (items: unknown): boolean =>
    Array.isArray(items) && items.every((item) => isRecord(item))

  if (!Array.isArray(assets.pages)) return undefined
  if (!isObjectArray(assets.flows)) return undefined
  if (!isObjectArray(assets.functions) || !isObjectArray(assets.components)) return undefined

  return {
    projectId: value.projectId,
    revision: value.revision,
    createdAt: value.createdAt,
    assets: {
      pages: assets.pages.filter((item): item is PageRecord => isPageRecord(item)),
      flows: assets.flows as ProjectRelease['assets']['flows'],
      functions: assets.functions as ProjectRelease['assets']['functions'],
      components: assets.components as ProjectRelease['assets']['components'],
      // 接口与环境都是后加的字段：旧快照不带它们算合法，带了但形状坏了就丢掉这一项
      ...(assets.apis === undefined || !isObjectArray(assets.apis)
        ? {}
        : { apis: assets.apis as ProjectRelease['assets']['apis'] }),
      ...(isEnvironment(assets.environment) ? { environment: assets.environment } : {}),
    },
  }
}
