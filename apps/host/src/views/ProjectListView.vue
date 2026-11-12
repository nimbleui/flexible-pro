<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref } from 'vue'
import type { ProjectAssetCounts, ProjectDefinition } from '../projects/project-model'
import { DEFAULT_PROJECT_ID } from '../projects/project-model'
import {
  countAssetsOf,
  createProject,
  onProjectsChange,
  projects,
  removeProject,
  updateProject,
} from '../projects/project-store'
import { projectPath } from '../projects/project-path'
import { useAssetStoreVersion } from '../projects/use-asset-store-version'
import { toastService } from '../toast'

/**
 * 项目工作台。
 *
 * 平台层的入口页：建、改名、删项目，并把每个项目名下的资产数量摊在卡片上。
 * 「进入」直接落到项目内的页面列表，四类资产的列表页都按项目过滤，
 * 不带项目前缀的旧路径由 `router.ts` 回落默认项目。
 */

interface ProjectRow {
  /** 项目记录 */
  readonly project: ProjectDefinition
  /** 名下四类资产数量 */
  readonly counts: ProjectAssetCounts
  /** 是否为承接存量资产的默认项目 */
  readonly isDefault: boolean
}

/** 弹框模式：新建与改名共用一套字段，差别只在提交调用哪个写入函数 */
type DialogMode = 'create' | 'rename'

// 卡片计数来自四个独立存储，任何一个变了都要重算，否则数字会停在旧值
const assetVersion = useAssetStoreVersion()
const projectVersion = ref(0)

const projectsDisposable = onProjectsChange(() => {
  projectVersion.value += 1
})

onUnmounted(() => projectsDisposable.dispose())

const pendingDelete = ref<string | null>(null)
const dialogMode = ref<DialogMode>('create')
const editingId = ref<string | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const dialogOpen = ref(false)
const draft = reactive({ name: '', description: '' })

const rows = computed<readonly ProjectRow[]>(() => {
  projectVersion.value
  assetVersion.value
  return projects.value.map((project) => ({
    project,
    counts: countAssetsOf(project.id),
    isDefault: project.id === DEFAULT_PROJECT_ID,
  }))
})

const canSubmit = computed(() => draft.name.trim() !== '')

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
  draft.name = ''
  draft.description = ''
  dialogOpen.value = true
  // 弹框是 v-if 挂载的，焦点必须等这一帧渲染完；名称是唯一的必填项，直接落在它上面
  void nextTick(() => nameInput.value?.focus())
}

function openRename(project: ProjectDefinition): void {
  dialogMode.value = 'rename'
  editingId.value = project.id
  draft.name = project.name
  draft.description = project.description ?? ''
  dialogOpen.value = true
  void nextTick(() => nameInput.value?.focus())
}

function closeDialog(): void {
  dialogOpen.value = false
}

function submitDialog(): void {
  if (!canSubmit.value) return

  try {
    if (dialogMode.value === 'create') {
      const created = createProject({ name: draft.name, description: draft.description })
      toastService.show(`项目「${created.name}」已创建`, 'success')
    } else if (editingId.value) {
      const saved = updateProject(editingId.value, {
        name: draft.name,
        description: draft.description,
      })
      toastService.show(`项目「${saved.name}」已更新`, 'success')
    }
    closeDialog()
  } catch (cause) {
    // store 抛的是可直接展示的用户文案（名称为空、项目不存在），原样透出
    toastService.show(messageOf(cause), 'error')
  }
}

