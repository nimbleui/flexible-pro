import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 宿主 store 的依赖链会经 @lc/vue 入口带到 .vue 文件，node 环境也需要 SFC 插件才能解析
  plugins: [vue()],
  test: {
    // apps 侧只跑纯逻辑（草稿映射、校验、几何计算）：页面组件仍靠浏览器实测覆盖
    include: ['packages/**/tests/**/*.spec.ts', 'apps/**/tests/**/*.spec.ts'],
    environment: 'node',
  },
})
