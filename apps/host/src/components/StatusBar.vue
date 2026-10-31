<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import type {
  CanvasContext,
  CanvasService,
  DocumentService,
  HistoryService,
  SelectionService,
} from '@lc/contracts'
import { useAppContext } from '@lc/vue'

const props = defineProps<{
  /** 画布 Realm 上下文 */
  canvasContext: CanvasContext
}>()

const ctx = useAppContext()
const canvas = props.canvasContext.require<CanvasService>('canvas')
const selection = props.canvasContext.require<SelectionService>('selection')
const history = ctx.get<HistoryService>('history')
const document = ctx.get<DocumentService>('document')

const version = ref(0)
const disposables: Array<{ dispose(): void }> = []

// 在 setup 阶段同步订阅：CanvasStage 的首次 fit 发生在父级 mounted 之后，
// 若在 onMounted 里订阅会漏掉这一次视口变化。
disposables.push(
  canvas.viewport.onDidChange(() => {
    version.value += 1
  }),
  selection.onDidChange(() => {
    version.value += 1
  }),
)
if (history) {
  disposables.push(
    history.onDidChange(() => {
      version.value += 1
    }),
  )
}
if (document) {
  disposables.push(
    document.onDidChange(() => {
      version.value += 1
    }),
  )
}

onUnmounted(() => {
  for (const disposable of disposables) disposable.dispose()
  disposables.length = 0
})

const zoomLabel = computed(() => {
  version.value
  return `${Math.round(canvas.viewport.state.zoom * 100)}%`
})

const selectionLabel = computed(() => {
  version.value
  return selection.ids.length > 0 ? `选中 ${selection.ids.length}` : '未选中'
})

const dirtyLabel = computed(() => {
  version.value
  return document?.model.dirty ? '未保存' : '已同步'
})

const canUndo = computed(() => {
  version.value
  return history?.canUndo ?? false
})

const canRedo = computed(() => {
  version.value
  return history?.canRedo ?? false
})
</script>

<template>
  <footer class="lc-status">
    <span class="lc-status__item">缩放 {{ zoomLabel }}</span>
    <span class="lc-status__item">{{ selectionLabel }}</span>
    <span class="lc-status__item">{{ dirtyLabel }}</span>
    <span class="lc-status__spacer" />
    <button
      type="button"
      class="lc-status__button"
      :disabled="!canUndo"
      @click="history?.undo()"
    >
      撤销
    </button>
    <button
      type="button"
      class="lc-status__button"
      :disabled="!canRedo"
      @click="history?.redo()"
    >
      重做
    </button>
  </footer>
</template>
