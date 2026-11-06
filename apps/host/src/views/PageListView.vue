<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { PageRecord } from '../pages/page-model'
import { createPage, onPagesChange, pages, removePage, renamePage } from '../pages/page-store'
import { resolveProjectId } from '../projects/project-model'
import { currentReleaseOf, onReleasesChange } from '../projects/release-store'
import { projectPath } from '../projects/project-path'
import { toastService } from '../toast'
import { useAppContext } from '@lc/vue'

/**
 * 页面列表。
 *
 * 记录来自 `page-store`（localStorage），并按 URL 上的项目过滤：项目是归属容器，
 * 这一页只该看到自己名下的页面。改造前带过来的记录没有归属字段，
 * 由 `resolveProjectId` 解释成默认项目，所以它们只在默认项目里出现。
 */

const route = useRoute()
const router = useRouter()
const appCtx = useAppContext()
const projectId = String(route.params.projectId)

const version = ref(0)
const bump = (): void => {
  version.value += 1
}

// 打开/关闭文档、页面增删、发布版本变化都会影响这一页：前两者改列表与徽标，
// 最后一个改每行「运行」能不能点
const disposables = [
  appCtx.workspace.onDidChange(bump),
  onPagesChange(bump),
  onReleasesChange(bump),
]

onUnmounted(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose()
})

const pendingDelete = ref<string | null>(null)

/** 弹框模式：新建与重命名共用一个标题字段，差别只在提交调用哪个写入函数 */
const dialogMode = ref<'create' | 'rename'>('create')
const editingId = ref<string | null>(null)
const titleInput = ref<HTMLInputElement | null>(null)
const dialogOpen = ref(false)
const draft = reactive({ title: '' })

/** 已打开的文档 id；Realm 由本应用持有，切进设计器后仍留在工作区里 */
const openIds = computed(() => {
  version.value
  return new Set(appCtx.workspace.listEditors().map((realm) => realm.documentId))
})

/** 当前项目名下的页面；没有归属字段的存量记录算默认项目的 */
const visible = computed<readonly PageRecord[]>(() => {
  version.value
  return pages.value.filter((page) => resolveProjectId(page.projectId) === projectId)
})

/**
 * 线上版本里的页面 id。
 *
 * 「运行」只对快照里存在的页面开放：发布之后新建或改归属的页面不在这份内容里，
 * 点进去只能看到一张空白文档，那比按钮灰着更糟。
 */
const livePageIds = computed(() => {
  version.value
  return new Set((currentReleaseOf(projectId)?.assets.pages ?? []).map((item) => item.id))
})

/** 项目有没有线上版本；只影响禁用按钮上那句解释怎么说 */
const hasLiveRelease = computed(() => {
  version.value
  return currentReleaseOf(projectId) !== undefined
})

const canSubmit = computed(() => draft.title.trim() !== '')

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function openCreate(): void {
  dialogMode.value = 'create'
  editingId.value = null
  draft.title = ''
  dialogOpen.value = true
  // 弹框是 v-if 挂载的，焦点必须等这一帧渲染完；标题是唯一的必填项，直接落在它上面
  void nextTick(() => titleInput.value?.focus())
}

function openRename(page: PageRecord): void {
  dialogMode.value = 'rename'
  editingId.value = page.id
  draft.title = page.title
  dialogOpen.value = true
  void nextTick(() => titleInput.value?.focus())
}

function closeDialog(): void {
  dialogOpen.value = false
}

/** 新建直接进设计器：空白页停在列表里没有可继续编辑的对象，看着像没生效 */
function submitDialog(): void {
  if (!canSubmit.value) return

  try {
    if (dialogMode.value === 'create') {
      const created = createPage(draft.title, projectId)
      closeDialog()
      void router.push(projectPath(projectId, `design/${encodeURIComponent(created.id)}`))
      return
    }

    if (editingId.value) {
      renamePage(editingId.value, draft.title)
    }
    closeDialog()
  } catch (cause) {
    // store 抛的是可直接展示的用户文案（标题为空、页面不存在），原样透出
    toastService.show(messageOf(cause), 'error')
  }
}

function confirmDelete(id: string): void {
  removePage(id)
  pendingDelete.value = null
}

function onKeydown(event: KeyboardEvent): void {
  if (!dialogOpen.value || event.key !== 'Escape') return

  event.preventDefault()
  closeDialog()
}

window.addEventListener('keydown', onKeydown)

onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <main class="lc-pages">
    <header class="lc-pages__head">
      <div class="lc-pages__heading">
        <h1 class="lc-pages__title">页面</h1>
        <p class="lc-pages__hint">
          这一页只列当前项目名下的页面。页面是一份可持久化的文档：设计器里的「保存」写回文档快照，
          列表页负责新建、改名与删除；文档 Realm 与外壳由主应用持有，画布由远程模块
          <code>designerCanvas</code> 装载。
        </p>
      </div>
      <button type="button" class="lc-pages__primary" @click="openCreate">+ 新建页面</button>
    </header>

    <div v-if="visible.length === 0" class="lc-pages__empty">
      <span class="lc-pages__empty-title">这个项目还没有页面</span>
      <span>先建一张空白页，进画布拖物料，保存后就常驻在这里。</span>
      <button type="button" class="lc-pages__link" @click="openCreate">创建第一个页面</button>
    </div>

    <ul v-else class="lc-pages__list">
      <li
        v-for="page in visible"
        :key="page.id"
        class="lc-pages__item"
        :class="{ 'is-active': pendingDelete === page.id }"
      >
        <div class="lc-pages__item-main">
          <div class="lc-pages__item-head">
            <span class="lc-pages__name">{{ page.title }}</span>
            <code class="lc-pages__id">{{ page.id }}</code>
            <span v-if="openIds.has(page.id)" class="lc-pages__badge">已打开</span>
          </div>

          <span class="lc-pages__meta">
            {{ Object.keys(page.schema.nodes).length }} 个节点 · 更新于
            {{ formatTime(page.updatedAt) }}
          </span>
        </div>

        <div class="lc-pages__actions">
          <template v-if="pendingDelete === page.id">
            <span class="lc-pages__confirm">删除？</span>
            <button
              type="button"
              class="lc-pages__button lc-pages__button--danger"
              @click="confirmDelete(page.id)"
            >
              确认
            </button>
            <button type="button" class="lc-pages__button" @click="pendingDelete = null">
              取消
            </button>
          </template>
          <template v-else>
            <RouterLink
              class="lc-pages__button"
              :to="projectPath(projectId, `design/${page.id}`)"
            >
              编辑
            </RouterLink>
            <!-- 预览挂在编辑入口外面：链接套链接是无效 HTML，整行本身不是可点区域 -->
            <RouterLink
              class="lc-pages__button"
              :to="projectPath(projectId, `preview/${page.id}`)"
            >
              预览
            </RouterLink>
            <!-- 运行走线上快照，与上面的草稿预览是两条不同的路；不在快照里就禁用而不是给张空白页 -->
            <RouterLink
              v-if="livePageIds.has(page.id)"
              class="lc-pages__button"
              :to="projectPath(projectId, `run/${page.id}`)"
              title="渲染线上版本快照里的这张页面"
            >
              运行
            </RouterLink>
            <button
              v-else
              type="button"
              class="lc-pages__button"
              disabled
              :title="
                hasLiveRelease
                  ? '这张页面不在线上版本里，发布后才能运行'
                  : '项目还没有线上版本，先去「发布」'
              "
            >
              运行
            </button>
            <button type="button" class="lc-pages__button" @click="openRename(page)">
              重命名
            </button>
            <button
              type="button"
              class="lc-pages__button lc-pages__button--danger"
              @click="pendingDelete = page.id"
            >
              删除
            </button>
          </template>
        </div>
      </li>
    </ul>
  </main>

  <!-- Teleport 到 body：列表容器有 overflow: auto，弹框留在里面会被滚动区裁掉 -->
  <Teleport to="body">
    <div v-if="dialogOpen" class="lc-pages__backdrop" @mousedown.self="closeDialog">
      <section
        class="lc-pages__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-pages-dialog-title"
      >
        <header class="lc-pages__dialog-head">
          <div class="lc-pages__dialog-heading">
            <h2 id="lc-pages-dialog-title" class="lc-pages__dialog-title">
              {{ dialogMode === 'create' ? '新建页面' : '重命名页面' }}
            </h2>
            <p class="lc-pages__dialog-subtitle">
              {{
                dialogMode === 'create'
                  ? '先定标题，确认后带着 id 进画布；标题之后还能在这里改。'
                  : '标题只影响列表与设计器顶栏，文档 id 不变。'
              }}
            </p>
          </div>
          <button
            type="button"
            class="lc-pages__close"
            aria-label="关闭页面弹框"
            @click="closeDialog"
          >
            ×
          </button>
        </header>

        <form class="lc-pages__form" @submit.prevent="submitDialog">
          <label class="lc-pages__field">
            <span class="lc-pages__field-label">标题</span>
            <input
              ref="titleInput"
              v-model="draft.title"
              type="text"
              autocomplete="off"
              placeholder="如：订单列表"
            />
          </label>

          <footer class="lc-pages__dialog-foot">
            <button type="button" class="lc-pages__button" @click="closeDialog">取消</button>
            <button
              type="submit"
              class="lc-pages__button lc-pages__button--primary"
              :disabled="!canSubmit"
            >
              {{ dialogMode === 'create' ? '创建并进入画布' : '保存修改' }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.lc-pages {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 32px 36px;
  overflow: auto;
}

.lc-pages__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 22px;
}

