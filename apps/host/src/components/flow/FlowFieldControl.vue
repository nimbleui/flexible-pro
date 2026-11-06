<script setup lang="ts">
import { computed } from 'vue'
import type { ActionFieldSchema, RefOption } from '@lc/schema'
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
  /** 所属节点 id；参与控件 id，保证同页多个节点不会撞出重复 label 关联 */
  nodeId: string
  /**
   * 引用型字段的候选。
   *
   * 由父面板算好传入而不是在这里现取：候选来自页面存储、物料注册表与流程仓库三处，
   * 本控件保持「给什么候选就渲染什么」，才能脱服务单测。
   */
  refOptions?: readonly RefOption[]
}>()

const emit = defineEmits<{
  /** 一次合法的字段提交；`undefined` 表示清空该键 */
  (event: 'commit', value: unknown): void
}>()

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

/** 多选引用字段的当前值；非数组的历史数据按空处理 */
const multiValue = computed<string[]>(() =>
  Array.isArray(props.modelValue)
    ? props.modelValue.filter((item): item is string => typeof item === 'string')
    : [],
)

/**
 * 当前下拉该列哪些候选。
 *
 * `select` 的候选写在协议里（`field.options`），`ref` 的候选由调用方传入，
 * 两者在渲染上是同一个下拉，所以在这里收成一个值，模板不必分两个分支。
 */
const choices = computed<readonly RefOption[]>(() =>
  props.field.kind === 'ref' ? (props.refOptions ?? []) : (props.field.options ?? []),
)

/**
 * 文档值是否能在候选项里找到。
 *
 * 找不到时补一个「未选择」占位：历史数据与插件自定义取值都可能落在候选项之外，
 * 直接交给浏览器会显示成空白，作者看不出这个字段到底填了什么。未填时值为空串，
 * 同样落不进候选，因此这条占位也兼作「还没选」的显示。
 */
const isSelectValueListed = computed(() =>
  choices.value.some((option) => option.value === selectValue.value),
)

/** 选择类控件取值域由控件本身约束，选择即合法，不需要草稿 */
function onDirectChange(event: Event): void {
  const target = event.target

  if (props.field.kind === 'toggle') {
    if (!(target instanceof HTMLInputElement)) return
    emit('commit', target.checked)

    return
  }

  if (!(target instanceof HTMLSelectElement)) return

  // 多选引用交回选中项集合；清空是合法操作，落 [] 而不是删键
  if (props.field.multiple) {
    emit('commit', [...target.selectedOptions].map((option) => option.value).filter(Boolean))
    return
  }

  if (target.value === '') return
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
      v-else-if="field.kind === 'select' || field.kind === 'ref'"
      :id="inputId"
      :multiple="field.multiple"
      :size="field.multiple ? 4 : 1"
      class="lc-flow-inspector__select"
      @change="onDirectChange"
    >
      <option v-if="!isSelectValueListed" value="" :selected="!selectValue">未选择</option>
      <option
        v-for="option in choices"
        :key="option.value"
        :value="option.value"
        :selected="
          field.multiple ? multiValue.includes(option.value) : option.value === selectValue
        "
        :title="option.description"
      >
        {{ option.label }}
      </option>
      <!-- 引用来源为空时留一条说明：让作者知道是「先选上一项」而不是功能坏了 -->
      <option v-if="field.kind === 'ref' && choices.length === 0" value="" disabled>
        暂无可选，请先确定上游项
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
