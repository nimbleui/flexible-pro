<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppContext } from '@lc/vue'
import ToastHost from './components/ToastHost.vue'
import { setTheme, type Theme } from './storage/app-preferences'

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

/**
 * 视图重建键。
 *
 * 默认绑 path：换文档即整页重建，画布模块与文档 Realm 的装载状态保持一致。
 * 例外是函数主控台：列表 / 新建 / 编辑三条路由共用一个视图实例，未保存草稿
 * 缓存在视图里，若跟着 path 重建，每次切换选中都会丢修改，所以这三条路由
 * 共用项目级键；换项目仍然整页重建。
 */
const viewKey = computed(() => {
  const name = route.name
  if (
    typeof route.params.projectId === 'string' &&
    (name === 'project-functions' ||
      name === 'project-function-new' ||
      name === 'project-function-edit')
  ) {
    return `functions:${route.params.projectId}`
  }
  return route.path
})

/**
 * 顶栏只留平台级入口。
 *
 * 四类资产的入口搬进了项目外壳（`ProjectShellView` 的页签）：「这个项目的页面有哪些」
 * 是项目内的问题，挂在平台层就只剩「不分项目的全集」这一种解释，而项目化之后
 * 已经没有这种全集了。旧路径 `/pages`、`/flows` 等在 `router.ts` 里回落默认项目。
 *
 * 点亮判断用前缀而不是精确匹配：`/projects/<id>/design/<doc>` 这类下钻路径
 * 仍属于「项目管理」，精确匹配会让编辑态一条导航都不高亮。
 */
const navItems: readonly TopbarNavItem[] = [
  { label: '项目管理', to: '/projects' },
  { label: '插件市场', hint: '插件市场尚未接入' },
  { label: 'AI 助手', hint: 'AI 助手尚未接入' },
]

function isNavActive(to: string | undefined): boolean {
  return to !== undefined && route.path.startsWith(to)
}

function togglePalette(): void {
  appCtx.emit('palette:toggle')
}

/**
 * 深色 / 亮色主题切换：状态落到 <html data-theme> 并写穿 app_kv，刷新后保持。
 *
 * 首帧的主题在 main.ts 挂载前就按 getTheme() 设好了，这里只负责运行中切换。
 */
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  setTheme(theme)
}

function toggleTheme(): void {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light'
  applyTheme(isLight ? 'dark' : 'light')
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
          class="lc-topbar__icon"
          aria-label="切换主题"
          title="切换深色 / 亮色主题"
          @click="toggleTheme"
        >
          <span class="lc-topbar__glyph lc-topbar__glyph--theme" aria-hidden="true" />
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

    <!-- key 默认绑 path：换文档即整页重建；函数主控台三条路由共用项目级键，见 viewKey -->
    <RouterView :key="viewKey" />

    <!-- 提示层挂在外壳而不是各视图里：动作链弹的提示要跨路由存活 -->
    <ToastHost />
  </div>
</template>
