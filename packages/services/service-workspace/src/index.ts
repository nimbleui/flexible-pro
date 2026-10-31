import type {
  CanvasContext,
  CanvasRealm,
  EditorContext,
  EditorRealm,
  RealmOptions,
  WorkspaceService,
} from '@lc/contracts'
import { definePlugin } from '@lc/kernel'
import type { Disposable } from '@lc/kernel'
import { SCHEMA_VERSION } from '@lc/schema'
import type { PageSchema } from '@lc/schema'
import { createId } from '@lc/shared'
import canvasCorePlugin from '@lc/service-canvas-core'
import documentPlugin from '@lc/service-document'
import historyPlugin from '@lc/service-history'
import selectionPlugin from '@lc/service-selection'

/**
 * 构造一棵只有根容器的空文档。
 *
 * 根节点固定 id `root`、绝对定位，尺寸 1200×800 是新文档的默认画幅；
 * nodeId 与 nodes 的键必须同为 root，画布靠它取根包围盒。
 */
function createEmptySchema(documentId: string): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        componentName: 'Container',
        layout: {
          mode: 'absolute',
          rect: { x: 0, y: 0, width: 1200, height: 800 },
        },
      },
    },
    components: [],
    metadata: { title: documentId },
  }
}

/**
 * 工作区服务插件（应用级）。
 *
 * Realm 不是裸 `fork()`：每个 Realm 拥有独立 service scope 与生命周期记录，
 * `dispose` 由 workspace 的 effect 托管；关闭文档会级联清空文档级与画布级插件。
 *
 * 骨架阶段 Realm 内固定装配 document / history / selection，
 * 画布 Realm 装页面画布核心；生产环境可由预设按产品形态裁剪。
 */
export default definePlugin({
  name: 'service-workspace',

  apply(ctx) {
    const realms = new Map<string, EditorRealm>()
    const listeners = new Set<() => void>()
    let active: EditorRealm | undefined

    function notify(): void {
      for (const listener of [...listeners]) listener()
    }

    /**
     * 打开一个文档并建立它的 EditorRealm。
     *
     * fork 出的子作用域拥有独立 service scope，文档级插件互不串台。装配顺序是
     * document → history → selection：history 依赖 document，必须先完成注册。
     *
     * @throws 同一 documentId 已打开时抛错，避免两个 Realm 写同一份文档。
     */
    function createEditorRealm(options: RealmOptions): EditorRealm {
      if (realms.has(options.documentId)) {
        throw new Error(`[workspace] 文档已打开: ${options.documentId}`)
      }

      const realmCtx = ctx.fork()
      realmCtx.plugin(documentPlugin, {
        id: options.documentId,
        schema: options.schema ?? createEmptySchema(options.documentId),
        title: options.title,
        mode: options.mode ?? 'edit',
      })
      realmCtx.plugin(historyPlugin)
      realmCtx.plugin(selectionPlugin)

      // 一个文档可以有多个画布视图；关闭文档时按创建顺序反向回收
      const canvases: CanvasRealm[] = []
      let disposed = false

      const realm: EditorRealm = {
        id: createId('editor'),
        documentId: options.documentId,

        get context(): EditorContext {
          return realmCtx as EditorContext
        },

        /**
         * 新建一个画布视图（CanvasRealm）。
         *
         * 每个画布有独立的视口、图层、交互管线与画布设置，文档与选中集仍来自
         * 同一个 EditorRealm。契约把这一步描述为「主画布、每文档一个」，
         * 实现不限制调用次数。
         */
        createCanvasRealm(): CanvasRealm {
          const canvasCtx = realmCtx.fork()
          canvasCtx.plugin(canvasCorePlugin)

          const canvasRealm: CanvasRealm = {
            id: createId('canvas'),
            get context(): CanvasContext {
              return canvasCtx as CanvasContext
            },
            dispose: () => {
              // 先从列表摘除再销毁，文档级 dispose 不会重复回收同一个画布
              const index = canvases.indexOf(canvasRealm)
              if (index >= 0) canvases.splice(index, 1)
              canvasCtx.dispose()
            },
          }

          canvases.push(canvasRealm)
          return canvasRealm
        },

        /** 关闭文档：幂等，反向销毁全部画布后释放 Realm 作用域并通知订阅者。 */
        dispose: () => {
          if (disposed) return
          disposed = true
          for (const canvas of [...canvases].reverse()) canvas.dispose()
          canvases.length = 0
          realmCtx.dispose()
          realms.delete(options.documentId)
          if (active === realm) active = undefined
          notify()
        },
      }

      realms.set(options.documentId, realm)

      // 最近创建的文档即 activeEditor：当前没有「用户切换活动文档」的入口，
      // 关闭 active 文档后 active 变为 undefined，而不是自动回退到上一篇
      active = realm

      // 由 workspace 的 effect 托管：插件停用或应用销毁时级联关闭文档
      ctx.effect((): Disposable => ({ dispose: () => realm.dispose() }))
      notify()
      return realm
    }

    const service: WorkspaceService = {
      createEditorRealm,

      get activeEditor() {
        return active
      },

      getEditor(documentId) {
        return realms.get(documentId)
      },

      /** 打开顺序列表；同一文档只会有一条，key 冲突时已在创建阶段抛错 */
      listEditors() {
        return [...realms.values()]
      },

      /** 打开与关闭都会通知；不区分事件类型，订阅者需要自行比对前后状态 */
      onDidChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    }

    ctx.effect(() => ctx.provide('workspace', service, { apiVersion: '1.0' }))
  },
})
