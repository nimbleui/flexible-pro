<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ExpressionEngine } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import FunctionDetail from '../components/functions/FunctionDetail.vue'
import { functionTypeOptions } from '../components/common/type-options'
import type { FunctionConsoleDraft } from '../functions/function-draft'
import { consoleDraftFrom, functionBodyText } from '../functions/function-draft'
import type { FunctionScope, GlobalFunction } from '../functions/global-functions'
import {
  globalFunctions,
  removeGlobalFunction,
  resolveFunctionScope,
  saveGlobalFunction,
} from '../functions/global-functions'
import type { FunctionPublishStatus } from '../functions/function-status'
import { functionPublishStatus } from '../functions/function-status'
import { releases } from '../projects/release-store'
import { resolveProjectId, visibleInProject } from '../projects/project-model'
import { projectPath } from '../projects/project-path'
import { toastService } from '../toast'

/**
 * 函数管理主控台：左侧清单 + 右侧编辑区。
 *
 * 三条路由（列表 / 新建 / 编辑）共用这一页，URL 只决定选中项；草稿按条目 id
 * 缓存在本页，切换选中不丢未保存修改。函数的运行时注册仍是应用级的
 * （`bootstrap.ts` 启动时一次装完），项目过滤与作用域分类只管这一页的可见范围。
 */

const ctx = useAppContext()
const engine = ctx.require<ExpressionEngine>('expression')
const route = useRoute()
const router = useRouter()
const projectId = String(route.params.projectId)

const search = ref('')
const scopeFilter = ref<'all' | FunctionScope>('all')
const menuFor = ref<string | null>(null)
const confirmDeleteId = ref<string | null>(null)

const SCOPES: readonly FunctionScope[] = ['global', 'page', 'private']

const SCOPE_LABELS: Readonly<Record<FunctionScope, string>> = {
  global: '全局',
  page: '页面',
  private: '私有',
}

const STATUS_LABELS: Readonly<Record<FunctionPublishStatus, string>> = {
  published: '已发布',
  modified: '有改动',
  draft: '未发布',
}

const isNewRoute = computed(() => route.name === 'project-function-new')

const visible = computed<readonly GlobalFunction[]>(() =>
  globalFunctions.value.filter((fn) => resolveProjectId(fn.projectId) === projectId),
)

const filtered = computed<readonly GlobalFunction[]>(() => {
  const keyword = search.value.trim().toLowerCase()
  return visible.value.filter((fn) => {
    if (scopeFilter.value !== 'all' && resolveFunctionScope(fn.scope) !== scopeFilter.value) {
      return false
    }
    if (keyword === '') return true
    return (
      fn.name.toLowerCase().includes(keyword) ||
      (fn.title ?? '').toLowerCase().includes(keyword) ||
      (fn.description ?? '').toLowerCase().includes(keyword)
    )
  })
})

const scopeCounts = computed<Readonly<Record<FunctionScope, number>>>(() => {
  const counts: Record<FunctionScope, number> = { global: 0, page: 0, private: 0 }
  for (const fn of visible.value) counts[resolveFunctionScope(fn.scope)] += 1
  return counts
})

/** 发布状态从快照派生；releases 是 shallowRef，先触一下让卡片跟着发布 / 回滚刷新 */
const cards = computed(() => {
  void releases.value
  return filtered.value.map((fn) => ({ fn, status: functionPublishStatus(fn, projectId) }))
})

/**
 * 选中项由 URL 决定：编辑路由按 id 找（归属不符当不存在），列表路由自动选第一条，
 * 新建路由恒为 null。这样刷新 / 分享链接都能回到同一个编辑现场。
 */
const selected = computed<GlobalFunction | null>(() => {
  if (isNewRoute.value) return null
  const id = route.params.functionId
  if (typeof id === 'string') {
    return (
      visibleInProject(
        globalFunctions.value.find((item) => item.id === id),
        projectId,
      ) ?? null
    )
  }
  return visible.value[0] ?? null
})

