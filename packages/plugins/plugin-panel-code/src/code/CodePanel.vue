<script setup lang="ts">
import { useCodePanel } from './composables/use-code-panel'

defineProps<{
  /** 宿主传入的只读上下文；面板自己从注入的 Context 取服务 */
  context?: Record<string, unknown>
}>()

const {
  code,
  copy,
  download,
  isNodeScopeAvailable,
  lineCount,
  scope,
  selectedLabel,
  warnings,
} = useCodePanel()
</script>

<template>
  <div class="lc-code">
    <header class="lc-code__bar">
      <div class="lc-code__scope" role="radiogroup" aria-label="出码范围">
        <button
          type="button"
          role="radio"
          class="lc-code__scope-item"
          :aria-checked="scope === 'page'"
          @click="scope = 'page'"
        >
          整页
        </button>
        <button
          type="button"
          role="radio"
          class="lc-code__scope-item"
          :aria-checked="scope === 'node'"
          :title="isNodeScopeAvailable ? selectedLabel : '先在画布上选中一个节点'"
          @click="scope = 'node'"
        >
          选中节点
        </button>
      </div>

      <span v-if="scope === 'node' && !isNodeScopeAvailable" class="lc-code__hint">
        未选中节点，当前出的是整页
      </span>

      <span class="lc-code__meta">
        <span>{{ lineCount }} 行</span>
        <span v-if="warnings.length" class="lc-code__badge">{{ warnings.length }} 项降级</span>
      </span>

      <div class="lc-code__actions">
        <button type="button" class="lc-code__button" @click="copy">复制</button>
        <button
          type="button"
          class="lc-code__button lc-code__button--primary"
          @click="download"
        >
          下载 .vue
        </button>
      </div>
    </header>

    <div class="lc-code__body">
      <div class="lc-code__view">
        <ol class="lc-code__gutter" aria-hidden="true">
          <li v-for="line in lineCount" :key="line">{{ line }}</li>
        </ol>
        <pre class="lc-code__text" tabindex="0" aria-label="出码结果">{{ code }}</pre>
      </div>

      <aside v-if="warnings.length" class="lc-code__warnings" aria-label="出码降级说明">
        <p class="lc-code__warnings-title">本次出码的降级项</p>
        <ul>
          <li v-for="(warning, index) in warnings" :key="`${warning}-${index}`">
            {{ warning }}
          </li>
        </ul>
      </aside>
    </div>
  </div>
</template>

<style scoped src="./styles/base.css"></style>
<style scoped src="./styles/view.css"></style>
<style scoped src="./styles/states.css"></style>
