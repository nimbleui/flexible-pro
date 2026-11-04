<script setup lang="ts">
import type { Component, CSSProperties, PropType } from 'vue'
import {
  computed,
  defineComponent,
  h,
  markRaw,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import type { EditorContext, RendererService } from '@lc/contracts'
import type { ActionService } from '@lc/contracts'
import type { Disposable } from '@lc/kernel'
import type { Rect } from '@lc/schema'
import { PAGE_EVENT_SOURCE, buildEventPayload, buildExpressionScope } from '@lc/schema'
import type { RenderNode } from '../render/tree'
import { buildRenderTree } from '../render/tree'
import { splitSlotChildren } from '../render/slots'
import { eventListenerProp } from '../render/events'

/**
 * 页面运行时渲染器。
 *
 * 与 `CanvasStage` 的差别是**设计态与运行态**的差别，不是两条渲染路径的差别：
 * 两者都用 `buildRenderTree` 求值同一份节点图，但本组件
 *  - 作用域里的 `data.<变量>` 取**状态服务的当前值**，而画布取声明的默认值
 *   （协议规定设计器不执行真实业务，编辑一个按钮不该真的跳转）；
 *  - 把物料 emit 的事件接给 `action` 服务，画布不接；
 *  - 没有视口矩阵、选中框、拖拽与覆盖层。
 *
 * 因此「预览能跑、画布不认」这类分歧在这里不会出现：同一个物料、同一份 schema，
 * 只有事件是否被接线、状态是否读运行时值两处不同。
 */

const props = defineProps<{
  /** 文档 Realm 上下文；document / pageState / dataSource / action 均在作用域内 */
  context: EditorContext
  /**
   * 宿主注入的额外表达式作用域，例如 `$route` / `$params` / `$query`。
   *
   * 页面自身的 `data` / `page` / `event` 由本组件装配，宿主键同名时被覆盖。
   */
  scope?: Record<string, unknown>
}>()

const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 }

const ctx = props.context
const document = ctx.document
const renderer = ctx.require<RendererService>('renderer')
const expression = ctx.expression
const pageState = ctx.pageState
const dataSource = ctx.dataSource
const action = ctx.require<ActionService>('action')

// 三个来源都不是响应式源，用自增计数把 onDidChange 桥接成 Vue 依赖
const docVersion = ref(0)
const dataVersion = ref(0)
const stateVersion = ref(0)
// 物料插槽声明同样不是响应式源
const slotVersion = ref(0)

const components = shallowRef(new Map<string, Component | null>())
// 只做并发去重，不参与渲染，因此故意不放进响应式系统
const loading = new Set<string>()

const disposables: Disposable[] = []

/**
 * 表达式作用域。
 *
 * 与动作执行器共用 `buildExpressionScope` 装配，两侧的形状因此不可能分叉：
 * 作者在面板里写的 `{{ count > 0 }}` 在渲染和链路上看到的是同一个 `count`。
 */
const scope = computed(() => {
  docVersion.value
  dataVersion.value
  stateVersion.value
  const schema = document.model.schema

  return buildExpressionScope({
    schema,
    dataSources: dataSource.states(),
    variables: pageState.snapshot(),
    base: props.scope,
  })
})

const tree = computed<RenderNode[]>(() =>
  buildRenderTree({
    schema: document.model.schema,
    scope: scope.value,
    resolveValue: expression.resolveValue,
  }),
)

/** 坐标原点：根节点的世界矩形左上角，其余节点按它做补偿 */
const origin = computed(() => {
  const schema = document.model.schema
  const rect = schema.nodes[schema.nodeId]?.layout?.rect ?? EMPTY_RECT
  return { x: rect.x, y: rect.y }
})

/** 页面内容尺寸，用于把容器撑到与画幅一致 */
const canvasSize = computed(() => {
  const schema = document.model.schema
  const rect = schema.nodes[schema.nodeId]?.layout?.rect ?? EMPTY_RECT
  return { width: rect.width, height: rect.height }
})

/**
 * 某个节点上需要注入的事件名。
 *
 * 取自 `connections`，而不是物料声明：作者绑了一个物料没声明的事件时，
 * 仍然应该把监听器挂上去——挂上就有机会触发（物料内部确实 emit 了这个名字的话），
 * 不挂则是彻底静默。声明只影响 `event` 里有哪些参数名。
 */
const boundEvents = computed<ReadonlyMap<string, readonly string[]>>(() => {
  docVersion.value
  const map = new Map<string, string[]>()

  for (const connection of Object.values(document.model.schema.connections ?? {})) {
    if (!connection.enabled || connection.sourceNodeId === PAGE_EVENT_SOURCE) continue

    const names = map.get(connection.sourceNodeId)
    if (names) names.push(connection.eventName)
    else map.set(connection.sourceNodeId, [connection.eventName])
  }

  return map
})

/** 已解析的物料组件；null 表示解析完成但该组件不存在 */
function materialOf(name: string): Component | null {
  return components.value.get(name) ?? null
}

/**
 * 节点的事件监听器 props。
 *
 * 实参按物料声明的参数名折叠成 `event`（`buildEventPayload`）；没声明参数时
 * `event` 是空对象，而不是把原始实参数组塞进去——表达式里没有名字可以引用它。
 */