const isMissing = computed(
  () =>
    !isNewRoute.value && typeof route.params.functionId === 'string' && selected.value === null,
)

const activeKey = computed(() => {
  if (isNewRoute.value) return 'new'
  return selected.value?.id ?? ''
})

/**
 * 草稿缓存：键是条目 id（新建用 'new'）。用 reactive Map 而不是普通 Map，
 * 让 activeDraft 的 computed 能感知 watch 里的写入。
 */
const drafts = reactive(new Map<string, FunctionConsoleDraft>())

watch(
  activeKey,
  (key) => {
    if (key === '' || drafts.has(key)) return
    drafts.set(key, consoleDraftFrom(key === 'new' ? null : selected.value))
  },
  { immediate: true },
)

const activeDraft = computed(() => drafts.get(activeKey.value) ?? null)

const takenNames = computed<readonly string[]>(() =>
  globalFunctions.value
    .filter((item) => item.id !== selected.value?.id)
    .map((item) => item.name),
)

/** 可引用其他自定义函数的形参与返回类型；不包含当前函数自身 */
const typeOptions = computed(() => {
  void globalFunctions.value
  const currentName = selected.value?.name
  return functionTypeOptions(engine.functions.describe()).filter((option) => {
    if (!currentName) return true
    return (
      option.id !== `return:${currentName}` && !option.id.startsWith(`param:${currentName}:`)
    )
  })
})

const ICON_COLORS: readonly string[] = [
  'var(--lc-accent-bright)',
  'var(--lc-accent-2-bright)',
  'var(--lc-success)',
  'var(--lc-warning)',
]

