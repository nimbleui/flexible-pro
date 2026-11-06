import { DEFAULT_PROJECT_ID } from './project-model'

/**
 * 项目内资产路径的唯一构造点。
 *
 * 资产路由统一挂在 `/projects/:projectId` 下，链接散在四个列表页、四个编辑器与新建
 * 弹框里。前缀写在一处，换路由结构时不必逐页搜字符串，也不会出现两种拼法。
 *
 * @param projectId 项目 id；参与 URL，按分量编码，手改存储写进来的怪字符不会撕开路径
 * @param sub 项目内的相对段，如 `flows/flow-1/edit`
 */
export function projectPath(projectId: string, sub: string): string {
  return `/projects/${encodeURIComponent(projectId)}/${sub}`
}

/**
 * 旧路径的回落目标。
 *
 * 项目化前的两类链接还活着：浏览器书签，以及写进文档动作里的跳转目标
 * （例如示例文档里的 `/preview/event-doc`）。文档内容已经落盘，改不动它们，
 * 所以旧路径继续存在并指向默认项目，而不是变成 404。
 */
export function legacyPath(sub: string): string {
  return projectPath(DEFAULT_PROJECT_ID, sub)
}
