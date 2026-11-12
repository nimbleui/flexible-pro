import { createApp } from 'vue'
import { provideContext } from '@lc/vue'
import App from './App.vue'
import { router } from './router'
import { bootstrapHost } from './bootstrap'
import { hydrateAll } from './storage/hydrate'
import { getTheme } from './storage/app-preferences'
// 组件库样式先于外壳样式：物料的外观默认值要能被外壳的 tokens 与 app.css 覆盖。
import '@agile-plus/components/style.css'
import './styles/tokens.css'
import './styles/app.css'

async function start(): Promise<void> {
  // 先把 IndexedDB 灌进各 store 的内存态，再引导内核与挂载：视图沿用的同步读取此前必须就位
  await hydrateAll()
  document.documentElement.setAttribute('data-theme', getTheme())

  const { context } = await bootstrapHost()

  const app = createApp(App)
  provideContext(app, context)
  app.use(router)
  app.mount('#app')
}

start().catch((error: unknown) => {
  console.error('[host] 主应用启动失败', error)
  const root = document.querySelector('#app')
  if (root) {
    root.innerHTML = `<pre style="padding:24px;color:#b91c1c;font:13px/1.6 monospace;">主应用启动失败：${
      error instanceof Error ? error.message : String(error)
    }</pre>`
  }
})