function iconColor(index: number): string {
  return ICON_COLORS[index % ICON_COLORS.length]
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function select(id: string): void {
  closeMenu()
  if (route.params.functionId === id) return
  void router.replace(projectPath(projectId, `functions/${id}/edit`))
}

function goNew(): void {
  closeMenu()
  void router.replace(projectPath(projectId, 'functions/new'))
}

function goList(): void {
  void router.replace(projectPath(projectId, 'functions'))
}

function openMenu(id: string): void {
  if (menuFor.value === id) {
    menuFor.value = null
  } else {
    menuFor.value = id
    confirmDeleteId.value = null
  }
}

function closeMenu(): void {
  menuFor.value = null
  confirmDeleteId.value = null
}

/** 卡片菜单的复制：从已保存记录复制（区别于编辑区「更多」里复制当前草稿） */
function duplicateFunction(fn: GlobalFunction): void {
  closeMenu()
  const taken = new Set(globalFunctions.value.map((item) => item.name))
  const base = `${fn.name}_copy`
  let name = base
  let index = 2
  while (taken.has(name)) {
    name = `${base}${index}`
    index += 1
  }

  try {
    const entry = saveGlobalFunction({
      name,
      title: fn.title,
      params: fn.params,
      paramTypes: fn.paramTypes,
      body: fn.body,
      description: fn.description,
      scope: resolveFunctionScope(fn.scope),
      projectId,
    })
    drafts.set(entry.id, consoleDraftFrom(entry))
    void router.replace(projectPath(projectId, `functions/${entry.id}/edit`))
    toastService.show(`已复制为「${entry.name}」`, 'success')
  } catch (error) {
    toastService.show(error instanceof Error ? error.message : String(error), 'error')
  }
}

function deleteFunction(id: string): void {
  const target = globalFunctions.value.find((item) => item.id === id)
  removeGlobalFunction(id)
  drafts.delete(id)
  closeMenu()
  if (route.params.functionId === id) goList()
  toastService.show(target ? `函数「${target.name}」已删除` : '函数已删除', 'success')
}

/** 新建保存成功后把 URL 换成真实 id；导航完成后再清 'new' 草稿，避免编辑区闪断 */
function onSaved(fn: GlobalFunction): void {
  if (!isNewRoute.value) return
  drafts.set(fn.id, consoleDraftFrom(fn))
  void router.replace(projectPath(projectId, `functions/${fn.id}/edit`)).then(() => {
    drafts.delete('new')
  })
}

function onDuplicated(fn: GlobalFunction): void {
  drafts.set(fn.id, consoleDraftFrom(fn))
  void router.replace(projectPath(projectId, `functions/${fn.id}/edit`))
}

function onRemoved(id: string): void {
  drafts.delete(id)
  if (route.params.functionId === id) goList()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu()
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <main class="lc-fnc">
    <nav class="lc-fnc__crumb" aria-label="面包屑">
      <span>逻辑编排</span>
      <span class="lc-fnc__crumb-sep" aria-hidden="true">/</span>
      <span class="lc-fnc__crumb-current" aria-current="page">自定义函数</span>
    </nav>

    <header class="lc-fnc__hero">
      <span class="lc-fnc__hero-icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="26"
          height="26"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M8 6 3 12l5 6" />
          <path d="m16 6 5 6-5 6" />
          <path d="M13.5 4 10.5 20" />
        </svg>
      </span>
      <div class="lc-fnc__hero-text">
        <h1 class="lc-fnc__title">自定义函数</h1>
        <p class="lc-fnc__subtitle">创建和管理自定义函数，供流程、事件、表达式等场景使用</p>
      </div>

      <svg
        class="lc-fnc__art"
        viewBox="0 0 200 140"
        width="180"
        height="126"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="lc-fnc-cube-top" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style="stop-color: var(--lc-accent-bright)" />
            <stop offset="1" style="stop-color: var(--lc-accent)" />
          </linearGradient>
          <linearGradient id="lc-fnc-cube-left" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style="stop-color: var(--lc-accent)" />
            <stop offset="1" style="stop-color: var(--lc-accent-2)" />
          </linearGradient>
          <linearGradient id="lc-fnc-cube-right" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style="stop-color: var(--lc-accent-2-bright)" />
            <stop offset="1" style="stop-color: var(--lc-accent-2)" />
          </linearGradient>
        </defs>

        <ellipse cx="100" cy="116" rx="36" ry="7" fill="var(--lc-accent)" opacity="0.16" />

        <g class="lc-fnc__orbit lc-fnc__orbit--a">
          <ellipse
            cx="100"
            cy="70"
            rx="86"
            ry="26"
            transform="rotate(-16 100 70)"
            fill="none"
            stroke="var(--lc-accent-bright)"
            stroke-opacity="0.35"
            stroke-dasharray="3 6"
          />
          <circle
            cx="186"
            cy="70"
            r="3"
            transform="rotate(-16 100 70)"
            fill="var(--lc-accent-bright)"
          />
        </g>
        <g class="lc-fnc__orbit lc-fnc__orbit--b">
          <ellipse
            cx="100"
            cy="70"
            rx="70"
            ry="34"
            transform="rotate(24 100 70)"
            fill="none"
            stroke="var(--lc-accent-2-bright)"
            stroke-opacity="0.3"
            stroke-dasharray="2 7"
          />
          <circle
            cx="170"
            cy="70"
            r="2.5"
            transform="rotate(24 100 70)"
            fill="var(--lc-accent-2-bright)"
          />
        </g>

        <g class="lc-fnc__cube">
          <polygon points="100,38 132,54 100,70 68,54" fill="url(#lc-fnc-cube-top)" />
          <polygon points="68,54 100,70 100,106 68,90" fill="url(#lc-fnc-cube-left)" />
          <polygon points="132,54 100,70 100,106 132,90" fill="url(#lc-fnc-cube-right)" />
          <path
            d="M68 54 100 70 132 54 M100 70 V106"
            fill="none"
            stroke="var(--lc-on-accent)"
            stroke-opacity="0.35"
          />
          <text
            x="100"
            y="60"
            text-anchor="middle"
            font-size="11"
            font-family="monospace"
            fill="var(--lc-on-accent)"
            opacity="0.92"
          >
            &lt;/&gt;
          </text>
        </g>
      </svg>
    </header>

    <div class="lc-fnc__body">
      <aside class="lc-fnc__list" aria-label="函数列表">
        <div class="lc-fnc__list-head">
          <label class="lc-fnc__search">
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              v-model="search"
              type="search"
              class="lc-fnc__search-input"
              placeholder="搜索函数名称、描述..."
              aria-label="搜索函数名称、描述"
            />
          </label>
          <button type="button" class="lc-fnc__primary" @click="goNew">+ 新建函数</button>
        </div>

        <div class="lc-fnc__chips" role="group" aria-label="按作用域筛选">
          <button
            type="button"
            class="lc-fnc__chip"
            :class="{ 'lc-fnc__chip--on': scopeFilter === 'all' }"
            @click="scopeFilter = 'all'"
          >
            全部 {{ visible.length }}
          </button>
          <button
            v-for="scope in SCOPES"
            :key="scope"
            type="button"
            class="lc-fnc__chip"
            :class="{ 'lc-fnc__chip--on': scopeFilter === scope }"
            @click="scopeFilter = scope"
          >
            {{ SCOPE_LABELS[scope] }} {{ scopeCounts[scope] }}
          </button>
        </div>

        <div v-if="visible.length === 0" class="lc-fnc__empty">
          <span class="lc-fnc__empty-title">这个项目还没有函数</span>
          <span>把跨页面复用的计算逻辑抽成函数，表达式里就能直接调用。</span>
          <button type="button" class="lc-fnc__primary" @click="goNew">创建第一个函数</button>
        </div>
        <div v-else-if="cards.length === 0" class="lc-fnc__empty">
          <span class="lc-fnc__empty-title">没有匹配的函数</span>
          <span>换个关键词，或把作用域筛选切回「全部」。</span>
        </div>

        <ul v-else class="lc-fnc__cards">
          <li
            v-for="(card, index) in cards"
            :key="card.fn.id"
            class="lc-fnc__card"
            :class="{ 'lc-fnc__card--active': !isNewRoute && selected?.id === card.fn.id }"
          >
            <button type="button" class="lc-fnc__card-main" @click="select(card.fn.id)">
              <span
                class="lc-fnc__card-icon"
                :style="{ color: iconColor(index) }"
                aria-hidden="true"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M8 6 3 12l5 6" />
                  <path d="m16 6 5 6-5 6" />
                  <path d="M13.5 4 10.5 20" />
                </svg>
              </span>
              <span class="lc-fnc__card-text">
                <span class="lc-fnc__card-head">
                  <code class="lc-fnc__card-name">{{ card.fn.name }}</code>
                  <span
                    class="lc-fnc__badge"
                    :class="`lc-fnc__badge--${resolveFunctionScope(card.fn.scope)}`"
                    >{{ SCOPE_LABELS[resolveFunctionScope(card.fn.scope)] }}</span
                  >
                </span>
                <span class="lc-fnc__card-desc">{{
                  card.fn.description || card.fn.title || functionBodyText(card.fn)
                }}</span>
                <span class="lc-fnc__card-meta">
                  <span class="lc-fnc__status" :class="`lc-fnc__status--${card.status}`">{{
                    STATUS_LABELS[card.status]
                  }}</span>
                  <span class="lc-fnc__card-time">{{ formatTime(card.fn.updatedAt) }}</span>
                </span>
              </span>
            </button>

            <button
              type="button"
              class="lc-fnc__dots"
              :aria-label="`管理 ${card.fn.name}`"
              :aria-expanded="menuFor === card.fn.id"
              @click="openMenu(card.fn.id)"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="12" cy="5" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="12" cy="19" r="1.8" />
              </svg>
            </button>

            <div v-if="menuFor === card.fn.id" class="lc-fnc__menu" role="menu">
              <template v-if="confirmDeleteId === card.fn.id">
                <p class="lc-fnc__menu-warn">删除后，表达式里对它的调用会失败。</p>
                <button
                  type="button"
                  class="lc-fnc__menu-item lc-fnc__menu-item--danger"
                  role="menuitem"
                  @click="deleteFunction(card.fn.id)"
                >
                  确认删除
                </button>
                <button
                  type="button"
                  class="lc-fnc__menu-item"
                  role="menuitem"
                  @click="confirmDeleteId = null"
                >
                  取消
                </button>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="lc-fnc__menu-item"
                  role="menuitem"
                  @click="duplicateFunction(card.fn)"
                >
                  复制函数
                </button>
                <button
                  type="button"
                  class="lc-fnc__menu-item lc-fnc__menu-item--danger"
                  role="menuitem"
                  @click="confirmDeleteId = card.fn.id"
                >
                  删除函数
                </button>
              </template>
            </div>
          </li>
        </ul>
      </aside>

      <section class="lc-fnc__detail" aria-label="函数编辑区">
        <FunctionDetail
          v-if="activeDraft && (selected !== null || isNewRoute)"
          :key="activeKey"
          :draft="activeDraft"
          :saved="selected"
          :project-id="projectId"
          :engine="engine"
          :taken-names="takenNames"
          :type-options="typeOptions"
          @saved="onSaved"
          @removed="onRemoved"
          @duplicated="onDuplicated"
        />

        <div v-else-if="isMissing" class="lc-fnc__placeholder">
          <span class="lc-fnc__placeholder-title">函数不存在</span>
          <span>它可能已被删除，链接中的 id 不正确，或者归在别的项目里。</span>
          <button type="button" class="lc-fnc__ghost" @click="goList">返回函数列表</button>
        </div>

        <div v-else class="lc-fnc__placeholder">
          <span class="lc-fnc__placeholder-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="30"
              height="30"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M8 6 3 12l5 6" />
              <path d="m16 6 5 6-5 6" />
              <path d="M13.5 4 10.5 20" />
            </svg>
          </span>
          <span class="lc-fnc__placeholder-title">从左侧选择一个函数，或新建一个</span>
          <span>函数保存后立即注册到表达式引擎，所有页面都能按名字调用。</span>
          <button type="button" class="lc-fnc__primary" @click="goNew">+ 新建函数</button>
        </div>
      </section>
    </div>

    <div v-if="menuFor" class="lc-fnc__backdrop" @click="closeMenu"></div>
  </main>
</template>

<style scoped>
.lc-fnc {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 22px 28px 26px;
  overflow: hidden;
}

/* ---------------------------------------------------------------------------
   面包屑 + 横幅
---------------------------------------------------------------------------- */

.lc-fnc__crumb {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  color: var(--lc-text-muted);
  font-size: 12px;
}

.lc-fnc__crumb-sep {
  opacity: 0.6;
}

.lc-fnc__crumb-current {
  color: var(--lc-text-secondary);
}

.lc-fnc__hero {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  gap: 18px;
  padding: 20px 26px;
  overflow: hidden;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background:
    radial-gradient(560px 200px at 12% -40%, var(--lc-accent-soft), transparent 70%),
    radial-gradient(480px 220px at 88% 140%, var(--lc-accent-2-soft), transparent 72%),
    linear-gradient(150deg, var(--lc-surface-raised), var(--lc-surface-sunken));
}

/* 细网格底纹：只留在横幅里，呼应设计器的工程感 */
.lc-fnc__hero::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(var(--lc-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--lc-grid) 1px, transparent 1px);
  background-size: 26px 26px;
  mask-image: radial-gradient(420px 160px at 70% 50%, black, transparent 78%);
  opacity: 0.5;
}

.lc-fnc__hero-icon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border: 1px solid var(--lc-accent);
  border-radius: 14px;
  background: linear-gradient(
    135deg,
    var(--lc-accent-bright),
    var(--lc-accent) 55%,
    var(--lc-accent-2)
  );
  box-shadow:
    0 0 24px var(--lc-glow),
    inset 0 1px 0 rgba(255, 255, 255, 0.25);
  color: var(--lc-on-accent);
}

