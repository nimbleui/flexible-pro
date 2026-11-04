import type { SchemaPatch, StyleSchema } from '@lc/schema'

/**
 * 样式字段的读写换算。
 *
 * 面板按「四边独立」编辑内边距与外边距，落到 schema 时写 CSS 长手属性
 * （`padding-top` 等）而不是 `padding` 简写：渲染层把 `node.style` 原样 spread 成
 * CSSProperties（见 `@lc/vue` 的 CanvasStage / PageRuntime），长手键是唯一能表达
 * 「某一边不设值」的形式，而 `SpacingValue` 的对象形态在 spread 下不产生任何样式。
 * 历史文档里的简写字符串与对象形态仍然读得出来，写一次即归一成可用的长手键。
 */

/** 盒模型的一个方向 */
export type BoxSide = 'top' | 'right' | 'bottom' | 'left'

/** 四边取值；空串表示该方向不设值 */
export interface BoxSides {
  /** 上边取值 */
  top: string
  /** 右边取值 */
  right: string
  /** 下边取值 */
  bottom: string
  /** 左边取值 */
  left: string
}

/** 面板按四边编辑的属性名 */
export type BoxProperty = 'padding' | 'margin'

/** 边框的一个组成部件 */
export type BorderPart = 'width' | 'style' | 'color'

/** 边框三要素；空串表示该部件不设值 */
export interface BorderParts {
  /** 边框宽度，如 `1px` */
  width: string
  /** 边框线型，取值见 CSS border-style */
  style: string
  /** 边框颜色，任意合法 CSS 颜色 */
  color: string
}

/** 一次字段编辑落到 `node.style` 上的键值变更 */
export interface StyleEdit {
  /** 写入 style 的键名，如 `padding-top` */
  key: string
  /** 新值；缺省表示删除该键 */
  value?: string
}

const BOX_SIDES: readonly BoxSide[] = ['top', 'right', 'bottom', 'left']

const BORDER_PARTS: readonly BorderPart[] = ['width', 'style', 'color']

/** CSS border-style 的合法取值，用于把 `1px solid #ccc` 拆回三要素 */
const BORDER_STYLES: readonly string[] = [
  'none',
  'hidden',
  'dotted',
  'dashed',
  'solid',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
]

/** 长度单位结尾即认定为宽度值，覆盖 `10`、`1.5px`、`50%` 这类写法 */
const LENGTH_PATTERN = /^-?\d+(\.\d+)?(px|em|rem|%|vh|vw|vmin|vmax|pt|pc)?$/

function emptySides(): BoxSides {
  return { top: '', right: '', bottom: '', left: '' }
}

