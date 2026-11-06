<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { FlowDefinition, FlowTriggerKind } from '@lc/schema'
import { FLOW_NODE_CATALOG, FLOW_TRIGGER } from '@lc/schema'
import { createFlow, flows, publishFlow, removeFlow } from '../workflows/flow-store'
import { resolveProjectId } from '../projects/project-model'
import { projectPath } from '../projects/project-path'
import { toastService } from '../toast'

const route = useRoute()
const router = useRouter()
const projectId = String(route.params.projectId)

const pendingDelete = ref<string | null>(null)

/** 新建弹框：确认后才落库拿 id，再带着 id 进编辑器，避免第二条创建入口 */
const createOpen = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)
const draft = reactive({ name: '', description: '', withSeed: false })

/** 列表行视图模型：触发类型读取与节点计数收敛在这里，模板只负责展示 */
interface FlowRow {
  readonly flow: FlowDefinition
  /** 触发类型文案；图里没有触发节点时说明缺起点 */
  readonly triggerLabel: string
  /** 有没有可用的触发节点；没有的行要标灰，因为它不可能被执行 */
  readonly hasTrigger: boolean
  readonly nodeCount: number
}

/** 触发类型 → 中文名；与节点库同源，避免目录改名字典不动 */
const TRIGGER_KIND_LABELS = new Map<string, string>(
  FLOW_NODE_CATALOG.filter((entry) => entry.triggerKind).map((entry) => [
    entry.triggerKind as FlowTriggerKind,
    entry.title,
  ]),
)

/**
 * 这张图声明自己被哪一类来源唤起。
 *
 * 这里**不再显示**「哪个页面的哪个按钮」——绑定现在写在页面的 `connection.flowId` 上，
 * 一张图可以被任意多个事件引用，图侧没有唯一答案可展示。要查具体被谁绑，去页面的事件面板。
 */
function triggerOf(flow: FlowDefinition): { label: string; hasTrigger: boolean } {
  for (const node of Object.values(flow.nodes)) {
    if (node.type !== FLOW_TRIGGER) continue

    const kind = node.config.kind
    const label = typeof kind === 'string' ? TRIGGER_KIND_LABELS.get(kind) : undefined

    return { label: label ?? '未声明触发类型', hasTrigger: true }
  }

  return { label: '缺少触发节点', hasTrigger: false }
}

/** 当前项目名下的图；跨项目的图不进列表，页面也选不到它 */
const rows = computed<readonly FlowRow[]>(() =>
  flows.value
    .filter((flow) => resolveProjectId(flow.projectId) === projectId)
    .map((flow) => {
      const trigger = triggerOf(flow)

      return {
        flow,
        triggerLabel: trigger.label,
        hasTrigger: trigger.hasTrigger,
        nodeCount: Object.keys(flow.nodes).length,
      }
    }),
)

const canCreate = computed(() => draft.name.trim() !== '')

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function openCreate(): void {
  draft.name = ''
  draft.description = ''
  draft.withSeed = false
  createOpen.value = true
  // 弹框是 v-if 挂载的，焦点必须等这一帧渲染完；名称是唯一的必填项，直接落在它上面
  void nextTick(() => nameInput.value?.focus())
}

function closeCreate(): void {
  createOpen.value = false
}

function submitCreate(): void {
  if (!canCreate.value) return

  try {
    const created = createFlow({
      name: draft.name,
      description: draft.description,
      withSeed: draft.withSeed,
      projectId,
    })
    closeCreate()
    void router.push(projectPath(projectId, `flows/${created.id}/edit`))
  } catch (cause) {
    // 必填名称已由禁用拦住，这里兜住 store 后续新增的校验规则
    toastService.show(messageOf(cause), 'error')
  }
}

function publish(flowId: string): void {
  try {
    const published = publishFlow(flowId)
    toastService.show(`流程「${published.name}」已发布 v${published.version}`, 'success')
  } catch (cause) {
    // store 抛的是可直接展示的用户文案（校验不通过、事件占用冲突），原样透出
    toastService.show(messageOf(cause), 'error')
  }
}

function confirmDelete(id: string): void {
  removeFlow(id)
  pendingDelete.value = null
}

function onKeydown(event: KeyboardEvent): void {
  if (!createOpen.value || event.key !== 'Escape') return

  event.preventDefault()
  closeCreate()
}

window.addEventListener('keydown', onKeydown)

onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <main class="lc-flows">
    <header class="lc-flows__head">
      <div class="lc-flows__heading">
        <h1 class="lc-flows__title">流程编排</h1>
        <p class="lc-flows__hint">
          流程是一张按触发点被页面事件调用的执行图；只有发布后的图才参与事件匹配，草稿只在编辑器里可见。
          这里只列当前项目的图，事件键的占用也只在本项目内互相拦截。
        </p>
      </div>
      <button type="button" class="lc-flows__primary" @click="openCreate">+ 新建流程</button>
    </header>

    <div v-if="rows.length === 0" class="lc-flows__empty">
      <span class="lc-flows__empty-title">还没有流程</span>
      <span>先建一张图，给它一个触发节点，页面事件就能按「来源 + 事件名」调用它。</span>
      <button type="button" class="lc-flows__link" @click="openCreate">创建第一个流程</button>
    </div>

    <ul v-else class="lc-flows__list">
      <li
        v-for="row in rows"
        :key="row.flow.id"
        class="lc-flows__item"
        :class="{ 'is-active': pendingDelete === row.flow.id }"
      >
        <div class="lc-flows__item-main">
          <div class="lc-flows__item-head">
            <span class="lc-flows__name">{{ row.flow.name }}</span>
            <span
              class="lc-flows__badge"
              :class="
                row.flow.status === 'published'
                  ? 'lc-flows__badge--published'
                  : 'lc-flows__badge--draft'
              "
            >
              {{ row.flow.status === 'published' ? `已发布 v${row.flow.version}` : '草稿' }}
            </span>
            <span
              class="lc-flows__trigger"
              :class="{ 'lc-flows__trigger--none': !row.hasTrigger }"
              >{{ row.triggerLabel }}</span
            >
          </div>

          <p v-if="row.flow.description" class="lc-flows__desc">{{ row.flow.description }}</p>
        </div>

        <div class="lc-flows__item-side">
          <span class="lc-flows__meta">
            {{ row.nodeCount }} 个节点 · {{ formatTime(row.flow.updatedAt) }}
          </span>

          <div class="lc-flows__actions">
            <template v-if="pendingDelete === row.flow.id">
              <span class="lc-flows__confirm">删除？</span>
              <button
                type="button"
                class="lc-flows__button lc-flows__button--danger"
                @click="confirmDelete(row.flow.id)"
              >
                确认
              </button>
              <button type="button" class="lc-flows__button" @click="pendingDelete = null">
                取消
              </button>
            </template>
            <template v-else>
              <RouterLink
                class="lc-flows__button"
                :to="projectPath(projectId, `flows/${row.flow.id}/edit`)"
              >
                编辑
              </RouterLink>
              <button
                v-if="row.flow.status !== 'published'"
                type="button"
                class="lc-flows__button"
                @click="publish(row.flow.id)"
              >
                发布
              </button>
              <button
                type="button"
                class="lc-flows__button lc-flows__button--danger"
                @click="pendingDelete = row.flow.id"
              >
                删除
              </button>
            </template>
          </div>
        </div>
      </li>
    </ul>
  </main>

  <!-- Teleport 到 body：列表容器有 overflow: auto，弹框留在里面会被滚动区裁掉 -->
  <Teleport to="body">
    <div v-if="createOpen" class="lc-flows__backdrop" @mousedown.self="closeCreate">
      <section
        class="lc-flows__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-flows-create-title"
      >
        <header class="lc-flows__dialog-head">
          <div class="lc-flows__dialog-heading">
            <h2 id="lc-flows-create-title" class="lc-flows__dialog-title">新建流程</h2>
            <p class="lc-flows__dialog-subtitle">
              先定名字与起点，确认后带着 id 进编辑器画图。名称之外随时都能改。
            </p>
          </div>
          <button
            type="button"
            class="lc-flows__close"
            aria-label="关闭新建流程弹框"
            @click="closeCreate"
          >
            ×
          </button>
        </header>

        <form class="lc-flows__form" @submit.prevent="submitCreate">
          <label class="lc-flows__field">
            <span class="lc-flows__field-label">名称</span>
            <input
              ref="nameInput"
              v-model="draft.name"
              type="text"
              autocomplete="off"
              placeholder="如：订单审批流程"
            />
          </label>

          <label class="lc-flows__field">
            <span class="lc-flows__field-label">说明（可选）</span>
            <textarea
              v-model="draft.description"
              rows="3"
              placeholder="这张图在什么场景下被触发、做完什么"
            ></textarea>
          </label>

          <label class="lc-flows__check">
            <input v-model="draft.withSeed" type="checkbox" />
            <span>使用订单审批示例作为起点</span>
          </label>

          <footer class="lc-flows__dialog-foot">
            <button type="button" class="lc-flows__button" @click="closeCreate">取消</button>
            <button
              type="submit"
              class="lc-flows__button lc-flows__button--primary"
              :disabled="!canCreate"
            >
              创建并进入编辑器
            </button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.lc-flows {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 32px 36px;
  overflow: auto;
}

.lc-flows__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 22px;
}

