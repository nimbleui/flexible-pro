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
import type { SlotContent } from '../slot-content'
import { useAppContext } from '../context'
import { resolveRects } from '../render/constraints'
import { outletSlotNames, renderableSlots } from '../render/slots'
import { buildRenderTree } from '../render/tree'
import type { RenderNode } from '../render/tree'

/**
 * 节点图渲染器（预览与复合物料共用）。
 *
 * 与 `CanvasStage` 的区别是它不认识画布微内核：没有视口矩阵、拖拽与覆盖层。
 * 两种用法靠 `fit` 区分：
 * - `fit: true`（组件管理页预览）：按容器等比缩放出整张蓝图，纯粹是**视图缩放**，
 *   不改变任何几何数据，等价于设计器里的"缩小看全貌"；
 * - `fit: false`（复合物料在画布上）：容器就是实例的真实尺寸，节点按
 *   `layout.constraints` 重排。改实例大小 = 改组件本身，而不是把图片放大。
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
    /**
     * 页面填进本实例的具名插槽内容。
     *
     * 内容节点自带「相对实例原点」的绝对定位，因此渲染在**不参与重排与缩放**的覆盖层里：
     * 槽位内容归页面所有，组件改尺寸不该挪动使用者摆下的位置（与 Webflow 等工具的
     * slot 语义一致）。组件管理页的预览没有实例，留空即可，出口只显示占位。
     */
    content?: SlotContent
    /** 视图等比缩放 @default true */
    fit?: boolean
  }>(),
  { scope: undefined, content: undefined, fit: true },
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

/**
 * 要渲染的内容插槽。
 *
 * 蓝图声明了出口就只渲染出口对应的格子，一个出口都没有时全部内容照旧渲染：
 * 「忘了放出口」不该让页面内容凭空消失，那属于可恢复的配置遗漏而不是有意隐藏。
 */
const visibleSlots = computed<readonly string[]>(() => {
  const content = props.content
  if (!content) return []
  return renderableSlots(outletSlotNames(props.nodes), Object.keys(content))
})

/**
 * 插槽内容层。
 *
 * 直接把内容的 VNode 摊平成片段挂在本组件根节点下：这些节点自带相对实例原点的
 * 绝对定位，外面再套一层 div 会让它们的坐标基准偏移一整个盒子。
 */
const ContentLayer = defineComponent({
  name: 'LcPreviewContent',
  props: {
    names: { type: Array as PropType<readonly string[]>, required: true },
    content: { type: Object as PropType<SlotContent>, required: true },
  },
  setup(layerProps) {
    return () => layerProps.names.flatMap((name) => layerProps.content[name]?.() ?? [])
  },
})

const tree = computed<RenderNode[]>(() =>
  buildRenderTree({
    schema: { nodeId: props.nodeId, nodes: props.nodes },
    scope: props.scope ?? {},
    resolveValue: expression.resolveValue,
  }),
)

/**
 * 蓝图设计盒：所有渲染实例世界矩形的并集。
 *
 * 蓝图里的 rect 是世界坐标，节点可能整体偏移在原点之外；这里求出并集矩形，
 * 既是约束重排的"设计时父容器"，也是视图缩放与居中偏移的基准。
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

/**
 * 目标盒子：`fit` 模式下等于蓝图设计盒（几何不动，只靠视图缩放显示），
 * 非 `fit` 模式下等于实测容器盒（实例真实尺寸，交给约束重排）。
 */
const targetBox = computed<Rect>(() => {
  const box = contentBox.value
  if (props.fit) return box

  return { x: 0, y: 0, width: container.value.width, height: container.value.height }
})

/** 每个节点解析后的实际矩形；key 用渲染 key，循环实例因此各自独立 */
const resolved = computed<Map<string, Rect>>(() =>
  resolveRects(tree.value, contentBox.value, targetBox.value, props.nodeId),
)

const layerOrigin = computed<Point>(() => ({ x: targetBox.value.x, y: targetBox.value.y }))

/** 视图缩放比：只在 `fit` 模式下生效；尺寸未测得时保持 1:1，避免首帧缩成 0 */
const viewScale = computed<number>(() => {
  if (!props.fit) return 1
  const box = contentBox.value
  if (box.width <= 0 || box.height <= 0) return 1
  if (container.value.width <= 0 || container.value.height <= 0) return 1
  return Math.min(container.value.width / box.width, container.value.height / box.height)
})

const layerStyle = computed<CSSProperties>(() => {
  const box = targetBox.value
  const ratio = viewScale.value
  return {
    width: `${box.width}px`,
    height: `${box.height}px`,
    // translate 在 scale 之前应用：缩放以图层左上角为原点，居中偏移按缩放后的尺寸计算
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
 * 节点样式：解析后的矩形减去父级解析后的原点。
 *
 * 与 `CanvasStage` 同样的坐标补偿口径，只是这里的矩形已经过约束重排：
 * 子节点相对父节点的局部量由 `resolveRects` 算好，DOM 层只负责裁剪与层叠。
 * 这里不写 `data-node-id`：预览子树不属于任何文档，带上节点 id 会让图层面板
 * 与画布的选择逻辑把蓝图内部节点误认成文档节点。
 */
function nodeStyle(item: RenderNode, origin: Point): CSSProperties {
  const rect = resolved.value.get(item.key) ?? item.rect
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
  const rect = resolved.value.get(item.key) ?? item.rect
  const children = item.children.length
    ? h(NodeTree, {
        key: 'children',
        items: item.children,
        origin: { x: rect.x, y: rect.y },
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
      <NodeTree :items="tree" :origin="layerOrigin" />
    </div>

    <!-- 槽位内容不参与重排：页面摆在哪，这里就落在哪 -->
    <ContentLayer
      v-if="props.content && visibleSlots.length"
      :names="visibleSlots"
      :content="props.content"
    />
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
