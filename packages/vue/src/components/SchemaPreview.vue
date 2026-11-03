<script setup lang="ts">
import type { Component, CSSProperties, PropType } from 'vue'
import {
  computed,
  defineComponent,
  h,
  markRaw,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from 'vue'
import type { Point, RendererService } from '@lc/contracts'
import type { ExpressionEngine, NodeSchema, Rect } from '@lc/schema'
import { useAppContext } from '../context'
import { buildRenderTree } from '../render/tree'
import type { RenderNode } from '../render/tree'

/**
 * 节点图预览渲染器。
 *
 * 与 `CanvasStage` 的区别是它不认识画布微内核：没有视口矩阵、没有拖拽与覆盖层，
 * 只把一份节点图按内容包围盒等比缩放进容器。因此同一个渲染路径既能在组件管理页
 * 出图，也能作为复合物料在画布节点框内出图，两者不会出现「预览能跑、画布不认」的分歧。
 */

const props = withDefaults(
  defineProps<{
    /** 蓝图根节点 id */
    nodeId: string
    /**
     * 蓝图节点表。
     *
     * props 是浅响应，就地改内部字段不会触发重渲染：调用方更新蓝图时必须整体替换引用。
     */
    nodes: Record<string, NodeSchema>
    /** 求值作用域；复合物料把自己的属性放在 `props` 命名空间下传入 */
    scope?: Record<string, unknown>
  }>(),
  { scope: undefined },
)

/** 容器实测尺寸；只做缩放计算，不参与布局 */
interface Size {
  /** 可用宽度（px） */
  width: number
  /** 可用高度（px） */
  height: number
}

const ctx = useAppContext()
const renderer = ctx.require<RendererService>('renderer')
const expression = ctx.require<ExpressionEngine>('expression')

const rootRef = ref<HTMLElement | null>(null)
const container = ref<Size>({ width: 0, height: 0 })

const tree = computed<RenderNode[]>(() =>
  buildRenderTree({
    schema: { nodeId: props.nodeId, nodes: props.nodes },
    scope: props.scope ?? {},
    resolveValue: expression.resolveValue,
  }),
)

/**
 * 内容包围盒：所有渲染实例世界矩形的并集。
 *
 * 蓝图里的 rect 是世界坐标，节点可能整体偏移在原点之外；这里求出并集矩形，
 * 既作为坐标补偿的原点，也作为缩放基准，预览与运行时都能把内容完整框住。
 */
const contentBox = computed<Rect>(() => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  const walk = (items: readonly RenderNode[]): void => {
    for (const item of items) {
      minX = Math.min(minX, item.rect.x)
      minY = Math.min(minY, item.rect.y)
      maxX = Math.max(maxX, item.rect.x + item.rect.width)
      maxY = Math.max(maxY, item.rect.y + item.rect.height)
      walk(item.children)
    }
  }
  walk(tree.value)

  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
})

const contentOrigin = computed<Point>(() => ({ x: contentBox.value.x, y: contentBox.value.y }))

/** 等比缩放比：内容或容器尺寸未测得时保持 1:1，避免首帧把内容缩成 0 */
const scale = computed<number>(() => {
  const box = contentBox.value
  if (box.width <= 0 || box.height <= 0) return 1
  if (container.value.width <= 0 || container.value.height <= 0) return 1
  return Math.min(container.value.width / box.width, container.value.height / box.height)
})

const layerStyle = computed<CSSProperties>(() => {
  const box = contentBox.value
  const ratio = scale.value
  return {
    width: `${box.width}px`,
    height: `${box.height}px`,
    // translate 在 scale 之前应用，缩放以图层左上角为原点，居中偏移量按缩放后的尺寸计算
    transform: `translate(${(container.value.width - box.width * ratio) / 2}px, ${(container.value.height - box.height * ratio) / 2}px) scale(${ratio})`,
  }
})

