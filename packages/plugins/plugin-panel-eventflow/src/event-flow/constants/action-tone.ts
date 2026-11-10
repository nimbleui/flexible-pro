import type { CSSProperties } from 'vue'
import type { ActionDeclaration } from '@lc/schema'
import { findActionDefinition } from '@lc/schema'

/**
 * 动作类型色与事件色一样属于「类型编码」，不随主题变化，集中在命名常量表里。
 * 动作卡片和右栏摘要共用同一张表，避免两处配色漂移。
 */
export type ActionTone =
  'state' | 'dataSource' | 'navigation' | 'ui' | 'flow' | 'plugin' | 'unknown'

const ACTION_STYLE: Record<
  ActionTone,
  {
    /**
     * CSS 颜色字面量（#rrggbb，不含 alpha）。
     *
     * 卡片另外两个变量由此拼接透明度后缀派生，因此必须是 6 位十六进制，
     * 换成 `rgb()` 一类函数式写法会让 ring / glow 的拼接失效。
     */
    color: string
  }
> = {
  state: { color: '#22d3a6' },
  dataSource: { color: '#a78bfa' },
  navigation: { color: '#2f8cff' },
  ui: { color: '#38bdf8' },
  flow: { color: '#f5a524' },
  plugin: { color: '#7f9bc2' },
  unknown: { color: '#ff6b81' },
}

const ACTION_TONE_BY_PREFIX: ReadonlyArray<{
  /** 动作 type 的前缀；按数组顺序取第一个 `startsWith` 命中，新增时注意别被更宽的前缀抢走 */
  prefix: string
  /** 命中后使用的配色种类 */
  tone: ActionTone
}> = [
  { prefix: 'state.', tone: 'state' },
  { prefix: 'dataSource.', tone: 'dataSource' },
  { prefix: 'navigation.', tone: 'navigation' },
  { prefix: 'ui.', tone: 'ui' },
  { prefix: 'flow.', tone: 'flow' },
  { prefix: 'plugin.', tone: 'plugin' },
]

/** 由动作 type 前缀推断其配色种类；动作缺失或未匹配时退回 unknown。 */
export function actionTone(action: ActionDeclaration | undefined): ActionTone {
  if (!action) return 'unknown'
  const matched = ACTION_TONE_BY_PREFIX.find((item) => action.type.startsWith(item.prefix))
  return matched?.tone ?? 'unknown'
}

/** 生成动作卡片的 CSS 变量：主色及由它派生的 ring / glow 透明度色。 */
export function actionCardStyle(action: ActionDeclaration | undefined): CSSProperties {
  const color = ACTION_STYLE[actionTone(action)].color
  return {
    '--action-color': color,
    // 8 位十六进制直接承载透明度（对应 #色22 / #色18），省去为每种类型再维护两份描边常量
    '--action-ring': `${color}22`,
    '--action-glow': `${color}18`,
  }
}

const TOAST_LEVEL_LABELS: Record<string, string> = {
  info: '提示',
  success: '成功',
  warning: '警告',
  error: '错误',
}

/**
 * 引用来源为空时的下拉占位文案。
 *
 * 「暂无可选变量」比「暂无数据」有用得多：作者需要知道缺的是哪一类候选，
 * 才知道该去页面数据里补变量，还是该先在动作链里加动作。
 */
export const REF_SOURCE_LABELS: Record<string, string> = {
  variable: '变量',
  dataSource: '数据源',
  action: '动作',
  node: '节点',
  flow: '流程',
  event: '事件',
  page: '页面',
}

function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 卡片第二行的参数摘要必须按动作类型解释 config，而不是直接拼 JSON：
 * 用户需要一眼看懂「调哪个接口 / 跳哪里 / 什么级别」，原始字段名没有这个信息量。
 * 每种内置动作都在这张表里给出独立口径，模板只调用 summarize。
 */
const ACTION_PARAM_SUMMARY: Record<string, (config: Record<string, unknown>) => string> = {
  'state.set': () => '(setState)',
  'state.reset': () => '(resetState)',
  'dataSource.fetch': (config) => {
    const dataSourceId = configString(config, 'dataSourceId')
    return dataSourceId === '' ? '(调用接口)' : `(${dataSourceId})`
  },
  'navigation.go': (config) => {
    const to = configString(config, 'to')
    return to === '' ? '(跳转)' : `(${to})`
  },
  'ui.toast': (config) => {
    const level = configString(config, 'level')
    return `(${TOAST_LEVEL_LABELS[level] ?? TOAST_LEVEL_LABELS.info})`
  },
  'flow.condition': (config) => {
    const target = configString(config, 'trueActionId')
    return target === '' ? '(分支)' : `(分支 → ${target})`
  },
  'flow.sequence': (config) => {
    const members = config.actionIds
    return Array.isArray(members) && members.length > 0 ? `(批量 ${members.length})` : '(批量)'
  },
  'flow.end': () => '(结束)',
  'plugin.invoke': (config) => {
    const service = configString(config, 'service')
    const method = configString(config, 'method')
    return service === '' || method === '' ? '(调用插件)' : `(${service}.${method})`
  },
}

/** 按动作类型把 config 解释成一行参数摘要（调哪个接口 / 跳哪里 / 什么级别）。 */
export function actionParamSummary(action: ActionDeclaration | undefined): string {
  if (!action) return '(未知动作)'
  const summarize = ACTION_PARAM_SUMMARY[action.type]
  return summarize ? summarize(action.config) : '(未知动作)'
}

/**
 * 按动作类型取展示名。
 *
 * 单独成函数是因为动作选择器（`kind: 'action'` 的下拉）只有类型和 id，
 * 手上没有完整的 `ActionDeclaration`。
 */
export function actionTypeTitle(type: string): string {
  return findActionDefinition(type)?.title || type
}

/** 取动作展示名：显式命名优先，其次内置类型标题，最后退回 type。 */
export function actionTitle(action: ActionDeclaration | undefined): string {
  if (!action) return '动作已丢失'
  // 用户显式命名优先；未命名时内置类型取协议标题，自定义类型只能退回 type
  return action.name || actionTypeTitle(action.type) || '未知动作'
}
