import type { CanvasDropPayload, CanvasTransaction, SchemaPatch } from '@lc/contracts'
import { defineCanvasPlugin } from '@lc/contracts'
import type { NodeSchema } from '@lc/schema'
import { nodePath } from '@lc/schema'
import { createId } from '@lc/shared'
import { DEFAULT_DROP_HEIGHT, DEFAULT_DROP_WIDTH, DROP_PREVIEW_SETTING } from './constants'
import DropOverlay from './overlay'

export { manifest } from './manifest'

function cloneNode(node: NodeSchema): NodeSchema {
  return JSON.parse(JSON.stringify(node)) as NodeSchema
}

/**
 * 物料拖入插件。
 *
 * drop 由画布宿主转成 `canvas:drop` 事件；这里负责：
 * 1. 从物料 snippet 生成节点（新 id、清除悬空子引用）
 * 2. 命中容器时挂到容器 children，否则挂到文档根节点
 * 3. 一个事务写入一条历史，并选中新节点
 */
export default defineCanvasPlugin({
  name: 'canvas-drop',
  // material 是硬依赖：没有物料 snippet 就生成不出可插入的节点，
  // 声明成必需依赖让本插件等物料就位再激活
  inject: ['canvas', 'document', 'material'],

  apply(ctx) {
    const canvas = ctx.canvas
    const document = ctx.document
    const material = ctx.material

    ctx.effect(() =>
      canvas.settings.register({
        id: DROP_PREVIEW_SETTING,
        title: '拖入预览',
        scope: 'document',
        schema: {},
        default: null,
      }),
    )

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-drop.overlay',
        band: 'preview',
        pointerEvents: 'none',
        load: () => Promise.resolve({ default: DropOverlay }),
      }),
    )

    ctx.effect(() =>
      ctx.on('canvas:drop', (payload: CanvasDropPayload) => {
        const schema = document.model.schema
        const entry = material.get(payload.materialName)
        if (!entry) {
          ctx.diagnostics.report(new Error(`未知物料: ${payload.materialName}`), {
            scope: 'canvas-drop',
          })
          return false
        }

        const parentId = canvas.hitTest.containerAt(payload.screen) ?? schema.nodeId
        const parent = schema.nodes[parentId]
        if (!parent) return false

        const snippet = entry.snippet ? cloneNode(entry.snippet) : undefined
        const snippetRect = snippet?.layout?.rect
        const width = snippetRect?.width ?? DEFAULT_DROP_WIDTH
        const height = snippetRect?.height ?? DEFAULT_DROP_HEIGHT

        const siblings = parent.children ?? []
        const maxZ = siblings.reduce((max, id) => {
          const z = schema.nodes[id]?.layout?.zIndex ?? 0
          return Math.max(max, z)
        }, 0)

        const node: NodeSchema = {
          ...(snippet ?? { componentName: entry.name }),
          id: createId('node'),
          componentName: entry.name,
          children: undefined,
          slots: undefined,
          props: snippet?.props ?? {},
          layout: {
            ...(snippet?.layout ?? {}),
            mode: 'absolute',
            rect: {
              x: payload.world.x - width / 2,
              y: payload.world.y - height / 2,
              width,
              height,
            },
            zIndex: maxZ + 1,
          },
        }

        const patches: SchemaPatch[] = [
          { op: 'add', path: nodePath(node.id), value: node },
          {
            op: 'replace',
            path: nodePath(parentId, 'children'),
            value: [...siblings, node.id],
          },
        ]

        let transaction: CanvasTransaction
        try {
          transaction = canvas.transaction.begin({ label: '添加节点', owner: 'canvas-drop' })
        } catch {
          return false
        }
        transaction.preview(patches)
        transaction.commit()

        canvas.selection.set([node.id])
        canvas.settings.set(DROP_PREVIEW_SETTING, null)
        return true
      }),
    )
  },
})
