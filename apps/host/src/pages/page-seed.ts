import type { PageRecord } from './page-model'
import { createBlankPageSchema } from './page-model'
import { createAdminDocumentSchema } from '../admin-document'
import { createDemoSchema } from '../demo-document'
import { createEventDemoSchema } from '../event-demo-document'
import { createFormPageSchema } from '../form-page-document'

/**
 * 内置页面种子。
 *
 * 只在 IndexedDB 里还没有页面存储时写入一次，之后它们就是普通记录：可以改名、
 * 可以删掉，与设计器里保存出来的页面没有任何区别。
 *
 * 前三个 id 沿用项目化改造前 `pages.ts` 里的那三个：事件链演示的动作引用的是文档内的
 * 节点 id，收藏与外链也按这些文档 id 写死，播种时换 id 会让既有的演示和书签一起失效。
 * 后加的 `admin-doc` 没有这个包袱，但同样用固定 id：管理台的示例动作里写死了
 * `/preview/event-doc` 这样的跳转目标，id 稳定才能让链接与外部引用一直指得到。
 */
export function createBuiltinPageSeeds(): PageRecord[] {
  const now = new Date().toISOString()

  return [
    { id: 'demo-doc', title: '示例页面', schema: createDemoSchema(), updatedAt: now },
    { id: 'event-doc', title: '事件链演示', schema: createEventDemoSchema(), updatedAt: now },
    {
      id: 'admin-doc',
      title: '工单管理系统',
      schema: createAdminDocumentSchema(),
      updatedAt: now,
    },
    {
      id: 'form-doc',
      title: '自定义表单页',
      schema: createFormPageSchema(),
      updatedAt: now,
    },
    {
      id: 'blank-doc',
      title: '空白页面',
      schema: createBlankPageSchema('空白页面'),
      updatedAt: now,
    },
  ]
}
