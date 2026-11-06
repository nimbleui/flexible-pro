import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import type { DocumentService, EditorRealm } from '@lc/contracts'
import type {
  ExpressionEngine,
  FunctionRegistration,
  PageSchema,
  RequestDefaults,
} from '@lc/schema'
import { useAppContext } from '@lc/vue'

/**
 * 一个文档的运行时渲染生命周期。
 *
 * 预览与运行态装的是同一个 `PageRuntime`，需要的事情也完全一样：建/复用 Realm、
 * 等服务就绪、把本文档的页面函数注册进表达式引擎、离开时注销。两处各写一遍的话，
 * 「注册漏了」这种错只会在其中一个页面里表现成「表达式取不到函数」。
 */
export interface PageRuntimeInput {
  /** EditorRealm 的 key；workspace 对同一个 key 只允许一个 Realm */
  realmKey: string
  /** 顶栏标题；Realm 契约不回带标题，两个视图都用调用方给的这一个值 */
  title: string
  /** 初始文档快照；缺省时文档服务给一棵只有根容器的空文档 */
  schema?: PageSchema
  /**
   * 请求默认值（域名、默认头、默认参数、凭据策略）。
   *
   * 草稿预览传当前项目的当前环境，运行页传**这份快照记下的那一套**——环境后来改了，
   * 线上版本不能跟着换域名。
   */
  requestDefaults?: RequestDefaults
  /**
   * 是否复用同 key 的已开 Realm。
   *
   * 设计器旁边的预览要 `true`：同 key 就是同一份内存草稿，改一半立刻能看见。
   * 运行态必须 `false`：它要渲染的是发布快照，撞上设计器里未保存的草稿就等于
   * 「线上跑的是草稿」，而这种事在界面上完全没有痕迹。
   */
  preferExisting: boolean
}

export function usePageRuntime(input: PageRuntimeInput) {
  const appCtx = useAppContext()
  const route = useRoute()

  /**
   * 宿主路由作用域。
   *
   * 画布只负责页面数据（data/page），路由值由宿主提供：同一个渲染器既要能被设计器
   * 装载，也要能被独立页面装载，而它自己不该依赖 vue-router。
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

  const editor: EditorRealm =
    (input.preferExisting ? appCtx.workspace.getEditor(input.realmKey) : undefined) ??
    appCtx.workspace.createEditorRealm({
      documentId: input.realmKey,
      title: input.title,
      schema: input.schema,
      requestDefaults: input.requestDefaults,
      // 两者都是只读：链里的动作写的是状态服务，不是文档
      mode: 'preview',
    })

  /**
   * 服务就绪门。
   *
   * `plugin()` 只做登记，Realm 内的插件要等运行时微任务批里才 apply；`PageRuntime`
   * 在 setup 阶段就 `require` 动作服务，所以先等一次空闲再渲染。
   */
  const ready = shallowRef(false)
  let unmounted = false

  /** 页面函数注册；离开时注销，避免与后续打开的文档共享一份函数表 */
  let pageFunctionRegistration: FunctionRegistration = { dispose: () => {} }

  /**
   * 注册本文档的页面函数。
   *
   * 必须自带这一步：表达式里的 `progress(todos)` 之类只有注册进引擎才能求值，
   * 而注册表挂在应用级引擎上，不会随 Realm 切换自动换一套。
   */
  function registerPageFunctions(): void {
    const schema = editor.context.require<DocumentService>('document').model.schema
    const expression = editor.context.require<ExpressionEngine>('expression')
    pageFunctionRegistration.dispose()
    pageFunctionRegistration = expression.functions.registerAll(schema.functions ?? [], 'page')
  }

  onMounted(async () => {
    await appCtx.runtime.whenIdle()
    // 等待期间用户可能已经离开：此时不能再访问服务
    if (unmounted) return

    registerPageFunctions()
    ready.value = true
  })

  onUnmounted(() => {
    unmounted = true
    pageFunctionRegistration.dispose()
    // 不复用就一定是自己新建的，离开即回收；反过来（预览态）可能正挂着设计器那份，
    // 关掉会打断正在编辑的文档
    if (!input.preferExisting) editor.dispose()
  })

  return { editor, ready, routeScope }
}
