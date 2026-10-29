import { createApp } from 'vue'
import { provideContext } from '@lc/vue'
import App from './App.vue'
import { bootstrapDesigner } from './bootstrap'
import './styles/tokens.css'
import './styles/app.css'

async function start(): Promise<void> {
  const { context, editor, canvas } = await bootstrapDesigner()

  const app = createApp(App, {
    editorContext: editor.context,
    canvasContext: canvas.context,
  })
  provideContext(app, context)
  app.mount('#app')
}

start().catch((error: unknown) => {
  console.error('[designer] 启动失败', error)
  const root = document.querySelector('#app')
  if (root) {
    root.innerHTML = `<pre style="padding:24px;color:#b91c1c;font:13px/1.6 monospace;">设计器启动失败：${
      error instanceof Error ? error.message : String(error)
    }</pre>`
  }
})
