<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { PageRuntime } from '@lc/vue'
import type { ProjectRequestDefaults } from '@lc/contracts'
import type { PageRecord } from '../../pages/page-model'
import { usePageRuntime } from '../../pages/use-page-runtime'

/**
 * 发布快照的缩略预览卡。
 *
 * 用运行态渲染器真实渲染快照里的那张页面，再按容器宽度整体缩放，得到「浏览器
 * 截图」式的预览。Realm key 带版本号与页面 id，且 preferExisting=false：预览的
 * 必须是这份快照，而不是设计器里未保存的草稿。调用方以 revision+pageId 作 key
 * 重建本组件，切换版本即换 Realm，卸载时由 usePageRuntime 回收。
 */

const props = defineProps<{
  /** 要预览的快照页面记录 */
  page: PageRecord
  /** 快照发布号，参与 Realm key，避免与运行页撞 key */
  revision: number
  /** 快照定版的请求环境；预览取数按发布时那一套跑 */
  environment?: ProjectRequestDefaults
}>()

const { editor, ready, routeScope } = usePageRuntime({
  realmKey: `vm-preview@r${props.revision}:${props.page.id}`,
  title: props.page.title,
  schema: props.page.schema,
  requestDefaults: props.environment,
  preferExisting: false,
})

const canvasRect = computed(
  () => props.page.schema.nodes[props.page.schema.nodeId]?.layout?.rect,
)
const canvasWidth = computed(() => canvasRect.value?.width || 1200)
const canvasHeight = computed(() => canvasRect.value?.height || 800)

const viewport = ref<HTMLElement | null>(null)
const scale = ref(0)

/** 只读容器宽度一次再写 transform；容器尺寸由 CSS 固定，不会形成观测循环 */
function measure(): void {
  const width = viewport.value?.clientWidth ?? 0
  if (width === 0) return
  scale.value = Math.min(1, width / canvasWidth.value)
}

let observer: ResizeObserver | undefined

onMounted(() => {
  measure()
  observer = new ResizeObserver(measure)
  if (viewport.value) observer.observe(viewport.value)
})

onUnmounted(() => {
  observer?.disconnect()
})

watch(canvasWidth, measure)
</script>

<template>
  <figure class="lc-release-preview">
    <div class="lc-release-preview__chrome">
      <span class="lc-release-preview__lights" aria-hidden="true">
        <i class="lc-release-preview__light lc-release-preview__light--red" />
        <i class="lc-release-preview__light lc-release-preview__light--yellow" />
        <i class="lc-release-preview__light lc-release-preview__light--green" />
      </span>
      <span class="lc-release-preview__address">{{ page.title }}</span>
      <span class="lc-release-preview__rev">v{{ revision }}</span>
    </div>

    <div ref="viewport" class="lc-release-preview__viewport">
      <div v-if="!ready || scale === 0" class="lc-release-preview__loading">快照装载中…</div>
      <div
        v-else
        class="lc-release-preview__scale"
        :style="{
          width: `${canvasWidth}px`,
          height: `${canvasHeight}px`,
          transform: `scale(${scale})`,
        }"
      >
        <PageRuntime :context="editor.context" :scope="routeScope" />
      </div>
    </div>

    <figcaption class="lc-release-preview__caption">
      快照 v{{ revision }} · {{ page.title }} · 缩略预览
    </figcaption>
  </figure>
</template>

<style scoped>
.lc-release-preview {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
}

.lc-release-preview__chrome {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--lc-border);
  background: var(--lc-surface-sunken);
}

.lc-release-preview__lights {
  display: inline-flex;
  gap: 5px;
}

.lc-release-preview__light {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.lc-release-preview__light--red {
  background: var(--lc-danger);
}

.lc-release-preview__light--yellow {
  background: var(--lc-warning);
}

.lc-release-preview__light--green {
  background: var(--lc-success);
}

.lc-release-preview__address {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: 3px 10px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  background: var(--lc-surface);
  color: var(--lc-text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-release-preview__rev {
  flex: none;
  color: var(--lc-accent-bright);
  font-size: 11px;
  font-weight: 600;
}

/* 视口尺寸由 CSS 固定：缩放内容绝对定位，不反过来撑大容器 */
.lc-release-preview__viewport {
  position: relative;
  height: 300px;
  overflow: hidden;
  background: var(--lc-canvas-bg);
}

.lc-release-preview__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--lc-text-secondary);
  font-size: 12px;
}

.lc-release-preview__scale {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
  pointer-events: none;
}

.lc-release-preview__caption {
  flex: none;
  padding: 7px 12px;
  border-top: 1px solid var(--lc-border);
  color: var(--lc-text-muted);
  font-size: 11px;
}
</style>
