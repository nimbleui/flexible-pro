import type { DataSourceService, WorkspaceService } from '@lc/contracts'
import type { PageSchema, RequestDefaults } from '@lc/schema'
import { applyApiBindings } from '@lc/schema'
import { pages } from '../pages/page-store'
import { blueprintDocumentId } from '../custom-components/blueprint-document'
import { customComponents } from '../custom-components/custom-components'
import { resolveProjectId } from '../projects/project-model'
import { apisOfProject } from './api-store'
import { requestDefaultsOf } from './api-config'

/**
 * 项目侧配置进入文档 Realm 的唯一入口。
 *
 * 引用式设计的两端都在这里：落盘的文档永远只存绑定（写回时由 `stripApiBindings` 剥离），
 * 进入 Realm 之前才展开成完整的 `datasources`；请求默认值（域名、token 之类）则整个绕开
 * 文档，直接交给取数服务——两者都为了同一个目标：项目改一次，页面不必被重写。
 *
 * 本模块是宿主侧的（它要读 localStorage 里的接口表与环境表），发布快照那条路不走这里的
 * 默认值：版本内容定版时记下的是当时那套环境。
 */

/**
 * 把存储里的页面文档展开成装载进 Realm 时该用的文档。
 *
 * 没有绑定的文档原样返回同一个引用，`design` 与 `preview` 两条路径都靠这条性质
 * 不去无谓地重建 schema。
 *
 * @param schema 记录里的文档；`undefined` 表示页面不存在，直接透传让调用方保持原判
 * @param projectId URL 上的项目段，接口表按它取
 * @returns 展开后的文档，或与入参同一个引用
 */
export function loadSchemaWithApis(
  schema: PageSchema | undefined,
  projectId: string,
): PageSchema | undefined {
  if (!schema) return schema

  const bindings = schema.apis
  if (!bindings || bindings.length === 0) return schema

  return applyApiBindings(schema, apisOfProject(projectId))
}

/**
 * 把当前项目的请求默认值推给**本项目**已打开的 Realm。
 *
 * 切环境或补一条 Authorization 之后必须重取，否则页面显示的是上一个域名拿回来的数据，
 * 而界面上毫无痕迹。之所以重建 Realm 不可行：画布里的未保存改动只活在内存中，重建等于丢掉。
 *
 * 按文档 id 归属过滤而不是全量广播：`listEditors()` 里可能同时挂着别的项目的 Realm，
 * 把 A 项目的 token 推给 B 项目的文档，是那种要等到串数据才会被发现、一发现就说明
 * 作用域模型已经错了的 bug。
 *
 * @param workspace `appCtx.workspace`
 * @param projectId 当前项目段
 * @returns 推出去的默认值，供调用方展示或日志
 */
export function pushRequestDefaults(
  workspace: WorkspaceService,
  projectId: string,
): RequestDefaults | undefined {
  const defaults = requestDefaultsOf(projectId)
  const owned = new Set<string>([
    ...pages.value
      .filter((page) => resolveProjectId(page.projectId) === projectId)
      .map((page) => page.id),
    // 蓝图 Realm 的 documentId 是带前缀的合成 id，不是组件 id
    ...customComponents.value
      .filter((item) => resolveProjectId(item.projectId) === projectId)
      .map((item) => blueprintDocumentId(item.id)),
  ])

  for (const realm of workspace.listEditors()) {
    if (!owned.has(realm.documentId)) continue
    realm.context.get<DataSourceService>('dataSource')?.setRequestDefaults(defaults)
  }

  return defaults
}