.lc-fnc__hero-text {
  position: relative;
  z-index: 1;
  min-width: 0;
}

.lc-fnc__title {
  margin: 0 0 6px;
  color: var(--lc-text);
  font-size: 22px;
  font-weight: 650;
  letter-spacing: 0.5px;
}

.lc-fnc__subtitle {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.lc-fnc__art {
  position: relative;
  z-index: 1;
  flex: none;
  margin-left: auto;
}

.lc-fnc__orbit {
  transform-box: view-box;
  transform-origin: 100px 70px;
  animation: lc-fnc-orbit 26s linear infinite;
}

.lc-fnc__orbit--b {
  animation-duration: 38s;
  animation-direction: reverse;
}

.lc-fnc__cube {
  transform-box: view-box;
  transform-origin: 100px 70px;
  animation: lc-fnc-float 6s ease-in-out infinite;
}

@keyframes lc-fnc-orbit {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@keyframes lc-fnc-float {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(-5px);
  }
}

/* ---------------------------------------------------------------------------
   主体两栏
---------------------------------------------------------------------------- */

.lc-fnc__body {
  display: grid;
  flex: 1;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
  min-height: 0;
}

.lc-fnc__list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(165deg, var(--lc-surface), var(--lc-surface-sunken));
}

.lc-fnc__list-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 8px;
}

