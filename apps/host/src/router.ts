import { createRouter, createWebHistory } from 'vue-router'
import PageListView from './views/PageListView.vue'
import DesignerView from './views/DesignerView.vue'
import PreviewView from './views/PreviewView.vue'
import FunctionListView from './views/FunctionListView.vue'
import FunctionEditView from './views/FunctionEditView.vue'
import ComponentListView from './views/ComponentListView.vue'
import ComponentBlueprintView from './views/ComponentBlueprintView.vue'
import FlowListView from './views/FlowListView.vue'
import FlowEditorView from './views/FlowEditorView.vue'

/**
 * 主应用路由。
 *
 * `/design/:documentId` 一条路由对应一个文档 Realm；事件流是设计器底部的停靠面板，
 * 不再单独占一条路由。App.vue 用 path 作 key，切换文档即重建视图，
 * 远程模块随之重新装载，视图层不必监听参数变化。
 *
 * 组件蓝图复用同一条画布链路：`/components/:componentId/edit` 进 ComponentBlueprintView。
 * 新建不在此列——它先走列表页的定义弹框，落库拿到 id 后才进画布，
 * 避免「画布画完了才发现还没起名」和第二条创建入口。
 *
 * 流程编排同样遵循这条约定：`/flows/new` 只是手改地址栏的兜底，编辑器会立刻把 URL
 * 换成真实 id，所以刷新不会重复建图。
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/pages' },
    { path: '/pages', component: PageListView },
    { path: '/design/:documentId', component: DesignerView },
    { path: '/preview/:documentId', component: PreviewView },
    { path: '/functions', component: FunctionListView },
    { path: '/functions/new', component: FunctionEditView },
    { path: '/functions/:functionId/edit', component: FunctionEditView },
    { path: '/components', component: ComponentListView },
    { path: '/components/:componentId/edit', component: ComponentBlueprintView },
    { path: '/flows', component: FlowListView },
    { path: '/flows/new', component: FlowEditorView },
    { path: '/flows/:flowId/edit', component: FlowEditorView },
  ],
})
