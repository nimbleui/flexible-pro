<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useAppContext } from '@lc/vue'
import { PAGES } from '../pages'

const appCtx = useAppContext()

const version = ref(0)
const offWorkspace = appCtx.workspace.onDidChange(() => {
  version.value += 1
})
onUnmounted(offWorkspace.dispose)

/** 已打开的文档 id；Realm 由本应用持有，切进设计器后仍留在工作区里 */
const openIds = computed(() => {
  version.value
  return new Set(appCtx.workspace.listEditors().map((realm) => realm.documentId))
})
</script>

<template>
  <main class="lc-pages">
    <h1 class="lc-pages__title">页面</h1>
    <p class="lc-pages__hint">
      文档 Realm 与外壳由主应用持有，画布由远程模块 <code>designerCanvas</code> 装载。
    </p>

    <ul class="lc-pages__list">
      <li v-for="page in PAGES" :key="page.documentId" class="lc-pages__item">
        <RouterLink class="lc-pages__link" :to="`/design/${page.documentId}`">
          <span class="lc-pages__name">{{ page.title }}</span>
          <span class="lc-pages__id">{{ page.documentId }}</span>
          <span v-if="openIds.has(page.documentId)" class="lc-pages__badge">已打开</span>
        </RouterLink>
        <!-- 预览挂在卡片外面：链接套链接是无效 HTML，卡片本身整块是进设计器的入口 -->
        <RouterLink class="lc-pages__preview" :to="`/preview/${page.documentId}`"
          >预览</RouterLink
        >
      </li>
    </ul>
  </main>
</template>

<style scoped>
.lc-pages__item {
  position: relative;
}

.lc-pages__preview {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 1;
  padding: 3px 10px;
  border: 1px solid var(--lc-border-strong);
  border-radius: 999px;
  color: var(--lc-text-secondary);
  font-size: 11px;
  text-decoration: none;
  transition:
    border-color 0.15s ease,
    color 0.15s ease;
}

/* 与卡片 hover 用同一组强调色，但键盘聚焦必须单独给：只用 hover 时 Tab 过来看不见入口 */
.lc-pages__preview:hover,
.lc-pages__preview:focus-visible {
  border-color: rgba(55, 182, 255, 0.55);
  color: var(--lc-accent-bright);
}

.lc-pages__preview:focus-visible {
  outline: 1px solid var(--lc-accent-bright);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-pages__preview {
    transition: none;
  }
}
</style>