.lc-fnc__search {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  transition: border-color 0.15s ease;
}

.lc-fnc__search:focus-within {
  border-color: var(--lc-accent);
  box-shadow: 0 0 0 2px var(--lc-accent-soft);
}

.lc-fnc__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.lc-fnc__search-input::placeholder {
  color: var(--lc-text-muted);
}

.lc-fnc__primary {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 32px;
  padding: 0 13px;
  border: 1px solid var(--lc-accent);
  border-radius: var(--lc-radius-sm);
  background: linear-gradient(
    135deg,
    var(--lc-accent-bright),
    var(--lc-accent) 52%,
    var(--lc-accent-2)
  );
  box-shadow: 0 0 16px var(--lc-glow-soft);
  color: var(--lc-on-accent);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.15s ease;
}

.lc-fnc__primary:hover {
  border-color: var(--lc-accent-bright);
  box-shadow: 0 0 22px var(--lc-glow);
  transform: translateY(-1px);
}

.lc-fnc__chips {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 12px 10px;
}

.lc-fnc__chip {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  background: transparent;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.lc-fnc__chip:hover {
  border-color: var(--lc-border-strong);
  color: var(--lc-text);
}

.lc-fnc__chip--on {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
  font-weight: 600;
}

.lc-fnc__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: 6px 12px 14px;
  padding: 30px 16px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-md);
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

