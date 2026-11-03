<script setup lang="ts">
import { computed } from 'vue'
import type { FlowNode } from '@lc/schema'
import {
  FLOW_BRANCH_FALSE,
  FLOW_BRANCH_TRUE,
  FLOW_SWITCH,
  findFlowNodeType,
  isFlowBranchNode,
} from '@lc/schema'
import type { FlowEditorHandle } from './composables/use-flow-editor'
import {
  fieldDraftText,
  isTextOrEmpty,
  parseFieldDraft,
  useFlowFieldDraft,
} from './composables/use-flow-field-draft'

const props = defineProps<{
  /** 流程编辑器句柄 */
  editor: FlowEditorHandle
}>()

/** 条件节点的两条出边；文案与画布上的「是 / 否」标签一致 */
const BRANCH_OPTIONS: readonly { value: string; label: string }[] = [
  { value: FLOW_BRANCH_TRUE, label: '是' },
  { value: FLOW_BRANCH_FALSE, label: '否' },
]

const edge = computed(() => props.editor.selectedEdge.value)

const sourceNode = computed(() => {
  const current = edge.value

  return current ? props.editor.flow.value?.nodes[current.source] : undefined
})

const targetNode = computed(() => {
  const current = edge.value

  return current ? props.editor.flow.value?.nodes[current.target] : undefined
})

/** 源节点是否按判定结果挑出边；只有它才允许配置分支 */
const isBranchSource = computed(() => {
  const source = sourceNode.value

  return source ? isFlowBranchNode(source) : false
})

/** 多分支按表达式值匹配任意多条出边，分支值是自由文本而不是是 / 否 */
const isSwitchSource = computed(() => sourceNode.value?.type === FLOW_SWITCH)

const labelField = useFlowFieldDraft({
  display: () => fieldDraftText('text', edge.value?.label),
  parse: (text) => parseFieldDraft('text', text),
  commit: (value) => {
    const id = edge.value?.id
    if (!id || !isTextOrEmpty(value)) return
    props.editor.updateEdge(id, { label: value })
  },
})

const branchField = useFlowFieldDraft({
  display: () => fieldDraftText('text', edge.value?.branch),
  parse: (text) => parseFieldDraft('text', text),
  commit: (value) => {
    const id = edge.value?.id
    if (!id || !isTextOrEmpty(value)) return
    props.editor.updateEdge(id, { branch: value })
  },
})

const { draft: labelText, onInput: onLabelInput, commitDraft: commitLabel } = labelField

const { draft: branchText, onInput: onBranchInput, commitDraft: commitBranch } = branchField

function nodeLabel(node: FlowNode | undefined): string {
  if (!node) return '已删除的节点'

  return node.name ?? findFlowNodeType(node.type)?.title ?? node.id
}

/** 分支下拉：空串表示「无」，即普通后继边 */
function onBranchSelectChange(event: Event): void {
  const target = event.target
  const id = edge.value?.id
  if (!id || !(target instanceof HTMLSelectElement)) return

  props.editor.updateEdge(id, { branch: target.value || undefined })
}

function removeCurrentEdge(): void {
  const id = edge.value?.id
  if (!id) return
  props.editor.removeEdge(id)
}
</script>

<template>
  <p v-if="!edge" class="lc-flow-inspector__empty">请在画布选择一条连线</p>

  <div v-else class="lc-flow-inspector__pane">
    <div class="lc-flow-inspector__route">
      <span class="lc-flow-inspector__route-node">{{ nodeLabel(sourceNode) }}</span>
      <span class="lc-flow-inspector__route-arrow" aria-hidden="true">→</span>
      <span class="lc-flow-inspector__route-node">{{ nodeLabel(targetNode) }}</span>
    </div>

    <div class="lc-flow-inspector__form">
      <div class="lc-flow-inspector__field">
        <label class="lc-flow-inspector__field-label" for="lc-flow-edge-label">标签</label>
        <input
          id="lc-flow-edge-label"
          class="lc-flow-inspector__input"
          type="text"
          :value="labelText"
          placeholder="留空则按分支标记显示"
          @input="onLabelInput"
          @change="commitLabel"
          @blur="commitLabel"
        />
      </div>

      <div v-if="isBranchSource && isSwitchSource" class="lc-flow-inspector__field">
        <label class="lc-flow-inspector__field-label" for="lc-flow-edge-branch"
          >分支匹配值</label
        >
        <input
          id="lc-flow-edge-branch"
          class="lc-flow-inspector__input"
          type="text"
          :value="branchText"
          placeholder="与匹配表达式相等时走这条边"
          @input="onBranchInput"
          @change="commitBranch"
          @blur="commitBranch"
        />
        <small class="lc-flow-inspector__field-note">多分支按值选边，留空表示默认分支</small>
      </div>

      <div v-else-if="isBranchSource" class="lc-flow-inspector__field">
        <label class="lc-flow-inspector__field-label" for="lc-flow-edge-branch">分支</label>
        <select
          id="lc-flow-edge-branch"
          class="lc-flow-inspector__select"
          :value="edge.branch ?? ''"
          @change="onBranchSelectChange"
        >
          <option value="">无</option>
          <option v-for="option in BRANCH_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>
    </div>

    <button type="button" class="lc-flow-inspector__delete" @click="removeCurrentEdge">
      删除连线
    </button>
  </div>
</template>