function emptyBorderParts(): BorderParts {
  return { width: '', style: '', color: '' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 把 schema 里的样式值转成输入框文本。
 *
 * 数字补 `px`：`CSSValue` 允许裸数字，但内联样式里 `paddingTop = "12"` 会被浏览器
 * 整条丢掉，面板必须回显成用户看得懂、写回去也可用的形式。
 */
function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}px`
  return ''
}

/**
 * 按空白切分 CSS 值，括号内不切。
 *
 * `calc(10px + 2px) 4px` 是两个值而不是四个；不识别括号就会把一个合法值拆成垃圾。
 */
function splitValues(text: string): string[] {
  const tokens: string[] = []
  let depth = 0
  let current = ''

  for (const char of text) {
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)

    if (/\s/.test(char) && depth === 0) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }

  if (current) tokens.push(current)

  return tokens
}

/**
 * 解析 CSS 四值简写。
 *
 * 遵循规范的折叠规则：1 值四边同值、2 值上下/左右、3 值左=右、4 值逐边。
 * 超过 4 段属于非法写法，返回 `null` 而不是猜一个解释——猜错会让面板显示的和文档里
 * 存的不一致，用户一次编辑就把原值改没了。
 */
export function parseSpacingShorthand(text: string): BoxSides | null {
  const tokens = splitValues(text)
  if (tokens.length === 0) return emptySides()
  if (tokens.length > 4) return null

  const [top = '', right = top, bottom = top, left = right] = tokens
  return { top, right, bottom, left }
}

/** 读简写形态（字符串或四方向对象）；两种都是 `SpacingValue` 允许的写法 */
function shorthandSides(style: StyleSchema | undefined, property: BoxProperty): BoxSides {
  const shorthand = style?.[property]
  if (typeof shorthand === 'string') return parseSpacingShorthand(shorthand) ?? emptySides()
  if (isRecord(shorthand)) {
    return {
      top: toText(shorthand.top),
      right: toText(shorthand.right),
      bottom: toText(shorthand.bottom),
      left: toText(shorthand.left),
    }
  }
  return emptySides()
}

/**
 * 读取四边编辑器的显示值。
 *
 * **逐边合并**长手键与简写键，而不是「有长手就只看长手」：文档里两者并存时（手写或
 * 旧版导出）CSS 的口径是简写打底、长手覆盖对应边，整体丢弃简写会让用户改一条边就弄丢
 * 另外三条。
 */
export function readBoxSides(style: StyleSchema | undefined, property: BoxProperty): BoxSides {
  const base = shorthandSides(style, property)
  const sides = emptySides()

  for (const side of BOX_SIDES) {
    const longhand = toText(style?.[`${property}-${side}`])
    sides[side] = longhand === '' ? base[side] : longhand
  }

  return sides
}

/**
 * 计算改一条边需要的键值变更。
 *
 * 先把四边的合并视图整体对齐到目标状态，再决定是否拆掉简写键：只写用户改的那一条会让
 * 简写里的其它边一起消失，那是数据丢失而不是编辑。简写与长手并存时浏览器按书写顺序
 * 决胜，留着旧简写会留下「改了上边、左右也跟着变」的幽灵回归，所以一旦有长手落地就删掉它。
 *
 * 值没变时返回空数组，避免一次无意义的失焦留下一条可撤销的历史。
 */
export function boxSideEdits(
  style: StyleSchema | undefined,
  property: BoxProperty,
  side: BoxSide,
  text: string,
): StyleEdit[] {
  const current = readBoxSides(style, property)
  const next: BoxSides = { ...current, [side]: text.trim() }

  const edits: StyleEdit[] = []
  for (const target of BOX_SIDES) {
    const key = `${property}-${target}`
    const before = toText(style?.[key])
    const after = next[target]
    if (after === before) continue
    edits.push(after === '' ? { key } : { key, value: after })
  }

  const hasShorthand = style?.[property] !== undefined
  const writesAny = edits.some((edit) => edit.value !== undefined)
  const clearsAll = BOX_SIDES.every((target) => next[target] === '')

  if (hasShorthand && (writesAny || clearsAll)) edits.push({ key: property })

  return edits
}

/**
 * 解析 `border` 简写。
 *
 * CSS 允许三个部件任意顺序、任意缺省，因此按「是不是已知线型 / 是不是长度」归类，
 * 剩下的当作颜色。无法识别的段落在颜色位保留，而不是丢弃。
 */
export function parseBorderShorthand(text: string): BorderParts {
  const parts = emptyBorderParts()

  for (const token of splitValues(text)) {
    if (BORDER_STYLES.includes(token)) parts.style = token
    else if (parts.width === '' && LENGTH_PATTERN.test(token)) parts.width = token
    else parts.color = parts.color === '' ? token : `${parts.color} ${token}`
  }

  return parts
}

/** 读边框的简写形态（字符串或结构化对象） */
function shorthandBorder(style: StyleSchema | undefined): BorderParts {
  const border = style?.border
  if (typeof border === 'string') return parseBorderShorthand(border)
  if (isRecord(border)) {
    return {
      width: toText(border.width),
      style: toText(border.style),
      color: toText(border.color),
    }
  }
  return emptyBorderParts()
}

/** 读取边框三要素；合并规则同 {@link readBoxSides} */
export function readBorderParts(style: StyleSchema | undefined): BorderParts {
  const base = shorthandBorder(style)
  const parts = emptyBorderParts()

  for (const part of BORDER_PARTS) {
    const longhand = toText(style?.[`border-${part}`])
    parts[part] = longhand === '' ? base[part] : longhand
  }

  return parts
}

/** 改一个边框部件所需的键值变更，合并与拆简写规则同 {@link boxSideEdits} */
export function borderPartEdits(
  style: StyleSchema | undefined,
  part: BorderPart,
  text: string,
): StyleEdit[] {
  const current = readBorderParts(style)
  const next: BorderParts = { ...current, [part]: text.trim() }

  const edits: StyleEdit[] = []
  for (const target of BORDER_PARTS) {
    const key = `border-${target}`
    const before = toText(style?.[key])
    const after = next[target]
    if (after === before) continue
    edits.push(after === '' ? { key } : { key, value: after })
  }

  const hasShorthand = style?.border !== undefined
  const writesAny = edits.some((edit) => edit.value !== undefined)
  const clearsAll = BORDER_PARTS.every((target) => next[target] === '')

  if (hasShorthand && (writesAny || clearsAll)) edits.push({ key: 'border' })

  return edits
}

/**
 * 改一个普通样式键（颜色、圆角、字号等）所需的键值变更。
 *
 * 与盒模型不同，这些键本身就只有一个输入框，不存在简写与长手并存的问题。
 */
export function styleValueEdits(
  style: StyleSchema | undefined,
  key: string,
  text: string,
): StyleEdit[] {
  const current = toText(style?.[key])
  const next = text.trim()

  if (next === '') return style?.[key] === undefined ? [] : [{ key }]
  return next === current ? [] : [{ key, value: next }]
}

/**
 * 把键值变更映射成文档补丁。
 *
 * 路径由调用方给（面板持有节点 id 与 `nodePath`），本函数不碰 patch 结构，
 * 因此可以脱离文档服务单独测试。
 */
export function toPatches(
  edits: readonly StyleEdit[],
  pathOf: (key: string) => string,
): SchemaPatch[] {
  return edits.map((edit) =>
    edit.value === undefined
      ? { op: 'remove' as const, path: pathOf(edit.key) }
      : { op: 'replace' as const, path: pathOf(edit.key), value: edit.value },
  )
}
