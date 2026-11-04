<script setup lang="ts">
import { computed } from 'vue'
import type { FlowEditorHandle } from './composables/use-flow-editor'
import type { useFlowCanvas } from './composables/use-flow-canvas'
import FlowEdgeLayer from './FlowEdgeLayer.vue'
import FlowMinimap from './FlowMinimap.vue'
import FlowNodeCard from './FlowNodeCard.vue'
import type { FlowEdgeRunState } from './utils/edge-path'
import './styles/canvas.css'

/**
 * 流程画布。
 *
 * 舞台只有一个子元素被 transform：内容层。节点与连线都写世界坐标，缩放 250% 时
 * 不会重算任何样式，这与设计器画布（`@lc/vue` 的 CanvasStage）是同一套做法。
 */
const props = defineProps<{
  /** 编辑器工作副本 */
  editor: FlowEditorHandle
  /** 视口与手势句柄 */
  canvas: ReturnType<typeof useFlowCanvas>
  /** 本次试运行里各节点的结果，用于给卡片描边着色；跑完后没访问的节点是 `unreached` */
  nodeRunStates: Record<string, string>
  /** 试运行正在执行的节点 id；没有则在 null，用于给该卡片加「执行中」动画 */
  currentNodeId: string | null
  /** 试运行是否还在推进；只有推进中连线才流动，跑完保留静态的成功色 */
  stepping: boolean
}>()

const emit = defineEmits<{ undo: []; redo: [] }>()

// 模板 ref 只能绑到 setup 作用域里的同名变量，所以把舞台引用取出来再交给模板
const stageRef = props.canvas.stageRef

const flow = computed(() => props.editor.flow.value)

const nodes = computed(() => (flow.value ? Object.values(flow.value.nodes) : []))

const edges = computed(() => (flow.value ? flow.value.edges : {}))

/**
 * 连线在本次运行里的走向。
 *
 * 执行器只逐步上报节点、不报边，所以「这条线走过没有」只能从两端状态推。两端都还没
 * 状态时不下结论（运行途中的下游只是「还没轮到」，此时保持默认色）；有一端是
 * `unreached` 就一定没走过——`unreached` 同样是状态，只按「有没有状态」判会让
 * `pass → end` 因为 end 执行过而被算成走过。
 * 目标的状态决定线的颜色：失败或跳过的节点若拖着一条成功绿的入边，读起来自相矛盾。
 */
const edgeRunStates = computed<Record<string, FlowEdgeRunState>>(() => {
  const map: Record<string, FlowEdgeRunState> = {}
  const current = flow.value
  if (!current) return map

  for (const [id, edge] of Object.entries(current.edges)) {
    const source = props.nodeRunStates[edge.source]
    const target = props.nodeRunStates[edge.target]
    if (!source || !target) continue
    if (source === 'unreached' || target === 'unreached') {
      map[id] = 'unreached'
      continue
    }

    if (target === 'failed') map[id] = 'failed'
    else if (target === 'skipped') map[id] = 'skipped'
    else map[id] = 'traversed'
  }

  return map
})

function runStateOf(nodeId: string): 'success' | 'failed' | 'skipped' | 'unreached' | null {
  const state = props.nodeRunStates[nodeId]

  return state === 'success' ||
    state === 'failed' ||
    state === 'skipped' ||
    state === 'unreached'
    ? state
    : null
}
</script>