function listenersOf(node: RenderNode['node']): Record<string, unknown> {
  const names = boundEvents.value.get(node.id)
  if (!names || names.length === 0) return {}

  const definitions = ctx.material.get(node.componentName)?.events
  const handlers: Record<string, unknown> = {}

  for (const eventName of names) {
    handlers[eventListenerProp(eventName)] = (...args: unknown[]): void => {
      const parameters = definitions?.find((item) => item.name === eventName)?.parameters
      void action.trigger(node.id, eventName, buildEventPayload(parameters, args))
    }
  }

  return handlers
}

function nodeStyle(item: RenderNode): CSSProperties {
  const rect = item.rect
  return {
    ...(item.node.style as CSSProperties | undefined),
    position: 'absolute',
    left: `${rect.x - origin.value.x}px`,
    top: `${rect.y - origin.value.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    zIndex: item.node.layout?.zIndex,
    transform: item.node.layout?.rotate ? `rotate(${item.node.layout.rotate}deg)` : undefined,
    display: item.visible ? undefined : 'none',
  }
}

function renderNode(item: RenderNode): ReturnType<typeof h> {
  const component = materialOf(item.node.componentName)
  const name = item.node.componentName

  // 与 CanvasStage 同一套归属判定：声明了插槽的内容交给组件，其余继续平铺
  slotVersion.value
  const declared = component ? ctx.material.get(name)?.slots : undefined
  const split = component ? splitSlotChildren(item.node, item.children, declared) : null
  const rest = split ? split.rest : item.children
  const children = rest.length ? h(NodeTree, { key: 'children', items: rest }) : null
  const named = split ? slotFactories(split.named) : undefined

  return h(
    'div',
    {
      key: item.key,
      class: 'lc-runtime__node',
      style: nodeStyle(item),
    },
    [
      component
        ? h(component, { ...item.props, ...listenersOf(item.node) }, named)
        : h('div', { class: 'lc-runtime__placeholder' }, item.node.componentName),
      children,
    ],
  )
}

/**
 * 已声明插槽 → Vue 具名 slot 工厂。
 *
 * 只给真有内容的插槽建工厂：Vue 会为一个空的 `default` 覆盖掉组件自己的兜底内容。
 */
function slotFactories(
  named: Record<string, RenderNode[]>,
): Record<string, () => ReturnType<typeof h>[]> | undefined {
  const entries = Object.entries(named)
  if (entries.length === 0) return undefined

  return Object.fromEntries(
    entries.map(([slot, items]) => [slot, () => [h(NodeTree, { key: `slot-${slot}`, items })]]),
  )
}

/** 递归节点树：渲染树已求值，这里只负责 DOM 与事件接线 */
const NodeTree = defineComponent({
  name: 'LcRuntimeNodeTree',
  props: {
    items: { type: Array as PropType<RenderNode[]>, required: true },
  },
  setup(treeProps) {
    return () => treeProps.items.map((item) => renderNode(item))
  },
})

/**
 * 为渲染树里出现的组件名解析物料。
 *
 * 整体替换 `components` 的 Map 引用而不是就地 `set`：`shallowRef` 只在引用变化时
 * 触发重渲染，就地改会让后到的物料永远不显示。
 */
function ensureMaterials(): void {
  const pending: string[] = []

  for (const node of Object.values(document.model.schema.nodes)) {
    const name = node.componentName
    if (components.value.has(name) || loading.has(name)) continue
    pending.push(name)
  }

  if (pending.length === 0) return

  for (const name of pending) {
    loading.add(name)
    void renderer
      .resolveMaterial(name)
      .then((component) => {
        // 契约层返回 unknown（不依赖 Vue），适配层在此收窄为 Component
        components.value = new Map(components.value).set(
          name,
          component ? markRaw(component as Component) : null,
        )
      })
      .finally(() => loading.delete(name))
  }
}

watch(tree, ensureMaterials, { immediate: true })

onMounted(() => {
  disposables.push(
    document.onDidChange(() => {
      docVersion.value += 1
    }),
    pageState.onDidChange(() => {
      stateVersion.value += 1
    }),
    dataSource.onDidChange(() => {
      dataVersion.value += 1
    }),
    ctx.material.onDidChange(() => {
      slotVersion.value += 1
    }),
  )

  // 宿主作用域用 provider 传入而不是快照：`$route` 会随导航变化，
  // 一次性展开会把路由永久钉在挂载那一刻
  disposables.push(action.setScopeProvider(() => ({ ...(props.scope ?? {}) })))

  void action.trigger(PAGE_EVENT_SOURCE, 'pageLoad')
})

onUnmounted(() => {
  // pageUnload 先于释放订阅：链里可能还要读状态与数据源
  void action.trigger(PAGE_EVENT_SOURCE, 'pageUnload')

  // 逆序释放：先断掉后注册的订阅，避免订阅读到已销毁的实例
  for (const disposable of disposables.reverse()) disposable.dispose()
  disposables.length = 0
})
</script>

<template>
  <div
    class="lc-runtime"
    :style="{ width: `${canvasSize.width}px`, height: `${canvasSize.height}px` }"
  >
    <NodeTree :items="tree" />
  </div>
</template>

<style scoped>
.lc-runtime {
  position: relative;
  box-sizing: border-box;
  overflow: hidden;
}

.lc-runtime__node {
  box-sizing: border-box;
}

.lc-runtime__placeholder {
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
