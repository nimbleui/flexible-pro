import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { CSSProperties, PropType } from 'vue'
import type { Disposable } from '@lc/kernel'
import type {
  CanvasFrame,
  CanvasMenuItem,
  CanvasMenuTarget,
  CanvasService,
  CommandService,
  Size,
} from '@lc/contracts'
import { CANVAS_CONTEXT_MENU_STATE } from '@lc/contracts'
import { useAppContext } from '@lc/vue'

/** 菜单宽度与行高：位置夹紧要用它估算边界，行高同时用于整体高度估算 */
const MENU_WIDTH = 190
const ROW_HEIGHT = 28
const SEPARATOR_HEIGHT = 9
const PADDING = 6

/** 菜单容器外观：宽度、圆角、投影固定，只有落点由 clampToStage 决定 */
const MENU_SHELL_STYLE: CSSProperties = {
  position: 'absolute',
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
}

/**
 * 菜单项外观。行高与估算高度用的 ROW_HEIGHT 必须同源，否则夹紧会偏差一整行。
 *
 * @param enabled 禁用项只靠文字颜色与光标区分，不显示悬停底色
 * @param hovered 悬停项；调用方只在可用项上置真
 */
function menuItemStyle(enabled: boolean, hovered: boolean): CSSProperties {
  return {
    height: `${ROW_HEIGHT}px`,
    padding: '0 10px',
    border: 'none',
    borderRadius: '4px',
    background: hovered ? 'rgba(37, 99, 235, 0.12)' : 'transparent',
    color: enabled ? 'var(--lc-text, #0f172a)' : 'var(--lc-text-secondary, #94a3b8)',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '12px',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }
}

/**
 * 菜单项 = 画布注册表按命令注册表过滤后的结果。
 *
 * 引用了未装配命令的项目直接丢弃，保证「画布预设关掉某能力后菜单不留死项」；
 * `visible` 缺省视为可见。
 */
function listVisibleItems(
  canvas: CanvasService,
  command: CommandService,
  target: CanvasMenuTarget,
): CanvasMenuItem[] {
  return canvas.contextMenu
    .list()
    .filter((item) => !item.command || command.get(item.command) !== undefined)
    .filter((item) => item.visible?.(target) ?? true)
}

/**
 * 按 CSS 像素估算菜单整体高度，供夹紧定位使用。
 *
 * 分隔线只插在相邻 group 变化处，因此数量要在 items 序列上单遍统计，
 * 不能按 group 去重数。
 */
function estimateMenuHeight(items: readonly CanvasMenuItem[]): number {
  const separators = items.reduce(
    (count, item, index) =>
      index > 0 && (item.group ?? 'default') !== (items[index - 1]?.group ?? 'default')
        ? count + 1
        : count,
    0,
  )
  return items.length * ROW_HEIGHT + separators * SEPARATOR_HEIGHT + PADDING * 2
}

/**
 * 把菜单左上角收进舞台边界。
 *
 * 入参 `size` 是舞台的屏幕尺寸，`target.screen` 与结果同属舞台本地屏幕坐标空间；
 * 贴边时往回收，菜单永不超出舞台。`Math.max(4, …)` 兜底菜单比舞台还高的极端缩放；
 * 舞台尺寸未测量时 size 为 0，退化为按原点显示。
 */
function clampToStage(
  size: Size,
  target: CanvasMenuTarget,
  menuHeight: number,
): {
  /** 菜单左边到舞台左边的距离：舞台本地 CSS 像素，不受 zoom 与设备像素比影响 */
  left: number
  /** 菜单顶边到舞台顶边的距离：同上，夹紧下限固定为 4px 安全边距 */
  top: number
} {
  const left = Math.max(4, Math.min(target.screen.x, size.width - MENU_WIDTH - 4))
  const top = Math.max(4, Math.min(target.screen.y, Math.max(4, size.height - menuHeight - 4)))
  return { left, top }
}

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

    /** 单个菜单项按钮：可用性优先取菜单项自身断言，否则回落到命令注册表 */
    function buildMenuRow(
      item: CanvasMenuItem,
      target: CanvasMenuTarget,
    ): ReturnType<typeof h> {
      const definition = item.command ? command.get(item.command) : undefined
      const label = item.title ?? definition?.title ?? item.id
      const enabled = item.enabled ? item.enabled(target) : (definition?.enabled?.() ?? true)

      return h(
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
          style: menuItemStyle(enabled, hoveredId.value === item.id),
        },
        label,
      )
    }

    /** 行序列：group 变化处先插一条分隔线占位块，再插按钮 */
    function buildMenuRows(items: CanvasMenuItem[], target: CanvasMenuTarget) {
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

        rows.push(buildMenuRow(item, target))
      }

      return rows
    }

    return () => {
      version.value

      const target = canvas.settings.get<CanvasMenuTarget | null>(CANVAS_CONTEXT_MENU_STATE)
      if (!target) return null

      const items = listVisibleItems(canvas, command, target)
      if (items.length === 0) return null

      const { left, top } = clampToStage(props.frame.size, target, estimateMenuHeight(items))

      return h(
        'div',
        {
          class: 'lc-context-menu',
          style: { ...MENU_SHELL_STYLE, left: `${left}px`, top: `${top}px` },
          // 压在菜单上不算画布点击：不拦住会让菜单在 pointerdown 阶段就被自己关掉
          onPointerdown: (event: PointerEvent) => event.stopPropagation(),
          onContextmenu: (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
          },
        },
        buildMenuRows(items, target),
      )
    }
  },
})

export default ContextMenuOverlay
