<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppContext } from '@lc/vue'

interface TopbarNavItem {
  label: string
  /** 有路由的入口；占位项只带 hint，渲染成不可用文本 */
  to?: string
  /** 占位原因，同时作为 title 说明 */
  hint?: string
}

const route = useRoute()
const appCtx = useAppContext()

const navItems: readonly TopbarNavItem[] = [
  { label: '项目管理', hint: '项目管理尚未接入' },
  { label: '页面管理', to: '/pages' },
  { label: '函数管理', to: '/functions' },
  { label: '组件库', hint: '组件库尚未接入' },
  { label: '插件市场', hint: '插件市场尚未接入' },
  { label: 'AI 助手', hint: 'AI 助手尚未接入' },
]

// 设计器路由归属「页面管理」，否则进入画布后顶栏没有任何导航项处于选中态
const isDesignerRoute = computed(() => route.path.startsWith('/design/'))

function togglePalette(): void {
  appCtx.emit('palette:toggle')
}
</script>

<template>
  <div class="lc-app">
    <header class="lc-app__header">
      <div class="lc-app__brand">
        <span class="lc-app__logo" aria-hidden="true" />
        <span class="lc-app__brand-name">低代码平台</span>
        <span class="lc-app__badge">企业版</span>
      </div>

      <nav class="lc-topbar__nav" aria-label="产品导航">
        <template v-for="item in navItems" :key="item.label">
          <RouterLink
            v-if="item.to"
            class="lc-topbar__nav-item"
            :class="{
              'lc-topbar__nav-item--active': item.to === '/pages' && isDesignerRoute,
            }"
            :to="item.to"
          >
            {{ item.label }}
          </RouterLink>
          <span v-else class="lc-topbar__nav-item" aria-disabled="true" :title="item.hint">
            {{ item.label }}
          </span>
        </template>
      </nav>

      <div class="lc-topbar__actions">
        <button
          type="button"
          class="lc-topbar__icon"
          aria-label="搜索与命令面板"
          title="搜索 / 命令面板（Ctrl+K）"
          @click="togglePalette"
        >
          <span class="lc-topbar__glyph lc-topbar__glyph--search" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="lc-topbar__icon"
          aria-label="通知（尚未接入）"
          aria-disabled="true"
          title="通知中心尚未接入"
        >
          <span class="lc-topbar__glyph lc-topbar__glyph--bell" aria-hidden="true" />
          <span class="lc-topbar__dot" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="lc-topbar__avatar"
          aria-label="账户菜单（尚未接入）"
          aria-disabled="true"
          title="账户菜单尚未接入"
        >
          LC
        </button>
      </div>
    </header>

    <!-- key 绑 path：换文档即整页重建，画布模块与文档 Realm 的装载状态保持一致 -->
    <RouterView :key="route.path" />
  </div>
</template>
