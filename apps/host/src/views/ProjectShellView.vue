<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import type { ProjectAssetCounts } from '../projects/project-model'
import { countAssetsOf, getProject } from '../projects/project-store'
import { projectPath } from '../projects/project-path'
import { useAssetStoreVersion } from '../projects/use-asset-store-version'

/**
 * 项目外壳。
 *
 * 顶栏只留「项目管理」一个入口，五类资产与发布版本都归这里：项目是归属容器，
 * 进项目才谈得上「这个项目的页面 / 流程 / 函数 / 组件 / 接口」。页签上的计数
 * 同时是作用域的可见证据——切个项目数字就变，比只有标题变化更难被忽略。
 */

interface ProjectTab {
  /** 页签的稳定 id，同时也是项目内路径的那一段 */
  id: string
  /** 页签文案 */
  label: string
  /** 计数取自哪一类资产；发布页签没有「条数」这种东西，留空即不渲染计数 */
  countKey?: keyof ProjectAssetCounts
  /** 归属前缀：编辑器路径（`design/`、`preview/`）与运行路径都要点亮它从属的页签 */
  prefixes: readonly string[]
}

const TABS: readonly ProjectTab[] = [
  { id: 'pages', label: '页面', countKey: 'pages', prefixes: ['pages', 'design/', 'preview/'] },
  { id: 'flows', label: '流程', countKey: 'flows', prefixes: ['flows'] },
  { id: 'functions', label: '函数', countKey: 'functions', prefixes: ['functions'] },
  { id: 'components', label: '组件', countKey: 'components', prefixes: ['components'] },
  { id: 'apis', label: '接口', countKey: 'apis', prefixes: ['apis'] },
  { id: 'releases', label: '发布', prefixes: ['releases', 'run/'] },
]

const route = useRoute()
const projectId = String(route.params.projectId)
const project = getProject(projectId)

const version = useAssetStoreVersion()

const counts = computed<ProjectAssetCounts | null>(() => {
  version.value
  return project ? countAssetsOf(projectId) : null
})

/**
 * 当前页签。
 *
 * 从 `route.path` 剥掉项目前缀得到相对段再比前缀，而不是给每条子路由挂 meta：
 * 归属关系由路由结构决定，写两处就会和 `router.ts` 漂移（与顶栏同一做法）。
 */
const activeTab = computed(() => {
  const sub = route.path.slice(projectPath(projectId, '').length)
  return TABS.find((tab) => tab.prefixes.some((prefix) => sub.startsWith(prefix)))?.id ?? null
})
</script>

<template>
  <main v-if="!project" class="lc-shell lc-shell--missing">
    <span class="lc-shell__missing-title">项目不存在</span>
    <span>它可能已被删除，或链接里的项目 id 不正确。资产本身还在，回到工作台即可选择。</span>
    <RouterLink class="lc-shell__button" to="/projects">返回项目管理</RouterLink>
  </main>

  <div v-else class="lc-shell">
    <header class="lc-shell__bar">
      <RouterLink class="lc-shell__crumb" to="/projects">项目管理</RouterLink>
      <span class="lc-shell__sep" aria-hidden="true">/</span>
      <span class="lc-shell__name">{{ project.name }}</span>
      <code class="lc-shell__id">{{ project.id }}</code>
      <span v-if="project.description" class="lc-shell__desc">{{ project.description }}</span>

      <nav class="lc-shell__tabs" aria-label="项目内导航">
        <RouterLink
          v-for="tab in TABS"
          :key="tab.id"
          class="lc-shell__tab"
          :class="{ 'is-active': activeTab === tab.id }"
          :to="projectPath(projectId, tab.id)"
        >
          {{ tab.label }}
          <span v-if="tab.countKey" class="lc-shell__count">{{
            counts?.[tab.countKey] ?? 0
          }}</span>
        </RouterLink>
      </nav>
    </header>

    <RouterView />
  </div>
</template>

<style scoped>
.lc-shell {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.lc-shell__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 36px;
  border-bottom: 1px solid var(--lc-border);
  background: var(--lc-surface-sunken);
}

.lc-shell__crumb,
.lc-shell__button {
  color: var(--lc-accent-bright);
  font-size: 12px;
  text-decoration: none;
}

.lc-shell__crumb:hover {
  text-decoration: underline;
}

.lc-shell__sep {
  color: var(--lc-text-muted);
  font-size: 12px;
}

.lc-shell__name {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-shell__id {
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--lc-panel-glass);
  color: var(--lc-text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
}

.lc-shell__desc {
  overflow: hidden;
  max-width: 320px;
  color: var(--lc-text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-shell__tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.lc-shell__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--lc-text-secondary);
  font-size: 12px;
  text-decoration: none;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.lc-shell__tab:hover {
  border-color: var(--lc-border);
  color: var(--lc-accent-bright);
}

.lc-shell__tab.is-active {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-shell__count {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--lc-panel-glass);
  color: var(--lc-text-muted);
  font-size: 10px;
}

.lc-shell--missing {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 56px 36px;
  color: var(--lc-text-secondary);
  font-size: 13px;
}

.lc-shell__missing-title {
  color: var(--lc-text);
  font-size: 18px;
  font-weight: 600;
}

.lc-shell__button {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
}

.lc-shell :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 900px) {
  .lc-shell__bar {
    padding: 10px 20px;
  }

  .lc-shell__tabs {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-shell__tab {
    transition: none;
  }
}
</style>