function confirmDelete(id: string): void {
  try {
    removeProject(id)
    pendingDelete.value = null
  } catch (cause) {
    toastService.show(messageOf(cause), 'error')
    pendingDelete.value = null
  }
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
  <main class="lc-projects">
    <header class="lc-projects__head">
      <div class="lc-projects__heading">
        <h1 class="lc-projects__title">项目管理</h1>
        <p class="lc-projects__hint">
          项目是页面、流程、函数与组件的归属容器：一个项目对应一个可独立发布的业务应用。
          计数按资产记录上的归属字段统计，改造前已有的资产都归在「默认项目」里。
        </p>
      </div>
      <button type="button" class="lc-projects__primary" @click="openCreate">+ 新建项目</button>
    </header>

    <ul class="lc-projects__grid">
      <li
        v-for="row in rows"
        :key="row.project.id"
        class="lc-projects__card"
        :class="{ 'is-pending': pendingDelete === row.project.id }"
      >
        <div class="lc-projects__card-head">
          <span class="lc-projects__name">{{ row.project.name }}</span>
          <span v-if="row.isDefault" class="lc-projects__tag">默认项目</span>
          <span
            v-if="row.project.publishedRevision"
            class="lc-projects__tag lc-projects__tag--live"
          >
            线上 v{{ row.project.publishedRevision }}
          </span>
        </div>

        <code class="lc-projects__id">{{ row.project.id }}</code>

        <p class="lc-projects__desc">
          {{ row.project.description || '暂无说明' }}
        </p>

        <dl class="lc-projects__counts">
          <div class="lc-projects__count">
            <dt>页面</dt>
            <dd>{{ row.counts.pages }}</dd>
          </div>
          <div class="lc-projects__count">
            <dt>流程</dt>
            <dd>{{ row.counts.flows }}</dd>
          </div>
          <div class="lc-projects__count">
            <dt>函数</dt>
            <dd>{{ row.counts.functions }}</dd>
          </div>
          <div class="lc-projects__count">
            <dt>组件</dt>
            <dd>{{ row.counts.components }}</dd>
          </div>
          <div class="lc-projects__count">
            <dt>接口</dt>
            <dd>{{ row.counts.apis }}</dd>
          </div>
        </dl>

        <span class="lc-projects__meta">更新于 {{ formatTime(row.project.updatedAt) }}</span>

        <div class="lc-projects__actions">
          <template v-if="pendingDelete === row.project.id">
            <span class="lc-projects__confirm">删除？</span>
            <button
              type="button"
              class="lc-projects__button lc-projects__button--danger"
              @click="confirmDelete(row.project.id)"
            >
              确认
            </button>
            <button type="button" class="lc-projects__button" @click="pendingDelete = null">
              取消
            </button>
          </template>
          <template v-else>
            <RouterLink
              class="lc-projects__button lc-projects__button--primary"
              :to="projectPath(row.project.id, 'pages')"
            >
              进入
            </RouterLink>
            <button type="button" class="lc-projects__button" @click="openRename(row.project)">
              重命名
            </button>
            <button
              type="button"
              class="lc-projects__button lc-projects__button--danger"
              :disabled="row.isDefault"
              :title="row.isDefault ? '默认项目承接存量资产，不能删除' : undefined"
              @click="pendingDelete = row.project.id"
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
    <div v-if="dialogOpen" class="lc-projects__backdrop" @mousedown.self="closeDialog">
      <section
        class="lc-projects__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-projects-dialog-title"
      >
        <header class="lc-projects__dialog-head">
          <h2 id="lc-projects-dialog-title" class="lc-projects__dialog-title">
            {{ dialogMode === 'create' ? '新建项目' : '重命名项目' }}
          </h2>
          <button
            type="button"
            class="lc-projects__close"
            aria-label="关闭项目弹框"
            @click="closeDialog"
          >
            ×
          </button>
        </header>

        <form class="lc-projects__form" @submit.prevent="submitDialog">
          <label class="lc-projects__field">
            <span class="lc-projects__field-label">名称</span>
            <input
              ref="nameInput"
              v-model="draft.name"
              type="text"
              autocomplete="off"
              placeholder="如：订单中台"
            />
          </label>

          <label class="lc-projects__field">
            <span class="lc-projects__field-label">说明（可选）</span>
            <textarea
              v-model="draft.description"
              rows="3"
              placeholder="这个项目服务哪块业务、给谁用"
            ></textarea>
          </label>

          <footer class="lc-projects__dialog-foot">
            <button type="button" class="lc-projects__button" @click="closeDialog">取消</button>
            <button
              type="submit"
              class="lc-projects__button lc-projects__button--primary"
              :disabled="!canSubmit"
            >
              {{ dialogMode === 'create' ? '创建项目' : '保存修改' }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.lc-projects {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 32px 36px;
  overflow: auto;
}

.lc-projects__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 22px;
}

.lc-projects__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 6px;
  color: var(--lc-text);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.lc-projects__title::before {
  content: '';
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--lc-accent-bright), var(--lc-accent));
  box-shadow: 0 0 10px var(--lc-glow);
}

