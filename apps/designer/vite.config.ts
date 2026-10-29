import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // 保证 @lc/vue 与宿主使用同一个 Vue 实例
    dedupe: ['vue'],
  },
  server: {
    port: 5173,
  },
})
