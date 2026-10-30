import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { PropType } from 'vue'
import type { Disposable } from '@lc/kernel'
import type {
  CanvasFrame,
  CanvasMenuItem,
  CanvasMenuTarget,
  CanvasService,
  CommandService,
} from '@lc/contracts'
import { CANVAS_CONTEXT_MENU_STATE } from '@lc/contracts'
import { useAppContext } from '@lc/vue'

/** 菜单宽度与行高：位置夹紧要用它估算边界，行高同时用于整体高度估算 */
const MENU_WIDTH = 190
const ROW_HEIGHT = 28
const SEPARATOR_HEIGHT = 9
const PADDING = 6

/**
 * 右键菜单覆盖层。
 *
 * 开合状态来自画布设置（`CANVAS_CONTEXT_MENU_STATE`），项目来自 `canvas.contextMenu`，
 * 标题与可用性来自命令注册表：三层各自独立，所以关掉某个画布能力后菜单不会留下
 * 失效项目，命令被置灰时菜单同步置灰。
 */
export const ContextMenuOverlay = defineComponent({
  name: 'LcContextMenuOverlay',
  props: {
    /** 画布帧快照；用 size 做边界夹紧 */
    frame: { type: Object as PropType<CanvasFrame>, required: true },
  },
  setup(props) {
    const ctx = useAppContext()
    const canvas = ctx.require<CanvasService>('canvas')
    const command = ctx.require<CommandService>('command')

    // 设置、菜单表、命令表都不是响应式源，统一用自增计数桥接进 Vue 依赖
    const version = ref(0)
    const hoveredId = ref<string | null>(null)
    const disposables: Disposable[] = []

    const bump = (): void => {
      version.value += 1
    }

    onMounted(() => {
      disposables.push(canvas.settings.onDidChange(CANVAS_CONTEXT_MENU_STATE, bump))
      disposables.push(canvas.contextMenu.onDidChange(bump))
      disposables.push(command.onDidChange(bump))
    })

    onUnmounted(() => {
      for (const disposable of disposables) disposable.dispose()
      disposables.length = 0
    })

    function close(): void {
      canvas.settings.set<CanvasMenuTarget | null>(CANVAS_CONTEXT_MENU_STATE, null)
    }

    function choose(item: CanvasMenuItem): void {
      // 先收菜单再执行：命令可能改选中集，留着旧目标信息没有意义
      close()
      if (item.command) void command.execute(item.command)
    }

    return () => {
      version.value

      const target = canvas.settings.get<CanvasMenuTarget | null>(CANVAS_CONTEXT_MENU_STATE)
      if (!target) return null

      const items = canvas.contextMenu
        .list()
        .filter((item) => !item.command || command.get(item.command) !== undefined)
        .filter((item) => item.visible?.(target) ?? true)
      if (items.length === 0) return null

      const separators = items.reduce(
        (count, item, index) =>
          index > 0 && (item.group ?? 'default') !== (items[index - 1]?.group ?? 'default')
            ? count + 1
            : count,
        0,
      )
      const height = items.length * ROW_HEIGHT + separators * SEPARATOR_HEIGHT + PADDING * 2
      const size = props.frame.size
      // 贴边时往回收，菜单永不超出舞台；舞台尺寸未测量时按原点显示
      const left = Math.max(4, Math.min(target.screen.x, size.width - MENU_WIDTH - 4))
      const top = Math.max(4, Math.min(target.screen.y, Math.max(4, size.height - height - 4)))

      const rows: ReturnType<typeof h>[] = []
      let previousGroup: string | null = null

      for (const item of items) {
        const group = item.group ?? 'default'
        if (previousGroup !== null && group !== previousGroup) {
          rows.push(
            h('div', {
              key: `sep-${item.id}`,
              style: { height: `${SEPARATOR_HEIGHT - 2}px`, margin: '1px 8px' },
            }),
          )
        }
        previousGroup = group

        const definition = item.command ? command.get(item.command) : undefined
        const label = item.title ?? definition?.title ?? item.id
        const enabled = item.enabled ? item.enabled(target) : (definition?.enabled?.() ?? true)

        rows.push(
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              class: 'lc-context-menu__item',
              disabled: !enabled,
              onMouseenter: () => {
                hoveredId.value = enabled ? item.id : null
              },
              onMouseleave: () => {
                hoveredId.value = null
              },
              onClick: () => {
                if (enabled) choose(item)
              },
              style: {
                height: `${ROW_HEIGHT}px`,
                padding: '0 10px',
                border: 'none',
                borderRadius: '4px',
                background:
                  hoveredId.value === item.id ? 'rgba(37, 99, 235, 0.12)' : 'transparent',
                color: enabled
                  ? 'var(--lc-text, #0f172a)'
                  : 'var(--lc-text-secondary, #94a3b8)',
                cursor: enabled ? 'pointer' : 'default',
                fontSize: '12px',
                textAlign: 'left',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            label,
          ),
        )
      }

      return h(
        'div',
        {
          class: 'lc-context-menu',
          style: {
            position: 'absolute',
            left: `${left}px`,
            top: `${top}px`,
            width: `${MENU_WIDTH}px`,
            display: 'flex',
            flexDirection: 'column',
            gap: '1px',
            padding: `${PADDING}px`,
            boxSizing: 'border-box',
            // 图层本身是 children 模式（容器穿透），只有菜单实体接管指针
            pointerEvents: 'auto',
            border: '1px solid var(--lc-border, rgba(15, 23, 42, 0.12))',
            borderRadius: '8px',
            background: 'var(--lc-surface, #ffffff)',
            boxShadow: 'var(--lc-shadow, 0 12px 32px rgba(15, 23, 42, 0.16))',
          },
          // 压在菜单上不算画布点击：不拦住会让菜单在 pointerdown 阶段就被自己关掉
          onPointerdown: (event: PointerEvent) => event.stopPropagation(),
          onContextmenu: (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
          },
        },
        rows,
      )
    }
  },
})

export default ContextMenuOverlay
