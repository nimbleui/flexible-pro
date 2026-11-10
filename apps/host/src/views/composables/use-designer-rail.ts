import { ref } from 'vue'
import type { Ref } from 'vue'

/**
 * 设计器左侧 rail 与三块外壳面板的可见性。
 *
 * 三块面板的可见性互不排斥、可以同屏，因此各自一个 ref 而不是单一互斥状态。
 * `runCommand` 由视图显式传入：rail 只负责分发点击，不反向依赖工具栏的命令态。
 */

/** 浮动面板的标题；rail 项与浮层头部共用同一个字符串，不在两处各写一遍 */
const OVERLAY_TITLE = '页面大纲'

/** rail 上可开关的界面；面板可见性归外壳，内容归贡献该槽的插件 */
export type RailTarget = 'leftPanel' | 'overlayPanel' | 'dock'

export interface DesignerRailItem {
  /** 稳定 id，用于 key 与 aria 定位 */
  id: string
  /** 图标下方的短标签 */
  label: string
  /** 共享图标注册表里的图标名 */
  icon: string
  /**
   * 点击行为；undefined 渲染成禁用态，提示尚未接入。
   *
   * 命令型复用宿主已注册的命令（页面数据 / 自定义函数弹框），不新造一套开关状态。
   */
  action?: { kind: 'toggle'; target: RailTarget } | { kind: 'command'; commandId: string }
}

// rail 是工作区入口集合：组件库常驻左栏，页面大纲浮在画布上，底部面板开关停靠区
const railItems: readonly DesignerRailItem[] = [
  {
    id: 'components',
    label: '组件库',
    icon: 'library',
    action: { kind: 'toggle', target: 'leftPanel' },
  },
  {
    id: 'outline',
    label: OVERLAY_TITLE,
    icon: 'outline',
    action: { kind: 'toggle', target: 'overlayPanel' },
  },
  {
    id: 'dataSource',
    label: '数据源',
    icon: 'database',
    action: { kind: 'command', commandId: 'pageData.openDialog' },
  },
  {
    id: 'functions',
    label: '方法管理',
    icon: 'function',
    action: { kind: 'command', commandId: 'pageFunction.openDialog' },
  },
  {
    id: 'dock',
    label: '底部面板',
    icon: 'list',
    action: { kind: 'toggle', target: 'dock' },
  },
  {
    id: 'versions',
    label: '版本管理',
    icon: 'version',
    action: { kind: 'command', commandId: 'version.openHistory' },
  },
  { id: 'settings', label: '设置', icon: 'sliders' },
]

export interface DesignerRailOptions {
  /** 命令型 rail 项复用的命令执行入口 */
  runCommand: (id: string) => void
}

export interface DesignerRail {
  OVERLAY_TITLE: string
  railItems: readonly DesignerRailItem[]
  leftPanelOpen: Ref<boolean>
  overlayOpen: Ref<boolean>
  dockExpanded: Ref<boolean>
  railPressed(item: DesignerRailItem): boolean | undefined
  onRailClick(item: DesignerRailItem): void
}

export function useDesignerRail(options: DesignerRailOptions): DesignerRail {
  const { runCommand } = options

  /** 左侧常驻面板、浮动大纲面板与底部停靠区的可见性；三者互不排斥，可以同屏 */
  const leftPanelOpen = ref(true)
  const overlayOpen = ref(false)
  const dockExpanded = ref(true)

  /** rail 项的按下态；命令型按钮没有可保持的状态，返回 undefined 让 Vue 不写 aria-pressed */
  function railPressed(item: DesignerRailItem): boolean | undefined {
    const action = item.action
    if (!action || action.kind === 'command') return undefined
    if (action.target === 'leftPanel') return leftPanelOpen.value
    if (action.target === 'overlayPanel') return overlayOpen.value
    return dockExpanded.value
  }

  function onRailClick(item: DesignerRailItem): void {
    const action = item.action
    if (!action) return

    if (action.kind === 'command') {
      runCommand(action.commandId)
      return
    }

    if (action.target === 'leftPanel') leftPanelOpen.value = !leftPanelOpen.value
    else if (action.target === 'overlayPanel') overlayOpen.value = !overlayOpen.value
    else dockExpanded.value = !dockExpanded.value
  }

  return {
    OVERLAY_TITLE,
    railItems,
    leftPanelOpen,
    overlayOpen,
    dockExpanded,
    railPressed,
    onRailClick,
  }
}