.lc-fnc__empty-title {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

/* ---------------------------------------------------------------------------
   函数卡片
---------------------------------------------------------------------------- */

.lc-fnc__cards {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  margin: 0;
  padding: 2px 12px 14px;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-fnc__cards::-webkit-scrollbar {
  width: 8px;
}

.lc-fnc__cards::-webkit-scrollbar-track {
  background: transparent;
}

.lc-fnc__cards::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: var(--lc-border-strong);
}

.lc-fnc__cards::-webkit-scrollbar-thumb:hover {
  background: var(--lc-accent);
}

.lc-fnc__card {
  position: relative;
  flex: none;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(150deg, var(--lc-surface-raised), var(--lc-surface));
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    background 0.18s ease;
}

.lc-fnc__card:hover {
  border-color: var(--lc-border-strong);
}

.lc-fnc__card--active,
.lc-fnc__card--active:hover {
  border-color: var(--lc-accent);
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--lc-accent) 12%, var(--lc-surface-raised)),
    var(--lc-surface)
  );
  box-shadow:
    0 0 0 1px var(--lc-accent-soft),
    0 0 22px var(--lc-glow-soft);
}

.lc-fnc__card-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 11px 30px 11px 12px;
  border: none;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.lc-fnc__card-icon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin-top: 1px;
  border: 1px solid var(--lc-border);
  border-radius: 8px;
  background: var(--lc-surface-sunken);
}

