<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { DocumentService } from '@lc/contracts'
import type { Disposable } from '@lc/kernel'
import type { ExpressionEngine, FunctionSchema, SchemaPatch } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import type { FunctionDraft } from '../../functions/function-draft'
import {
  EMPTY_FUNCTION_DRAFT,
  draftFromSchema,
  functionBodyText,
} from '../../functions/function-draft'
import { globalFunctions } from '../../functions/global-functions'
import FunctionEditorForm from './FunctionEditorForm.vue'

const props = defineProps<{
  /** 是否打开弹框；打开期间由本组件管理列表与编辑两种视图 */
  open: boolean
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

const ctx = useAppContext()
const doc = ctx.require<DocumentService>('document')
const engine = ctx.require<ExpressionEngine>('expression')

const version = ref(0)
const mode = ref<'list' | 'edit'>('list')
const editingIndex = ref<number | null>(null)
const pendingDelete = ref<number | null>(null)
const formKey = ref(0)
const closeButton = ref<HTMLButtonElement | null>(null)

let off: Disposable | null = null

onMounted(() => {
  off = doc.onDidChange(() => {
    version.value += 1
  })
})

onUnmounted(() => {
  off?.dispose()
  off = null
})

const functions = computed<readonly FunctionSchema[]>(() => {
  version.value
  return doc.model.schema.functions ?? []
})

/** 当前编辑条目的初始草稿；新建时是空草稿 */
const initialDraft = computed<FunctionDraft>(() => {
  const index = editingIndex.value
  const schema = index === null ? undefined : functions.value[index]
  return schema ? draftFromSchema(schema) : { ...EMPTY_FUNCTION_DRAFT }
})

/**
 * 当前作用域内已占用的名字。
 *
 * 页面函数之间不能重名；与全局函数重名同样拒绝，否则全局函数被页面覆盖后，
 * 在管理页修改它不会反映到当前页面，命名冲突会变得难以解释。
 */
const takenNames = computed<readonly string[]>(() => {
  const index = editingIndex.value
  const pageNames = functions.value
    .filter((_, position) => position !== index)
    .map((item) => item.name)
  return [...pageNames, ...globalFunctions.value.map((item) => item.name)]
})

function openCreate(): void {
  editingIndex.value = null
  formKey.value += 1
  mode.value = 'edit'
}

function openEdit(index: number): void {
  editingIndex.value = index
  formKey.value += 1
  mode.value = 'edit'
}

function backToList(): void {
  mode.value = 'list'
  editingIndex.value = null
  pendingDelete.value = null
}

function save(fn: FunctionSchema): void {
  const current = doc.model.schema.functions
  const index = editingIndex.value
  const list = current ?? []
  const next = index === null ? [...list, fn] : list.map((item, i) => (i === index ? fn : item))

  const patch: SchemaPatch =
    current === undefined
      ? { op: 'add', path: '/functions', value: next }
      : { op: 'replace', path: '/functions', value: next }

  doc.apply([patch], {
    record: true,
    label: index === null ? '新增页面函数' : '修改页面函数',
  })
  backToList()
}

function removeAt(index: number): void {
  const next = functions.value.filter((_, position) => position !== index)
  const patch: SchemaPatch =
    next.length === 0
      ? { op: 'remove', path: '/functions' }
      : { op: 'replace', path: '/functions', value: next }

  doc.apply([patch], { record: true, label: '删除页面函数' })
  pendingDelete.value = null
}

function requestClose(): void {
  emit('close')
}

// 每次重新打开都回到列表：上次停在编辑态会让用户以为弹框记住了草稿
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    backToList()
    await nextTick()
    closeButton.value?.focus()
  },
  { immediate: true },
)

