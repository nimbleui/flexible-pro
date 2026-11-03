<script setup lang="ts">
import type { CSSProperties, Component, PropType } from 'vue'
import {
  computed,
  defineComponent,
  h,
  markRaw,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  shallowRef,
} from 'vue'
import type {
  CanvasContext,
  CanvasDropPayload,
  CanvasService,
  DataSourceService,
  DocumentService,
  Point,
  RendererService,
} from '@lc/contracts'
import { CANVAS_DROP_PREVIEW_SETTING, materialNameFromDragTypes } from '@lc/contracts'
import type { ExpressionEngine } from '@lc/schema'
import { buildPageData } from '@lc/schema'
import { buildRenderTree } from '../render/tree'
import type { RenderNode } from '../render/tree'
import LayerHost from './LayerHost.vue'

const props = defineProps<{
  /** 画布 Realm 上下文；document / selection / canvas 均在作用域内 */
  context: CanvasContext
  /**
   * 宿主注入的额外表达式作用域，例如 `$route` / `$params` / `$query`。
   *
   * 页面自身的 `data` 与 `page` 由本组件按 schema 装配，不能被宿主覆盖。
   */
  scope?: Record<string, unknown>
}>()

const canvas = props.context.require<CanvasService>('canvas')
const document = props.context.require<DocumentService>('document')
const renderer = props.context.require<RendererService>('renderer')
const expression = props.context.require<ExpressionEngine>('expression')
const dataSource = props.context.get<DataSourceService>('dataSource')

const rootRef = ref<HTMLElement | null>(null)

// 内容层 transform：由 scheduler 帧回调整体替换，不用 computed——
// 视口变化频率高，集中在一帧提交可避免每个事件都触发一次渲染
const matrix = shallowRef('matrix(1, 0, 0, 1, 0, 0)')

// 文档服务不是响应式源，用自增计数把 onDidChange 桥接成 Vue 依赖
const docVersion = ref(0)

// 数据源状态同样不是响应式源；loading/error/loaded 变化需要触发重渲染
const dataVersion = ref(0)

const components = reactive(new Map<string, Component | null>())

// 只做并发去重，不参与渲染，因此故意不放进响应式系统
const loading = new Set<string>()

const disposables: Array<{
  /** 释放该条订阅或挂载；卸载时按注册逆序调用，重复调用由注册方保证幂等 */
  dispose(): void
}> = []
const rootOrigin: Point = { x: 0, y: 0 }

const tree = computed<RenderNode[]>(() => {
  docVersion.value
  dataVersion.value
  const schema = document.model.schema
  return buildRenderTree({
    schema,
    scope: {
      ...(props.scope ?? {}),
      data: buildPageData(schema, dataSource?.states()),
      page: schema.metadata ?? {},
    },
    resolveValue: expression.resolveValue,
  })
})

/** 已解析的材料组件；null 表示解析完成但该组件不存在，渲染占位框 */
function materialOf(name: string): Component | null {
  return components.get(name) ?? null
}

/**
 * 节点样式：把世界矩形减去父级原点写入 DOM。
 *
 * 容器渲染使用「坐标补偿」而不是相对坐标模型：schema 里的 rect 始终是世界坐标，
 * 嵌套 DOM 只负责裁剪与层叠，视觉与扁平渲染保持一致。
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
  const material = materialOf(item.node.componentName)
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
      class: 'lc-node',
      'data-node-id': item.node.id,
      'data-disabled': item.disabled ? 'true' : undefined,
      style: nodeStyle(item, origin),
    },
    [
      material
        ? h(material, item.props)
        : h('div', { class: 'lc-node__placeholder' }, item.node.componentName),
      children,
    ],
  )
}

/** 递归节点树：渲染树已求值，这里只负责 DOM 与坐标补偿 */
const NodeTree = defineComponent({
  name: 'LcNodeTree',
  props: {
    items: { type: Array as PropType<RenderNode[]>, required: true },
    origin: { type: Object as PropType<Point>, required: true },
  },
  setup(treeProps) {
    return () => treeProps.items.map((item) => renderNode(item, treeProps.origin))
  },
})

/**
 * 为文档里出现的组件名异步解析材料组件。
 *
 * 已缓存或正在解析的名字直接跳过，所以文档逐帧变化也不会重复请求同一材料。
 */
function syncComponents(): void {
  for (const node of Object.values(document.model.schema.nodes)) {
    const name = node.componentName
    if (components.has(name) || loading.has(name)) continue
    loading.add(name)
    void renderer
      .resolveMaterial(name)
      .then((component) => {
        // 契约层返回 unknown（不依赖 Vue），宿主在此收窄为 Component
        components.set(name, component ? markRaw(component as Component) : null)
      })
      .finally(() => loading.delete(name))
  }
}

/** 把视口矩阵提交成内容层 transform；由 scheduler 帧回调触发 */
function refreshMatrix(): void {
  matrix.value = `matrix(${canvas.viewport.matrix.join(', ')})`
}

