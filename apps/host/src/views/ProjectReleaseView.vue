<script setup lang="ts">
import { computed, defineComponent, h, onMounted, onUnmounted, ref, watch } from 'vue'
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
import { listDeployOf } from '../projects/release-deploy-log'
import type { DeployRecord } from '../projects/release-deploy-log'
import { ASSET_KIND_LABELS, assetSummary, diffReleaseAssets } from '../projects/release-diff'
import type { ReleaseChange, ReleaseChangeKind } from '../projects/release-diff'
import { getProject, onProjectsChange, countAssetsOf } from '../projects/project-store'
import { useAssetStoreVersion } from '../projects/use-asset-store-version'
import { toastService } from '../toast'
import FilterSelect from '../components/common/FilterSelect.vue'
import type { FilterSelectOption } from '../components/common/filter-select'
import EmptyState from '../components/common/EmptyState.vue'
import ReleasePreview from '../components/releases/ReleasePreview.vue'
import ReleaseSourceDialog from '../components/releases/ReleaseSourceDialog.vue'

/**
 * 项目版本管理页。
 *
 * 布局对齐控制台视觉稿：顶部应用信息卡（当前版本 / 发布时间 / 发布人 / 发布新版本），
 * 左侧版本历史（筛选 + 选中 + 行内菜单），右侧四页签（版本详情 / 变更记录 / 对比记录 /
 * 部署记录）。所有读数来自 release-store 的不可变快照：发布 = 校验 + 冻结 + 移指针，
 * 回滚只移指针；变更记录与对比记录是两份快照的资产级 diff，部署记录是指针移动的留痕。
 */

const route = useRoute()
const projectId = String(route.params.projectId)

const version = ref(0)
const bump = (): void => {
  version.value += 1
}

// 资产变了要重算校验清单，指针与快照变了要重算版本表
const assetVersion = useAssetStoreVersion()
const disposables = [onReleasesChange(bump), onProjectsChange(bump)]

const project = computed(() => {
  version.value
  return getProject(projectId)
})

const history = computed<readonly ProjectRelease[]>(() => {
  version.value
  assetVersion.value
  return [...listReleasesOf(projectId)].sort((a, b) => b.revision - a.revision)
})

const current = computed<ProjectRelease | undefined>(() => {
  version.value
  assetVersion.value
  return currentReleaseOf(projectId)
})

const issues = computed<ValidationIssue[]>(() => {
  version.value
  assetVersion.value
  return checkProjectRelease(projectId)
})

const blockers = computed(() => issues.value.filter((issue) => issue.severity === 'error'))
const notices = computed(() => issues.value.filter((issue) => issue.severity === 'warning'))
const canPublish = computed(() => blockers.value.length === 0)

/** 当前草稿的五类计数，发布弹框里说明「这次会冻结什么」 */
const draftCounts = computed(() => {
  version.value
  assetVersion.value
  return countAssetsOf(projectId)
})

/* ── 选中与历史筛选 ─────────────────────────────────────────────────────── */

const selectedRevision = ref<number | null>(null)

const selected = computed<ProjectRelease | undefined>(
  () =>
    history.value.find((item) => item.revision === selectedRevision.value) ?? history.value[0],
)

/** 选中版本的上一份快照；变更记录的基线，首版本时为 undefined */
const previous = computed<ProjectRelease | undefined>(() => {
  const target = selected.value
  if (!target) return undefined
  return history.value.find((item) => item.revision < target.revision)
})

const filter = ref<string>('all')

const FILTER_OPTIONS: readonly FilterSelectOption[] = [
  { value: 'all', label: '全部版本' },
  { value: 'live', label: '线上版本' },
  { value: 'archived', label: '历史版本' },
]

const filteredHistory = computed(() => {
  if (filter.value === 'live') {
    return history.value.filter((item) => item.revision === current.value?.revision)
  }
  if (filter.value === 'archived') {
    return history.value.filter((item) => item.revision !== current.value?.revision)
  }
  return history.value
})

function select(revision: number): void {
  selectedRevision.value = revision
  activeTab.value = 'detail'
  menuFor.value = null
}

function summaryOf(release: ProjectRelease): string {
  return release.note ?? assetSummary(release.assets)
}

function publisherOf(release: ProjectRelease): string {
  return release.publishedBy ?? '本地用户'
}

/* ── 页签与变更分组 ─────────────────────────────────────────────────────── */

type DetailTab = 'detail' | 'changes' | 'compare' | 'deploy'

const activeTab = ref<DetailTab>('detail')

const TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: 'detail', label: '版本详情' },
  { id: 'changes', label: '变更记录' },
  { id: 'compare', label: '对比记录' },
  { id: 'deploy', label: '部署记录' },
]

const CHANGE_GROUPS: ReadonlyArray<{ change: ReleaseChangeKind; label: string }> = [
  { change: 'added', label: '新增内容' },
  { change: 'modified', label: '修改内容' },
  { change: 'removed', label: '移除内容' },
]

const CHANGE_LABELS: Readonly<Record<ReleaseChangeKind, string>> = {
  added: '新增',
  modified: '修改',
  removed: '移除',
}

const changes = computed<ReleaseChange[]>(() =>
  selected.value ? diffReleaseAssets(previous.value?.assets, selected.value.assets) : [],
)

