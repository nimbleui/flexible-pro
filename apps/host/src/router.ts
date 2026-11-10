/**
 * 主应用路由。
 *
 * 五类资产都挂在 `/projects/:projectId` 下面：项目是资产的归属容器，URL 上那一段就是
 * 作用域声明。同一份编辑器代码换项目看到的是另一批记录，而不是同一批记录套一层筛子。
 * 项目根路径落到页面列表，所以卡片「进入」只需拼到项目段。
 *
 * `design/:documentId` 一条路由对应一个文档 Realm；事件流是设计器底部的停靠面板，
 * 不单独占一条路由。App.vue 用 path 作 key，切换文档即重建视图，远程模块随之重新装载，
 * 视图层不必监听参数变化。
 *
 * 组件蓝图与流程编辑器复用同一条「列表 → 编辑器」链路：新建不直接进画布，先走列表页的
 * 定义弹框，落库拿到 id 后才跳编辑器，避免出现第二条创建入口；`flows/new` 只是手改
 * 地址栏的兜底，编辑器会立刻把 URL 换成真实 id，刷新不会重复建图。
 */
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { legacyPath, projectPath } from './projects/project-path'

/**
 * 视图一律按需加载：编辑器、蓝图与流程画布都带各自的面板和样式，静态全量 import 会让
 * 入口 chunk 背上运行期用不到的代码。同一视图被多条路由引用时 Vite 会合并成同一个 chunk。
 */
const projectChildren: RouteRecordRaw[] = [
  { path: '', redirect: (to) => projectPath(String(to.params.projectId), 'pages') },
  { path: 'pages', component: () => import('./views/PageListView.vue') },
  { path: 'design/:documentId', component: () => import('./views/DesignerView.vue') },
  { path: 'preview/:documentId', component: () => import('./views/PreviewView.vue') },
  { path: 'functions', component: () => import('./views/FunctionListView.vue') },
  { path: 'functions/new', component: () => import('./views/FunctionEditView.vue') },
  {
    path: 'functions/:functionId/edit',
    component: () => import('./views/FunctionEditView.vue'),
  },
  { path: 'components', component: () => import('./views/ComponentListView.vue') },
  {
    path: 'components/:componentId/edit',
    component: () => import('./views/ComponentBlueprintView.vue'),
  },
  // 接口：字段比函数多，新建直接进编辑器，第一条就在「列表页弹框」里填不下
  { path: 'apis', component: () => import('./views/ApiListView.vue') },
  { path: 'apis/new', component: () => import('./views/ApiEditorView.vue') },
  { path: 'apis/:apiId/edit', component: () => import('./views/ApiEditorView.vue') },
  { path: 'flows', component: () => import('./views/FlowListView.vue') },
  { path: 'flows/new', component: () => import('./views/FlowEditorView.vue') },
  { path: 'flows/:flowId/edit', component: () => import('./views/FlowEditorView.vue') },
  // 发布页与运行页：一个是闸门与版本表，一个渲染线上快照，草稿改动要发布后才进得来
  { path: 'releases', component: () => import('./views/ProjectReleaseView.vue') },
  { path: 'run/:documentId', component: () => import('./views/ProjectRunView.vue') },
]

/**
 * 旧路径回落到默认项目。
 *
 * 项目化前有两类链接在外面飘：浏览器书签，以及写进文档动作里的跳转目标
 * （示例文档的 `navigate` 动作就写着 `/preview/event-doc`）。文档内容已经落盘，
 * 改不动它们，所以旧形状继续存在而不是 404。带参数的路径先按分量编码再拼，
 * query 与 hash 原样带上——掉参数的「定位到某节点再预览」链接会静默失效。
 *
 * @param oldPath 旧的路由形状
 * @param sub 默认项目里的相对段；含 `{param}` 时替换成该路由参数的编码值
 */
function legacyRoute(oldPath: string, sub: string): RouteRecordRaw {
  const param = /:(\w+)/.exec(oldPath)?.[1]

  if (!param) return { path: oldPath, redirect: () => ({ path: legacyPath(sub) }) }

  return {
    path: oldPath,
    redirect: (to) => {
      const raw = to.params[param]
      const value = Array.isArray(raw) ? (raw[0] ?? '') : String(raw ?? '')

      return {
        path: legacyPath(sub.replace('{param}', encodeURIComponent(value))),
        query: to.query,
        hash: to.hash,
      }
    },
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/projects' },
    { path: '/projects', component: () => import('./views/ProjectListView.vue') },
    {
      path: '/projects/:projectId',
      component: () => import('./views/ProjectShellView.vue'),
      children: projectChildren,
    },
    legacyRoute('/pages', 'pages'),
    legacyRoute('/design/:documentId', 'design/{param}'),
    legacyRoute('/preview/:documentId', 'preview/{param}'),
    legacyRoute('/functions', 'functions'),
    legacyRoute('/functions/new', 'functions/new'),
    legacyRoute('/functions/:functionId/edit', 'functions/{param}/edit'),
    legacyRoute('/components', 'components'),
    legacyRoute('/components/:componentId/edit', 'components/{param}/edit'),
    legacyRoute('/flows', 'flows'),
    legacyRoute('/flows/new', 'flows/new'),
    legacyRoute('/flows/:flowId/edit', 'flows/{param}/edit'),
  ],
})
