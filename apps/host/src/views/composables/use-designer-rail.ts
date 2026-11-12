import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import { getDesignerLayout, setDesignerLayout } from '../../storage/app-preferences'

/**
 * 设计器左侧 rail 与三块外壳面板的可见性。
 *
 * 三块面板的可见性互不排斥、可以同屏，因此各自一个 ref 而不是单一互斥状态。
 * `runCommand` 由视图显式传入：rail 只负责分发点击，不反向依赖工具栏的命令态。
 * 可见性写穿 app_kv：折叠一次 dock 只换来 228px 舞台高，不持久化就得每次进来重按。
 */

/** 浮动面板的标题；rail 项与浮层头部共用同一个字符串，不在两处各写一遍 */
const OVERLAY_TITLE = '页面大纲'

/**
 * 外壳纵向 chrome 合计（dock 展开态、宽屏口径）：项目栏 47 + 应用头 60 + 工具栏 56 +
 * 状态栏 36 + 居中留白 24 + 间隙 10 + dock 260 = 493，再加 .lc-designer__stage 上下
 * 各 1px 边框 = 495。canvas 量的是内层 .lc-stage，那 2px 边框必须算进 chrome；
 * 1920×1080 实测内层舞台 585，1080 − 585 正是 495。
 *
 * 常量取宽屏实测值。两个已知偏差都偏向「多算」，也就是宁可提前折叠：≤1440 的
 * media query 把留白与间隙再收 12px（1366×768 实测 chrome 483），而 .lc-shell__bar
 * 是 flex-wrap: wrap，窗口很窄时它会变成两行更高。
 */
const SHELL_CHROME_HEIGHT = 495

/** 舞台可视高低于它就把 dock 默认折叠；1366×768 算出 155px，画布已经没法干活 */
const MIN_STAGE_HEIGHT = 320

/**
 * 首次进入设计器（从没存过布局）时底部停靠区是否展开。
 *
 * dock 展开比折叠多占 228px 舞台高，小屏一进来就落在「画布最小态」。只按窗口高判断，
 * 不读 DOM，因此保持纯函数、可直接单测；有持久化值时调用方不会走到这里。
 */
export function shouldExpandDockByDefault(innerHeight: number): boolean {
  return innerHeight - SHELL_CHROME_HEIGHT >= MIN_STAGE_HEIGHT
}

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

  /**
   * 左侧常驻面板、浮动大纲面板与底部停靠区的可见性；三者互不排斥，可以同屏。
   *
   * 有存过的值就原样恢复；只有 dock 在没存过时按窗口高给首次默认，另两块面板的
   * 默认态不依赖尺寸（物料面板收起会让拖拽入口消失，宁可让它一直开着）。
   */
  const stored = getDesignerLayout()
  const leftPanelOpen = ref(stored?.leftPanelOpen ?? true)
  const overlayOpen = ref(stored?.overlayOpen ?? false)
  const dockExpanded = ref(
    stored?.dockExpanded ?? shouldExpandDockByDefault(window.innerHeight),
  )

  /**
   * 写回持久化。
   *
   * dock 有两个写入口（rail 项与停靠区头部的折叠按钮），用 watch 收口比在两处各写
   * 一次可靠；watch 只在值真的变了时触发，初次 setup 不会把刚读出的值再写一遍。
   * 监听器随组件实例卸载自动停止，不必手动 dispose。
   */
  watch([leftPanelOpen, overlayOpen, dockExpanded], ([left, overlay, dock]) => {
    setDesignerLayout({ leftPanelOpen: left, overlayOpen: overlay, dockExpanded: dock })
  })

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
