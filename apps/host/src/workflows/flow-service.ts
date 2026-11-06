import type { FlowService } from '@lc/contracts'
import { router } from '../router'
import { DEFAULT_PROJECT_ID, resolveProjectId } from '../projects/project-model'
import { getPublishedFlowById, listProjectFlows, onFlowsChange } from './flow-store'

/**
 * 流程图仓库的宿主实现。
 *
 * 契约只问「这张 id 的图发布了吗」「本项目有哪些图」，不问「在哪个项目」——项目是宿主的
 * 路由事实，不是平台概念。所以这一层把当前项目从路由里取出来，闭进两次查询里。
 *
 * 服务注册在应用 Context 上、按调用时刻取项目：设计器与预览都在 `/projects/:projectId/…`
 * 下面，一次导航换项目时不必重装服务，也不会出现「切了项目还在用上一个项目的图」。
 */
export const flowService: FlowService = {
  getPublished(flowId) {
    return getPublishedFlowById(currentProjectId(), flowId)
  },

  list() {
    return listProjectFlows(currentProjectId())
  },

  /**
   * 直接转发仓库的变更订阅。
   *
   * 不按项目过滤：订阅者要的是「内容变了，重算」，项目由本服务在读取时决定。
   * 跨项目的变更只让对方面向一次空重算，比漏掉本项目的那次便宜。
   */
  onDidChange(listener) {
    return onFlowsChange(listener)
  },
}

/**
 * 当前项目 id。
 *
 * 路由参数缺失时按默认项目解释，与 `legacyPath` 指向默认项目同一口径：项目化之前的
 * 书签路径没有 projectId 段，那些页面上绑定的图仍然应该能在默认项目里找到。
 */
function currentProjectId(): string {
  const param = router.currentRoute.value.params.projectId
  const value = Array.isArray(param) ? param[0] : param
  if (typeof value === 'string' && value.trim() !== '') return resolveProjectId(value)

  return DEFAULT_PROJECT_ID
}
