import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CanvasRealm, EditorRealm } from '@lc/contracts'
import type { Context } from '@lc/kernel'
import type { PageSchema, RequestDefaults } from '@lc/schema'
import { projectPath } from '../../projects/project-path'

/**
 * 设计器视图的 Realm 装配与宿主路由桥接。
 *
 * 编辑器 Realm 按文档 id 复用（workspace 对重复 documentId 直接抛错），画布 Realm 则随视图
 * 创建、随视图释放：前者承载未保存的文档内存态，后者只属于当前这张视图。
 *
 * 这里只做 setup 期的同步装配，不注册 onMounted / onUnmounted：视图的卸载回调要按固定顺序
 * 释放页面函数、订阅与画布 Realm，把生命周期拆进 composable 会改变这个顺序。
 */

export interface DesignerRealmOptions {
  /** 应用级 Context；workspace 挂在它上面 */
  appCtx: Context
  /** 当前文档 id */
  documentId: string
  /** URL 上的项目段；预览路径按它拼 */
  projectId: string
  /** 页面标题；Realm 契约不回带它，工具栏与提示文案共用这一个值 */
  pageTitle: string
  /** 已展开项目接口绑定的文档；页面不存在时为 undefined */
  schema: PageSchema | undefined
  /** 当前项目的请求默认值；与 schema 一起在建 Realm 时交给取数服务 */
  requestDefaults: RequestDefaults | undefined
}

export interface DesignerRealm {
  editor: EditorRealm
  canvas: CanvasRealm
  /** 注入画布的宿主路由作用域 */
  routeScope: ComputedRef<Record<string, unknown>>
  /** 打开同应用内的项目预览页 */
  openPreview(): void
}

export function useDesignerRealm(options: DesignerRealmOptions): DesignerRealm {
  const route = useRoute()
  const router = useRouter()
  const { appCtx, documentId, projectId, pageTitle, schema, requestDefaults } = options

  /**
   * 预览走同应用内的项目内路径，不用 `window.open`：两个视图共用同一个文档
   * Realm，设计到一半、还没点保存时也能立刻看到真实渲染；整页导航会重建应用并丢掉这份
   * 内存态，预览就只剩页面记录里已保存的内容。
   */
  function openPreview(): void {
    void router.push(projectPath(projectId, `preview/${encodeURIComponent(documentId)}`))
  }

  /**
   * 注入画布的宿主路由作用域。
   *
   * 画布只负责页面数据（data/page），路由值由宿主提供；这样同一个画布模块
   * 既能被设计器装载，也能被预览/运行时装载，而不用自己依赖 vue-router。
   */
  const routeScope = computed<Record<string, unknown>>(() => {
    const params = { ...route.params }
    const query = { ...route.query }
    return {
      $params: params,
      $query: query,
      $route: {
        path: route.path,
        fullPath: route.fullPath,
        name: typeof route.name === 'string' ? route.name : null,
        hash: route.hash,
        params,
        query,
      },
    }
  })

  // 重复进入同一文档复用已开的 Realm：workspace 对重复 documentId 直接抛错
  const editor: EditorRealm =
    appCtx.workspace.getEditor(documentId) ??
    appCtx.workspace.createEditorRealm({
      documentId,
      title: pageTitle,
      // 项目接口在进 Realm 前展开；保存时由 page-store 剥回去，落盘的文档只留绑定
      schema,
      requestDefaults,
    })

  // 一篇文档可以有多个画布视图，所以画布 Realm 随视图创建、随视图释放
  const canvas: CanvasRealm = editor.createCanvasRealm()

  // 调试入口跟随视图：__lc.canvas 始终指向当前活动画布，production 下 __lc 未挂载即为 no-op
  if (window.__lc) window.__lc.canvas = canvas

  return { editor, canvas, routeScope, openPreview }
}
