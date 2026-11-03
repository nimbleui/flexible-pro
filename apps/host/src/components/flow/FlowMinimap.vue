<script setup lang="ts">
import { computed } from 'vue'
import type { useFlowCanvas } from './composables/use-flow-canvas'

/**
 * 小地图。
 *
 * 投影与反向换算都在 `use-flow-canvas` 里算好（那部分是纯几何，可单测），
 * 这里只做渲染与把点击坐标回传。组件不持有任何视口状态，避免出现第二个真相。
 */
const props = defineProps<{
  /** 画布句柄；只读取它的 minimap 计算结果 */
  canvas: ReturnType<typeof useFlowCanvas>
}>()

const emit = defineEmits<{ focus: [{ x: number; y: number }] }>()

const map = computed(() => props.canvas.minimap.value)

function onPointerDown(event: PointerEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  emit('focus', { x: event.clientX - rect.left, y: event.clientY - rect.top })
}
</script>

<template>
  <div
    v-if="map"
    class="lc-flow-minimap"
    :style="{ width: `${map.size.width}px`, height: `${map.size.height}px` }"
    aria-hidden="true"
    @pointerdown="onPointerDown"
  >
    <span
      v-for="node in map.nodes"
      :key="node.id"
      class="lc-flow-minimap__node"
      :style="{
        left: `${node.x}px`,
        top: `${node.y}px`,
        width: `${Math.max(node.width, 2)}px`,
        height: `${Math.max(node.height, 2)}px`,
      }"
    />
    <span
      class="lc-flow-minimap__viewport"
      :style="{
        left: `${map.viewportRect.x}px`,
        top: `${map.viewportRect.y}px`,
        width: `${Math.max(map.viewportRect.width, 4)}px`,
        height: `${Math.max(map.viewportRect.height, 4)}px`,
      }"
    />
  </div>
</template>
