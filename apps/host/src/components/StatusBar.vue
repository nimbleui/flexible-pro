<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import type {
  CanvasContext,
  CanvasService,
  DocumentService,
  HistoryService,
  SelectionService,
  VersionHostService,
} from '@lc/contracts'
import { useAppContext } from '@lc/vue'

const props = defineProps<{
  /** 画布 Realm 上下文 */
  canvasContext: CanvasContext
  /** 当前项目 id；版本服务按项目分库。蓝图视图等无项目上下文时省略，分支读数不显示 */
  projectId?: string
}>()

const ctx = useAppContext()
const canvas = props.canvasContext.require<CanvasService>('canvas')
const selection = props.canvasContext.require<SelectionService>('selection')
const history = ctx.get<HistoryService>('history')
const document = ctx.get<DocumentService>('document')

const version = ref(0)
const disposables: Array<{
  /** 释放该条订阅；卸载时逐条调用，重复调用由注册方保证幂等 */
  dispose(): void
}> = []

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

/**
 * 状态栏的分支读数。
 *
 * 版本宿主服务是可选能力：未接入或 off 档位时不显示这一项，而不是写「main」骗人。
 * 会话按项目惰性创建，所以首次进入可能晚一拍；`onDidChange` 覆盖后续提交与切分支。
 */
const versionHost = ctx.get<VersionHostService>('version')
const branchLabel = ref('')

async function refreshBranch(): Promise<void> {
  const id = props.projectId ?? ''
  if (!versionHost || versionHost.mode === 'off' || id === '') {
    branchLabel.value = ''
    return
  }

  try {
    const session = await versionHost.session(id)
    if (!session) {
      branchLabel.value = ''
      return
    }
    const head = session.head
    branchLabel.value = head.branch ?? `游离 ${head.commit.slice(0, 8)}`
  } catch {
    // 版本库故障时状态栏降级为不显示分支，不牵连缩放、选中与撤销读数
    branchLabel.value = ''
  }
}

if (versionHost) disposables.push(versionHost.onDidChange(() => void refreshBranch()))
void refreshBranch()

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
    <span v-if="branchLabel" class="lc-status__item">分支 {{ branchLabel }}</span>
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
