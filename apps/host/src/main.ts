import { createApp } from 'vue'
import { provideContext } from '@lc/vue'
import App from './App.vue'
import { router } from './router'
import { bootstrapHost } from './bootstrap'
import './styles/tokens.css'
import './styles/app.css'

async function start(): Promise<void> {
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
