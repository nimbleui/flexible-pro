/** 可筛选下拉的候选项 */
export interface FilterSelectOption {
  /** 提交值 */
  value: string
  /** 展示文本 */
  label: string
  /** 分组标题；同组连续渲染 */
  group?: string
  /** 可选的补充说明 */
  description?: string
}
