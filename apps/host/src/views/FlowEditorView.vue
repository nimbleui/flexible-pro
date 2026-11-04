<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { findFlowCatalogEntry } from '@lc/schema'
import { toastService } from '../toast'
import { createFlow } from '../workflows/flow-store'
import FlowCanvas from '../components/flow/FlowCanvas.vue'
import FlowDebugDock from '../components/flow/FlowDebugDock.vue'
import FlowInspector from '../components/flow/FlowInspector.vue'
import FlowNodeLibrary from '../components/flow/FlowNodeLibrary.vue'
import { useFlowCanvas } from '../components/flow/composables/use-flow-canvas'
import { useFlowDebug } from '../components/flow/composables/use-flow-debug'
import { useFlowEditor } from '../components/flow/composables/use-flow-editor'
import { flowNodeSize } from '../components/flow/constants/node-tone'
import '../components/flow/styles/layout.css'

/**
 * 流程编排编辑器。
 *
 * 一个路由对应一张图：外壳只负责装配三个面板与一条工具栏，文档状态全在
 * `useFlowEditor` 的工作副本里。`App.vue` 用 path 作 RouterView 的 key，
 * 所以换图会整页重建，视图层不需要监听参数变化。
 */
const route = useRoute()
const router = useRouter()

/**
 * `/flows/new` 兜底创建。
 *
 * 正常入口是列表页的新建弹框（先拿到名字和 id 再进画布），这里只兜住手动改地址栏：
 * 建一张默认名的图并把 URL 换成真实 id，否则刷新一次就多一张孤儿图。
 */
function resolveFlowId(): string {
  const param = String(route.params.flowId ?? '')
  if (param !== 'new') return param

  const created = createFlow({ name: '未命名流程' })
  return created.id
}

const currentFlowId = resolveFlowId()
const editor = useFlowEditor(currentFlowId)
const canvas = useFlowCanvas(editor)
const debug = useFlowDebug(editor)

const libraryVisible = ref(true)
const inspectorVisible = ref(true)
const dockVisible = ref(false)

/** 从节点库拖出时的幽灵卡片；位置是屏幕坐标，落点才换算成世界坐标 */
const ghost = ref<{ catalogKey: string; x: number; y: number } | null>(null)

const flow = computed(() => editor.flow.value)

const statusLabel = computed(() => (flow.value?.status === 'published' ? '已发布' : '草稿'))

const updatedText = computed(() => {
  const raw = flow.value?.updatedAt
  if (!raw) return ''
  const date = new Date(raw)

  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('zh-CN', { hour12: false })
})

/**
 * 试运行结果按节点折叠成一份状态表，画布只读它需要的这一面。
 *
 * 直接取 `debug.stepStates`：它由播放器逐步落地，所以画布上的点亮顺序就是执行顺序，
 * 而不是等整条流程跑完一次性上色。
 *
 * 跑完（`settled`）之后把从没被访问的节点补成 `unreached`：不补的话「没走到」与
 * 「还没跑过」是同一种长相，作者分不清分支没选中、上游失败，还是压根没运行过。
 * 执行途中不补——那时下游只是「还没轮到」。
 */
const nodeRunStates = computed<Record<string, string>>(() => {
  const states: Record<string, string> = { ...debug.stepStates.value }
  const current = flow.value
  if (!current || !debug.settled.value) return states

  for (const nodeId of Object.keys(current.nodes)) {
    if (!states[nodeId]) states[nodeId] = 'unreached'
  }

  return states
})

watch(
  () => editor.missing.value,
  (missing) => {
    if (missing) toastService.show('流程不存在或已被删除', 'error')
  },
  { immediate: true },
)

if (String(route.params.flowId ?? '') === 'new') {
  router.replace(`/flows/${currentFlowId}/edit`)
}

function notifyError(error: unknown): void {
  toastService.show(error instanceof Error ? error.message : String(error), 'error')
}

