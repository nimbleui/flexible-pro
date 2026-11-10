import type { Directive } from '@lc/schema'
import { createExpression } from '@lc/schema'

/** 指令类型在下拉里的呈现 */
export interface DirectiveTypeOption {
  /** 写入 schema 的指令类型 */
  type: Directive['type']
  /** 下拉里的展示名 */
  label: string
  /**
   * 渲染层是否真的实现该指令。
   *
   * `readonly` / `required` 在协议里存在，但 `buildRenderTree` 只消费
   * show / hide / disabled。面板照常列出它们（文档里可能已有），并标注未生效，
   * 免得用户配完以为起了作用。
   */
  honored: boolean
}

/** 指令类型下拉选项；`honored` 标出渲染层是否真正实现该指令。 */
export const DIRECTIVE_TYPES: readonly DirectiveTypeOption[] = [
  { type: 'show', label: '显示 show', honored: true },
  { type: 'hide', label: '隐藏 hide', honored: true },
  { type: 'disabled', label: '禁用 disabled', honored: true },
  { type: 'readonly', label: '只读 readonly（渲染层未生效）', honored: false },
  { type: 'required', label: '必填 required（渲染层未生效）', honored: false },
]

/** 取指令类型的展示名；未知取值回退成原文，便于发现写错的类型 */
export function directiveTypeLabel(type: string): string {
  return DIRECTIVE_TYPES.find((option) => option.type === type)?.label ?? type
}

/** 指令条件为空时的占位表达式；空条件求值为假，指令自然不生效，比存裸文本安全 */
function emptyCondition(): Directive['condition'] {
  return createExpression('')
}

/** 追加一条默认隐藏指令；条件留给用户填，空条件不会改变渲染结果 */
export function appendDirective(list: readonly Directive[]): Directive[] {
  return [...list, { type: 'hide', condition: emptyCondition() }]
}

/**
 * 就地改一条指令。
 *
 * 越界下标原样返回而不是抛错：列表可能在校验与提交之间被别处删短（撤销、画布删除节点），
 * 面板此时应当安静地什么都不做。
 */
export function updateDirective(
  list: readonly Directive[],
  index: number,
  changes: Partial<Pick<Directive, 'type' | 'condition'>>,
): Directive[] {
  const current = list[index]
  if (!current) return [...list]

  return list.map((item, position) => (position === index ? { ...item, ...changes } : item))
}

/** 删除一条指令；返回新数组，空数组由调用方决定是删键还是留空表 */
export function removeDirective(list: readonly Directive[], index: number): Directive[] {
  if (!list[index]) return [...list]
  return list.filter((_, position) => position !== index)
}
