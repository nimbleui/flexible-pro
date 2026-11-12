<script setup lang="ts">
import { computed, ref } from 'vue'
import EmptyState from '../components/common/EmptyState.vue'
import { useRoute } from 'vue-router'
import type { ProjectApi } from '@lc/schema'
import { joinApiUrl } from '@lc/schema'
import ApiRequestConfigPanel from '../components/api/ApiRequestConfigPanel.vue'
import { groupApis } from '../apis/api-model'
import { apisOfProject, findApiReferences, removeApi } from '../apis/api-store'
import { activeEnvironmentOf } from '../apis/api-config'
import { projectPath } from '../projects/project-path'
import { toastService } from '../toast'

/**
 * 项目接口列表。
 *
 * 接口是项目级资产，与页面 / 流程 / 函数 / 组件同级：登记一次，页面在「页面数据」里按
 * 引用使用，URL 上的项目段就是作用域。列表只按分组展示定义与引用数，编辑在独立视图里
 * 完成——接口字段比函数多，塞进弹框既放不下也难核对。
 *
 * 顶部的面板维护域名与默认请求头：它们属于项目而不属于某条接口，所以列表上显示的地址是
 * 「拼完之后的样子」，而存下来的仍然是相对路径——换环境时只需要改一处。
 */

const route = useRoute()
const projectId = String(route.params.projectId)

const pendingDelete = ref<string | null>(null)

/** 一条接口的展示数据 */
interface ApiRow {
  api: ProjectApi
  /** 实际请求地址（已按当前环境拼接），用于核对配错域名 */
  url: string
  /** 引用该接口的页面数 */
  referenceCount: number
}

/** 分组后的列表：域名拼接与引用计数都在这里算完，模板不做逻辑 */
const rows = computed(() => {
  const baseUrl = activeEnvironmentOf(projectId).baseUrl

  return groupApis(apisOfProject(projectId)).map((group) => ({
    name: group.name,
    items: group.apis.map((api): ApiRow => ({
      api,
      url: joinApiUrl(baseUrl, api.path),
      referenceCount: findApiReferences(api.id).length,
    })),
  }))
})

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso

  return date.toLocaleString('zh-CN', { hour12: false })
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 删除走两道：第一次点击进入待确认态，第二次才真的删；仍被引用时由存储层拒绝 */
function askDelete(id: string): void {
  pendingDelete.value = pendingDelete.value === id ? null : id
}

function confirmDelete(id: string): void {
  try {
    removeApi(id)
    pendingDelete.value = null
    toastService.show('接口已删除', 'success')
  } catch (cause) {
    pendingDelete.value = null
    toastService.show(messageOf(cause), 'error')
  }
}
</script>

<template>
  <main class="lc-apis">
    <header class="lc-apis__head">
      <div class="lc-apis__heading">
        <h1 class="lc-apis__title">接口管理</h1>
        <p class="lc-apis__hint">
          接口按项目登记一次，页面在「页面数据」里按名字引用；改一次定义，所有引用的页面在下一次装载时都用新地址。
        </p>
      </div>
      <RouterLink class="lc-apis__primary" :to="projectPath(projectId, 'apis/new')"
        >+ 新建接口</RouterLink
      >
    </header>

    <ApiRequestConfigPanel :project-id="projectId" />

    <EmptyState
      v-if="rows.length === 0"
      title="这个项目还没有登记接口"
      description="把跨页面复用的接口抽到这里，页面里就只需要选名字，不必各抄一遍地址。"
    >
      <template #actions>
        <RouterLink class="lc-apis__primary" :to="projectPath(projectId, 'apis/new')"
          >登记第一个接口</RouterLink
        >
      </template>
    </EmptyState>

    <section v-for="group in rows" :key="group.name ?? '__ungrouped'" class="lc-apis__group">
      <h2 class="lc-apis__group-title">{{ group.name ?? '未分组' }}</h2>

      <ul class="lc-apis__list">
        <li v-for="row in group.items" :key="row.api.id" class="lc-apis__item">
          <div class="lc-apis__item-main">
            <div class="lc-apis__item-head">
              <span class="lc-apis__method" :data-method="row.api.method">{{
                row.api.method
              }}</span>
              <span class="lc-apis__name">{{ row.api.name }}</span>
              <code class="lc-apis__url">{{ row.url }}</code>
            </div>
            <p v-if="row.api.description" class="lc-apis__desc">{{ row.api.description }}</p>
            <p class="lc-apis__meta">
              <span>被 {{ row.referenceCount }} 个页面引用</span>
              <span>更新于 {{ formatTime(row.api.updatedAt) }}</span>
              <span v-if="row.api.path.startsWith('http')">绝对地址，不拼前缀</span>
            </p>
          </div>

          <div class="lc-apis__item-actions">
            <RouterLink
              class="lc-apis__link"
              :to="projectPath(projectId, `apis/${row.api.id}/edit`)"
            >
              编辑
            </RouterLink>
            <button
              v-if="pendingDelete !== row.api.id"
              type="button"
              class="lc-apis__ghost"
              @click="askDelete(row.api.id)"
            >
              删除
            </button>
            <template v-else>
              <button type="button" class="lc-apis__danger" @click="confirmDelete(row.api.id)">
                确认删除
              </button>
              <button type="button" class="lc-apis__ghost" @click="askDelete(row.api.id)">
                取消
              </button>
            </template>
          </div>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.lc-apis {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 18px;
  overflow: auto;
  padding: 24px 36px 40px;
}

