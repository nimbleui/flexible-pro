import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // apps 侧只跑纯逻辑（草稿映射、校验、几何计算）：页面组件仍靠浏览器实测覆盖
    include: ['packages/**/tests/**/*.spec.ts', 'apps/**/tests/**/*.spec.ts'],
    environment: 'node',
  },
})