const changeGroups = computed(() =>
  CHANGE_GROUPS.map((group) => ({
    ...group,
    items: changes.value.filter((item) => item.change === group.change),
  })).filter((group) => group.items.length > 0),
)

const expanded = ref(false)

/** 详情侧栏默认每组只露三条，展开全部后看全量 */
function visibleItems(items: readonly ReleaseChange[]): readonly ReleaseChange[] {
  return expanded.value ? items : items.slice(0, 3)
}

/* ── 对比记录 ───────────────────────────────────────────────────────────── */

const compareBase = ref('none')
const compareTarget = ref('')

const baseOptions = computed<readonly FilterSelectOption[]>(() => [
  { value: 'none', label: '空基线（初始内容）' },
  ...history.value.map((item) => ({
    value: String(item.revision),
    label: `v${item.revision}`,
  })),
])

const targetOptions = computed<readonly FilterSelectOption[]>(() =>
  history.value.map((item) => ({ value: String(item.revision), label: `v${item.revision}` })),
)

const compareFrom = computed<ProjectRelease | undefined>(() =>
  compareBase.value === 'none'
    ? undefined
    : history.value.find((item) => String(item.revision) === compareBase.value),
)

const compareTo = computed<ProjectRelease | undefined>(
  () =>
    history.value.find((item) => String(item.revision) === compareTarget.value) ??
    selected.value,
)

const compareChanges = computed<ReleaseChange[]>(() =>
  compareTo.value ? diffReleaseAssets(compareFrom.value?.assets, compareTo.value.assets) : [],
)

// 快照被剪枝或首次进入时，把对比两端落到真实存在的版本上
watch(
  history,
  (list) => {
    if (list.length === 0) return
    if (list.some((item) => String(item.revision) === compareTarget.value)) return

    compareTarget.value = String(selected.value?.revision ?? list[0].revision)
    compareBase.value = previous.value ? String(previous.value.revision) : 'none'
  },
  { immediate: true },
)

function openCompare(revision: number): void {
  const base = history.value.find((item) => item.revision < revision)
  compareTarget.value = String(revision)
  compareBase.value = base ? String(base.revision) : 'none'
  activeTab.value = 'compare'
  menuFor.value = null
}

function swapCompare(): void {
  if (compareBase.value === 'none') return
  const base = compareBase.value
  compareBase.value = compareTarget.value
  compareTarget.value = base
}

/* ── 部署记录 / 预览 / 弹层 ─────────────────────────────────────────────── */

const deployRecords = computed<DeployRecord[]>(() => {
  version.value
  return listDeployOf(projectId)
})

const previewPageId = ref('')

const previewPage = computed(() => {
  const pages = selected.value?.assets.pages ?? []
  return pages.find((item) => item.id === previewPageId.value) ?? pages[0]
})

const sourceFor = ref<ProjectRelease | null>(null)

const publishOpen = ref(false)
const publishNote = ref('')

function openPublish(): void {
  publishNote.value = ''
  publishOpen.value = true
}

function confirmPublish(): void {
  try {
    const created = publishProject(projectId, { note: publishNote.value })
    selectedRevision.value = created.revision
    activeTab.value = 'detail'
    publishOpen.value = false
    toastService.show(`已发布 v${created.revision}`, 'success')
  } catch (cause) {
    toastService.show(messageOf(cause), 'error')
  }
}

function rollback(revision: number): void {
  menuFor.value = null
  try {
    setCurrentRelease(projectId, revision)
    toastService.show(`线上版本已切到 v${revision}`, 'success')
  } catch (cause) {
    toastService.show(messageOf(cause), 'error')
  }
}

/* ── 行内菜单 ───────────────────────────────────────────────────────────── */

const menuFor = ref<number | null>(null)

function toggleMenu(revision: number): void {
  menuFor.value = menuFor.value === revision ? null : revision
}

function openSource(release: ProjectRelease): void {
  sourceFor.value = release
  menuFor.value = null
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (menuFor.value === null) return
  const target = event.target
  if (target instanceof Element && target.closest('.lc-vm__menu, .lc-vm__dots')) return
  menuFor.value = null
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') menuFor.value = null
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeydown)
  for (const disposable of disposables.splice(0)) disposable.dispose()
})

/* ── 展示工具 ───────────────────────────────────────────────────────────── */

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const ICON_PATHS: Readonly<Record<string, string>> = {
  app: 'M2.5 2.5h4.5v4.5H2.5z M9 2.5h4.5v4.5H9z M2.5 9h4.5v4.5H2.5z M9 9h4.5v4.5H9z',
  send: 'M14 2L7.5 8.5 M14 2L9.5 14L7.5 8.5L2 6.5L14 2',
  calendar: 'M2.5 4h11v9.5h-11z M2.5 7h11 M5.5 2.5v3 M10.5 2.5v3',
  user: 'M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M3 13.5c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5',
  note: 'M3.5 2.5h9v11h-9z M6 5.5h4 M6 8h4 M6 10.5h2.5',
  rollback: 'M3 6.5h7a3.5 3.5 0 0 1 0 7H6 M3 6.5L6 3.5 M3 6.5L6 9.5',
  compare: 'M2.5 3h4.5v10H2.5z M9 3h4.5v10H9z',
  code: 'M5.5 4.5L2 8l3.5 3.5 M10.5 4.5L14 8l-3.5 3.5',
  dots: 'M3.5 8h.01 M8 8h.01 M12.5 8h.01',
  check: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M5.5 8l2 2 3.5-3.5',
  box: 'M8 2l5.5 3v6L8 14l-5.5-3V5z M8 8l5.5-3 M8 8L2.5 5 M8 8v6',
  layers: 'M8 2.5l6 3-6 3-6-3z M2 10.5l6 3 6-3',
  clock: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M8 5v3l2.5 1.5',
  swap: 'M3 5.5h9 M12 5.5L9.5 3 M12 5.5L9.5 8 M13 10.5H4 M4 10.5L6.5 8 M4 10.5L6.5 13',
}

