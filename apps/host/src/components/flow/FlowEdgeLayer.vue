<script setup lang="ts">
import { computed } from 'vue'
import type { Point } from '@lc/contracts'
import type { FlowEdge } from '@lc/schema'
import { FLOW_BRANCH_FALSE, FLOW_BRANCH_TRUE } from '@lc/schema'
import type { EdgeRoute, FlowEdgeRunState } from './utils/edge-path'

/**
 * 连线层。
 *
 * 整块 SVG 挂在被视口矩阵变换的内容层里，所以路径直接用世界坐标写，缩放平移时
 * 只有外层一个 `transform` 变化。盒子取内容层的 100% 并放开 `overflow`：路径可能
 * 落在负坐标或超出图范围的地方；尺寸写成 0 会被 Chrome 按 0×0 视口整棵裁掉，
 * 表现是连线一条都画不出来，而 DOM 与命中测试看起来完全正常。
 *
 * 每条边渲染两个 path：一个可见细线，一个加宽的透明命中区。靠 `stroke-width`
 * 放大命中区而不是给线加粗，是因为 2px 的线在 100% 缩放下几乎点不中。
 */
const props = defineProps<{
  /** 全部连线 */
  edges: Record<string, FlowEdge>
  /** 连线 id → 布局结果 */
  routes: Map<string, EdgeRoute>
  /** 当前选中的连线 id */
  selectedEdgeId: string | null
  /** 连线在本次运行里的走向；没有走向的边保持默认色 */
  runStates: Record<string, FlowEdgeRunState>
  /** 正在拉出的临时连线 */
  pending: { from: Point; to: Point } | null
}>()

const emit = defineEmits<{ select: [edgeId: string] }>()

/**
 * 箭头跟着线一起换色。
 *
 * 每条边只挂一个共享 marker 的话，失败的红色线会顶着一只默认蓝箭头，读起来自相矛盾。
 * `context-stroke` 在各引擎上的支持时间不一致，所以按走向各留一只 marker。
 */
const MARKER_STATES: readonly FlowEdgeRunState[] = [
  'idle',
  'traversed',
  'skipped',
  'failed',
  'unreached',
]

/** 分支标签：作者写过的 label 优先，否则按分支标记给默认文案 */
function branchLabel(edge: FlowEdge): string {
  if (edge.label) return edge.label
  if (edge.branch === FLOW_BRANCH_TRUE) return '是'
  if (edge.branch === FLOW_BRANCH_FALSE) return '否'

  return edge.branch ?? ''
}

interface RenderedEdge {
  id: string
  d: string
  label: string
  labelAt: Point
  tone: 'true' | 'false' | 'plain'
  selected: boolean
  runState: FlowEdgeRunState
}

const rendered = computed<RenderedEdge[]>(() => {
  const list: RenderedEdge[] = []

  for (const edge of Object.values(props.edges)) {
    const route = props.routes.get(edge.id)
    if (!route) continue

    list.push({
      id: edge.id,
      d: route.d,
      label: branchLabel(edge),
      labelAt: route.labelAt,
      tone:
        edge.branch === FLOW_BRANCH_TRUE
          ? 'true'
          : edge.branch === FLOW_BRANCH_FALSE
            ? 'false'
            : 'plain',
      selected: props.selectedEdgeId === edge.id,
      runState: props.runStates[edge.id] ?? 'idle',
    })
  }

  return list
})

const pendingPath = computed(() => {
  if (!props.pending) return ''
  const { from, to } = props.pending

  return `M${from.x} ${from.y} L${to.x} ${to.y}`
})
</script>

<template>
  <svg class="lc-flow-edges" aria-hidden="true">
    <defs>
      <marker
        v-for="state in MARKER_STATES"
        :id="`lc-flow-arrow-${state}`"
        :key="state"
        markerWidth="9"
        markerHeight="9"
        refX="7"
        refY="4.5"
        orient="auto"
        markerUnits="userSpaceOnUse"
      >
        <path
          d="M0 0 L9 4.5 L0 9 Z"
          :class="`lc-flow-edges__arrow lc-flow-edges__arrow--${state}`"
        />
      </marker>
    </defs>

    <g v-for="edge in rendered" :key="edge.id" class="lc-flow-edges__group">
      <path
        class="lc-flow-edges__hit"
        :d="edge.d"
        @pointerdown.stop="emit('select', edge.id)"
      />
      <path
        class="lc-flow-edges__line"
        :class="[
          `lc-flow-edges__line--${edge.tone}`,
          {
            'is-selected': edge.selected,
            'is-active': edge.runState === 'traversed',
            'is-skipped': edge.runState === 'skipped',
            'is-failed': edge.runState === 'failed',
            'is-unreached': edge.runState === 'unreached',
          },
        ]"
        :d="edge.d"
        :marker-end="`url(#lc-flow-arrow-${edge.runState})`"
      />
      <g
        v-if="edge.label"
        class="lc-flow-edges__label"
        :transform="`translate(${edge.labelAt.x}, ${edge.labelAt.y})`"
      >
        <rect
          class="lc-flow-edges__label-bg"
          :class="`lc-flow-edges__label-bg--${edge.tone}`"
          x="-14"
          y="-11"
          width="28"
          height="22"
          rx="6"
        />
        <text class="lc-flow-edges__label-text" x="0" y="4" text-anchor="middle">
          {{ edge.label }}
        </text>
      </g>
    </g>

    <path v-if="pendingPath" class="lc-flow-edges__pending" :d="pendingPath" />
  </svg>
</template>
