<script setup lang="ts">
import { provide, ref, watch } from 'vue'
import type { FlowEditorHandle } from './composables/use-flow-editor'
import FlowEdgeConfigPane from './FlowEdgeConfigPane.vue'
import FlowGlobalConfigPane from './FlowGlobalConfigPane.vue'
import FlowNodeConfigPane from './FlowNodeConfigPane.vue'
import './styles/inspector.css'

const props = defineProps<{
  /** 流程编辑器句柄；三块面板各自从中取选中项与写入方法 */
  editor: FlowEditorHandle
}>()

type InspectorTab = 'node' | 'edge' | 'global'

const TABS: readonly { value: InspectorTab; label: string }[] = [
  { value: 'node', label: '节点配置' },
  { value: 'edge', label: '连线配置' },
  { value: 'global', label: '全局配置' },
]

const activeTab = ref<InspectorTab>('node')

/**
 * 把编辑器交给深层控件。
 *
 * 目前只有 `kind: 'action'` 的字段控件需要整张图（列出可选节点）。给它单独加一个
 * prop 会让配置面板多一层与业务无关的透传，因此这里用 provide 而不是继续拆 props。
 */
provide('lc-flow-inspector:editor', props.editor)

// 只跟随「选中项发生变化」，不跟随「存在选中项」：否则用户手动切到全局配置后，
// 面板会被自己的 watch 反复拽回节点页，等于锁死了另外两块配置。
watch(
  () => [props.editor.selectedNodeId.value, props.editor.selectedEdgeId.value] as const,
  ([nodeId, edgeId], [previousNodeId, previousEdgeId]) => {
    if (edgeId && edgeId !== previousEdgeId) activeTab.value = 'edge'
    else if (nodeId && nodeId !== previousNodeId) activeTab.value = 'node'
  },
)
</script>

<template>
  <section class="lc-flow-inspector" aria-label="流程配置面板">
    <p v-if="editor.missing.value" class="lc-flow-inspector__empty">流程不存在或已被删除</p>

    <template v-else>
      <div class="lc-flow-inspector__tabs" role="tablist" aria-label="配置类型">
        <button
          v-for="tab in TABS"
          :id="`lc-flow-inspector-tab-${tab.value}`"
          :key="tab.value"
          type="button"
          class="lc-flow-inspector__tab"
          :class="{ 'is-active': activeTab === tab.value }"
          role="tab"
          :aria-selected="activeTab === tab.value"
          :aria-controls="`lc-flow-inspector-panel-${tab.value}`"
          @click="activeTab = tab.value"
        >
          {{ tab.label }}
        </button>
      </div>

      <div
        class="lc-flow-inspector__body"
        role="tabpanel"
        :id="`lc-flow-inspector-panel-${activeTab}`"
        :aria-labelledby="`lc-flow-inspector-tab-${activeTab}`"
      >
        <FlowNodeConfigPane v-if="activeTab === 'node'" :editor="editor" />
        <FlowEdgeConfigPane v-else-if="activeTab === 'edge'" :editor="editor" />
        <FlowGlobalConfigPane v-else :editor="editor" />
      </div>
    </template>
  </section>
</template>