.lc-flows__heading {
  min-width: 0;
}

.lc-flows__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 6px;
  color: var(--lc-text);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.lc-flows__title::before {
  content: '';
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--lc-accent-bright), var(--lc-accent));
  box-shadow: 0 0 10px var(--lc-glow);
}

.lc-flows__hint {
  max-width: 720px;
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.lc-flows__primary,
.lc-flows__button,
.lc-flows__link {
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

.lc-flows__primary {
  border-color: var(--lc-accent);
  background: linear-gradient(135deg, var(--lc-accent), var(--lc-accent-bright));
  box-shadow: 0 0 18px var(--lc-glow);
  color: var(--lc-app-bg);
  font-weight: 600;
}

.lc-flows__button:hover,
.lc-flows__link:hover {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-flows__button--danger {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-flows__button--danger:hover {
  border-color: var(--lc-danger);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-flows__button--primary {
  border-color: var(--lc-accent);
  background: linear-gradient(150deg, var(--lc-accent-bright), var(--lc-accent));
  color: var(--lc-app-bg);
  font-weight: 600;
}

.lc-flows__button--primary:hover {
  border-color: var(--lc-accent-bright);
  color: var(--lc-app-bg);
}

/* 禁用态只改前景与边框，不靠 opacity 把整颗按钮洗淡 */
.lc-flows__button:disabled {
  border-color: var(--lc-border);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  cursor: not-allowed;
}

.lc-flows__empty {
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

.lc-flows__empty-title {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-flows__link {
  margin-top: 8px;
}

.lc-flows__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-flows__item {
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
.lc-flows__item.is-active {
  border-color: var(--lc-danger-border);
  background: linear-gradient(150deg, var(--lc-danger-surface), var(--lc-surface-sunken));
}

.lc-flows__item-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.lc-flows__item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.lc-flows__name {
  color: var(--lc-text);
  font-size: 14px;
  font-weight: 600;
}

.lc-flows__badge {
  flex: none;
  padding: 1px 8px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  font-size: 11px;
}

.lc-flows__badge--published {
  border-color: color-mix(in srgb, var(--lc-success) 40%, transparent);
  background: color-mix(in srgb, var(--lc-success) 12%, transparent);
  color: var(--lc-success);
}

.lc-flows__badge--draft {
  border-color: color-mix(in srgb, var(--lc-warning) 40%, transparent);
  background: color-mix(in srgb, var(--lc-warning) 12%, transparent);
  color: var(--lc-warning);
}

.lc-flows__trigger {
  overflow: hidden;
  max-width: 320px;
  padding: 1px 7px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-flows__trigger--none {
  border-style: dashed;
  color: var(--lc-text-muted);
}

.lc-flows__desc {
  overflow: hidden;
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-flows__item-side {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.lc-flows__meta {
  color: var(--lc-text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.lc-flows__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lc-flows__confirm {
  color: var(--lc-danger);
  font-size: 11px;
}

.lc-flows__backdrop {
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

.lc-flows__backdrop *,
.lc-flows__backdrop *::before,
.lc-flows__backdrop *::after {
  box-sizing: border-box;
}

.lc-flows__dialog {
  width: min(460px, 100%);
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
  color: var(--lc-text);
}

.lc-flows__dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 12px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-flows__dialog-heading {
  min-width: 0;
}

.lc-flows__dialog-title {
  margin: 0 0 6px;
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-flows__dialog-subtitle {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 11px;
  line-height: 1.6;
}

.lc-flows__close {
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

.lc-flows__close:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-flows__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
}

.lc-flows__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.lc-flows__field-label {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-flows__field input,
.lc-flows__field textarea {
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

.lc-flows__field input::placeholder,
.lc-flows__field textarea::placeholder {
  color: var(--lc-text-muted);
}

.lc-flows__field input:hover,
.lc-flows__field textarea:hover {
  border-color: var(--lc-border-strong);
}

.lc-flows__check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--lc-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.lc-flows__check input {
  flex: none;
  width: 14px;
  height: 14px;
  accent-color: var(--lc-accent);
  cursor: pointer;
}

.lc-flows__dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.lc-flows :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

/* 弹框 Teleport 到 body，已经不在 .lc-flows 子树里，焦点环单独给一份 */
.lc-flows__backdrop :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 900px) {
  .lc-flows {
    padding: 24px 20px;
  }

  .lc-flows__head {
    flex-wrap: wrap;
    gap: 14px;
  }

  .lc-flows__item {
    flex-direction: column;
    align-items: stretch;
  }

  .lc-flows__item-side {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .lc-flows__trigger {
    max-width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-flows__primary,
  .lc-flows__button,
  .lc-flows__link,
  .lc-flows__item {
    transition: none;
  }
}
</style>