/** 页内共用的小图标：单 path 描边风格，颜色跟随 currentColor */
const VmIcon = defineComponent({
  name: 'VmIcon',
  props: { name: { type: String, required: true } },
  setup(iconProps) {
    return () =>
      h('svg', { viewBox: '0 0 16 16', class: 'lc-vm__icon', 'aria-hidden': 'true' }, [
        h('path', {
          d: ICON_PATHS[iconProps.name],
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.4,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      ])
  },
})
</script>

<template>
  <main class="lc-vm">
    <!-- 应用信息头卡 -->
    <section class="lc-vm__hero">
      <div class="lc-vm__app">
        <span class="lc-vm__app-icon" aria-hidden="true"><VmIcon name="app" /></span>
        <div class="lc-vm__app-text">
          <div class="lc-vm__app-line">
            <h1 class="lc-vm__app-name">{{ project?.name ?? '项目' }}</h1>
            <span
              class="lc-vm__badge"
              :class="current ? 'lc-vm__badge--live' : 'lc-vm__badge--none'"
            >
              {{ current ? '已发布' : '未发布' }}
            </span>
            <button
              v-if="blockers.length > 0"
              type="button"
              class="lc-vm__blockers"
              title="查看发布检查清单"
              @click="openPublish"
            >
              {{ blockers.length }} 处阻断
            </button>
          </div>
          <p class="lc-vm__app-desc">
            {{
              project?.description ||
              '面向企业的低代码应用，页面、流程、函数、组件与接口在此定版发布。'
            }}
          </p>
        </div>
      </div>

      <div class="lc-vm__stats">
        <div class="lc-vm__stat">
          <span class="lc-vm__stat-label">当前版本</span>
          <strong class="lc-vm__stat-value">
            {{ current ? `v${current.revision}` : '—' }}
          </strong>
        </div>
        <div class="lc-vm__stat">
          <span class="lc-vm__stat-label">发布时间</span>
          <strong class="lc-vm__stat-value lc-vm__stat-value--small">
            {{ current ? formatTime(current.createdAt) : '—' }}
          </strong>
        </div>
        <div class="lc-vm__stat">
          <span class="lc-vm__stat-label">发布人</span>
          <strong class="lc-vm__stat-value lc-vm__stat-value--small">
            {{ current ? publisherOf(current) : '—' }}
          </strong>
        </div>
        <button
          type="button"
          class="lc-vm__primary"
          :disabled="!canPublish"
          :title="canPublish ? '校验通过，发布为新版本' : '存在阻断问题，点击查看清单'"
          @click="openPublish"
        >
          <VmIcon name="send" />
          发布新版本
        </button>
      </div>
    </section>

    <div class="lc-vm__body">
      <!-- 版本历史 -->
      <aside class="lc-vm__history">
        <header class="lc-vm__history-head">
          <span class="lc-vm__history-title">版本历史</span>
          <span class="lc-vm__count">{{ history.length }}</span>
          <div class="lc-vm__filter">
            <FilterSelect v-model="filter" :options="FILTER_OPTIONS" aria-label="筛选版本" />
          </div>
        </header>

        <ul v-if="filteredHistory.length > 0" class="lc-vm__list">
          <li v-for="item in filteredHistory" :key="item.revision">
            <article
              class="lc-vm__card"
              :class="{ 'lc-vm__card--active': selected?.revision === item.revision }"
            >
              <button type="button" class="lc-vm__card-main" @click="select(item.revision)">
                <span class="lc-vm__card-line">
                  <span
                    class="lc-vm__dot"
                    :class="{
                      'lc-vm__dot--live': item.revision === current?.revision,
                    }"
                    aria-hidden="true"
                  />
                  <span class="lc-vm__rev">v{{ item.revision }}</span>
                  <span
                    class="lc-vm__badge"
                    :class="
                      item.revision === current?.revision
                        ? 'lc-vm__badge--live'
                        : 'lc-vm__badge--archived'
                    "
                  >
                    {{ item.revision === current?.revision ? '线上' : '已发布' }}
                  </span>
                  <span v-if="item.revision === current?.revision" class="lc-vm__current-tag">
                    当前版本
                  </span>
                </span>
                <span class="lc-vm__card-summary">{{ summaryOf(item) }}</span>
                <span class="lc-vm__card-meta">
                  <span class="lc-vm__avatar" aria-hidden="true">
                    {{ publisherOf(item).slice(0, 1) }}
                  </span>
                  <span class="lc-vm__by">{{ publisherOf(item) }}</span>
                  <span class="lc-vm__time">{{ formatTime(item.createdAt) }}</span>
                </span>
              </button>

              <button
                type="button"
                class="lc-vm__dots"
                :aria-label="`v${item.revision} 更多操作`"
                @click="toggleMenu(item.revision)"
              >
                <VmIcon name="dots" />
              </button>

              <div v-if="menuFor === item.revision" class="lc-vm__menu" role="menu">
                <button type="button" role="menuitem" @click="select(item.revision)">
                  查看详情
                </button>
                <button type="button" role="menuitem" @click="openCompare(item.revision)">
                  对比版本
                </button>
                <button type="button" role="menuitem" @click="openSource(item)">
                  查看源码
                </button>
                <button
                  v-if="item.revision !== current?.revision"
                  type="button"
                  role="menuitem"
                  @click="rollback(item.revision)"
                >
                  切到此版本
                </button>
              </div>
            </article>
          </li>
        </ul>
        <EmptyState
          v-else
          title="还没有版本"
          description="发布一次项目，这里就会出现第一份不可变快照。"
        />

        <footer class="lc-vm__history-foot">每个项目保留最近 5 份快照，更旧的自动剪枝</footer>
      </aside>

      <!-- 详情区 -->
      <section class="lc-vm__detail">
        <nav class="lc-vm__tabs" role="tablist" aria-label="版本详情分区">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            type="button"
            role="tab"
            class="lc-vm__tab"
            :class="{ 'lc-vm__tab--active': activeTab === tab.id }"
            :aria-selected="activeTab === tab.id"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </nav>

        <EmptyState
          v-if="!selected"
          title="暂无版本详情"
          description="发布新版本后，这里展示快照详情、变更与部署留痕。"
        >
          <template #actions>
            <button
              type="button"
              class="lc-vm__primary"
              :disabled="!canPublish"
              @click="openPublish"
            >
              <VmIcon name="send" />
              发布新版本
            </button>
          </template>
        </EmptyState>

        <template v-else>
          <!-- 版本详情 -->
          <div v-if="activeTab === 'detail'" class="lc-vm__panel" role="tabpanel">
            <header class="lc-vm__detail-head">
              <span class="lc-vm__detail-title">
                <span
                  class="lc-vm__dot"
                  :class="{ 'lc-vm__dot--live': selected.revision === current?.revision }"
                  aria-hidden="true"
                />
                v{{ selected.revision }}
                <span
                  class="lc-vm__badge"
                  :class="
                    selected.revision === current?.revision
                      ? 'lc-vm__badge--live'
                      : 'lc-vm__badge--archived'
                  "
                >
                  {{ selected.revision === current?.revision ? '线上' : '已发布' }}
                </span>
              </span>
              <span class="lc-vm__actions">
                <button
                  type="button"
                  class="lc-vm__button"
                  :disabled="selected.revision === current?.revision"
                  :title="
                    selected.revision === current?.revision
                      ? '当前线上版本无需回滚'
                      : '把线上指针切到该版本，不改草稿'
                  "
                  @click="rollback(selected.revision)"
                >
                  <VmIcon name="rollback" />
                  回滚版本
                </button>
                <button
                  type="button"
                  class="lc-vm__button"
                  @click="openCompare(selected.revision)"
                >
                  <VmIcon name="compare" />
                  对比版本
                </button>
                <button type="button" class="lc-vm__button" @click="sourceFor = selected">
                  <VmIcon name="code" />
                  查看源码
                </button>
              </span>
            </header>

            <p class="lc-vm__summary">{{ summaryOf(selected) }}</p>

            <div class="lc-vm__meta">
              <span class="lc-vm__meta-item">
                <VmIcon name="calendar" />
                <span class="lc-vm__meta-label">发布时间</span>
                <span class="lc-vm__meta-value">{{ formatTime(selected.createdAt) }}</span>
              </span>
              <span class="lc-vm__meta-item">
                <VmIcon name="user" />
                <span class="lc-vm__meta-label">发布人</span>
                <span class="lc-vm__meta-value">{{ publisherOf(selected) }}</span>
              </span>
              <span class="lc-vm__meta-item">
                <VmIcon name="note" />
                <span class="lc-vm__meta-label">备注</span>
                <span class="lc-vm__meta-value">{{ selected.note ?? '无备注' }}</span>
              </span>
            </div>

            <div class="lc-vm__content">
              <div class="lc-vm__preview-col">
                <ReleasePreview
                  v-if="previewPage"
                  :key="`${selected.revision}:${previewPage.id}`"
                  :page="previewPage"
                  :revision="selected.revision"
                  :environment="selected.assets.environment"
                />
                <div v-else class="lc-vm__preview-empty">该快照没有页面，无可预览内容</div>
                <div v-if="selected.assets.pages.length > 1" class="lc-vm__page-chips">
                  <button
                    v-for="page in selected.assets.pages"
                    :key="page.id"
                    type="button"
                    class="lc-vm__chip"
                    :class="{ 'lc-vm__chip--active': previewPage?.id === page.id }"
                    @click="previewPageId = page.id"
                  >
                    {{ page.title }}
                  </button>
                </div>
              </div>

              <aside class="lc-vm__changes">
                <header class="lc-vm__changes-head">
                  <span>变更内容</span>
                  <button type="button" class="lc-vm__link" @click="expanded = !expanded">
                    {{ expanded ? '收起' : '展开全部' }}
                  </button>
                </header>
                <p v-if="changeGroups.length === 0" class="lc-vm__changes-empty">
                  与上一版本内容一致，无资产级变更。
                </p>
                <div
                  v-for="group in changeGroups"
                  :key="group.change"
                  class="lc-vm__change-group"
                >
                  <span class="lc-vm__change-title">
                    <span class="lc-vm__change-dot" aria-hidden="true" />
                    {{ group.label }}
                  </span>
                  <ul class="lc-vm__change-list">
                    <li
                      v-for="item in visibleItems(group.items)"
                      :key="`${item.kind}-${item.id}`"
                    >
                      {{ ASSET_KIND_LABELS[item.kind] }} · {{ item.label }}
                    </li>
                  </ul>
                  <button
                    v-if="!expanded && group.items.length > 3"
                    type="button"
                    class="lc-vm__link"
                    @click="expanded = true"
                  >
                    还有 {{ group.items.length - 3 }} 条…
                  </button>
                </div>
              </aside>
            </div>

            <section class="lc-vm__related">
              <h2 class="lc-vm__related-title">相关信息</h2>
              <div class="lc-vm__related-grid">
                <span class="lc-vm__related-item">
                  <VmIcon name="box" />
                  <span class="lc-vm__related-label">所属应用</span>
                  <span class="lc-vm__related-value">{{ project?.name }}</span>
                </span>
                <span class="lc-vm__related-item">
                  <VmIcon name="layers" />
                  <span class="lc-vm__related-label">发布环境</span>
                  <span class="lc-vm__related-value">
                    {{ selected.assets.environment?.name ?? '默认环境' }}
                  </span>
                </span>
                <span class="lc-vm__related-item">
                  <VmIcon name="clock" />
                  <span class="lc-vm__related-label">部署时间</span>
                  <span class="lc-vm__related-value">{{ formatTime(selected.createdAt) }}</span>
                </span>
                <span class="lc-vm__related-item">
                  <VmIcon name="check" />
                  <span class="lc-vm__related-label">部署状态</span>
                  <span
                    class="lc-vm__related-value"
                    :class="{
                      'lc-vm__related-value--live': selected.revision === current?.revision,
                    }"
                  >
                    {{ selected.revision === current?.revision ? '线上运行' : '已归档快照' }}
                  </span>
                </span>
              </div>
            </section>
          </div>

          <!-- 变更记录 -->
          <div v-else-if="activeTab === 'changes'" class="lc-vm__panel" role="tabpanel">
            <header class="lc-vm__panel-head">
              <span class="lc-vm__panel-title">
                {{
                  previous
                    ? `v${previous.revision} → v${selected.revision}`
                    : `v${selected.revision} · 首个版本`
                }}
              </span>
              <span class="lc-vm__panel-hint">相对上一份快照的资产级差异</span>
            </header>
            <p v-if="changes.length === 0" class="lc-vm__changes-empty">
              两份快照内容一致，没有资产级变更。
            </p>
            <ul v-else class="lc-vm__diff-list">
              <li v-for="item in changes" :key="`${item.kind}-${item.change}-${item.id}`">
                <span class="lc-vm__diff-tag" :class="`lc-vm__diff-tag--${item.change}`">
                  {{ CHANGE_LABELS[item.change] }}
                </span>
                <span class="lc-vm__diff-kind">{{ ASSET_KIND_LABELS[item.kind] }}</span>
                <span class="lc-vm__diff-label">{{ item.label }}</span>
                <code class="lc-vm__diff-id">{{ item.id }}</code>
              </li>
            </ul>
          </div>

          <!-- 对比记录 -->
          <div v-else-if="activeTab === 'compare'" class="lc-vm__panel" role="tabpanel">
            <header class="lc-vm__panel-head">
              <span class="lc-vm__panel-title">对比版本</span>
              <span class="lc-vm__panel-hint">任选两份快照比较资产差异</span>
            </header>
            <div class="lc-vm__compare-bar">
              <div class="lc-vm__compare-field">
                <span class="lc-vm__compare-label">基线</span>
                <FilterSelect
                  v-model="compareBase"
                  :options="baseOptions"
                  aria-label="基线版本"
                />
              </div>
              <button
                type="button"
                class="lc-vm__button"
                :disabled="compareBase === 'none'"
                title="交换基线与目标"
                @click="swapCompare"
              >
                <VmIcon name="swap" />
              </button>
              <div class="lc-vm__compare-field">
                <span class="lc-vm__compare-label">目标</span>
                <FilterSelect
                  v-model="compareTarget"
                  :options="targetOptions"
                  aria-label="目标版本"
                />
              </div>
            </div>
            <p v-if="compareChanges.length === 0" class="lc-vm__changes-empty">
              两份快照内容一致，没有资产级变更。
            </p>
            <ul v-else class="lc-vm__diff-list">
              <li
                v-for="item in compareChanges"
                :key="`${item.kind}-${item.change}-${item.id}`"
              >
                <span class="lc-vm__diff-tag" :class="`lc-vm__diff-tag--${item.change}`">
                  {{ CHANGE_LABELS[item.change] }}
                </span>
                <span class="lc-vm__diff-kind">{{ ASSET_KIND_LABELS[item.kind] }}</span>
                <span class="lc-vm__diff-label">{{ item.label }}</span>
                <code class="lc-vm__diff-id">{{ item.id }}</code>
              </li>
            </ul>
          </div>

          <!-- 部署记录 -->
          <div v-else class="lc-vm__panel" role="tabpanel">
            <header class="lc-vm__panel-head">
              <span class="lc-vm__panel-title">部署记录</span>
              <span class="lc-vm__panel-hint">发布与回滚的指针移动留痕</span>
            </header>
            <p v-if="deployRecords.length === 0" class="lc-vm__changes-empty">
              还没有部署留痕，发布或回滚一次即可记录。
            </p>
            <ul v-else class="lc-vm__deploy-list">
              <li v-for="(record, index) in deployRecords" :key="`${record.at}-${index}`">
                <span
                  class="lc-vm__deploy-icon"
                  :class="`lc-vm__deploy-icon--${record.kind}`"
                  aria-hidden="true"
                >
                  <VmIcon :name="record.kind === 'publish' ? 'send' : 'rollback'" />
                </span>
                <span class="lc-vm__deploy-text">
                  {{
                    record.kind === 'publish'
                      ? `发布 v${record.revision} 并上线`
                      : `线上回滚到 v${record.revision}`
                  }}
                </span>
                <span class="lc-vm__deploy-by">{{ record.by }}</span>
                <span class="lc-vm__deploy-time">{{ formatTime(record.at) }}</span>
              </li>
            </ul>
          </div>
        </template>
      </section>
    </div>

    <!-- 发布弹层：备注 + 发布检查 -->
    <Teleport to="body">
      <div v-if="publishOpen" class="lc-vm__scrim" @click.self="publishOpen = false">
        <section class="lc-vm__dialog" role="dialog" aria-modal="true" aria-label="发布新版本">
          <header class="lc-vm__dialog-head">
            <span class="lc-vm__dialog-title">发布新版本</span>
            <button
              type="button"
              class="lc-vm__button"
              aria-label="关闭发布弹层"
              @click="publishOpen = false"
            >
              关闭
            </button>
          </header>

          <div class="lc-vm__dialog-body">
            <p class="lc-vm__dialog-hint">
              将冻结当前内容：{{ draftCounts.pages }} 个页面 · {{ draftCounts.flows }} 条流程 ·
              {{ draftCounts.functions }} 个函数 · {{ draftCounts.components }} 个组件 ·
              {{ draftCounts.apis }} 个接口。发布后线上指针移到新版本，回滚只切指针、不改草稿。
            </p>

            <label class="lc-vm__field">
              <span class="lc-vm__field-label">发布备注（可选）</span>
              <textarea
                v-model="publishNote"
                rows="3"
                placeholder="例如：优化商品详情页布局，提升用户体验"
              />
            </label>

            <div class="lc-vm__check">
              <span class="lc-vm__check-title">
                发布检查（{{ blockers.length }} 处阻断 · {{ notices.length }} 条提示）
              </span>
              <p v-if="issues.length === 0" class="lc-vm__check-ok">校验通过，可以发布。</p>
              <ul v-else class="lc-vm__check-list">
                <li
                  v-for="(issue, index) in issues"
                  :key="`${issue.path}-${index}`"
                  :class="`lc-vm__check-item--${issue.severity}`"
                >
                  <span
                    class="lc-vm__diff-tag"
                    :class="
                      issue.severity === 'error'
                        ? 'lc-vm__diff-tag--removed'
                        : 'lc-vm__diff-tag--modified'
                    "
                  >
                    {{ issue.severity === 'error' ? '阻断' : '提示' }}
                  </span>
                  {{ issue.message }}
                </li>
              </ul>
            </div>
          </div>

          <footer class="lc-vm__dialog-foot">
            <button type="button" class="lc-vm__button" @click="publishOpen = false">
              取消
            </button>
            <button
              type="button"
              class="lc-vm__primary"
              :disabled="!canPublish"
              @click="confirmPublish"
            >
              <VmIcon name="send" />
              确认发布
            </button>
          </footer>
        </section>
      </div>
    </Teleport>

    <ReleaseSourceDialog v-if="sourceFor" :release="sourceFor" @close="sourceFor = null" />
  </main>
