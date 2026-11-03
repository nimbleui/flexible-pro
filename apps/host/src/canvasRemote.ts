import { defineAsyncComponent, defineComponent, h } from 'vue'

/**
 * 远程画布模块。
 *
 * 地址在运行时才由 Module Federation 解析，因此只能异步装载；远程不可达时给出
 * 可操作的提示，而不是留下一片空白让人以为画布坏了。
 *
 * 设计器与组件蓝图共用同一个装载入口：远程契约（`src/remotes.d.ts`）只有一份，
 * 在两处各写一遍异步声明会让「换了 props 却只改一个视图」变成隐性故障。
 */
export const CanvasModule = defineAsyncComponent({
  loader: () => import('designerCanvas/CanvasModule'),
  errorComponent: defineComponent({
    setup: () => () =>
      h(
        'div',
        { class: 'lc-designer__notice' },
        '画布模块不可用：请确认 designer 已在 5174 端口启动（pnpm dev 会并行拉起两个进程）',
      ),
  }),
})
