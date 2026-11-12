import { STORE, getOne, putOne } from './idb'
import type { KvRow } from './idb'

/**
 * 应用级偏好：深色 / 亮色主题、本地登录标记与设计器面板布局。
 *
 * 原来分别是 App.vue 的 `lc-theme` 与 LoginView 的 `lc-auth-user` 两个 localStorage 键。
 * 迁进 IndexedDB 的 app_kv 后，仍保留同步读取：启动 gate 里先 hydrate 到内存，
 * 之后 getTheme / getAuthUser / getDesignerLayout 都是同步取值，写入写穿 app_kv（失败只丢持久化）。
 *
 * 不用 shallowRef：主题落到 <html data-theme>、登录标记只在发布时读一次、布局只在
 * 设计器 setup 时读一次，都不需要响应式，普通模块变量即可。
 */

/** 主题取值；缺省深色，与外壳 CSS 的默认态一致 */
export type Theme = 'dark' | 'light'

/**
 * 设计器外壳的面板可见性。
 *
 * 只装这三块：它们都是 rail 上的常驻开关，用户会反复调整并期望下次进入时还在。
 * 底部停靠区对舞台高的影响最大（展开比折叠多吃 228px），所以单独有「按视口给首次
 * 默认值」的策略，见 `use-designer-rail` 的 shouldExpandDockByDefault。
 */
export interface DesignerLayout {
  /** 左侧常驻物料面板 */
  leftPanelOpen: boolean
  /** 浮动页面大纲面板 */
  overlayOpen: boolean
  /** 底部停靠区 */
  dockExpanded: boolean
}

const THEME_KEY = 'theme'
const AUTH_USER_KEY = 'auth-user'
const LAYOUT_KEY = 'designer-layout'

let theme: Theme = 'dark'
let authUser = ''

/** undefined 表示这个浏览器从没存过布局，调用方要改用按视口算出的首次默认 */
let layout: DesignerLayout | undefined

/** 从 app_kv 灌入内存；读不到或形状不对时保持缺省（深色 / 未登录 / 没存过布局） */
export async function hydratePreferences(): Promise<void> {
  try {
    const [themeRow, authRow, layoutRow] = await Promise.all([
      getOne<KvRow>(STORE.appKv, THEME_KEY),
      getOne<KvRow>(STORE.appKv, AUTH_USER_KEY),
      getOne<KvRow>(STORE.appKv, LAYOUT_KEY),
    ])

    theme = themeRow?.value === 'light' ? 'light' : 'dark'
    authUser = typeof authRow?.value === 'string' ? authRow.value : ''
    layout = toLayout(layoutRow?.value)
  } catch (error) {
    console.error('[host] 读取应用偏好失败，按缺省处理', error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 收窄存量布局行。
 *
 * 三个字段任一不是布尔就整份按「没存过」处理：留一半会让首次默认策略只对其中一块生效，
 * 比整体回落到默认更难解释。
 */
function toLayout(value: unknown): DesignerLayout | undefined {
  if (!isRecord(value)) return undefined

  const { leftPanelOpen, overlayOpen, dockExpanded } = value
  if (
    typeof leftPanelOpen !== 'boolean' ||
    typeof overlayOpen !== 'boolean' ||
    typeof dockExpanded !== 'boolean'
  ) {
    return undefined
  }

  return { leftPanelOpen, overlayOpen, dockExpanded }
}

/** 当前主题；启动 gate 已 hydrate，调用方同步取值 */
export function getTheme(): Theme {
  return theme
}

/** 设置主题并写穿 app_kv；写失败只丢持久化，当前会话仍生效 */
export function setTheme(next: Theme): void {
  theme = next
  void putOne<KvRow>(STORE.appKv, { key: THEME_KEY, value: next }).catch((error) => {
    console.error('[host] 保存主题到 IndexedDB 失败', error)
  })
}

/** 当前登录标记；未登录为空串。发布人取它并兜底「本地用户」 */
export function getAuthUser(): string {
  return authUser
}

/** 设置登录标记并写穿 app_kv */
export function setAuthUser(name: string): void {
  authUser = name
  void putOne<KvRow>(STORE.appKv, { key: AUTH_USER_KEY, value: name }).catch((error) => {
    console.error('[host] 保存登录标记到 IndexedDB 失败', error)
  })
}

/** 当前设计器面板布局；从没存过返回 undefined，由调用方决定首次默认值 */
export function getDesignerLayout(): DesignerLayout | undefined {
  return layout
}

/** 记录设计器面板布局并写穿 app_kv */
export function setDesignerLayout(next: DesignerLayout): void {
  layout = next
  void putOne<KvRow>(STORE.appKv, { key: LAYOUT_KEY, value: next }).catch((error) => {
    console.error('[host] 保存设计器布局到 IndexedDB 失败', error)
  })
}