function saveDraft(): void {
  try {
    editor.saveDraft()
    toastService.show('草稿已保存', 'success')
  } catch (error) {
    notifyError(error)
  }
}

function publish(): void {
  try {
    const result = editor.publish()
    if (!result.ok) {
      toastService.show(result.issues[0]?.message ?? '流程不能发布', 'error')
      return
    }

    toastService.show(`已发布 v${result.flow?.version ?? ''}`, 'success')
  } catch (error) {
    notifyError(error)
  }
}

async function runDebug(): Promise<void> {
  dockVisible.value = true

  const record = await debug.run()
  if (record && record.status === 'failed') {
    toastService.show(record.message ?? '执行失败', 'error')
  }
}

/** 同一个按钮兼任中止：执行中再点一次就是「别再往下走了」，而不是排队等第二次运行 */
function onRunButton(): void {
  if (debug.running.value) {
    debug.stop()
    return
  }

  void runDebug()
}

/**
 * 落点插入。
 *
 * 点击条目落在视口中心，拖拽落在指针处；两者都按节点尺寸回中，否则新节点的左上角
 * 停在指针上，视觉上像是「偏了一半」。
 */
function insertNode(catalogKey: string, screen?: { x: number; y: number }): void {
  const entry = findFlowCatalogEntry(catalogKey)
  if (!entry) {
    toastService.show(`节点库中不存在条目：${catalogKey}`, 'error')
    return
  }

  const world = screen ? canvas.worldPointAtScreen(screen) : canvas.viewCenterWorld()
  const size = flowNodeSize(entry)
  const position = canvas.anchorForInsertion(world, size)

  try {
    editor.addNode(catalogKey, position)
  } catch (error) {
    notifyError(error)
  }
}

/** 幽灵卡片上显示的节点名 */
const ghostLabel = computed(() => {
  const key = ghost.value?.catalogKey
  if (!key) return ''

  return findFlowCatalogEntry(key)?.title ?? key
})

function onLibraryDragStart(payload: {
  catalogKey: string
  clientX: number
  clientY: number
}): void {
  ghost.value = { catalogKey: payload.catalogKey, x: payload.clientX, y: payload.clientY }
}

function onWindowPointerMove(event: PointerEvent): void {
  if (!ghost.value) return
  ghost.value = { ...ghost.value, x: event.clientX, y: event.clientY }
}

function onWindowPointerUp(event: PointerEvent): void {
  if (!ghost.value) return

  const rect = canvas.stageRef.value?.getBoundingClientRect()
  const inside =
    !!rect &&
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom

  if (rect && inside) {
    insertNode(ghost.value.catalogKey, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    })
  }

  ghost.value = null
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const typing =
    !!target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

  const isMod = event.ctrlKey || event.metaKey

  if (isMod && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) editor.redo()
    else editor.undo()
    return
  }

  if (isMod && event.key.toLowerCase() === 's') {
    event.preventDefault()
    saveDraft()
    return
  }

  // 输入框里的退格是删字符，不是删节点
  if (typing) return
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    if (editor.selectedNodeId.value) editor.removeNode(editor.selectedNodeId.value)
    else if (editor.selectedEdgeId.value) editor.removeEdge(editor.selectedEdgeId.value)
  }
}

