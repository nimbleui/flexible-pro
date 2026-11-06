import type { PageSchema } from '@lc/schema'
import { PAGE_EVENT_SOURCE, nodeLabel } from '@lc/schema'

/** 一处引用：某个页面的某个事件把这个事件绑到了图上 */
export interface FlowUsage {
  /** 页面文档 id */
  documentId: string
  /** 页面标题；列表里只给 id 没人认得出是哪张页 */
  documentTitle: string
  /** 事件来源节点 id；页面级事件是 `'page'` 哨兵 */
  sourceNodeId: string
  /** 来源节点的显示名 */
  nodeLabel: string
  /** 事件名 */
  eventName: string
  /** 这条绑定当前会不会真的执行（连接被停用就不会） */
  effective: boolean
}

/** 反查要读的页面记录；只取这三项，避免把整个存储类型拖进来 */
export interface FlowUsagePage {
  id: string
  title: string
  schema: PageSchema
}

/**
 * 这张图被哪些页面事件引用。
 *
 * 绑定写在页面的 `connection.flowId` 上，所以图自己答不出「谁在用我」——只能反过来扫一遍
 * 全部页面。扫的动作放在调用方点一下才发生（见 `FlowNodeConfigPane`）：项目里页面可能很多，
 * 每帧都重扫整批文档不值得，而「谁在用我」本来就是低频排查问题。
 *
 * 纯函数、不读存储：输入是已经取好的页面清单，因此可以脱离宿主直接测。
 *
 * @param pages 当前项目的全部页面
 * @param flowId 要反查的图 id
 */
export function findFlowUsages(pages: readonly FlowUsagePage[], flowId: string): FlowUsage[] {
  const usages: FlowUsage[] = []

  for (const page of pages) {
    for (const connection of Object.values(page.schema.connections ?? {})) {
      if (connection.flowId !== flowId) continue

      usages.push({
        documentId: page.id,
        documentTitle: page.title,
        sourceNodeId: connection.sourceNodeId,
        nodeLabel: usageNodeLabel(page.schema, connection.sourceNodeId),
        eventName: connection.eventName,
        effective: connection.enabled,
      })
    }
  }

  return usages
}

/**
 * 来源节点的显示名。
 *
 * 页面级事件用哨兵值，nodes 表里没有对应条目，直接查会得到「undefined」；
 * 节点被删掉但引用还留着时也要显示得出来——引用断链比假装它不存在有用。
 */
function usageNodeLabel(schema: PageSchema, sourceNodeId: string): string {
  if (sourceNodeId === PAGE_EVENT_SOURCE) return '页面级事件'

  const node = schema.nodes[sourceNodeId]

  return node ? nodeLabel(node) : `已删除节点 ${sourceNodeId}`
}
