/**
 * 项目（应用）的数据形状与纯逻辑。
 *
 * 项目是页面、流程、函数、组件、接口五类资产的归属容器。资产记录只带 `projectId` 外键，
 * 项目记录本身不存资产 id 列表：双向引用会在删除资产后于项目里留下悬空 id，
 * 而「这个项目里有什么」始终能从资产侧按外键过滤出来。
 *
 * 本文件不读存储、不碰浏览器 API，读写都在 `project-store.ts`；
 * 收窄与计数留在这里，才谈得上被 node 环境的单测直接覆盖。
 */

/** 存量资产没有归属字段，一律按默认项目处理，免得为旧数据写一次性迁移 */
export const DEFAULT_PROJECT_ID = 'project-default'

/** 默认项目的初始名称；只在首次装载时写入，之后可以在列表页改名 */
export const DEFAULT_PROJECT_NAME = '默认项目'

/** 一条项目记录 */
export interface ProjectDefinition {
  /** 稳定 id；改名不影响它，资产的 `projectId` 引用的就是它 */
  id: string
  /** 项目展示名；空白名在创建阶段就被拒绝，因此这里恒为非空串 */
  name: string
  /** 项目说明（可选），项目卡片副标题；空白串按未填写处理 */
  description?: string
  /**
   * 当前线上版本的发布号（可选）。
   *
   * 缺省即「从未发布」。它是回滚唯一被改动的东西：运行态按这个号去快照表里取内容，
   * 切版本只移动指针，不回写任何资产记录——未发布的草稿不该被一次回滚静默盖掉。
   */
  publishedRevision?: number
  /** 创建时间（ISO 字符串） */
  createdAt: string
  /** 最后修改时间（ISO 字符串） */
  updatedAt: string
}

/** 新建或修改项目的输入 */
export interface ProjectInput {
  /** 项目名；首尾空白会被裁掉，裁完为空即拒绝 */
  name: string
  /** 项目说明；传空白串等同于清空 */
  description?: string
}

/**
 * 资产记录参与归属统计时的最小结构。
 *
 * 五类资产各自定义在自己的模块里，计数只关心「这条记录属于哪个项目」。用结构约束
 * 而不是给五类资产抽一个共同基类型：那一层抽象当前解决不了任何真实问题。
 */
export interface ProjectOwnedRecord {
  /** 归属项目 id；缺省表示默认项目 */
  projectId?: string
}

/** 五类资产在某个项目下的数量，对应项目卡片上的五段计数 */
export interface ProjectAssetCounts {
  /** 页面数 */
  pages: number
  /** 流程数 */
  flows: number
  /** 全局函数数 */
  functions: number
  /** 自定义组件数 */
  components: number
  /** 接口数 */
  apis: number
}

/** 计数输入；字段与 `ProjectAssetCounts` 一一对应，就是五类资产的全量清单 */
export interface ProjectAssetLists {
  /** 全部页面记录 */
  pages: readonly ProjectOwnedRecord[]
  /** 全部流程记录 */
  flows: readonly ProjectOwnedRecord[]
  /** 全部全局函数记录 */
  functions: readonly ProjectOwnedRecord[]
  /** 全部自定义组件记录 */
  components: readonly ProjectOwnedRecord[]
  /** 全部接口记录 */
  apis: readonly ProjectOwnedRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 把归属字段解析成实际的项目 id。
 *
 * 存量记录没有 `projectId`，手改过的存储里可能被写成空白串，两者都回落到默认项目。
 * 缺省含义只有这一处解释，过滤与计数才不必各写一遍判断。
 */
export function resolveProjectId(projectId: string | undefined): string {
  const value = projectId?.trim() ?? ''

  return value === '' ? DEFAULT_PROJECT_ID : value
}

/**
 * 统计某个项目名下的五类资产数量。
 *
 * 供项目卡片展示，也供删除项目前的拦截判断使用：两处共用一次过滤，口径不会漂移。
 */
export function countProjectAssets(
  lists: ProjectAssetLists,
  projectId: string,
): ProjectAssetCounts {
  const countOf = (list: readonly ProjectOwnedRecord[]): number =>
    list.filter((item) => resolveProjectId(item.projectId) === projectId).length

  return {
    pages: countOf(lists.pages),
    flows: countOf(lists.flows),
    functions: countOf(lists.functions),
    components: countOf(lists.components),
    apis: countOf(lists.apis),
  }
}

/**
 * 存储内容来自用户可编辑的 IndexedDB，读入时逐字段收窄。
 *
 * `name` 要求非空：空白名会让卡片既没有标题也没有可辨认的删除目标，
 * 与其替用户编一个名字，不如把这条记录直接丢掉。
 */
export function isProject(value: unknown): value is ProjectDefinition {
  if (!isRecord(value)) return false

  return (
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.publishedRevision === undefined ||
      (typeof value.publishedRevision === 'number' &&
        Number.isInteger(value.publishedRevision) &&
        value.publishedRevision >= 1))
  )
}

/**
 * 按项目归属过滤单条记录：不属于当前项目就当看不见。
 *
 * 地址栏里的项目段和记录上的归属字段是两次独立输入，缺一道校验就能把 A 项目的文档
 * 挂到 B 项目的 URL 上编辑——列表按 B 过滤、计数按 B 统计，内容却是 A 的，三处对不上。
 * 编辑器都从各自的存储按 id 取记录，统一走这里，判断只写一遍。
 */
export function visibleInProject<T extends ProjectOwnedRecord>(
  record: T | undefined,
  projectId: string,
): T | undefined {
  if (!record) return undefined

  return resolveProjectId(record.projectId) === projectId ? record : undefined
}

/**
 * 归一化项目的可编辑字段：裁掉首尾空白，空串统一写成缺省。
 *
 * 与全局函数存储同一个理由：存储里不留 `description: ''` 这种既无意义
 * 又会干扰前后 diff 的字段。
 */
export function normalizeProjectInput(
  input: ProjectInput,
): Pick<ProjectDefinition, 'name' | 'description'> {
  const name = input.name.trim()
  const description = input.description?.trim() ?? ''

  return description === '' ? { name } : { name, description }
}
