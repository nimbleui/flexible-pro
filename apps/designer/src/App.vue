<script setup lang="ts">
import type { CanvasContext, EditorContext } from '@lc/contracts'
import { CanvasStage, ContextScope, LcSlot, useAppContext } from '@lc/vue'
import ToolbarStock from './components/ToolbarStock.vue'
import StatusBar from './components/StatusBar.vue'
import CommandPalette from './components/CommandPalette.vue'

const props = defineProps<{
  /** 文档 Realm 上下文：面板 / 工具栏 / 状态栏在此作用域内运行 */
  editorContext: EditorContext
  /** 画布 Realm 上下文：舞台与覆盖层在此作用域内运行 */
  canvasContext: CanvasContext
}>()

const appCtx = useAppContext()

function togglePalette(): void {
  appCtx.emit('palette:toggle')
}
</script>

<template>
  <ContextScope :context="props.editorContext">
    <div class="lc-app">
      <header class="lc-app__header">
        <div class="lc-app__brand">
          <span class="lc-app__logo">LC</span>
          <span>LowCode Studio</span>
          <span class="lc-app__badge">插件化设计器</span>
        </div>
        <ToolbarStock />
        <button type="button" class="lc-app__palette-button" @click="togglePalette">
          命令 ⌘K
        </button>
      </header>

      <main class="lc-app__body">
        <aside class="lc-app__panel">
          <div class="lc-app__panel-title">面板</div>
          <LcSlot name="designer.leftPanel" :context="{ documentId: 'demo-doc' }">
            <template #empty>
              <div class="lc-app__empty">暂无面板贡献</div>
            </template>
          </LcSlot>
        </aside>

        <CanvasStage :context="props.canvasContext" />

        <aside class="lc-app__panel lc-app__panel--right">
          <div class="lc-app__panel-title">属性</div>
          <LcSlot name="designer.rightPanel" :context="{ documentId: 'demo-doc' }">
            <template #empty>
              <div class="lc-app__empty">暂无属性面板</div>
            </template>
          </LcSlot>
        </aside>
      </main>

      <StatusBar :canvas-context="props.canvasContext" />
      <CommandPalette />
    </div>
  </ContextScope>
</template>
