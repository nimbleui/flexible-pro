import type { NodeSchema, PageSchema, Rect } from '@lc/schema'
import { childRefs } from '@lc/schema'
import type { CodegenContext } from './context'
import { warn } from './context'
import { emitExpression } from './emit-expression'
import { resolveMaterialTag } from './materials'
import { attrName, escapeAttr, nodeClass, quote } from './naming'

/** 与 `packages/vue/src/render/tree.ts` 同一个缺省矩形：出码的几何必须和画布对得上 */
const DEFAULT_RECT: Rect = { x: 0, y: 0, width: 100, height: 40 }

/** 数字不补 px 的属性；漏一个就会把 `opacity: 0.5` 写成 `0.5px` */
const UNITLESS = new Set([
  'opacity',
  'zIndex',
  'z-index',
  'fontWeight',
  'font-weight',
  'lineHeight',
  'line-height',
  'flex',
  'flexGrow',
  'flex-grow',
  'flexShrink',
  'flex-shrink',
  'order',
  'zoom',
])

/** 模板与样式两段产物 */
export interface EmittedMarkup {
  /** `<template>` 内的行 */
  lines: string[]
  /** `<style scoped>` 内的行 */
  styles: string[]
}

/** 模板出码输入 */
export interface MarkupInput {
  /** 待出码的页面 schema */
  schema: PageSchema
  /** 节点 id → 已绑定的事件名；动作链本体不在出码范围内，模板里只留一条注释 */
  eventsByNode: ReadonlyMap<string, readonly string[]>
}

/** 一个 schema 值的出码结果 */
interface EmittedValue {
  /** 该 schema 值出码后的 JS 表达式文本 */
  js: string
  /** 模板里必须用 `:prop="…"` 绑定而不是静态属性 */
  needsBinding: boolean
}

function rectOf(node: NodeSchema): Rect {
  return node.layout?.rect ?? DEFAULT_RECT
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)
}

function cssValueText(property: string, value: unknown): string {
  if (typeof value === 'number') {
    return UNITLESS.has(property) || value === 0 ? String(value) : `${value}px`
  }
  return String(value)
}

/** margin / padding / border 的结构化形态展开成长写法 */
function structuredDeclarations(property: string, value: Record<string, unknown>): string[] {
  const lines: string[] = []

  for (const [part, partValue] of Object.entries(value)) {
    if (partValue === undefined || partValue === null) continue
    const name = property === 'border' ? `border-${kebab(part)}` : `${property}-${kebab(part)}`
    lines.push(`${name}: ${cssValueText(name, partValue)}`)
  }

  return lines
}

/**
 * 把 schema 里的样式值写成 CSS 声明。
 *
 * 数字补 `px`：Vue 的 style 绑定会自动加单位，纯 CSS 不会。作者写的 `position` 等
 * 字段仍会出现在这里，但几何声明在后面覆盖它——与 `render/nodeStyle.ts` 的展开顺序一致。
 */
function cssDeclarations(style: Record<string, unknown>): string[] {
  const declarations: string[] = []

  for (const [key, value] of Object.entries(style)) {
    if (value === undefined || value === null) continue
    const property = kebab(key)

    if (typeof value === 'object' && !Array.isArray(value)) {
      declarations.push(...structuredDeclarations(property, value as Record<string, unknown>))
      continue
    }

    declarations.push(`${property}: ${cssValueText(property, value)}`)
  }

  return declarations
}

/**
 * 出码整页模板与样式。
 *
 * DOM 结构与 `CanvasStage` / `PageRuntime` 同构：每个节点一个定位 wrapper，
 * 物料组件是 wrapper 的第一个子元素，`children` 与它并列，具名插槽交给组件。
 * 结构不一致的话，出码产物和画布就不是同一张页面，页签也就失去意义。
 */
