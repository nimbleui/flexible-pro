import { defineAsyncComponent, defineComponent, h } from 'vue'

/**
 * 远程画布模块。
 *
 * 地址在运行时才由 Module Federation 解析，因此只能异步装载；远程不可达时给出
 * 可操作的提示，而不是留下一片空白让人以为画布坏了。
 *
 * 设计器与组件蓝图共用同一个装载入口：远程契约（`src/remotes.d.ts`）只有一份，
 * 在两处各写一遍异步声明会让「换了 props 却只改一个视图」变成隐性故障。
 *
 * `delay` 用默认的 200ms：本地 dev 与已缓存的 chunk 通常更快到，不该闪一行加载态。
 * 加载态复用 `.lc-designer__loading`——舞台本身就是 flex 容器，这条规则在这层直接居中。
 */
export const CanvasModule = defineAsyncComponent({
  loader: () => import('designerCanvas/CanvasModule'),
  loadingComponent: defineComponent({
    setup: () => () => h('div', { class: 'lc-designer__loading' }, '画布模块装载中…'),
  }),
  errorComponent: defineComponent({
    setup: () => () =>
      h(
        'div',
        { class: 'lc-designer__notice' },
        '画布模块不可用：请确认 designer 已在 5174 端口启动（pnpm dev 会并行拉起两个进程）',
      ),
  }),
})
