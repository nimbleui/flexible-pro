<script setup lang="ts">
import { computed } from 'vue'
import type { ValueTypeKind } from '@lc/schema'
import type { NamedTypeOption, TypeNodeDraft } from './type-node'
import {
  TYPE_KIND_OPTIONS,
  createTypeNode,
  isLeafKind,
  typeNodeFromValueType,
} from './type-node'
import FilterSelect from './FilterSelect.vue'
import type { FilterSelectOption } from './filter-select'

defineOptions({ name: 'LcTypeNodeEditor' })

const props = withDefaults(
  defineProps<{
    /** 直接编辑的草稿节点；父级持有同一份响应式对象 */
    node: TypeNodeDraft
    /** 是否显示名称输入（对象字段、函数形参） */
    showName?: boolean
    /** 是否显示示例/默认值输入 */
    showValue?: boolean
    /** 当前嵌套深度，用于限制递归 */
    depth?: number
    /** 是否显示删除按钮 */
    removable?: boolean
    /** 页面里已定义的变量、接口结果与函数类型 */
    typeOptions?: readonly NamedTypeOption[]
  }>(),
  {
    showName: false,
    showValue: false,
    depth: 0,
    removable: false,
    typeOptions: () => [],
  },
)

const emit = defineEmits<{
  (event: 'remove'): void
}>()

const MAX_DEPTH = 5

function onKindChange(node: TypeNodeDraft): void {
  if (node.kind === 'array' && !node.item) {
    node.item = createTypeNode('', 'unknown')
  }
  if (node.kind !== 'object' && node.kind !== 'array') {
    node.fields = []
    node.item = undefined
  }
}

function addField(node: TypeNodeDraft): void {
  node.fields.push(createTypeNode('', 'unknown'))
}

function applyPreset(node: TypeNodeDraft, option: NamedTypeOption): void {
  const copied = typeNodeFromValueType(node.name, option.type, option.sample)

  // 名称与已填说明属于当前字段，不因引用类型而被覆盖
  copied.description = node.description || copied.description

  node.kind = copied.kind
  node.description = copied.description
  node.valueText = copied.valueText
  node.fields = copied.fields
  node.item = copied.item
  node.optional = copied.optional
  node.nullable = copied.nullable
}

const typeSelectOptions = computed<FilterSelectOption[]>(() => [
  ...TYPE_KIND_OPTIONS.map((option) => ({
    value: `kind:${option.value}`,
    label: option.label,
    group: '基础类型',
  })),
  ...props.typeOptions.map((option) => ({
    value: `preset:${option.id}`,
    label: option.label,
    group: '已定义类型',
  })),
])

function onTypeSelectValue(node: TypeNodeDraft, value: string): void {
  if (value.startsWith('kind:')) {
    node.kind = value.slice('kind:'.length) as ValueTypeKind
    onKindChange(node)
    return
  }

  if (value.startsWith('preset:')) {
    const option = props.typeOptions.find((item) => item.id === value.slice('preset:'.length))
    if (option) applyPreset(node, option)
  }
}

function valuePlaceholder(kind: ValueTypeKind): string {
  if (kind === 'string') return '示例文本'
  if (kind === 'number') return '如 1'
  if (kind === 'boolean') return 'true / false'
  return 'JSON 或文本'
}
</script>

<template>
  <div class="lc-type-node">
    <div class="lc-type-node__row">
      <input
        v-if="showName"
        v-model="node.name"
        class="lc-type-node__name"
        type="text"
        autocomplete="off"
        placeholder="名称"
      />

      <FilterSelect
        class="lc-type-node__kind"
        :model-value="`kind:${node.kind}`"
        :options="typeSelectOptions"
        :aria-label="showName ? `${node.name || '字段'}类型` : '类型'"
        @update:model-value="onTypeSelectValue(node, $event)"
      />

      <input
        v-model="node.description"
        class="lc-type-node__description"
        type="text"
        autocomplete="off"
        placeholder="说明"
      />

      <input
        v-if="showValue && isLeafKind(node.kind)"
        v-model="node.valueText"
        class="lc-type-node__value"
        type="text"
        autocomplete="off"
        :placeholder="valuePlaceholder(node.kind)"
      />

      <button
        v-if="removable"
        type="button"
        class="lc-type-node__remove"
        aria-label="删除字段"
        title="删除字段"
        @click="emit('remove')"
      >
        ×
      </button>
    </div>

    <div v-if="node.kind === 'object'" class="lc-type-node__children">
      <LcTypeNodeEditor
        v-for="(child, index) in node.fields"
        :key="index"
        :node="child"
        show-name
        :show-value="showValue"
        :depth="props.depth + 1"
        :type-options="props.typeOptions"
        removable
        @remove="node.fields.splice(index, 1)"
      />

      <button
        v-if="props.depth < MAX_DEPTH"
        type="button"
        class="lc-type-node__add"
        @click="addField(node)"
      >
        + 字段
      </button>
      <span v-else class="lc-type-node__hint">嵌套已达上限</span>
    </div>

    <div v-else-if="node.kind === 'array'" class="lc-type-node__item">
      <span class="lc-type-node__item-label">元素</span>

      <LcTypeNodeEditor
        v-if="node.item"
        :node="node.item"
        :show-value="showValue"
        :depth="props.depth + 1"
        :type-options="props.typeOptions"
      />
      <button
        v-else
        type="button"
        class="lc-type-node__add"
        @click="node.item = createTypeNode('', 'unknown')"
      >
        设置元素类型
      </button>
    </div>
  </div>
</template>

<style scoped>
.lc-type-node {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.lc-type-node__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.lc-type-node__row input,
.lc-type-node__row select {
  box-sizing: border-box;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
}

.lc-type-node__name {
  flex: 0 0 108px;
}

.lc-type-node__kind {
  flex: 0 0 104px;
}

.lc-type-node__description {
  flex: 1 1 130px;
  min-width: 80px;
}

.lc-type-node__value {
  flex: 1 1 110px;
  min-width: 76px;
}

.lc-type-node__row input:focus,
.lc-type-node__row select:focus {
  border-color: var(--lc-accent);
  outline: 1px solid var(--lc-accent);
}

.lc-type-node__remove {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.lc-type-node__remove:hover {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-type-node__children {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-left: 10px;
  padding-left: 9px;
  border-left: 1px solid var(--lc-border);
}

.lc-type-node__item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-left: 10px;
  padding-left: 9px;
  border-left: 1px solid var(--lc-border);
}

.lc-type-node__item-label {
  color: var(--lc-text-muted);
  font-size: 10px;
}

.lc-type-node__add {
  align-self: flex-start;
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--lc-border);
  border-radius: 5px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 10px;
  cursor: pointer;
}

.lc-type-node__add:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-type-node__hint {
  color: var(--lc-text-muted);
  font-size: 10px;
}

.lc-type-node :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}
</style>
