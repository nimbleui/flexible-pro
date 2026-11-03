/**
 * 补全片段模板表。
 *
 * 片段是「纯文本模板」，展开行为由宿主编辑器完成，因此这里只描述匹配键与模板体，
 * 不出现任何编辑器库类型。
 */

/** 一条片段模板；顶层与成员回调片段共用 */
interface SnippetTemplate {
  /** 匹配键：按用户已输入的前缀过滤，而不是按展示文本 */
  name: string
  /** 补全列表里的展示文本 */
  label: string
  /** 行右侧提示，标注「片段 · 场景」 */
  detail: string
  /** 片段模板体；`${...}` 为可 Tab 跳转的占位符 */
  snippet: string
}

/** 顶层片段：只在用户已输入前缀后出现，避免在空上下文里堆满模板 */
export const ROOT_SNIPPETS: readonly SnippetTemplate[] = [
  {
    name: 'ternary',
    label: 'ternary ? :',
    detail: '片段 · 条件表达式',
    snippet: '${condition} ? ${whenTrue} : ${whenFalse}',
  },
]

/** 方法片段：在成员补全里提供常用回调模板，普通方法项仍然保留 */
export const METHOD_SNIPPETS: readonly SnippetTemplate[] = [
  {
    name: 'filter',
    label: 'filter(x => …)',
    detail: '片段 · 数组',
    snippet: 'filter(${x} => ${})',
  },
  {
    name: 'map',
    label: 'map(x => …)',
    detail: '片段 · 数组',
    snippet: 'map(${x} => ${})',
  },
  {
    name: 'find',
    label: 'find(x => …)',
    detail: '片段 · 数组',
    snippet: 'find(${x} => ${})',
  },
  {
    name: 'sort',
    label: 'sort((a, b) => …)',
    detail: '片段 · 数组',
    snippet: 'sort((${a}, ${b}) => ${})',
  },
]