.lc-pages__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 6px;
  color: var(--lc-text);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.lc-pages__title::before {
  content: '';
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--lc-accent-bright), var(--lc-accent));
  box-shadow: 0 0 10px var(--lc-glow);
}

.lc-pages__hint {
  max-width: 720px;
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.lc-pages__primary,
.lc-pages__button,
.lc-pages__link {
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

.lc-pages__primary {
  border-color: var(--lc-accent);
  background: linear-gradient(135deg, var(--lc-accent), var(--lc-accent-bright));
  box-shadow: 0 0 18px var(--lc-glow);
  color: var(--lc-app-bg);
  font-weight: 600;
}

.lc-pages__primary:hover,
.lc-pages__button:hover,
.lc-pages__link:hover {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

/* 禁用态只改前景与边框，不靠 opacity 把整颗按钮洗淡 */
.lc-pages__button:disabled {
  border-color: var(--lc-border);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  cursor: not-allowed;
}

.lc-pages__button--primary {
  border-color: var(--lc-accent);
  background: linear-gradient(150deg, var(--lc-accent-bright), var(--lc-accent));
  color: var(--lc-app-bg);
  font-weight: 600;
}

.lc-pages__button--primary:hover {
  border-color: var(--lc-accent-bright);
  color: var(--lc-app-bg);
}

.lc-pages__button--danger {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-pages__button--danger:hover {
  border-color: var(--lc-danger);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-pages__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 56px 24px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-size: 13px;
  text-align: center;
}

.lc-pages__empty-title {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-pages__link {
  margin-top: 8px;
}

.lc-pages__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-pages__item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 18px;
  overflow: hidden;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(150deg, var(--lc-surface), var(--lc-surface-sunken));
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

/* 等待删除确认的行：状态由 pendingDelete 决定，不能让「删除？」只靠 hover 露出来 */
.lc-pages__item.is-active {
  border-color: var(--lc-danger-border);
  background: linear-gradient(150deg, var(--lc-danger-surface), var(--lc-surface-sunken));
}

.lc-pages__item-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.lc-pages__item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.lc-pages__name {
  color: var(--lc-text);
  font-size: 14px;
  font-weight: 600;
}

.lc-pages__id {
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--lc-surface-sunken);
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
}

.lc-pages__badge {
  padding: 1px 8px;
  border: 1px solid color-mix(in srgb, var(--lc-success) 40%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--lc-success) 12%, transparent);
  color: var(--lc-success);
  font-size: 11px;
}

.lc-pages__meta {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-pages__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lc-pages__confirm {
  color: var(--lc-danger);
  font-size: 11px;
}

.lc-pages__backdrop {
  position: fixed;
  z-index: 1200;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--lc-app-bg) 72%, transparent);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.lc-pages__backdrop *,
.lc-pages__backdrop *::before,
.lc-pages__backdrop *::after {
  box-sizing: border-box;
}

.lc-pages__dialog {
  width: min(440px, 100%);
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
  color: var(--lc-text);
}

.lc-pages__dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 12px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-pages__dialog-heading {
  min-width: 0;
}

.lc-pages__dialog-title {
  margin: 0 0 6px;
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-pages__dialog-subtitle {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 11px;
  line-height: 1.6;
}

.lc-pages__close {
  flex: none;
  width: 26px;
  height: 26px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.lc-pages__close:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-pages__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
}

.lc-pages__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.lc-pages__field-label {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-pages__field input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
}

.lc-pages__field input::placeholder {
  color: var(--lc-text-muted);
}

.lc-pages__field input:hover {
  border-color: var(--lc-border-strong);
}

.lc-pages__dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.lc-pages :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

/* 弹框 Teleport 到 body，已经不在 .lc-pages 子树里，焦点环单独给一份 */
.lc-pages__backdrop :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 900px) {
  .lc-pages {
    padding: 24px 20px;
  }

  .lc-pages__head {
    flex-wrap: wrap;
    gap: 14px;
  }

  .lc-pages__item {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-pages__primary,
  .lc-pages__button,
  .lc-pages__link,
  .lc-pages__item {
    transition: none;
  }
}
</style>
