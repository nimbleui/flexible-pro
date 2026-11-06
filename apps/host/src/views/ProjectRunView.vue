<script setup lang="ts">
import { useRoute } from 'vue-router'
import { PageRuntime } from '@lc/vue'
import { usePageRuntime } from '../pages/use-page-runtime'
import { currentReleaseOf } from '../projects/release-store'
import { getProject } from '../projects/project-store'
import { projectPath } from '../projects/project-path'

/**
 * 运行页：渲染线上版本快照里的那张页面。
 *
 * 与预览的分工是硬的：预览看草稿，这页只看指针指向的快照。所以 Realm key 带上版本号——
 * 同 key 会让 workspace 复用设计器打开的那一份 Realm，于是「运行 v3」显示的是从没发布过
 * 的改动，而界面上一点痕迹都没有。key 里的合成 documentId 只用于 Realm 索引：
 * 文档模型 id 在全仓没有别的消费者，页面表达式取的是路由参数，不是它。
 *
 * 视图按 path 重建（`App.vue` 的 RouterView key），所以三种渲染阻塞条件都在 setup 期判完，
 * 不需要跟着 store 变。
 */

const route = useRoute()
const projectId = String(route.params.projectId)
const documentId = String(route.params.documentId)

const project = getProject(projectId)
const release = currentReleaseOf(projectId)
const page = release?.assets.pages.find((item) => item.id === documentId)

/** 渲染阻塞的原因；`undefined` 表示可以跑 */
const blocked = !project
  ? '项目不存在，可能已被删除。'
  : !release
    ? '这个项目还没有线上版本，先去「发布」发一个版本。'
    : !page
      ? `线上版本 v${release.revision} 里没有这张页面——它可能是发布之后才新建或改归属的。`
      : undefined

const { editor, ready, routeScope } = usePageRuntime({
  realmKey: `${documentId}@r${release?.revision ?? 'none'}`,
  title: page?.title ?? documentId,
  schema: page?.schema,
  // 域名与 token 用这份快照记下的那一套环境，不是当前配置：改了环境不该改变线上版本的行为
  requestDefaults: release?.assets.environment,
  preferExisting: false,
})
</script>

<template>
  <main v-if="blocked" class="lc-run lc-run--blocked">
    <span class="lc-run__blocked-title">无法运行</span>
    <span>{{ blocked }}</span>
    <RouterLink class="lc-run__button" :to="projectPath(projectId, 'releases')"
      >去发布页</RouterLink
    >
  </main>

  <div v-else-if="!ready" class="lc-run__loading">页面装载中…</div>

  <div v-else class="lc-run">
    <header class="lc-run__bar">
      <RouterLink class="lc-run__back" :to="projectPath(projectId, 'pages')"
        >页面列表</RouterLink
      >
      <span class="lc-run__title">{{ page?.title }}</span>
      <span class="lc-run__badge">运行 v{{ release?.revision }}</span>
      <span class="lc-run__hint">内容来自已发布快照，草稿改动要再发布一次才会出现在这里</span>
    </header>

    <div class="lc-run__stage">
      <PageRuntime :context="editor.context" :scope="routeScope" />
    </div>
  </div>
</template>

<style scoped>
.lc-run {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

.lc-run--blocked {
  align-items: flex-start;
  gap: 10px;
  padding: 56px 36px;
  color: var(--lc-text-secondary);
  font-size: 13px;
}

.lc-run__blocked-title {
  color: var(--lc-text);
  font-size: 18px;
  font-weight: 600;
}

.lc-run__button,
.lc-run__back {
  color: var(--lc-accent-bright);
  font-size: 12px;
  text-decoration: none;
}

.lc-run__button {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
}

.lc-run__button:hover,
.lc-run__back:hover,
.lc-run__back:focus-visible {
  color: var(--lc-accent-bright);
  border-color: var(--lc-border-strong);
}

.lc-run__loading {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--lc-text-secondary);
  font-size: 13px;
}

.lc-run__bar {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 0 16px;
  border-bottom: 1px solid var(--lc-border);
  background: var(--lc-dock-bg);
}

.lc-run__back {
  color: var(--lc-text-secondary);
}

.lc-run__title {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-run__badge {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--lc-success) 40%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--lc-success) 12%, transparent);
  color: var(--lc-success);
  font-size: 11px;
}

.lc-run__hint {
  color: var(--lc-text-muted);
  font-size: 11px;
}

/* 舞台撑满剩余高度，页面内容按自身画幅定位，不缩放：运行态要看真实尺寸 */
.lc-run__stage {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px;
  background:
    radial-gradient(900px 520px at 20% -10%, rgba(47, 140, 255, 0.12), transparent 60%),
    var(--lc-canvas-bg);
}

.lc-run :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}
</style>