export function emitMarkup(input: MarkupInput, ctx: CodegenContext): EmittedMarkup {
  const { schema, eventsByNode } = input
  const lines: string[] = []
  const styles: string[] = ['.lc-node {', '  box-sizing: border-box;', '}']

  function nodeById(id: string): NodeSchema | undefined {
    return schema.nodes[id]
  }

  /** 子引用按渲染顺序，与图层树、拖拽落点同一口径 */
  function childrenOf(parent: NodeSchema): NodeSchema[] {
    return childRefs(parent)
      .map(nodeById)
      .filter((item): item is NodeSchema => item !== undefined)
  }

  function push(depth: number, text: string): void {
    lines.push(`${'  '.repeat(depth)}${text}`)
  }

  function emitValue(value: unknown): EmittedValue {
    if (value === undefined) return { js: 'undefined', needsBinding: true }
    if (value === null) return { js: 'null', needsBinding: true }

    if (typeof value === 'string') {
      if (!value.includes('{{')) return { js: quote(value), needsBinding: false }

      const emitted = emitExpression(value, 'template', ctx)
      if (emitted.error) warn(ctx, `模板插值语法不合法，已按原文输出：${value}`)
      return { js: emitted.js, needsBinding: true }
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return { js: JSON.stringify(value), needsBinding: false }
    }

    if (Array.isArray(value)) {
      const items = value.map((item) => emitValue(item))
      return { js: `[${items.map((item) => item.js).join(', ')}]`, needsBinding: true }
    }

    const record = value as Record<string, unknown>

    // 白名单的两种承载形式在这里分叉：expression 走直译，js 原样保留
    if (record.type === 'expression' && typeof record.raw === 'string') {
      const emitted = emitExpression(record.raw, 'expression', ctx)
      if (emitted.error) warn(ctx, `表达式语法不合法，已按原文输出：${record.raw}`)
      return { js: emitted.js, needsBinding: true }
    }

    if (record.type === 'js' && typeof record.code === 'string') {
      warn(ctx, `存在白名单之外的原生 JS 片段，出码原样保留：${record.code}`)
      return { js: record.code, needsBinding: true }
    }

    const pairs = Object.entries(record).map(
      ([key, item]) => `${quote(key)}: ${emitValue(item).js}`,
    )
    return { js: `{ ${pairs.join(', ')} }`, needsBinding: true }
  }

  /**
   * `loop.key` 与 `node.key` 按表达式读，而不是按字符串值读。
   *
   * 协议里这两项写的是「键值表达式」，作者填 `row.id` 想要的是取 `row` 的 id；
   * 当成字符串会原样输出 `'row.id'`，Vue 拿同一个字面量当 key，循环 diff 直接失效。
   */
  function emitKey(text: string): string {
    return emitExpression(text, 'expression', ctx).js
  }

  /** show / hide 合成一条 v-show；同类型后写者生效，与渲染层的逐条覆盖一致 */
  function visibility(node: NodeSchema): string | undefined {
    const conditions: string[] = []

    for (const directive of node.directives ?? []) {
      if (directive.type !== 'show' && directive.type !== 'hide') continue
      const js = emitValue(directive.condition).js
      conditions.push(directive.type === 'show' ? js : `!(${js})`)
    }

    return conditions.length === 0 ? undefined : conditions.join(' && ')
  }

  /** 物料属性与显式指令里的 disabled / readonly / required 都落在组件上 */
  function componentAttributes(node: NodeSchema): string[] {
    const attributes: string[] = []

    for (const [key, value] of Object.entries(node.props ?? {})) {
      const emitted = emitValue(value)
      const name = attrName(key)
      attributes.push(
        emitted.needsBinding
          ? `:${name}="${escapeAttr(emitted.js)}"`
          : `${name}=${quote(String(value))}`,
      )
    }

    for (const directive of node.directives ?? []) {
      if (directive.type === 'show' || directive.type === 'hide') continue
      attributes.push(`:${directive.type}="${escapeAttr(emitValue(directive.condition).js)}"`)
    }

    return attributes
  }

  function wrapperAttributes(node: NodeSchema): string[] {
    const classes = [`lc-node`, nodeClass(node.id)]
    if (node.className) classes.push(node.className)

    const attributes = [`class="${classes.join(' ')}"`]

    if (node.condition !== undefined) {
      attributes.push(`v-if="${escapeAttr(emitValue(node.condition).js)}"`)
    }

    if (node.loop) {
      const itemName = node.loop.itemName ?? '$item'
      const indexName = node.loop.indexName ?? '$index'
      const source = emitValue(node.loop.dataSource).js
      attributes.push(`v-for="(${itemName}, ${indexName}) in ${escapeAttr(source)}"`)

      const key = node.loop.key ?? node.key
      if (key !== undefined) attributes.push(`:key="${escapeAttr(emitKey(key))}"`)
    } else if (node.key !== undefined) {
      attributes.push(`:key="${escapeAttr(emitKey(node.key))}"`)
    }

    const visible = visibility(node)
    if (visible) attributes.push(`v-show="${escapeAttr(visible)}"`)

    return attributes
  }

  function emitRule(node: NodeSchema, origin: Rect, isRoot: boolean): void {
    const rect = rectOf(node)
    const declarations = cssDeclarations({
      ...(node.style as Record<string, unknown> | undefined),
    })

    if (isRoot) {
      // 根节点就是页面容器：与 PageRuntime 用根矩形撑开画幅的做法一致
      declarations.push('position: relative')
    } else {
      declarations.push(
        'position: absolute',
        `left: ${rect.x - origin.x}px`,
        `top: ${rect.y - origin.y}px`,
      )
    }

    declarations.push(`width: ${rect.width}px`, `height: ${rect.height}px`)

    if (node.layout?.zIndex !== undefined) declarations.push(`z-index: ${node.layout.zIndex}`)
    if (node.layout?.rotate) {
      declarations.push(`transform: rotate(${node.layout.rotate}deg)`)
    }

    styles.push(`.${nodeClass(node.id)} {`)
    for (const declaration of declarations) styles.push(`  ${declaration};`)
    styles.push('}')
  }

  function emitElement(node: NodeSchema, origin: Rect, depth: number, isRoot: boolean): void {
    // 设计态隐藏与渲染层同口径：整棵子树都不进产物
    if (node.hidden) return

    emitRule(node, origin, isRoot)

    const tag = resolveMaterialTag(node.componentName, ctx).tag
    const attributes = wrapperAttributes(node)
    const events = eventsByNode.get(node.id)

    push(depth, `<div ${attributes.join(' ')}>`)
    const inner = depth + 1

    if (events?.length) {
      push(
        inner,
        `<!-- 事件 ${events.join(' / ')} 由平台运行时按 connections 执行，不在出码范围内 -->`,
      )
    }

    emitComponent(node, tag, inner)

    for (const child of childrenOf(node)) emitElement(child, rectOf(node), inner, false)

    push(depth, '</div>')
  }

  /** 物料元素：属性 + 具名插槽内容；没有内容时自闭合 */
  function emitComponent(node: NodeSchema, tag: string, depth: number): void {
    const attributes = componentAttributes(node)
    const slotEntries = Object.entries(node.slots ?? {})
    const head = attributes.length === 0 ? tag : `${tag} ${attributes.join(' ')}`

    if (slotEntries.length === 0) {
      push(depth, `<${head} />`)
      return
    }

    push(depth, `<${head}>`)
    for (const [slotName, ids] of slotEntries) {
      push(depth + 1, `<template #${slotName}>`)
      for (const id of ids) {
        const child = nodeById(id)
        if (child) emitElement(child, rectOf(node), depth + 2, false)
      }
      push(depth + 1, '</template>')
    }
    push(depth, `</${tag}>`)
  }

  const root = nodeById(schema.nodeId)
  if (!root) return { lines: ['<div class="lc-page lc-node" />'], styles }

  emitElement(root, rectOf(root), 0, true)
  return { lines, styles }
}
