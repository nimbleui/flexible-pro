<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useAppContext } from '@lc/vue'
import ToastHost from './components/ToastHost.vue'

interface TopbarNavItem {
  /** 导航文案，同时作为无障碍名 */
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
  { label: '流程编排管理', to: '/flows' },
  { label: '函数管理', to: '/functions' },
  { label: '组件管理', to: '/components' },
  { label: '插件市场', hint: '插件市场尚未接入' },
  { label: 'AI 助手', hint: 'AI 助手尚未接入' },
]

/**
 * 顶层归属：进入子路由后顶栏仍要点亮对应入口。
 *
 * `/design/` 属于页面管理、`/flows/` 属于流程编排，两者都是「列表 → 编辑器」的下钻，
 * 精确匹配会让编辑态下一条导航都不高亮。用前缀表推导而不是给每项加 `match` 字段：
 * 归属关系是路由结构决定的，写两处就会和 `router.ts` 漂移。
 */
const NAV_OWNER_PREFIXES: ReadonlyArray<{ to: string; prefixes: readonly string[] }> = [
  { to: '/pages', prefixes: ['/pages', '/design/', '/preview/'] },
  { to: '/flows', prefixes: ['/flows'] },
  { to: '/functions', prefixes: ['/functions'] },
  { to: '/components', prefixes: ['/components'] },
]

function isNavActive(to: string | undefined): boolean {
  if (!to) return false

  const owner = NAV_OWNER_PREFIXES.find((entry) => entry.to === to)
  if (!owner) return route.path === to

  return owner.prefixes.some((prefix) => route.path.startsWith(prefix))
}

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
              'lc-topbar__nav-item--active': isNavActive(item.to),
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

    <!-- 提示层挂在外壳而不是各视图里：动作链弹的提示要跨路由存活 -->
    <ToastHost />
  </div>
</template>