.lc-projects__hint {
  max-width: 760px;
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.lc-projects__primary,
.lc-projects__button {
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
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.lc-projects__primary {
  border-color: var(--lc-accent);
  background: linear-gradient(
    135deg,
    var(--lc-accent-bright),
    var(--lc-accent) 52%,
    var(--lc-accent-2)
  );
  box-shadow: 0 0 18px var(--lc-glow);
  color: var(--lc-on-accent);
  font-weight: 600;
}

.lc-projects__primary:hover,
.lc-projects__button:hover {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

/* 禁用态只改前景与边框，不靠 opacity 把整颗按钮洗淡 */
.lc-projects__button:disabled {
  border-color: var(--lc-border);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  cursor: not-allowed;
}

.lc-projects__button--primary {
  border-color: var(--lc-accent);
  background: linear-gradient(
    150deg,
    var(--lc-accent-bright),
    var(--lc-accent) 55%,
    var(--lc-accent-2)
  );
  color: var(--lc-on-accent);
  font-weight: 600;
}

.lc-projects__button--primary:hover {
  border-color: var(--lc-accent-bright);
  color: var(--lc-on-accent);
}

.lc-projects__button--danger {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-projects__button--danger:hover {
  border-color: var(--lc-danger);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-projects__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-projects__card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 18px;
  overflow: hidden;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(150deg, var(--lc-surface), var(--lc-surface-sunken));
  transition:
    border-color 0.2s ease,
    background 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
}

/* 卡片右上角蓝紫光晕：hover 时点亮，给数据资产一点「在线模块」的能量感 */
.lc-projects__card::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 130px;
  height: 130px;
  pointer-events: none;
  background: radial-gradient(circle at 100% 0%, rgba(55, 182, 255, 0.2), transparent 70%);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.lc-projects__card:hover {
  border-color: var(--lc-border-strong);
  background: linear-gradient(150deg, var(--lc-surface-raised), var(--lc-surface));
  box-shadow:
    0 0 0 1px rgba(55, 182, 255, 0.2),
    0 18px 44px rgba(0, 6, 18, 0.5),
    0 0 30px rgba(47, 140, 255, 0.22);
  transform: translateY(-2px);
}

.lc-projects__card:hover::before {
  opacity: 1;
}

/* 等待删除确认的卡片：状态由 pendingDelete 决定，不能让「删除？」只靠 hover 露出来 */
.lc-projects__card.is-pending {
  border-color: var(--lc-danger-border);
  background: linear-gradient(150deg, var(--lc-danger-surface), var(--lc-surface-sunken));
}

.lc-projects__card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.lc-projects__name {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-projects__tag {
  padding: 1px 8px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

/* 已发布过的项目：一眼看出哪些项目真的有线上内容 */
.lc-projects__tag--live {
  border-color: color-mix(in srgb, var(--lc-success) 40%, transparent);
  background: color-mix(in srgb, var(--lc-success) 12%, transparent);
  color: var(--lc-success);
}

.lc-projects__id {
  overflow: hidden;
  color: var(--lc-text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-projects__desc {
  display: -webkit-box;
  overflow: hidden;
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.lc-projects__counts {
  display: flex;
  gap: 18px;
  margin: 2px 0 0;
}

.lc-projects__count {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.lc-projects__count dt {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-projects__count dd {
  margin: 0;
  color: var(--lc-accent-bright);
  font-size: 16px;
  font-weight: 600;
}

.lc-projects__meta {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-projects__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.lc-projects__confirm {
  color: var(--lc-danger);
  font-size: 11px;
}

.lc-projects__backdrop {
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

.lc-projects__backdrop *,
.lc-projects__backdrop *::before,
.lc-projects__backdrop *::after {
  box-sizing: border-box;
}

.lc-projects__dialog {
  width: min(440px, 100%);
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
  color: var(--lc-text);
}

.lc-projects__dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-projects__dialog-title {
  margin: 0;
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-projects__close {
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

.lc-projects__close:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-projects__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
}

.lc-projects__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.lc-projects__field-label {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-projects__field input,
.lc-projects__field textarea {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}

.lc-projects__field input::placeholder,
.lc-projects__field textarea::placeholder {
  color: var(--lc-text-muted);
}

.lc-projects__field input:hover,
.lc-projects__field textarea:hover {
  border-color: var(--lc-border-strong);
}

.lc-projects__dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.lc-projects :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

/* 弹框 Teleport 到 body，已经不在 .lc-projects 子树里，焦点环单独给一份 */
.lc-projects__backdrop :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 900px) {
  .lc-projects {
    padding: 24px 20px;
  }

  .lc-projects__head {
    flex-wrap: wrap;
    gap: 14px;
  }

  .lc-projects__grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-projects__primary,
  .lc-projects__button,
  .lc-projects__card {
    transition: none;
  }
}
</style>
