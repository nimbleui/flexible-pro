<script setup lang="ts">
import type { Component } from 'vue'
import {
  computed,
  markRaw,
  onMounted,
  onUnmounted,
  provide,
  reactive,
  ref,
  shallowRef,
} from 'vue'
import type {
  CanvasContext,
  CanvasFrame,
  CanvasLayer,
  CanvasService,
  SelectionService,
  SnapService,
} from '@lc/contracts'
import { LC_CONTEXT } from '../context'

const props = defineProps<{
  /** 画布 Realm 上下文；覆盖层组件通过注入得到同一 Context */
  context: CanvasContext
}>()

const ctx = props.context
// 覆盖层在画布作用域内运行：ctx.canvas / ctx.selection 均可用
provide(LC_CONTEXT, props.context)

const canvas = ctx.require<CanvasService>('canvas')
const selection = ctx.require<SelectionService>('selection')

/** 图层 id → 已加载组件；缺失表示尚未加载完成 */
const components = reactive(new Map<string, Component>())

/** 图层 id → 失败原因，用于在图层内显示降级提示而不是整块画布报错 */
const failures = reactive(new Map<string, string>())

// 只用于并发去重，不参与渲染，因此不进响应式
const loading = new Set<string>()

// 图层集合不是响应式源，用自增计数把 layers.onDidChange 桥接进 Vue 依赖
const layerVersion = ref(0)

/** 当前吸附服务；未安装 canvas-snap 时为 undefined，frame.snap 退化为 null */
let snap = ctx.get<SnapService>('snap')

/** 已订阅 over 的 snap 实例与订阅句柄；服务替换时先释放旧句柄再重绑 */
let boundSnap: SnapService | undefined
let snapSub: { dispose(): void } | null = null
const disposables: Array<{
  /** 释放该条订阅；卸载时按注册逆序调用，重复调用由注册方保证幂等 */
  dispose(): void
}> = []

const frame = shallowRef<CanvasFrame>(buildFrame())

/**
 * 收集一帧渲染所需的全部只读快照。
 *
 * 四个来源都在这一处读取，覆盖层拿到的永远是同一时刻的视口 / 选中 / 吸附 / 尺寸，
 * 不会各读各的而出现撕裂。视口与尺寸取到的是服务当前的对象引用，
 * 下一次 refresh 会整体替换 frame，覆盖层不需要自行比较字段。
 */
function buildFrame(): CanvasFrame {
  return {
    viewport: canvas.viewport.state,
    selection: selection.ids,
    snap: snap?.lastResult ?? null,
    size: canvas.viewport.size,
  }
}

/** 重建 frame：shallowRef 只比较引用，所以必须换整个对象才触发更新 */
function refresh(): void {
  frame.value = buildFrame()
}

const layers = computed(() => {
  // 读取 layerVersion 建立依赖，注册表变化后重新取图层列表
  layerVersion.value
  return canvas.layers.list()
})

/** 未提供 visible 的图层默认可见；该判断每帧对每层执行，必须保持廉价 */
function isVisible(layer: CanvasLayer): boolean {
  return layer.visible ? layer.visible(frame.value) : true
}

/**
 * 图层定位样式。
 *
 * z 序由服务给的数组下标决定（band → zIndex → 注册顺序），这里给每层留出 10 的
 * 间隔再叠加同层内的 zIndex；zIndex 达到或超过 10 就会与下一层取到相同的 z，
 * 因此 zIndex 只适合做同 band 内的微调，不要当绝对层级用。
 */
function layerStyle(layer: CanvasLayer, index: number): Record<string, string | number> {
  return {
    position: 'absolute',
    inset: '0',
    pointerEvents: layer.pointerEvents ?? 'none',
    // band 顺序由服务确定；这里只在该顺序上叠加同 band 的 zIndex
    zIndex: (index + 1) * 10 + (layer.zIndex ?? 0),
  }
}

