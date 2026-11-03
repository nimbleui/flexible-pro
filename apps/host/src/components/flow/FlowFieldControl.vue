<script setup lang="ts">
import { computed, inject } from 'vue'
import type { ActionFieldSchema, FlowNode } from '@lc/schema'
import { findFlowNodeType } from '@lc/schema'
import type { FlowEditorHandle } from './composables/use-flow-editor'
import {
  fieldDraftText,
  parseFieldDraft,
  useFlowFieldDraft,
} from './composables/use-flow-field-draft'

const props = defineProps<{
  /** 字段声明：决定控件形态、标题、必填与候选项 */
  field: ActionFieldSchema
  /** 文档里的当前值，即 `node.config[field.key]` */
  modelValue: unknown
  /** 所属节点 id；`action` 形态要按它排除自身 */
  nodeId: string
}>()

const emit = defineEmits<{
  /** 一次合法的字段提交；`undefined` 表示清空该键 */
  (event: 'commit', value: unknown): void
}>()

/**
 * 整份编辑器句柄，只有 `kind: 'action'` 的节点选择器需要它——它要列出图里其它节点。
 * 由 FlowInspector 提供，避免为一种控件形态把编辑器塞进每一层面板的 props。
 */
const editor = inject<Pick<FlowEditorHandle, 'flow'> | undefined>(
  'lc-flow-inspector:editor',
  undefined,
)

const {
  draft: draftText,
  error: draftError,
  onInput,
  commitDraft,
} = useFlowFieldDraft({
  display: () => fieldDraftText(props.field.kind, props.modelValue),
  parse: (text) => parseFieldDraft(props.field.kind, text),
  commit: (value) => emit('commit', value),
})

const inputId = computed(() => `lc-flow-${props.nodeId}-${props.field.key}`)

/** 文本类形态：值由草稿状态机管理，失焦或 change 时才提交 */
const isTextLike = computed(() => {
  const kind = props.field.kind

  return kind === 'text' || kind === 'number' || kind === 'expression' || kind === 'json'
})

/** 下拉的显示值；文档值与候选项同为字符串 */
const selectValue = computed(() => {
  const value = props.modelValue
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''

  return String(value)
})

/**
 * 文档值是否能在候选项里找到。
 *
 * 找不到时补一个「未选择」占位：历史数据与插件自定义取值都可能落在候选项之外，
 * 直接交给浏览器会显示成空白，作者看不出这个字段到底填了什么。
 */
const isSelectValueListed = computed(() =>
  (props.field.options ?? []).some((option) => option.value === selectValue.value),
)

/** `kind: 'action'` 的候选节点：排除自身，指向自己就是环 */
const nodeOptions = computed<{ value: string; label: string }[]>(() => {
  const flow = editor?.flow.value
  if (!flow) return []

  return Object.values(flow.nodes)
    .filter((node: FlowNode) => node.id !== props.nodeId)
    .map((node: FlowNode) => ({
      value: node.id,
      label: node.name ?? findFlowNodeType(node.type)?.title ?? node.id,
    }))
})

/** 选择类控件取值域由控件本身约束，选择即合法，不需要草稿 */
function onDirectChange(event: Event): void {
  const target = event.target

  if (props.field.kind === 'toggle') {
    if (!(target instanceof HTMLInputElement)) return
    emit('commit', target.checked)

    return
  }

  if (!(target instanceof HTMLSelectElement) || target.value === '') return
  emit('commit', target.value)
}
</script>

<template>
  <div class="lc-flow-inspector__field">
    <label class="lc-flow-inspector__field-label" :for="inputId">
      {{ field.label }}
      <em v-if="field.required" class="lc-flow-inspector__required">*</em>
    </label>

    <textarea
      v-if="field.kind === 'json'"
      :id="inputId"
      class="lc-flow-inspector__textarea"
      :value="draftText"
      :placeholder="field.placeholder"
      :rows="6"
      spellcheck="false"
      @input="onInput"
      @change="commitDraft"
      @blur="commitDraft"
    ></textarea>

    <input
      v-else-if="isTextLike"
      :id="inputId"
      class="lc-flow-inspector__input"
      :type="field.kind === 'number' ? 'number' : 'text'"
      :value="draftText"
      :placeholder="field.placeholder"
      @input="onInput"
      @change="commitDraft"
      @blur="commitDraft"
    />

    <select
      v-else-if="field.kind === 'select'"
      :id="inputId"
      class="lc-flow-inspector__select"
      :value="selectValue"
      @change="onDirectChange"
    >
      <option v-if="!isSelectValueListed" value="">未选择</option>
      <option v-for="option in field.options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>

    <select
      v-else-if="field.kind === 'action'"
      :id="inputId"
      class="lc-flow-inspector__select"
      :value="selectValue"
      @change="onDirectChange"
    >
      <option value="">未选择</option>
      <option v-for="option in nodeOptions" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>

    <span v-else-if="field.kind === 'toggle'" class="lc-flow-inspector__switch">
      <input
        :id="inputId"
        type="checkbox"
        :checked="modelValue === true"
        @change="onDirectChange"
      />
      <span aria-hidden="true"></span>
    </span>

    <p v-if="draftError" class="lc-flow-inspector__field-error">{{ draftError }}</p>
  </div>
</template>
