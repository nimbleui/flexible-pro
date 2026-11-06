<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { ValidationIssue } from '@lc/schema'
import type { ProjectRelease } from '../projects/release-model'
import {
  checkProjectRelease,
  currentReleaseOf,
  listReleasesOf,
  onReleasesChange,
  publishProject,
  setCurrentRelease,
} from '../projects/release-store'
import { getProject, onProjectsChange } from '../projects/project-store'
import { useAssetStoreVersion } from '../projects/use-asset-store-version'
import { toastService } from '../toast'

/**
 * 项目发布页。
 *
 * 一件发布在这里等于三件事：汇总校验 → 冻结一份不可变快照 → 把线上版本指针移到它。
 * 回滚只是反向移动指针，不改任何资产记录，所以「把线上切回 v2」和「我还没发布的改动」
 * 可以同时成立。
 */

const route = useRoute()
const projectId = String(route.params.projectId)

const version = ref(0)
const bump = (): void => {
  version.value += 1
}

// 资产变了要重算校验清单（改了页面就可能引入阻断问题），指针与快照变了要重算版本表
const assetVersion = useAssetStoreVersion()
const disposables = [onReleasesChange(bump), onProjectsChange(bump)]

onUnmounted(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose()
})

/** 每次渲染重新取，避免拿到上一次订阅回调之前的旧引用 */
const revision = computed(() => {
  version.value
  assetVersion.value
  return getProject(projectId)?.publishedRevision
})

const current = computed<ProjectRelease | undefined>(() => {
  revision.value
  assetVersion.value
  return currentReleaseOf(projectId)
})

const history = computed<readonly ProjectRelease[]>(() => {
  revision.value
  assetVersion.value
  return [...listReleasesOf(projectId)].sort((a, b) => b.revision - a.revision)
})

/**
 * 当前内容的校验清单。
 *
 * 每次渲染现算：`checkProjectRelease` 只读四份 store 的内存值并跑既有校验函数，
 * 没有 IO，缓存它反而要在每个写入方记得失效。
 */
const issues = computed<ValidationIssue[]>(() => {
  version.value
  assetVersion.value
  return checkProjectRelease(projectId)
})

const blockers = computed(() => issues.value.filter((issue) => issue.severity === 'error'))
const notices = computed(() => issues.value.filter((issue) => issue.severity === 'warning'))
const canPublish = computed(() => blockers.value.length === 0)

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function publish(): void {
  try {
    const created = publishProject(projectId)
    toastService.show(`已发布 v${created.revision}`, 'success')
  } catch (cause) {
    // store 抛的是可直接展示的用户文案（项目不存在、第一条阻断原因），原样透出
    toastService.show(messageOf(cause), 'error')
  }
}

function rollback(target: number): void {
  try {
    setCurrentRelease(projectId, target)
    toastService.show(`线上版本已切到 v${target}`, 'success')
  } catch (cause) {
    toastService.show(messageOf(cause), 'error')
  }
}
</script>

<template>
  <main class="lc-releases">
    <header class="lc-releases__head">
      <div class="lc-releases__heading">
        <h1 class="lc-releases__title">发布</h1>
        <p class="lc-releases__hint">
          发布把当前项目的页面、流程、函数与组件冻结成一份不可变快照，并把线上版本指针移到它上面。
          回滚只切指针，不会改动你的草稿。运行页读的就是这份快照。
        </p>
      </div>
      <button
        type="button"
        class="lc-releases__primary"
        :disabled="!canPublish"
        :title="canPublish ? '校验通过，发布为新版本' : '存在阻断问题，先修完再发布'"
        @click="publish"
      >
        发布新版本
      </button>
    </header>

    <section class="lc-releases__current">
      <div v-if="current" class="lc-releases__live">
        <span class="lc-releases__live-label">当前线上</span>
        <span class="lc-releases__live-rev">v{{ current.revision }}</span>
        <span class="lc-releases__live-meta">
          发布于 {{ formatTime(current.createdAt) }} · {{ current.assets.pages.length }} 个页面
          · {{ current.assets.flows.length }} 条流程 ·
          {{ current.assets.functions.length }} 个函数 ·
          {{ current.assets.components.length }} 个组件 ·
          {{ current.assets.apis?.length ?? 0 }} 个接口
        </span>
      </div>
      <div v-else class="lc-releases__live">
        <span class="lc-releases__live-label">当前线上</span>
        <span class="lc-releases__live-rev lc-releases__live-rev--none">尚未发布</span>
        <span class="lc-releases__live-meta">
          发布后这里会出现版本号，运行页也才有内容可渲染。
        </span>
      </div>
    </section>

    <section v-if="blockers.length > 0 || notices.length > 0" class="lc-releases__issues">
      <h2 class="lc-releases__issues-title">
        发布检查（{{ blockers.length }} 处阻断 · {{ notices.length }} 条提示）
      </h2>
      <ul class="lc-releases__issue-list">
        <li
          v-for="(issue, index) in [...blockers, ...notices]"
          :key="`${issue.path}-${index}`"
          class="lc-releases__issue"
          :class="`lc-releases__issue--${issue.severity}`"
        >
          <span class="lc-releases__issue-tag">{{
            issue.severity === 'error' ? '阻断' : '提示'
          }}</span>
          <span class="lc-releases__issue-text">{{ issue.message }}</span>
          <code class="lc-releases__issue-path">{{ issue.path }}</code>
        </li>
      </ul>
    </section>

    <section v-if="history.length > 0" class="lc-releases__history">
      <h2 class="lc-releases__sub">版本表（每个项目保留最近 5 份）</h2>
      <ul class="lc-releases__list">
        <li v-for="item in history" :key="item.revision" class="lc-releases__item">
          <div class="lc-releases__item-main">
            <span class="lc-releases__rev">v{{ item.revision }}</span>
            <span
              v-if="item.revision === revision"
              class="lc-releases__badge lc-releases__badge--live"
            >
              线上
            </span>
            <span class="lc-releases__meta">{{ formatTime(item.createdAt) }}</span>
            <span class="lc-releases__counts">
              页面 {{ item.assets.pages.length }} · 流程 {{ item.assets.flows.length }} · 函数
              {{ item.assets.functions.length }} · 组件 {{ item.assets.components.length }} ·
              接口
              {{ item.assets.apis?.length ?? 0 }}
            </span>
          </div>

          <div class="lc-releases__actions">
            <!-- 当前线上版本没有可执行动作，「线上」徽标已经说明它是什么；运行入口在页面列表 -->
            <button
              v-if="item.revision !== revision"
              type="button"
              class="lc-releases__button"
              @click="rollback(item.revision)"
            >
              切到此版本
            </button>
          </div>
        </li>
      </ul>
    </section>

    <p class="lc-releases__foot">
      快照只保证页面内容可回放；流程按事件键在项目内匹配，函数与组件注册仍是应用级的，
      这两条边界见 docs/10 的已知边界。
    </p>
  </main>