/**
 * 加载单个图层模块。
 *
 * 已加载或正在加载的名字直接返回，注册表频繁变化也不会重复请求模块。
 * 加载失败与「模块没有默认导出」都记进 failures 并上报诊断：图层缺失只降级为
 * 一条提示，不应把整个画布带崩。
 */
async function ensureLayer(layer: CanvasLayer): Promise<void> {
  if (components.has(layer.id) || loading.has(layer.id)) return
  loading.add(layer.id)

  try {
    const module = (await layer.load()) as {
      /** 图层组件必须由模块默认导出；缺失时降级为一条失败提示，不抛错 */
      default?: Component
    }
    // 图层模块加载期间画布 Realm 可能已关闭，不能再往响应式表里写组件
    if (ctx.signal.aborted) return
    if (!module.default) {
      failures.set(layer.id, '图层模块未导出默认组件')
      return
    }
    // 组件对象不能进响应式代理，否则 Vue 会重复代理并产生开销
    components.set(layer.id, markRaw(module.default))
  } catch (error) {
    failures.set(layer.id, error instanceof Error ? error.message : String(error))
    ctx.diagnostics.report(error, { scope: 'layer', layer: layer.id })
  } finally {
    loading.delete(layer.id)
  }
}

/**
 * 为注册表里的全部图层预取模块。
 *
 * 当前不按 visible 过滤：切换可见性时用 v-show，组件始终保持挂载，隐藏期间
 * 也照样收到 frame 更新，代价是不可见的图层也会占一份模块与组件实例。
 */
function syncLayers(): void {
  for (const layer of canvas.layers.list()) void ensureLayer(layer)
}

/** 订阅吸附变化；同一实例只订一次，服务被替换时先释放旧订阅再重绑。 */
function bindSnapChange(): void {
  if (boundSnap === snap) return
  boundSnap = snap
  snapSub?.dispose()
  snapSub = null
  if (!snap) return
  // snap 结果更新不经过 viewport/selection，单独订阅
  snapSub = snap.onDidChange(refresh)
}

onMounted(() => {
  disposables.push(
    canvas.layers.onDidChange(() => {
      layerVersion.value += 1
      syncLayers()
    }),
    // 每帧重建 frame：视口、选中、吸附、尺寸的变化统一在这里合并成一次更新
    canvas.scheduler.onFrame(refresh),
    selection.onDidChange(refresh),
    // snap 是可选服务，可能在画布装配后才出现，靠服务注册表变化补绑
    ctx.services.onDidChange((name) => {
      if (name !== 'snap') return
      const next = ctx.get<SnapService>('snap')
      // 其他 Realm 提供同名服务时值没变，不必让全部覆盖层整批重渲染
      if (next === snap) return
      snap = next
      bindSnapChange()
      refresh()
    }),
  )

  bindSnapChange()
  syncLayers()
  refresh()
})

onUnmounted(() => {
  snapSub?.dispose()
  snapSub = null
  // 逆序释放，与注册顺序相反：先断订阅，再解绑更早注册的监听
  for (const disposable of disposables.reverse()) disposable.dispose()
  disposables.length = 0
})
</script>

<template>
  <!-- 用 v-show 而不是 v-if：隐藏图层保留实例与内部状态，可见性切换不再付一次异步加载 -->
  <div class="lc-layer-host">
    <div
      v-for="(layer, index) in layers"
      :key="layer.id"
      v-show="isVisible(layer)"
      class="lc-layer"
      :data-layer-id="layer.id"
      :data-layer-band="layer.band"
      :style="layerStyle(layer, index)"
    >
      <component
        :is="components.get(layer.id)"
        v-if="components.get(layer.id)"
        :frame="frame"
      />
      <div v-else-if="failures.get(layer.id)" class="lc-layer__error">
        {{ failures.get(layer.id) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.lc-layer-host {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.lc-layer {
  pointer-events: none;
}

.lc-layer__error {
  position: absolute;
  left: 8px;
  bottom: 8px;
  padding: 4px 8px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 11px;
}
</style>
