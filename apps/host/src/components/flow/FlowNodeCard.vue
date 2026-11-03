<script setup lang="ts">
import { computed } from 'vue'
import type { FlowNode } from '@lc/schema'
import { FLOW_BRANCH_TYPES, FLOW_END, FLOW_TRIGGER } from '@lc/schema'
import { flowNodeCategoryOf, flowNodeSize, flowNodeTone } from './constants/node-tone'

/**
 * 画布上的一个流程节点。
 *
 * 卡片自己不管指针：拖动、连线、选中全部由舞台的事件委托统一处理（见
 * `use-flow-canvas.ts` 的 `resolveTarget`），这里只负责把 `data-flow-node`
 * 与 `data-flow-port` 两个标记挂对位置。
 */
const props = defineProps<{
  /** 节点数据 */
  node: FlowNode
  /** 是否被选中 */
  selected: boolean
  /** 拉线时指针正悬停在本节点上，表示可以作为连线的另一端 */
  connectable: boolean
  /** 本次试运行里该节点的状态；未执行过时为 null */
  runState: 'success' | 'failed' | 'skipped' | null
}>()

const size = computed(() => flowNodeSize(props.node))

/** 菱形只作用于背景层：文字保持水平，否则条件节点的标题要歪着读 */
const isDiamond = computed(() => FLOW_BRANCH_TYPES.has(props.node.type))

const toneColor = computed(() => `var(${flowNodeTone(props.node)})`)

const shapeClass = computed(() => {
  if (props.node.type === FLOW_TRIGGER || props.node.type === FLOW_END) {
    return 'lc-flow-node--terminal'
  }

  return isDiamond.value ? 'lc-flow-node--diamond' : 'lc-flow-node--action'
})

const style = computed(() => ({
  left: `${props.node.position.x}px`,
  top: `${props.node.position.y}px`,
  width: `${size.value.width}px`,
  height: `${size.value.height}px`,
  '--lc-flow-node-tone': toneColor.value,
}))

const categoryClass = computed(() => `lc-flow-node--${flowNodeCategoryOf(props.node)}`)
</script>

<template>
  <div
    class="lc-flow-node"
    :class="[
      shapeClass,
      categoryClass,
      runState ? `lc-flow-node--${runState}` : null,
      { 'is-selected': selected, 'is-connectable': connectable },
    ]"
    :style="style"
    :data-flow-node="node.id"
    tabindex="0"
    role="button"
    :aria-label="`${node.name ?? node.id}，${node.description ?? ''}`"
    :aria-pressed="selected"
  >
    <!-- 菱形背景单独一层：clip-path 会把文字一起裁掉 -->
    <span v-if="isDiamond" class="lc-flow-node__shape" aria-hidden="true" />

    <span class="lc-flow-node__icon" aria-hidden="true">
      <span class="lc-flow-node__glyph" />
    </span>

    <span class="lc-flow-node__text">
      <span class="lc-flow-node__title">{{ node.name ?? node.id }}</span>
      <span v-if="node.description" class="lc-flow-node__desc">{{ node.description }}</span>
    </span>

    <span
      class="lc-flow-node__port lc-flow-node__port--in"
      data-flow-port="in"
      aria-hidden="true"
    />
    <span
      class="lc-flow-node__port lc-flow-node__port--out"
      data-flow-port="out"
      aria-hidden="true"
    />
  </div>
</template>