<template>
  <div class="lc-flow-canvas" :class="{ 'is-stepping': stepping }">
    <div class="lc-flow-canvas__toolbar">
      <button
        type="button"
        class="lc-icon-button"
        aria-label="撤销"
        title="撤销（Ctrl+Z）"
        :disabled="!editor.canUndo.value"
        @click="emit('undo')"
      >
        <span class="lc-flow-canvas__glyph lc-flow-canvas__glyph--undo" />
      </button>
      <button
        type="button"
        class="lc-icon-button"
        aria-label="重做"
        title="重做（Ctrl+Shift+Z）"
        :disabled="!editor.canRedo.value"
        @click="emit('redo')"
      >
        <span class="lc-flow-canvas__glyph lc-flow-canvas__glyph--redo" />
      </button>
      <span class="lc-flow-canvas__divider" aria-hidden="true" />
      <button
        type="button"
        class="lc-icon-button"
        aria-label="放大"
        title="放大"
        @click="canvas.zoomBy(1.2)"
      >
        <span class="lc-flow-canvas__glyph lc-flow-canvas__glyph--zoom-in" />
      </button>
      <button
        type="button"
        class="lc-icon-button"
        aria-label="缩小"
        title="缩小"
        @click="canvas.zoomBy(1 / 1.2)"
      >
        <span class="lc-flow-canvas__glyph lc-flow-canvas__glyph--zoom-out" />
      </button>
      <button
        type="button"
        class="lc-icon-button"
        aria-label="适应画布"
        title="适应画布"
        @click="canvas.fitToScreen()"
      >
        <span class="lc-flow-canvas__glyph lc-flow-canvas__glyph--fit" />
      </button>
    </div>

    <!-- 钉死原生拖拽：Alt/Shift+拖动会被浏览器当成搬走选中内容的拖拽接管，
           一旦 dragstart 起来就只剩 pointercancel，按住 Alt 的拉线手势会整段丢掉 -->
    <div
      ref="stageRef"
      class="lc-flow-canvas__stage"
      data-flow-stage
      tabindex="0"
      aria-label="流程画布"
      @pointerdown="canvas.handlers.onPointerDown"
      @wheel="canvas.handlers.onWheel"
      @dragstart.prevent
    >
      <div class="lc-flow-canvas__grid" aria-hidden="true" />

      <div class="lc-flow-canvas__content" :style="{ transform: canvas.transform.value }">
        <FlowEdgeLayer
          :edges="edges"
          :routes="canvas.edgeRoutes.value"
          :selected-edge-id="editor.selectedEdgeId.value"
          :run-states="edgeRunStates"
          :pending="canvas.pendingEdge.value"
          @select="(id) => editor.selectEdge(id)"
        />

        <FlowNodeCard
          v-for="node in nodes"
          :key="node.id"
          :node="node"
          :selected="editor.selectedNodeId.value === node.id"
          :connectable="canvas.connectTargetId.value === node.id"
          :run-state="runStateOf(node.id)"
          :running="currentNodeId === node.id"
        />
      </div>
    </div>

    <div class="lc-flow-canvas__zoombar">
      <button
        type="button"
        class="lc-icon-button"
        aria-label="缩小"
        title="缩小"
        @click="canvas.zoomBy(1 / 1.2)"
      >
        <span class="lc-flow-canvas__glyph lc-flow-canvas__glyph--zoom-out" />
      </button>
      <span class="lc-flow-canvas__zoom">{{ canvas.zoomPercent.value }}%</span>
      <button
        type="button"
        class="lc-icon-button"
        aria-label="放大"
        title="放大"
        @click="canvas.zoomBy(1.2)"
      >
        <span class="lc-flow-canvas__glyph lc-flow-canvas__glyph--zoom-in" />
      </button>
      <button
        type="button"
        class="lc-icon-button"
        aria-label="适应画布"
        title="适应画布"
        @click="canvas.fitToScreen()"
      >
        <span class="lc-flow-canvas__glyph lc-flow-canvas__glyph--fit" />
      </button>
      <button
        type="button"
        class="lc-icon-button"
        aria-label="居中显示"
        title="居中显示"
        @click="canvas.centerGraph()"
      >
        <span class="lc-flow-canvas__glyph lc-flow-canvas__glyph--center" />
      </button>
      <span class="lc-flow-canvas__divider" aria-hidden="true" />
      <!-- Alt 起线是唯一能整卡拉线的入口，不写出来就没人知道有这条路 -->
      <span class="lc-flow-canvas__hint">按住 Alt 从卡片拖出连线</span>
    </div>

    <FlowMinimap :canvas="canvas" @focus="canvas.focusMinimapPoint" />
  </div>
</template>