.lc-apis__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.lc-apis__title {
  margin: 0 0 6px;
  color: var(--lc-text);
  font-size: 18px;
  font-weight: 600;
}

.lc-apis__hint {
  margin: 0;
  max-width: 640px;
  color: var(--lc-text-secondary);
  font-size: 12px;
}

.lc-apis__primary,
.lc-apis__link {
  color: var(--lc-accent-bright);
  font-size: 12px;
  text-decoration: none;
}

.lc-apis__primary {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--lc-accent);
  border-radius: var(--lc-radius-sm);
  background: linear-gradient(
    135deg,
    var(--lc-accent-bright),
    var(--lc-accent) 52%,
    var(--lc-accent-2)
  );
  box-shadow: 0 0 18px var(--lc-glow);
  color: var(--lc-on-accent);
  font-weight: 600;
  white-space: nowrap;
}

.lc-apis__primary:hover {
  border-color: var(--lc-accent-bright);
  color: var(--lc-on-accent);
  text-decoration: none;
}

.lc-apis__group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lc-apis__group-title {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.lc-apis__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-apis__item {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  transition:
    border-color 0.2s ease,
    background 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
}

/* 行尾光晕：hover 时点亮，呼应全局蓝紫霓虹，不抢交互焦点 */
.lc-apis__item::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 100px;
  height: 100%;
  pointer-events: none;
  background: radial-gradient(circle at 100% 50%, rgba(55, 182, 255, 0.16), transparent 72%);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.lc-apis__item:hover {
  border-color: var(--lc-border-strong);
  background: linear-gradient(150deg, var(--lc-surface-raised), var(--lc-surface));
  box-shadow:
    0 0 0 1px rgba(55, 182, 255, 0.2),
    0 14px 34px rgba(0, 6, 18, 0.5),
    0 0 26px rgba(47, 140, 255, 0.2);
  transform: translateY(-2px);
}

.lc-apis__item:hover::before {
  opacity: 1;
}

.lc-apis__item-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.lc-apis__item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.lc-apis__method {
  padding: 1px 6px;
  border: 1px solid var(--lc-border-strong);
  border-radius: 4px;
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 10px;
  font-weight: 600;
}

.lc-apis__method[data-method='DELETE'] {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-apis__name {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-apis__url {
  color: var(--lc-text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  word-break: break-all;
}

.lc-apis__desc,
.lc-apis__meta {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-apis__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--lc-text-muted);
}

.lc-apis__item-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.lc-apis__link:hover {
  text-decoration: underline;
}

.lc-apis__ghost,
.lc-apis__danger {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.lc-apis__danger {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-apis__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 40px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-md);
  color: var(--lc-text-secondary);
  font-size: 12px;
}

.lc-apis__empty-title {
  color: var(--lc-text);
  font-size: 14px;
  font-weight: 600;
}

@media (max-width: 900px) {
  .lc-apis {
    padding: 18px 20px 32px;
  }

  .lc-apis__item {
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-apis__primary,
  .lc-apis__item {
    transition: none;
  }
}
</style>