</template>

<style scoped>
.lc-vm {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  padding: 24px 28px;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-vm__icon {
  width: 14px;
  height: 14px;
  flex: none;
}

/* ── 应用信息头卡 ─────────────────────────────────────────────────────── */

.lc-vm__hero {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 22px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background:
    radial-gradient(420px 140px at 12% -40%, var(--lc-accent-soft), transparent 70%),
    linear-gradient(150deg, var(--lc-surface), var(--lc-surface-sunken));
}

.lc-vm__app {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.lc-vm__app-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  flex: none;
  border-radius: 14px;
  background: linear-gradient(
    135deg,
    var(--lc-accent-bright),
    var(--lc-accent) 55%,
    var(--lc-accent-2)
  );
  box-shadow: 0 0 18px var(--lc-glow);
  color: var(--lc-on-accent);
}

.lc-vm__app-icon .lc-vm__icon {
  width: 22px;
  height: 22px;
}

.lc-vm__app-text {
  min-width: 0;
}

.lc-vm__app-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.lc-vm__app-name {
  margin: 0;
  color: var(--lc-text);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.lc-vm__app-desc {
  margin: 4px 0 0;
  max-width: 560px;
  overflow: hidden;
  color: var(--lc-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-vm__blockers {
  padding: 2px 10px;
  border: 1px solid var(--lc-danger-border);
  border-radius: 999px;
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.lc-vm__stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 22px;
}

.lc-vm__stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 22px;
  border-left: 1px solid var(--lc-hairline);
}

.lc-vm__stat:first-child {
  padding-left: 0;
  border-left: 0;
}

.lc-vm__stat-label {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-vm__stat-value {
  color: var(--lc-text);
  font-size: 17px;
  font-weight: 600;
}

.lc-vm__stat-value--small {
  font-size: 13px;
}

/* ── 按钮 / 徽章 ──────────────────────────────────────────────────────── */

.lc-vm__primary,
.lc-vm__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 32px;
  padding: 0 16px;
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

.lc-vm__primary {
  border-color: var(--lc-accent);
  background: linear-gradient(135deg, var(--lc-accent), var(--lc-accent-bright));
  box-shadow: 0 0 18px var(--lc-glow);
  color: var(--lc-on-accent);
  font-weight: 600;
}

.lc-vm__primary:hover:not(:disabled),
.lc-vm__button:hover:not(:disabled) {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-vm__primary:disabled,
.lc-vm__button:disabled {
  border-color: var(--lc-border);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  box-shadow: none;
  cursor: not-allowed;
}

.lc-vm__badge {
  padding: 2px 9px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  font-size: 11px;
}

.lc-vm__badge--live {
  border-color: color-mix(in srgb, var(--lc-success) 40%, transparent);
  background: color-mix(in srgb, var(--lc-success) 12%, transparent);
  color: var(--lc-success);
}

.lc-vm__badge--archived {
  border-color: color-mix(in srgb, var(--lc-accent) 40%, transparent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-vm__badge--none {
  color: var(--lc-text-muted);
}

.lc-vm__link {
  border: 0;
  background: none;
  color: var(--lc-accent-bright);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.lc-vm__link:hover {
  text-decoration: underline;
}

/* ── 主体两栏 ─────────────────────────────────────────────────────────── */

.lc-vm__body {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
}

.lc-vm__history,
.lc-vm__detail {
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(160deg, var(--lc-surface), var(--lc-surface-sunken));
}

.lc-vm__history {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
}

.lc-vm__history-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lc-vm__history-title {
  color: var(--lc-text);
  font-size: 14px;
  font-weight: 600;
}

.lc-vm__count {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--lc-panel-glass);
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-vm__filter {
  width: 118px;
  margin-left: auto;
}

.lc-vm__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 600px;
  margin: 0;
  padding: 2px;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-vm__card {
  position: relative;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.lc-vm__card:hover {
  border-color: var(--lc-border-strong);
}

.lc-vm__card--active {
  border-color: var(--lc-accent);
  box-shadow:
    0 0 0 1px var(--lc-accent),
    0 0 18px var(--lc-glow-soft);
}

.lc-vm__card-main {
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: 100%;
  padding: 12px 34px 12px 12px;
  border: 0;
  background: none;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.lc-vm__card-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lc-vm__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--lc-accent);
  box-shadow: 0 0 8px var(--lc-glow-soft);
}

.lc-vm__dot--live {
  background: var(--lc-success);
  box-shadow: 0 0 8px color-mix(in srgb, var(--lc-success) 50%, transparent);
}

.lc-vm__rev {
  color: var(--lc-text);
  font-size: 14px;
  font-weight: 600;
}

.lc-vm__current-tag {
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--lc-accent) 45%, transparent);
  border-radius: 6px;
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
  font-size: 10px;
}

.lc-vm__card-summary {
  overflow: hidden;
  color: var(--lc-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-vm__card-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-vm__avatar {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--lc-accent), var(--lc-accent-2));
  color: var(--lc-on-accent);
  font-size: 10px;
}

.lc-vm__time {
  margin-left: auto;
}

.lc-vm__dots {
  position: absolute;
  top: 8px;
  right: 8px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--lc-text-muted);
  cursor: pointer;
}

.lc-vm__dots:hover {
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-vm__menu {
  position: absolute;
  top: 32px;
  right: 8px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  min-width: 128px;
  padding: 4px;
  border: 1px solid var(--lc-border-strong);
  border-radius: 8px;
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
}

.lc-vm__menu button {
  padding: 6px 10px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.lc-vm__menu button:hover {
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-vm__history-foot {
  color: var(--lc-text-muted);
  font-size: 11px;
  text-align: center;
}

/* ── 详情区 ───────────────────────────────────────────────────────────── */

.lc-vm__detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.lc-vm__tabs {
  display: flex;
  gap: 4px;
  padding: 0 14px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-vm__tab {
  position: relative;
  padding: 13px 14px;
  border: 0;
  background: none;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}

.lc-vm__tab:hover {
  color: var(--lc-accent-bright);
}

.lc-vm__tab--active {
  color: var(--lc-accent-bright);
  font-weight: 600;
}

.lc-vm__tab--active::after {
  content: '';
  position: absolute;
  right: 10px;
  bottom: -1px;
  left: 10px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--lc-accent), var(--lc-accent-bright));
  box-shadow: 0 0 10px var(--lc-glow);
}

.lc-vm__panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
}

.lc-vm__detail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.lc-vm__detail-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--lc-text);
  font-size: 18px;
  font-weight: 600;
}

.lc-vm__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.lc-vm__summary {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
}

.lc-vm__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 28px;
  padding: 12px 14px;
  border: 1px solid var(--lc-hairline);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
}

.lc-vm__meta-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--lc-text-muted);
  font-size: 12px;
}

.lc-vm__meta-value {
  color: var(--lc-text);
}

.lc-vm__content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 14px;
  align-items: start;
}