.lc-fnc__card--active .lc-fnc__card-icon {
  border-color: var(--lc-accent);
  box-shadow: 0 0 10px var(--lc-glow-soft);
}

.lc-fnc__card-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.lc-fnc__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.lc-fnc__card-name {
  overflow: hidden;
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-fnc__card--active .lc-fnc__card-name {
  color: var(--lc-accent-bright);
}

.lc-fnc__badge {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.6;
}

.lc-fnc__badge--global {
  background: color-mix(in srgb, var(--lc-success) 16%, transparent);
  color: var(--lc-success);
}

.lc-fnc__badge--page {
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-fnc__badge--private {
  background: color-mix(in srgb, var(--lc-warning) 16%, transparent);
  color: var(--lc-warning);
}

.lc-fnc__card-desc {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  color: var(--lc-text-secondary);
  font-size: 11.5px;
  line-height: 1.5;
}

.lc-fnc__card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.lc-fnc__status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
}

.lc-fnc__status::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.lc-fnc__status--published {
  color: var(--lc-success);
}

.lc-fnc__status--modified {
  color: var(--lc-warning);
}

.lc-fnc__status--draft {
  color: var(--lc-text-muted);
}

.lc-fnc__card-time {
  overflow: hidden;
  color: var(--lc-text-muted);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-fnc__dots {
  position: absolute;
  top: 8px;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--lc-text-muted);
  opacity: 0.65;
  cursor: pointer;
  transition:
    opacity 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.lc-fnc__card:hover .lc-fnc__dots,
.lc-fnc__dots:focus-visible,
.lc-fnc__dots[aria-expanded='true'] {
  opacity: 1;
}

.lc-fnc__dots:hover {
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-fnc__menu {
  position: absolute;
  top: 34px;
  right: 6px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  min-width: 150px;
  padding: 4px;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-raised);
  box-shadow: var(--lc-shadow);
}

.lc-fnc__menu-warn {
  margin: 0;
  padding: 6px 10px 4px;
  color: var(--lc-warning);
  font-size: 11px;
  line-height: 1.5;
}

.lc-fnc__menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

.lc-fnc__menu-item:hover {
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-fnc__menu-item--danger {
  color: var(--lc-danger);
}

.lc-fnc__menu-item--danger:hover {
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-fnc__backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}

/* ---------------------------------------------------------------------------
   右侧编辑区
---------------------------------------------------------------------------- */

.lc-fnc__detail {
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(165deg, var(--lc-surface), var(--lc-surface-sunken));
}

.lc-fnc__placeholder {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 28px;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
}

.lc-fnc__placeholder-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  margin-bottom: 4px;
  border: 1px dashed var(--lc-border-strong);
  border-radius: 16px;
  background: var(--lc-surface-sunken);
  color: var(--lc-accent-bright);
}

.lc-fnc__placeholder-title {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-fnc__ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  margin-top: 6px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.lc-fnc__ghost:hover {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-fnc :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

/* ---------------------------------------------------------------------------
   响应式
---------------------------------------------------------------------------- */

@media (max-width: 1100px) {
  .lc-fnc__body {
    grid-template-columns: 280px minmax(0, 1fr);
  }

  .lc-fnc__art {
    width: 140px;
    height: 98px;
  }
}

@media (max-width: 900px) {
  .lc-fnc {
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--lc-border-strong) transparent;
  }

  .lc-fnc__body {
    grid-template-columns: minmax(0, 1fr);
  }

  .lc-fnc__list {
    max-height: 360px;
  }

  .lc-fnc__detail {
    min-height: 540px;
  }

  .lc-fnc__art {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-fnc__orbit,
  .lc-fnc__cube {
    animation: none;
  }

  .lc-fnc__primary,
  .lc-fnc__chip,
  .lc-fnc__card,
  .lc-fnc__dots,
  .lc-fnc__menu-item,
  .lc-fnc__ghost,
  .lc-fnc__search {
    transition: none;
  }
}
</style>