function onKeydown(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  requestClose()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="lc-page-function" @mousedown.self="requestClose">
      <section
        class="lc-page-function__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-page-function-title"
      >
        <header class="lc-page-function__head">
          <div class="lc-page-function__heading">
            <h2 id="lc-page-function-title" class="lc-page-function__title">
              {{
                mode === 'edit'
                  ? editingIndex === null
                    ? '新建页面函数'
                    : '编辑页面函数'
                  : '页面函数'
              }}
            </h2>
            <p class="lc-page-function__subtitle">
              {{
                mode === 'edit'
                  ? '保存后写入当前页面 schema，只在本页表达式里可用。'
                  : '这里维护的函数只属于当前页面；需要跨页面复用时请到「函数管理」创建全局函数。'
              }}
            </p>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="lc-page-function__close"
            aria-label="关闭页面函数弹框"
            @click="requestClose"
          >
            ×
          </button>
        </header>

        <div class="lc-page-function__body">
          <template v-if="mode === 'list'">
            <div class="lc-page-function__toolbar">
              <span class="lc-page-function__count">共 {{ functions.length }} 个函数</span>
              <button type="button" class="lc-page-function__button" @click="openCreate">
                + 新建函数
              </button>
            </div>

            <div v-if="functions.length === 0" class="lc-page-function__empty">
              <span class="lc-page-function__empty-title">当前页面还没有自定义函数</span>
              <span>函数会注册到表达式引擎，可在模板、条件与事件表达式里按名字调用。</span>
            </div>

            <ul v-else class="lc-page-function__list">
              <li
                v-for="(fn, index) in functions"
                :key="`${fn.name}-${index}`"
                class="lc-page-function__item"
              >
                <div class="lc-page-function__item-main">
                  <div class="lc-page-function__item-head">
                    <code class="lc-page-function__name">
                      {{ fn.name }}({{ (fn.params ?? []).join(', ') }})
                    </code>
                    <span v-if="fn.title" class="lc-page-function__label">{{ fn.title }}</span>
                  </div>
                  <code class="lc-page-function__body-text">{{ functionBodyText(fn) }}</code>
                  <p v-if="fn.description" class="lc-page-function__desc">
                    {{ fn.description }}
                  </p>
                </div>

                <div class="lc-page-function__item-actions">
                  <template v-if="pendingDelete === index">
                    <span class="lc-page-function__confirm-text">删除？</span>
                    <button
                      type="button"
                      class="lc-page-function__button lc-page-function__button--danger"
                      @click="removeAt(index)"
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      class="lc-page-function__button"
                      @click="pendingDelete = null"
                    >
                      取消
                    </button>
                  </template>
                  <template v-else>
                    <button
                      type="button"
                      class="lc-page-function__button"
                      @click="openEdit(index)"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      class="lc-page-function__button lc-page-function__button--danger"
                      @click="pendingDelete = index"
                    >
                      删除
                    </button>
                  </template>
                </div>
              </li>
            </ul>
          </template>

          <FunctionEditorForm
            v-else
            :key="formKey"
            :initial="initialDraft"
            :engine="engine"
            :taken-names="takenNames"
            :submit-label="editingIndex === null ? '创建函数' : '保存修改'"
            @submit="save"
            @cancel="backToList"
          />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.lc-page-function {
  position: fixed;
  z-index: 1200;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(2, 8, 20, 0.72);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.lc-page-function *,
.lc-page-function *::before,
.lc-page-function *::after {
  box-sizing: border-box;
}

.lc-page-function__dialog {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: min(720px, calc(100vh - 48px));
  overflow: hidden;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow:
    0 0 0 1px rgba(47, 140, 255, 0.12),
    0 30px 80px rgba(0, 6, 18, 0.7);
  color: var(--lc-text);
}

.lc-page-function__head {
  display: flex;
  flex: none;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--lc-border);
  background: linear-gradient(180deg, rgba(47, 140, 255, 0.1), transparent);
}

.lc-page-function__heading {
  min-width: 0;
}

.lc-page-function__title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.lc-page-function__subtitle {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 11px;
  line-height: 1.55;
}

.lc-page-function__close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--lc-text-secondary);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.lc-page-function__close:hover {
  border-color: var(--lc-border);
  background: var(--lc-accent-soft);
  color: var(--lc-text);
}

.lc-page-function__body {
  flex: 1;
  min-height: 0;
  padding: 16px 20px 20px;
  overflow-y: auto;
}

.lc-page-function__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.lc-page-function__count {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-page-function__button {
  flex: none;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    color 0.15s ease,
    background-color 0.15s ease;
}

.lc-page-function__button:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-page-function__button--danger:hover {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-page-function__empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 36px 20px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: rgba(6, 17, 33, 0.5);
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

.lc-page-function__empty-title {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-page-function__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-page-function__item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: rgba(6, 17, 33, 0.55);
}

.lc-page-function__item-main {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.lc-page-function__item-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.lc-page-function__name {
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
}

.lc-page-function__label {
  overflow: hidden;
  color: var(--lc-text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-page-function__body-text {
  overflow: hidden;
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-page-function__desc {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.lc-page-function__item-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}

.lc-page-function__confirm-text {
  color: var(--lc-danger);
  font-size: 10px;
}

.lc-page-function :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-page-function__button {
    transition: none;
  }
}
</style>