.lc-vm__preview-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.lc-vm__preview-empty {
  display: grid;
  place-items: center;
  height: 200px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-md);
  color: var(--lc-text-muted);
  font-size: 12px;
}

.lc-vm__page-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.lc-vm__chip {
  padding: 3px 10px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  background: none;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.lc-vm__chip--active {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-vm__changes {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--lc-hairline);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
}

.lc-vm__changes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-vm__changes-empty {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 12px;
}

.lc-vm__change-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lc-vm__change-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
}

.lc-vm__change-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--lc-accent-bright);
  box-shadow: 0 0 8px var(--lc-glow-soft);
}

.lc-vm__change-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding-left: 13px;
  list-style: none;
  border-left: 1px solid var(--lc-hairline);
  color: var(--lc-text-secondary);
  font-size: 12px;
}

.lc-vm__related {
  padding: 14px;
  border: 1px solid var(--lc-hairline);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
}

.lc-vm__related-title {
  margin: 0 0 12px;
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-vm__related-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.lc-vm__related-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--lc-accent-bright);
}

.lc-vm__related-label {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-vm__related-value {
  overflow: hidden;
  color: var(--lc-text);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-vm__related-value--live {
  color: var(--lc-success);
}

/* ── 变更 / 对比 / 部署列表 ────────────────────────────────────────────── */

.lc-vm__panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px;
}

.lc-vm__panel-title {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-vm__panel-hint {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-vm__diff-list,
.lc-vm__deploy-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-vm__diff-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--lc-hairline);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  font-size: 12px;
}

.lc-vm__diff-tag {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
}

.lc-vm__diff-tag--added {
  background: color-mix(in srgb, var(--lc-success) 14%, transparent);
  color: var(--lc-success);
}

.lc-vm__diff-tag--modified {
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-vm__diff-tag--removed {
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-vm__diff-kind {
  flex: none;
  color: var(--lc-text-muted);
}

.lc-vm__diff-label {
  min-width: 0;
  overflow: hidden;
  color: var(--lc-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-vm__diff-id {
  margin-left: auto;
  color: var(--lc-text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 10px;
}

.lc-vm__compare-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.lc-vm__compare-field {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 220px;
}

.lc-vm__compare-label {
  flex: none;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-vm__deploy-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--lc-hairline);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  font-size: 12px;
}

.lc-vm__deploy-icon {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 50%;
}

.lc-vm__deploy-icon--publish {
  background: color-mix(in srgb, var(--lc-success) 14%, transparent);
  color: var(--lc-success);
}

.lc-vm__deploy-icon--rollback {
  background: color-mix(in srgb, var(--lc-warning) 14%, transparent);
  color: var(--lc-warning);
}

.lc-vm__deploy-text {
  color: var(--lc-text);
}

.lc-vm__deploy-by {
  color: var(--lc-text-secondary);
}

.lc-vm__deploy-time {
  margin-left: auto;
  color: var(--lc-text-muted);
  font-size: 11px;
}

/* ── 发布弹层 ─────────────────────────────────────────────────────────── */

.lc-vm__scrim {
  position: fixed;
  inset: 0;
  z-index: 1500;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--lc-app-bg) 72%, transparent);
}

.lc-vm__dialog {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(84vh, 640px);
  overflow: hidden;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
}

.lc-vm__dialog-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--lc-border);
  background: var(--lc-surface-sunken);
}

.lc-vm__dialog-title {
  color: var(--lc-text);
  font-size: 14px;
  font-weight: 600;
}

.lc-vm__dialog-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 16px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-vm__dialog-hint {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.lc-vm__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lc-vm__field-label {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-vm__field textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}

.lc-vm__field textarea:focus-visible {
  border-color: var(--lc-accent);
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

.lc-vm__check {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lc-vm__check-title {
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
}

.lc-vm__check-ok {
  margin: 0;
  color: var(--lc-success);
  font-size: 12px;
}

.lc-vm__check-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-vm__check-list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--lc-text-secondary);
  font-size: 12px;
}

.lc-vm__dialog-foot {
  display: flex;
  flex: none;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--lc-border);
}

.lc-vm :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 1100px) {
  .lc-vm__body {
    grid-template-columns: 1fr;
  }

  .lc-vm__content {
    grid-template-columns: 1fr;
  }

  .lc-vm__related-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-vm__primary,
  .lc-vm__button,
  .lc-vm__card {
    transition: none;
  }
}
</style>