</template>

<style scoped>
.lc-releases {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 32px 36px;
  overflow: auto;
}

.lc-releases__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 18px;
}

.lc-releases__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 6px;
  color: var(--lc-text);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.lc-releases__title::before {
  content: '';
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--lc-accent-bright), var(--lc-accent));
  box-shadow: 0 0 10px var(--lc-glow);
}

.lc-releases__hint {
  max-width: 760px;
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.lc-releases__primary,
.lc-releases__button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.lc-releases__primary {
  border-color: var(--lc-accent);
  background: linear-gradient(135deg, var(--lc-accent), var(--lc-accent-bright));
  box-shadow: 0 0 18px var(--lc-glow);
  color: var(--lc-app-bg);
  font-weight: 600;
}

.lc-releases__primary:hover,
.lc-releases__button:hover {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

/* 禁用态只改前景与边框，不靠 opacity 把整颗按钮洗淡 */
.lc-releases__primary:disabled {
  border-color: var(--lc-border);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  box-shadow: none;
  cursor: not-allowed;
}

.lc-releases__current {
  margin-bottom: 16px;
}

.lc-releases__live {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(150deg, var(--lc-surface), var(--lc-surface-sunken));
}

.lc-releases__live-label {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-releases__live-rev {
  color: var(--lc-accent-bright);
  font-size: 16px;
  font-weight: 600;
}

.lc-releases__live-rev--none {
  color: var(--lc-text-muted);
  font-size: 13px;
  font-weight: 500;
}

.lc-releases__live-meta {
  color: var(--lc-text-secondary);
  font-size: 12px;
}

.lc-releases__issues {
  margin-bottom: 18px;
  padding: 14px 16px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface-sunken);
}

.lc-releases__issues-title,
.lc-releases__sub {
  margin: 0 0 10px;
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-releases__issue-list,
.lc-releases__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-releases__issue {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}

.lc-releases__issue-tag {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
}

.lc-releases__issue--error .lc-releases__issue-tag {
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-releases__issue--warning .lc-releases__issue-tag {
  background: color-mix(in srgb, var(--lc-warning) 14%, transparent);
  color: var(--lc-warning);
}

.lc-releases__issue-text {
  color: var(--lc-text-secondary);
}

.lc-releases__issue-path {
  color: var(--lc-text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 10px;
}

.lc-releases__list {
  gap: 8px;
}

.lc-releases__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 16px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(150deg, var(--lc-surface), var(--lc-surface-sunken));
}

.lc-releases__item-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.lc-releases__rev {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-releases__badge {
  padding: 1px 8px;
  border: 1px solid color-mix(in srgb, var(--lc-success) 40%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--lc-success) 12%, transparent);
  color: var(--lc-success);
  font-size: 11px;
}

.lc-releases__meta,
.lc-releases__counts {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-releases__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lc-releases__foot {
  margin: 18px 0 0;
  color: var(--lc-text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.lc-releases :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 900px) {
  .lc-releases {
    padding: 24px 20px;
  }

  .lc-releases__head {
    flex-wrap: wrap;
    gap: 14px;
  }

  .lc-releases__item {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-releases__primary,
  .lc-releases__button {
    transition: none;
  }
}
</style>
