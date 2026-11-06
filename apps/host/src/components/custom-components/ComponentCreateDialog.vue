<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import ComponentDefinitionForm from './ComponentDefinitionForm.vue'
import {
  EMPTY_COMPONENT_DRAFT,
  definitionsFromDraft,
  eventsFromDraft,
  metaFromDraft,
  slotsFromDraft,
} from '../../custom-components/component-draft'
import { initialComponentSchema } from '../../custom-components/blueprint-document'
import { saveCustomComponent } from '../../custom-components/custom-components'

/**
 * 新建组件弹框。
 *
 * 先把「组件对外的样子」定下来：名称、分组、属性、事件，确认后才进画布搭结构。
 * 顺序反过来会更糟——先画蓝图再补名字，属性名与 `{{ props.xxx }}` 的引用就对不上了。
 *
 * 确认后立刻落库并带上起始蓝图，因此取消画布编辑也不会丢定义：列表里会留下这条组件，
 * 可以继续编辑或直接删除。
 */

const props = defineProps<{
  /** 是否打开弹框 */
  open: boolean
  /** 已被占用的物料名；新建时全部算占用 */
  takenNames: readonly string[]
  /** 新建组件归属哪个项目；由列表页从路由参数传进来，弹框自己不认识路由 */
  projectId: string
}>()

const emit = defineEmits<{
  (event: 'close'): void
  /** 定义已落库；外壳据此跳进画布 */
  (event: 'created', componentId: string): void
}>()

const form = ref<InstanceType<typeof ComponentDefinitionForm> | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
/** 每次打开都重挂表单：上一次的半成品不该跟着下一次新建 */
const formKey = ref(0)
const error = ref('')

watch(
  () => props.open,
  (open) => {
    if (!open) return

    formKey.value += 1
    error.value = ''
    void nextTick(() => closeButton.value?.focus())
  },
)

function requestClose(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return

  event.preventDefault()
  requestClose()
}

onMounted(() => window.addEventListener('keydown', onKeydown))

onUnmounted(() => window.removeEventListener('keydown', onKeydown))

function confirm(): void {
  if (!form.value) return

  const issues = form.value.validate()
  if (issues.length > 0) {
    error.value = `定义表还有 ${issues.length} 处需要修正。`
    return
  }

  const draft = form.value.snapshot()
  try {
    const saved = saveCustomComponent({
      definition: initialComponentSchema({
        meta: metaFromDraft(draft),
        props: definitionsFromDraft(draft.props),
        events: eventsFromDraft(draft.events),
        slots: slotsFromDraft(draft.slots),
      }),
      projectId: props.projectId,
    })
    emit('created', saved.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="lc-component-create" @mousedown.self="requestClose">
      <section
        class="lc-component-create__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-component-create-title"
      >
        <header class="lc-component-create__head">
          <div class="lc-component-create__heading">
            <h2 id="lc-component-create-title" class="lc-component-create__title">
              新建自定义组件
            </h2>
            <p class="lc-component-create__subtitle">
              先定名字与对外接口，确认后进入画布搭蓝图。属性与事件之后也能在画布右侧「组件定义」里改。
            </p>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="lc-component-create__close"
            aria-label="关闭新建组件弹框"
            @click="requestClose"
          >
            ×
          </button>
        </header>

        <div class="lc-component-create__body">
          <p v-if="error" class="lc-component-create__error" role="alert">{{ error }}</p>

          <ComponentDefinitionForm
            :key="formKey"
            ref="form"
            :initial="EMPTY_COMPONENT_DRAFT"
            :taken-names="takenNames"
          />
        </div>

        <footer class="lc-component-create__foot">
          <button type="button" class="lc-component-create__button" @click="requestClose">
            取消
          </button>
          <button
            type="button"
            class="lc-component-create__button lc-component-create__button--primary"
            @click="confirm"
          >
            保存并进入画布
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.lc-component-create {
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

.lc-component-create *,
.lc-component-create *::before,
.lc-component-create *::after {
  box-sizing: border-box;
}

.lc-component-create__dialog {
  display: flex;
  flex-direction: column;
  width: min(680px, 100%);
  max-height: min(760px, calc(100vh - 48px));
  overflow: hidden;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow:
    0 0 0 1px rgba(47, 140, 255, 0.12),
    0 30px 80px rgba(0, 6, 18, 0.7);
  color: var(--lc-text);
}

.lc-component-create__head {
  display: flex;
  flex: none;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-component-create__title {
  margin: 0 0 6px;
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-component-create__subtitle {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 11px;
  line-height: 1.6;
}

.lc-component-create__close {
  flex: none;
  width: 26px;
  height: 26px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.lc-component-create__close:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-component-create__body {
  flex: 1;
  min-height: 0;
  padding: 14px 20px;
  overflow-y: auto;
}

.lc-component-create__error {
  margin: 0 0 10px;
  padding: 6px 8px;
  border: 1px solid var(--lc-danger-border);
  border-radius: 6px;
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 11px;
}

.lc-component-create__foot {
  display: flex;
  flex: none;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--lc-border);
}

.lc-component-create__button {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: 8px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-component-create__button:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-component-create__button--primary {
  border-color: var(--lc-accent);
  background: linear-gradient(150deg, var(--lc-accent-bright), var(--lc-accent));
  color: #04101f;
  font-weight: 600;
}

.lc-component-create :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 720px) {
  .lc-component-create__head,
  .lc-component-create__body,
  .lc-component-create__foot {
    padding-right: 14px;
    padding-left: 14px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-component-create__button,
  .lc-component-create__close {
    transition: none;
  }
}
</style>
