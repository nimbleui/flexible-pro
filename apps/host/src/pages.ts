import type { PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import { createDemoSchema } from './demo-document'

/** 主应用可打开的页面；真实项目由服务端页面接口提供，这里保持同构的数据形状 */
export interface DesignerPage {
  /** 文档 id，同时作为 EditorRealm 的唯一 key */
  documentId: string
  /** 页面标题，写入 Realm 供大纲面板与状态栏显示 */
  title: string
  /** 打开时使用的文档 schema */
  createSchema: () => PageSchema
}

/** 空白页只有一个根容器，用来验证「同一宿主装载同一画布模块」的多文档切换 */
function createBlankSchema(): PageSchema {
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
          rect: { x: 160, y: 120, width: 520, height: 320 },
          zIndex: 0,
        },
        props: {
          fill: '#ffffff',
          stroke: 'rgba(15, 23, 42, 0.08)',
          radius: 16,
          label: '空白页面',
        },
      },
    },
    components: [],
    metadata: { title: '空白页面' },
  }
}

export const PAGES: readonly DesignerPage[] = [
  { documentId: 'demo-doc', title: '示例页面', createSchema: createDemoSchema },
  { documentId: 'blank-doc', title: '空白页面', createSchema: createBlankSchema },
]

/** 按 id 取页面元数据；未知 id 返回 undefined，由调用方回退为空白文档 */
export function findPage(documentId: string): DesignerPage | undefined {
  return PAGES.find((page) => page.documentId === documentId)
}
