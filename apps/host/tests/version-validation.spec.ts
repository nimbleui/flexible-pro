import { describe, expect, it } from 'vitest'
import type { WorkingTree } from '@lc/contracts'
import { validateWorkingTree } from '../src/projects/version-validation'

function tree(docs: WorkingTree): WorkingTree {
  return docs
}

function pageDoc(sections: Record<string, unknown>): WorkingTree[string] {
  return { kind: 'page', docSchemaVersion: '1.0.0', sections }
}

describe('合并产物校验', () => {
  it('空工作区没有问题', () => {
    expect(validateWorkingTree(tree({}))).toEqual([])
  })

  it('页面问题带版本库 docId 前缀，缺版本号由既有校验器报出', () => {
    const issues = validateWorkingTree(
      tree({
        'page:p1': pageDoc({
          version: '',
          nodeId: '',
          nodes: {},
          actions: {},
          connections: {},
        }),
      }),
    )

    expect(issues.some((issue) => issue.path === '/page:p1/version')).toBe(true)
    expect(issues.some((issue) => issue.message.includes('版本号'))).toBe(true)
  })

  it('流程图也进入校验，问题不覆盖页面的问题', () => {
    const issues = validateWorkingTree(
      tree({
        'page:p1': pageDoc({
          version: '',
          nodeId: '',
          nodes: {},
          actions: {},
          connections: {},
        }),
        'flow:f1': {
          kind: 'flow',
          docSchemaVersion: '1.0.0',
          sections: { id: 'f1', name: '', status: 'draft', version: '1.0.0', nodes: {} },
        },
      }),
    )

    expect(issues.some((issue) => issue.path.startsWith('/page:p1'))).toBe(true)
    expect(issues.some((issue) => issue.path.startsWith('/flow:f1'))).toBe(true)
  })

  it('函数 / 组件文档没有独立结构校验器时不产生噪声', () => {
    const issues = validateWorkingTree(
      tree({
        'component:c1': {
          kind: 'component',
          docSchemaVersion: '1.0.0',
          sections: { id: 'c1', anything: 'opaque' },
        },
      }),
    )

    expect(issues).toEqual([])
  })

  it('校验器抛错被收敛成一条阻断问题，不让合并预览崩掉', () => {
    const sections: Record<string, unknown> = {
      version: '1.0.0',
      nodeId: '',
      actions: {},
      connections: {},
    }
    Object.defineProperty(sections, 'nodes', {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })

    const issues = validateWorkingTree(tree({ 'page:p1': pageDoc(sections) }))
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('error')
    expect(issues[0].message).toContain('boom')
    expect(issues[0].path).toBe('/page:p1')
  })
})
