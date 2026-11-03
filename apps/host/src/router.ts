import { createRouter, createWebHistory } from 'vue-router'
import PageListView from './views/PageListView.vue'
import DesignerView from './views/DesignerView.vue'
import FunctionListView from './views/FunctionListView.vue'
import FunctionEditView from './views/FunctionEditView.vue'
import ComponentListView from './views/ComponentListView.vue'
import ComponentBlueprintView from './views/ComponentBlueprintView.vue'

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
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/pages' },
    { path: '/pages', component: PageListView },
    { path: '/design/:documentId', component: DesignerView },
    { path: '/functions', component: FunctionListView },
    { path: '/functions/new', component: FunctionEditView },
    { path: '/functions/:functionId/edit', component: FunctionEditView },
    { path: '/components', component: ComponentListView },
    { path: '/components/:componentId/edit', component: ComponentBlueprintView },
  ],
})
