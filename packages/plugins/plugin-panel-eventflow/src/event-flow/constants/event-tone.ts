import type { CSSProperties } from 'vue'
import type { EventConnection } from '@lc/schema'

const PAGE_EVENT_LABELS: Record<string, string> = {
  pageLoad: '页面加载',
  pageUnload: '页面卸载',
}

/** 页面事件名到中文标签；未登记时原样返回事件名。 */
export function pageEventLabel(eventName: string): string {
  return PAGE_EVENT_LABELS[eventName] ?? eventName
}

/**
 * 事件颜色只作为「类型编码」使用，不参与主题换肤，因此集中成命名常量表；
 * 模板只查表，不再写 if 链，新增事件种类时只改这里。
 */
export type EventTone = 'pageLoad' | 'pageUnload' | 'pointer' | 'data' | 'other'

const EVENT_STYLE: Record<
  EventTone,
  {
    /** CSS 颜色字面量（#rrggbb）；注入 `--event-color`，只用于图标着色 */
    color: string
  }
> = {
  pageLoad: { color: '#22d3a6' },
  pageUnload: { color: '#7f9bc2' },
  pointer: { color: '#2f8cff' },
  data: { color: '#f5a524' },
  other: { color: '#7f9bc2' },
}

/** 事件名到种类的映射：物料可以声明任意事件名，这里只覆盖常见族，未命中的归入中性色 */
const EVENT_TONE_BY_NAME: Record<string, EventTone> = {
  pageLoad: 'pageLoad',
  pageUnload: 'pageUnload',
  click: 'pointer',
  dblclick: 'pointer',
  contextmenu: 'pointer',
  mousedown: 'pointer',
  mouseup: 'pointer',
  pointerdown: 'pointer',
  pointerup: 'pointer',
  change: 'data',
  input: 'data',
  select: 'data',
  submit: 'data',
  focus: 'data',
  blur: 'data',
}

/** 由连接上的事件名推断其配色种类；未命中归入中性色 other。 */
export function eventTone(connection: EventConnection): EventTone {
  return EVENT_TONE_BY_NAME[connection.eventName] ?? 'other'
}

/** 生成事件连接图标的 CSS 变量：注入 `--event-color` 主色。 */
export function eventIconStyle(connection: EventConnection): CSSProperties {
  return { '--event-color': EVENT_STYLE[eventTone(connection)].color }
}