/** 已解析的物料组件；null 表示解析完成但该物料不存在，渲染占位框 */
const components = reactive(new Map<string, Component | null>())

// 只做并发去重，不参与渲染，因此故意不放进响应式系统
const loading = new Set<string>()

/** 为渲染树里出现的组件名解析物料；已缓存或正在解析的名字跳过 */
function ensureMaterials(items: readonly RenderNode[]): void {
  for (const item of items) {
    const name = item.node.componentName
    if (!components.has(name) && !loading.has(name)) {
      loading.add(name)
      void renderer.resolveMaterial(name).then((component) => {
        // 契约层返回 unknown（不依赖 Vue），适配层在此收窄为 Component
        components.set(name, component ? markRaw(component as Component) : null)
        loading.delete(name)
      })
    }
    ensureMaterials(item.children)
  }
}

watch(tree, ensureMaterials, { immediate: true })

/**
 * 节点样式：世界矩形减去包围盒原点。
 *
 * 与 `CanvasStage` 同样的坐标补偿口径：蓝图里的 rect 保持世界坐标，
 * DOM 层级只负责裁剪与层叠，改一层嵌套不会影响其余节点的视觉位置。
 * 这里不写 `data-node-id`：预览子树不属于任何文档，带上节点 id 会让图层面板
 * 与画布的选择逻辑把蓝图内部节点误认成文档节点。
 */
function nodeStyle(item: RenderNode, origin: Point): CSSProperties {
  const rect = item.rect
  return {
    ...(item.node.style as CSSProperties | undefined),
    position: 'absolute',
    left: `${rect.x - origin.x}px`,
    top: `${rect.y - origin.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    zIndex: item.node.layout?.zIndex,
    transform: item.node.layout?.rotate ? `rotate(${item.node.layout.rotate}deg)` : undefined,
    display: item.visible ? undefined : 'none',
  }
}

function renderNode(item: RenderNode, origin: Point): ReturnType<typeof h> {
  const material = components.get(item.node.componentName) ?? null
  const children = item.children.length
    ? h(NodeTree, {
        key: 'children',
        items: item.children,
        origin: { x: item.rect.x, y: item.rect.y },
      })
    : null

  return h(
    'div',
    {
      key: item.key,
      class: 'lc-preview__node',
      style: nodeStyle(item, origin),
    },
    [
      material
        ? h(material, item.props)
        : h('div', { class: 'lc-preview__placeholder' }, item.node.componentName),
      children,
    ],
  )
}

/** 递归节点树：渲染树已求值，这里只负责 DOM 与坐标补偿 */
const NodeTree = defineComponent({
  name: 'LcPreviewNodeTree',
  props: {
    items: { type: Array as PropType<RenderNode[]>, required: true },
    origin: { type: Object as PropType<Point>, required: true },
  },
  setup(treeProps) {
    return () => treeProps.items.map((item) => renderNode(item, treeProps.origin))
  },
})

let observer: ResizeObserver | null = null

onMounted(() => {
  const element = rootRef.value
  if (!element) return

  // 首帧同步量一次：ResizeObserver 的回调可能晚于第一次绘制，没有初值会先按 1:1 出图
  container.value = { width: element.clientWidth, height: element.clientHeight }

  observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect
    if (!box) return
    container.value = { width: box.width, height: box.height }
  })
  observer.observe(element)
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <div ref="rootRef" class="lc-preview">
    <div class="lc-preview__layer" :style="layerStyle">
      <NodeTree :items="tree" :origin="contentOrigin" />
    </div>
  </div>
</template>

<style scoped>
.lc-preview {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.lc-preview__layer {
  position: absolute;
  inset: 0 auto auto 0;
  transform-origin: 0 0;
  will-change: transform;
}

.lc-preview__node {
  box-sizing: border-box;
}

.lc-preview__placeholder {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--lc-border-strong);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface);
  color: var(--lc-text-secondary);
  font-size: 12px;
}
</style>
