<script setup lang="ts">
import { useRoute } from 'vue-router'
import { PageRuntime } from '@lc/vue'
import { loadSchemaWithApis } from '../apis/api-load'
import { requestDefaultsOf } from '../apis/api-config'
import { getPage } from '../pages/page-store'
import { usePageRuntime } from '../pages/use-page-runtime'
import { visibleInProject } from '../projects/project-model'
import { projectPath } from '../projects/project-path'

/**
 * 页面预览视图（草稿预览）。
 *
 * 与 `DesignerView` 共用同一个文档 Realm（`preferExisting`），所以设计到一半、还没点
 * 保存时也能立刻看到真实渲染；差别只在渲染器：这里装的是 `PageRuntime`——读状态服务的
 * 运行时值、把组件事件接给动作执行器，而设计器的画布只读声明的默认值且不接线，
 * 所以编辑操作不会真的跑业务。
 *
 * 想看「线上跑的那一份」用运行页（`ProjectRunView`）：它读发布快照，且不复用这里的 Realm。
 */

const route = useRoute()
const projectId = String(route.params.projectId)
const documentId = String(route.params.documentId)
const page = visibleInProject(getPage(documentId), projectId)
/** Realm 契约上不回带标题，标题只在宿主的页面表里 */
const pageTitle = page?.title ?? documentId

const { editor, ready, routeScope } = usePageRuntime({
  realmKey: documentId,
  title: pageTitle,
  // 与设计器同一条展开路径：预览要看的正是「绑定生效后的这张页面」
  schema: loadSchemaWithApis(page?.schema, projectId),
  requestDefaults: requestDefaultsOf(projectId),
  preferExisting: true,
})
</script>

<template>
  <div v-if="!ready" class="lc-preview-page__loading">页面装载中…</div>

  <div v-else class="lc-preview-page">
    <header class="lc-preview-page__bar">
      <RouterLink class="lc-preview-page__back" :to="projectPath(projectId, 'pages')"
        >返回页面列表</RouterLink
      >
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
