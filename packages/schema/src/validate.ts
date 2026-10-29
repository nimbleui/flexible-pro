/**
 * Schema 校验
 * ---
 * 只做「结构一致性」检查：引用完整性、必要字段、明显的非法配置。
 * 组件语义校验（属性类型、事件动作是否存在）由 material / action 服务负责，
 * 不属于纯 schema 包。
 */

import type { PageSchema } from './page'

/** 校验问题级别 */
export type ValidationSeverity = 'error' | 'warning'

/** 单条校验问题 */
export interface ValidationIssue {
  /** 出问题的位置（节点 id 路径或 schema 字段路径） */
  path: string
  /** 可读描述 */
  message: string
  /** 级别；error 阻断保存/发布，warning 仅提示 */
  severity: ValidationSeverity
}

/**
 * 校验页面 schema 的结构一致性。
 *
 * 检查项：
 * - version / nodeId 必填
 * - nodeId 必须指向 nodes 表中存在的节点
 * - 节点表键与节点自身 id 必须一致
 * - children / slots 引用的节点必须存在
 * - 节点必须声明非空 componentName
 *
 * @returns 问题列表；空数组表示结构合法。
 */
export function validateDocument(schema: PageSchema): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (!schema.version) {
    issues.push({ path: '/version', message: '缺少 schema 版本号', severity: 'error' })
  }

  const nodes = schema.nodes ?? {}
  if (Object.keys(nodes).length === 0) {
    issues.push({ path: '/nodes', message: '节点表为空', severity: 'error' })
    return issues
  }

  if (!schema.nodeId || !nodes[schema.nodeId]) {
    issues.push({
      path: '/nodeId',
      message: `根节点 "${schema.nodeId}" 不存在于 nodes 表中`,
      severity: 'error',
    })
  }

  for (const [key, node] of Object.entries(nodes)) {
    if (node.id !== key) {
      issues.push({
        path: `/nodes/${key}/id`,
        message: `节点键 "${key}" 与节点 id "${node.id}" 不一致`,
        severity: 'error',
      })
    }

    if (!node.componentName) {
      issues.push({
        path: `/nodes/${key}/componentName`,
        message: '节点缺少 componentName',
        severity: 'error',
      })
    }

    for (const childId of node.children ?? []) {
      if (!nodes[childId]) {
        issues.push({
          path: `/nodes/${key}/children`,
          message: `子节点 "${childId}" 不存在`,
          severity: 'error',
        })
      }
    }

    for (const [slot, slotChildren] of Object.entries(node.slots ?? {})) {
      for (const childId of slotChildren) {
        if (!nodes[childId]) {
          issues.push({
            path: `/nodes/${key}/slots/${slot}`,
            message: `插槽节点 "${childId}" 不存在`,
            severity: 'error',
          })
        }
      }
    }

    if (node.layout?.mode === 'absolute' && !node.layout.rect) {
      issues.push({
        path: `/nodes/${key}/layout`,
        message: '绝对定位节点缺少 rect 几何信息',
        severity: 'warning',
      })
    }
  }

  return issues
}

/** 是否存在阻断性问题。 */
export function hasBlockingIssue(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error')
}
