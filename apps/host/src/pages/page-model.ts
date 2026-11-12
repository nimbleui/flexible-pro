import type { PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'

/**
 * 页面的存储形状与纯逻辑。
 *
 * `PageRecord` 是「一条可持久化的页面」：文档 id、归属项目、标题与文档快照。
 * 原先页面由 `pages.ts` 里的常量数组硬编码，条目带的是 `createSchema` 工厂函数，
 * 于是「新建页面」在刷新后必然消失——项目要按归属统计资产，页面必须先变成数据。
 *
 * 本文件只做类型、空白文档构造与读档收窄，IndexedDB 读写在 `page-store.ts`。
 */

/** 一条页面记录 */
export interface PageRecord {
  /** 文档 id，同时作为 EditorRealm 的唯一 key；改名与改归属都不影响它 */
  id: string
  /** 归属项目 id；缺省表示默认项目 */
  projectId?: string
  /** 页面标题；列表、设计器与状态栏读它，改名时同步写进 `schema.metadata.title` */
  title: string
  /** 页面文档快照；设计器保存时整体替换 */
  schema: PageSchema
  /** 最后修改时间（ISO 字符串） */
  updatedAt: string
}

/** 空白页根容器的画幅；沿用改造前内置「空白页面」的尺寸，新页面进画布不会缩成一条 */
const BLANK_PAGE_RECT = { x: 160, y: 120, width: 520, height: 320 } as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 构造一张只有根容器的空白页面。
 *
 * 根节点 id 固定 `root` 且与 `nodeId` 一致：画布靠 `nodeId` 取根包围盒，
 * 两者不同会让新建的页面一进画布就没有可选中的对象。
 */
export function createBlankPageSchema(title: string): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        componentName: 'Box',
        children: [],
        layout: {
          mode: 'absolute',
          rect: { ...BLANK_PAGE_RECT },
          zIndex: 0,
        },
        props: {
          fill: '#ffffff',
          stroke: 'rgba(15, 23, 42, 0.08)',
          radius: 16,
          label: title,
        },
      },
    },
    components: [],
    metadata: { title },
  }
}

/**
 * 文档快照的最小结构判断。
 *
 * 只校验到「能安全交给文档服务建模型」：`createDocument` 依赖 version、nodeId、
 * nodes、components 四个顶层字段，节点内部形状由 `validateDocument` 与设计器负责。
 * 在这里重复一遍完整校验会让读档规则与 schema 演进绑死。
 */
export function isPageSchemaSnapshot(value: unknown): value is PageSchema {
  if (!isRecord(value)) return false

  return (
    typeof value.version === 'string' &&
    typeof value.nodeId === 'string' &&
    isRecord(value.nodes) &&
    Array.isArray(value.components)
  )
}

/** 存储内容来自用户可编辑的 IndexedDB，读入时逐字段收窄 */
export function isPageRecord(value: unknown): value is PageRecord {
  if (!isRecord(value)) return false

  return (
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.title === 'string' &&
    value.title !== '' &&
    typeof value.updatedAt === 'string' &&
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    isPageSchemaSnapshot(value.schema)
  )
}

/**
 * 裁出页面标题。
 *
 * 空白标题返回空串而不是回退成「未命名页面」：调用方据此拒绝写入，
 * 列表里凭空多出一行「未命名页面」比让用户重填更难解释。
 */
export function normalizePageTitle(title: string): string {
  return title.trim()
}
