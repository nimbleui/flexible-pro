<script setup lang="ts">
import type { Component } from 'vue'
import { markRaw, onUnmounted, reactive, ref, watch } from 'vue'
import type { SlotName } from '@lc/contracts'
import { moduleKey } from '@lc/contracts'
import { useAppContext } from '../context'
import PluginBoundary from './PluginBoundary.vue'

const props = defineProps<{
  /** 宿主插槽名 */
  name: SlotName

  /**
   * 传给面板组件的只读上下文，如 { documentId }
   *
   * 以 `context` 这一个 prop 原样下发，插槽不校验字段；键名约定由贡献声明与
   * 面板实现自行对齐。未传时面板收到 undefined。
   */
  context?: Record<string, unknown>

  /**
   * 只渲染该 id 的面板；缺省时渲染槽内全部面板。
   *
   * 底部停靠区的几个面板共用一个槽并且互斥显示，同时挂载会让每块面板各自订阅
   * 文档、各自占一份高度。过滤发生在加载之前，所以未选中的面板不会被激活也不会
   * 被下载。
   */
  active?: string
}>()

const ctx = useAppContext()

/** 组件是否已卸载；ctx 是应用级的，模块异步返回后要靠组件自身判活 */
let alive = true

// 贡献注册表不是响应式源，用自增计数把 onDidChange 桥接进 Vue 依赖
const version = ref(0)

/** key → 已加载面板组件 */
const components = reactive(new Map<string, Component>())

/** key → 加载失败原因 */
const failures = reactive(new Map<string, string>())

// 只用于并发去重，不参与渲染
const loading = new Set<string>()

const off = ctx.contribution.onDidChange(() => {
  version.value += 1
})
onUnmounted(() => {
  alive = false
  off.dispose()
})

/** 插槽内单个面板的渲染项 */
interface SlotEntry {
  /** `${plugin}/${panelId}` 组合键，同时是 components / failures 的索引 */
  key: string
  /** 贡献来源插件名，传给错误边界做归属 */
  plugin: string
  /** 面板 id，写在 data-panel 上供样式与测试定位 */
  panelId: string
  /** 面板展示标题 */
  title: string
  /** 已解析的面板组件；undefined 表示还在加载或已失败 */
  component?: Component
}

const entries = ref<SlotEntry[]>([])

watch(
  () => {
    // 读取 version 建立依赖：贡献变化后即使插槽名没变也要重新取列表
    version.value
    const items = ctx.contribution.listSlot(props.name)
    // 读了 props.active 就把它变成了依赖：换页签时只有命中的面板进入加载队列
    return props.active === undefined
      ? items
      : items.filter((item) => item.value.id === props.active)
  },
  (items) => {
    // 列表先按缓存渲染，未命中的面板由 ensurePanel 异步补齐后原地替换
    entries.value = items.map((item) => {
      const key = `${item.plugin}/${item.value.id}`
      return {
        key,
        plugin: item.plugin,
        panelId: item.value.id,
        title: item.value.title,
        component: components.get(key),
      }
    })
    for (const item of items) {
      void ensurePanel(item.plugin, item.value.id, item.value.module)
    }
  },
  { immediate: true },
)

/**
 * 按需加载面板模块。
 *
 * 加载完成后不只写缓存，还要重建 entries 里对应那一项：其余项保持原对象引用，
 * keyed v-for 因此只重渲染到达的那块面板，而不是整个插槽。
 * key 的拼接方式必须与 watch 内一致，否则缓存与渲染项对不上，面板会一直停在骨架。
 */
async function ensurePanel(plugin: string, panelId: string, moduleName: string): Promise<void> {
  const key = `${plugin}/${panelId}`
  if (components.has(key) || loading.has(key)) return
  loading.add(key)

  try {
    // 必须等插件行为激活完成再加载面板模块：apply 期注册的服务是面板组件的前提，
    // 并发触发会让模块先于这些服务就绪。纯声明式插件没有 main，会直接返回。
    // 放在既有 try 内，让 finally 在激活异常时也能回收 loading，不新增 try/catch。
    await ctx.loader.ensureActivated(`onPanel:${panelId}`)

    const module = await ctx.modules.load<{
      /** 面板组件必须由模块默认导出；缺失时按失败处理并显示提示 */
      default?: Component
    }>(moduleKey(plugin, moduleName))
    // 模块加载期间插槽可能已卸载，不能再写回已失效的响应式状态
    if (!alive) return
    if (!module.default) {
      failures.set(key, '面板模块未导出默认组件')
      return
    }
    components.set(key, markRaw(module.default))
    entries.value = entries.value.map((entry) =>
      entry.key === key ? { ...entry, component: markRaw(module.default as Component) } : entry,
    )
  } catch (error) {
    failures.set(key, error instanceof Error ? error.message : String(error))
    ctx.diagnostics.report(error, { scope: 'slot', plugin, panel: panelId, module: moduleName })
  } finally {
    loading.delete(key)
  }
}
</script>

<template>
  <div class="lc-slot" :data-slot="name">
    <!-- 每个面板单独包一层错误边界：一个插件渲染崩溃只降级它自己，不影响同槽其它面板 -->
    <PluginBoundary
      v-for="entry in entries"
      :key="entry.key"
      :plugin="entry.plugin"
      :title="entry.title"
    >
      <component :is="entry.component" v-if="entry.component" :context="props.context" />
      <div v-else-if="failures.has(entry.key)" class="lc-slot__error" role="alert">
        {{ failures.get(entry.key) }}
      </div>
      <!-- 既没到组件也没失败的中间态即加载中：用骨架占位，避免面板位置跳动 -->
      <div v-else class="lc-slot__skeleton" :data-panel="entry.panelId" />
    </PluginBoundary>

    <slot v-if="entries.length === 0" name="empty" />
  </div>
</template>

<style scoped>
.lc-slot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.lc-slot__skeleton {
  height: 72px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  border: 1px dashed var(--lc-border);
}

.lc-slot__error {
  padding: 8px 10px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 12px;
}
</style>