onMounted(() => {
  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', onWindowPointerUp)
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('pointerup', onWindowPointerUp)
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <main v-if="flow" class="lc-flow-editor">
    <header class="lc-flow-editor__bar">
      <button
        type="button"
        class="lc-icon-button"
        aria-label="返回流程列表"
        title="返回"
        @click="router.push('/flows')"
      >
        <span class="lc-flow-editor__back" aria-hidden="true" />
      </button>

      <nav class="lc-flow-editor__crumbs" aria-label="面包屑">
        <RouterLink class="lc-flow-editor__crumb" to="/flows">流程编排</RouterLink>
        <span class="lc-flow-editor__crumb-sep" aria-hidden="true">/</span>
        <span class="lc-flow-editor__crumb lc-flow-editor__crumb--current">编辑流程</span>
      </nav>

      <div class="lc-flow-editor__title">
        <span class="lc-flow-editor__logo" aria-hidden="true" />
        <div class="lc-flow-editor__heading">
          <input
            class="lc-flow-editor__name"
            :value="flow.name"
            aria-label="流程名称"
            @input="editor.updateMeta({ name: ($event.target as HTMLInputElement).value })"
          />
          <input
            class="lc-flow-editor__desc"
            :value="flow.description ?? ''"
            aria-label="流程说明"
            placeholder="填写流程用途"
            @input="
              editor.updateMeta({ description: ($event.target as HTMLInputElement).value })
            "
          />
        </div>
      </div>

      <span class="lc-flow-editor__badge" :class="`lc-flow-editor__badge--${flow.status}`">
        {{ statusLabel }} v{{ flow.version }}
      </span>

      <span v-if="updatedText" class="lc-flow-editor__time">更新时间：{{ updatedText }}</span>

      <div class="lc-flow-editor__actions">
        <button type="button" class="lc-flow-button" @click="saveDraft">
          <span class="lc-flow-button__glyph lc-flow-button__glyph--save" aria-hidden="true" />
          保存草稿
        </button>
        <button type="button" class="lc-flow-button lc-flow-button--primary" @click="publish">
          <span
            class="lc-flow-button__glyph lc-flow-button__glyph--publish"
            aria-hidden="true"
          />
          发布版本
        </button>
        <button
          type="button"
          class="lc-flow-button"
          :class="{ 'is-running': debug.running.value }"
          @click="onRunButton"
        >
          <span class="lc-flow-button__glyph lc-flow-button__glyph--run" aria-hidden="true" />
          {{ debug.running.value ? '中止执行' : '运行调试' }}
        </button>
        <button
          type="button"
          class="lc-icon-button"
          aria-label="切换节点库"
          :aria-pressed="libraryVisible"
          title="显示/隐藏节点库"
          @click="libraryVisible = !libraryVisible"
        >
          <span
            class="lc-flow-editor__glyph lc-flow-editor__glyph--panel-left"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="lc-icon-button"
          aria-label="切换配置面板"
          :aria-pressed="inspectorVisible"
          title="显示/隐藏配置面板"
          @click="inspectorVisible = !inspectorVisible"
        >
          <span
            class="lc-flow-editor__glyph lc-flow-editor__glyph--panel-right"
            aria-hidden="true"
          />
        </button>
      </div>
    </header>

    <div class="lc-flow-editor__body">
      <aside v-if="libraryVisible" class="lc-flow-editor__left">
        <FlowNodeLibrary
          @add="(key: string) => insertNode(key)"
          @drag-start="onLibraryDragStart"
          @close="libraryVisible = false"
        />
      </aside>

      <section class="lc-flow-editor__center">
        <FlowCanvas
          :editor="editor"
          :canvas="canvas"
          :node-run-states="nodeRunStates"
          :current-node-id="debug.currentNodeId.value"
          :stepping="debug.running.value"
          @undo="editor.undo()"
          @redo="editor.redo()"
        />

        <div v-if="dockVisible" class="lc-flow-editor__dock">
          <FlowDebugDock :debug="debug" @close="dockVisible = false" />
        </div>
      </section>

      <aside v-if="inspectorVisible" class="lc-flow-editor__right">
        <FlowInspector :editor="editor" />
      </aside>
    </div>

    <div
      v-if="ghost"
      class="lc-flow-editor__ghost"
      :style="{ left: `${ghost.x + 12}px`, top: `${ghost.y + 12}px` }"
      aria-hidden="true"
    >
      {{ ghostLabel }}
    </div>
  </main>

  <main v-else class="lc-flow-editor lc-flow-editor--missing">
    <p>流程不存在，可能已被删除。</p>
    <RouterLink class="lc-flow-button lc-flow-button--primary" to="/flows"
      >回到流程列表</RouterLink
    >
  </main>
</template>
