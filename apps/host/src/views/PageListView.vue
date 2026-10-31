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
      </li>
    </ul>
  </main>
</template>
