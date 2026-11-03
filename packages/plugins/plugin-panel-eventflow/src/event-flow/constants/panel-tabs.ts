export type PanelTab = 'eventflow' | 'data' | 'style' | 'code' | 'perf'
export type TabGlyph = 'bolt' | 'chain' | 'swatch' | 'code' | 'wave'

export interface PanelTabItem {
  /** 页签标识；目前只有 `eventflow` 接了内容，其余页签仍是占位 */
  id: PanelTab
  /** 页签与标题栏文案 */
  label: string
  /** 图标字形名，交给模板里的图标组件解释，不接受任意图标字符串 */
  glyph: TabGlyph
}

export const TABS: readonly PanelTabItem[] = [
  { id: 'eventflow', label: '事件流', glyph: 'bolt' },
  { id: 'data', label: '数据绑定', glyph: 'chain' },
  { id: 'style', label: '样式', glyph: 'swatch' },
  { id: 'code', label: '代码', glyph: 'code' },
  { id: 'perf', label: '性能监控', glyph: 'wave' },
]
