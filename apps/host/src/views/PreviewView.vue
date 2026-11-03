<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import type { DocumentService, EditorRealm } from '@lc/contracts'
import type { ExpressionEngine, FunctionRegistration, FunctionSchema } from '@lc/schema'
import { PageRuntime, useAppContext } from '@lc/vue'
import { findPage } from '../pages'

/**
 * 页面预览视图。
 *
 * 与 `DesignerView` 共用同一个文档 Realm（workspace 对重复 documentId 复用而不是重开），
 * 差别在渲染器：这里装的是 `PageRuntime`——读状态服务的运行时值、把组件事件接给动作
 * 执行器；设计器那边的画布只读声明的默认值且不接线，所以编辑操作不会真的跑业务。
 *
 * 因为共用 Realm，同一篇文档在设计器里改出来的动作链，切到预览立刻可见，
 * 不需要先保存或重新打开。
 */

const appCtx = useAppContext()
const route = useRoute()
const documentId = String(route.params.documentId)
const page = findPage(documentId)
/** Realm 契约上不回带标题，标题只在宿主的页面表里 */
const pageTitle = page?.title ?? documentId

/** 宿主路由作用域；`$route` / `$params` / `$query` 由页面表达式读取 */
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
  appCtx.workspace.getEditor(documentId) ??
  appCtx.workspace.createEditorRealm({
    documentId,
    title: page?.title ?? documentId,
    schema: page?.createSchema(),
    // 预览态文档只读：链里的动作写的是状态服务，不是文档
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

/** 页面函数注册；离开预览时注销，避免与后续打开的文档共享一份函数表 */
let pageFunctionRegistration: FunctionRegistration = { dispose: () => {} }

/**
 * 注册本文档的页面函数。
 *
 * 预览必须自带这一步：表达式里的 `progress(todos)` 之类只有注册进引擎才能求值，
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
})
</script>

<template>
  <div v-if="!ready" class="lc-preview-page__loading">页面装载中…</div>

  <div v-else class="lc-preview-page">
    <header class="lc-preview-page__bar">
      <RouterLink class="lc-preview-page__back" to="/pages">返回页面列表</RouterLink>
      <span class="lc-preview-page__title">{{ pageTitle }}</span>
      <span class="lc-preview-page__badge">预览</span>
    </header>

    <div class="lc-preview-page__stage">
      <PageRuntime :context="editor.context" :scope="routeScope" />
    </div>
  </div>
</template>

<style scoped>
.lc-preview-page {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

.lc-preview-page__loading {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--lc-text-secondary);
  font-size: 13px;
}

.lc-preview-page__bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  height: 44px;
  padding: 0 16px;
  border-bottom: 1px solid var(--lc-border);
  background: var(--lc-dock-bg);
}

.lc-preview-page__back {
  color: var(--lc-text-secondary);
  font-size: 12px;
  text-decoration: none;
}

.lc-preview-page__back:hover,
.lc-preview-page__back:focus-visible {
  color: var(--lc-accent-bright);
}

.lc-preview-page__title {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-preview-page__badge {
  padding: 2px 8px;
  border: 1px solid var(--lc-border-strong);
  border-radius: 999px;
  color: var(--lc-accent-bright);
  font-size: 11px;
}

/* 舞台撑满剩余高度，页面内容按自身画幅定位，不缩放：预览要看真实尺寸 */
.lc-preview-page__stage {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px;
  background:
    radial-gradient(900px 520px at 20% -10%, rgba(47, 140, 255, 0.12), transparent 60%),
    var(--lc-canvas-bg);
}
</style>