/**
 * 首帧把文档摆到视口中心，缩放保持默认的 100%。
 *
 * 不用 `viewport.fit`：fit 会为了塞下整张画幅把 zoom 夹到下限，容器一窄就直接掉到
 * 10%，节点文字糊成一团；需要看全貌时用户有「适应画布」命令。
 * 尺寸未测得时不写原点，否则会把文档中心对到屏幕左上角。
 */
function centerRootAtCurrentZoom(): void {
  const { width, height } = canvas.viewport.size
  if (width === 0 || height === 0) return

  const root = canvas.scene.getRootBounds()
  const { zoom } = canvas.viewport.state

  canvas.viewport.set({
    x: root.x + root.width / 2 - width / 2 / zoom,
    y: root.y + root.height / 2 - height / 2 / zoom,
  })
}

function dragMaterialName(event: DragEvent): string | null {
  return materialNameFromDragTypes(event.dataTransfer?.types ?? [])
}

/**
 * 落点坐标；两个坐标系同源于本次 drop 事件，供 canvas-drop 直接写进节点布局。
 *
 * @returns screen 为舞台本地屏幕坐标（供覆盖层与容器命中），world 为换算后的世界坐标
 * （供新建节点写入 layout.rect）；舞台元素尚未挂载时返回 null，调用方据此放弃本次拖拽预览与投放。
 */
function dropPoint(event: DragEvent): { screen: Point; world: Point } | null {
  const element = rootRef.value
  if (!element) return null
  const rect = element.getBoundingClientRect()
  const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  return { screen, world: canvas.viewport.screenToWorld(screen) }
}

function setDropPreview(value: unknown): void {
  try {
    canvas.settings.set(CANVAS_DROP_PREVIEW_SETTING, value)
  } catch {
    // canvas-drop 未安装时忽略预览，不影响 drop 本身
  }
}

function onDragOver(event: DragEvent): void {
  const materialName = dragMaterialName(event)
  if (!materialName) return

  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'

  const point = dropPoint(event)
  if (!point) return
  setDropPreview({
    materialName,
    ...point,
    containerId: canvas.hitTest.containerAt(point.screen),
  })
}

function onDragLeave(event: DragEvent): void {
  const element = rootRef.value
  const related = event.relatedTarget
  if (element && related instanceof Node && element.contains(related)) return
  setDropPreview(null)
}

function onDrop(event: DragEvent): void {
  const materialName = dragMaterialName(event)
  if (!materialName) return

  event.preventDefault()
  const point = dropPoint(event)
  setDropPreview(null)
  if (!point) return

  const payload: CanvasDropPayload = { materialName, ...point }
  void props.context.bail('canvas:drop', payload)
}

function clearDropPreview(): void {
  setDropPreview(null)
}

onMounted(() => {
  const element = rootRef.value
  if (!element) return

  // attach 会同步写入一次尺寸，紧随其后的居中才能拿到真实视口宽高
  disposables.push(canvas.attach(element))
  disposables.push(canvas.scheduler.onFrame(refreshMatrix))
  disposables.push(
    document.onDidChange(() => {
      docVersion.value += 1
      syncComponents()
    }),
  )
  if (dataSource) {
    disposables.push(
      dataSource.onDidChange(() => {
        dataVersion.value += 1
      }),
    )
  }
  window.addEventListener('dragend', clearDropPreview)
  disposables.push({ dispose: () => window.removeEventListener('dragend', clearDropPreview) })

  refreshMatrix()
  syncComponents()
  // 首次挂载：按 100% 展示，只把文档居中
  centerRootAtCurrentZoom()

  // 键盘事件挂在舞台元素上，不聚焦就收不到快捷键
  element.focus()
})

onUnmounted(() => {
  // 逆序释放：先断掉后注册的订阅，再卸载画布挂载，避免订阅读到已销毁的 DOM
  for (const disposable of disposables.reverse()) disposable.dispose()
  disposables.length = 0
  clearDropPreview()
})
</script>

<template>
  <!-- tabindex 是必需的：交互管线把 keydown / keyup 挂在舞台上，不可聚焦就收不到快捷键 -->
  <div
    ref="rootRef"
    class="lc-stage"
    tabindex="0"
    data-lc-stage
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- 内容层只承担一个 transform，节点坐标保持世界值，缩放到 400% 也不重算样式 -->
    <div class="lc-stage__content" :style="{ transform: matrix }">
      <NodeTree :items="tree" :origin="rootOrigin" />
    </div>

    <LayerHost :context="props.context" />
  </div>
</template>

<style scoped>
.lc-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--lc-canvas-bg);
  outline: none;
  touch-action: none;
  user-select: none;
}

.lc-stage__content {
  position: absolute;
  inset: 0;
  /* viewport.matrix 以舞台左上角为原点推导，改成 center 会让视口换算与画面分裂 */
  transform-origin: 0 0;
  will-change: transform;
}

.lc-node {
  box-sizing: border-box;
}

.lc-node__placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--lc-border-strong);
  border-radius: var(--lc-radius-sm);
  color: var(--lc-text-secondary);
  font-size: 12px;
  background: var(--lc-surface);
}
</style>
