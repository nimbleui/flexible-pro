import { describe, expect, it } from 'vitest'
import type { ProjectOwnedRecord } from '../src/projects/project-model'
import {
  DEFAULT_PROJECT_ID,
  countProjectAssets,
  isProject,
  normalizeProjectInput,
  resolveProjectId,
  visibleInProject,
} from '../src/projects/project-model'

/**
 * 项目归属的三条规则都在这份纯逻辑里，且都会直接影响卡片计数与删除拦截：
 * 缺省归属的解释、存储读入的收窄、计数的口径。写错一处就是「用户看不见资产」，
 * 所以这三条必须能在 node 环境里跑（不碰 localStorage）。
 */
describe('项目归属解析', () => {
  it('缺省与空白都回落到默认项目', () => {
    expect(resolveProjectId(undefined)).toBe(DEFAULT_PROJECT_ID)
    expect(resolveProjectId('')).toBe(DEFAULT_PROJECT_ID)
    expect(resolveProjectId('   ')).toBe(DEFAULT_PROJECT_ID)
  })

  it('正常 id 原样返回，只裁掉首尾空白', () => {
    expect(resolveProjectId(' project-a ')).toBe('project-a')
  })
})

describe('项目读档收窄', () => {
  const valid = {
    id: 'project-a',
    name: '订单中台',
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  }

  it('最小可用条目被接受', () => {
    expect(isProject(valid)).toBe(true)
  })

  it('缺 id、缺时间戳或非对象都被拒绝', () => {
    expect(isProject({ ...valid, id: '' })).toBe(false)
    expect(isProject({ ...valid, createdAt: undefined })).toBe(false)
    expect(isProject(null)).toBe(false)
    expect(isProject('project-a')).toBe(false)
  })

  it('空白项目名被拒绝：卡片没有标题就等于没有可辨认的删除目标', () => {
    expect(isProject({ ...valid, name: '' })).toBe(false)
  })

  it('说明写成非字符串时整条拒绝，而不是带着坏字段进渲染', () => {
    expect(isProject({ ...valid, description: 3 })).toBe(false)
  })
})

describe('项目输入归一化', () => {
  it('裁掉首尾空白', () => {
    expect(normalizeProjectInput({ name: '  订单中台  ' }).name).toBe('订单中台')
  })

  it('空白说明写成缺省，不留 description 键', () => {
    const result = normalizeProjectInput({ name: 'a', description: '   ' })
    expect(result).toEqual({ name: 'a' })
    expect('description' in result).toBe(false)
  })

  it('有内容时保留原样', () => {
    expect(normalizeProjectInput({ name: 'a', description: ' 面向仓储 ' }).description).toBe(
      '面向仓储',
    )
  })
})

describe('项目资产计数', () => {
  const lists = {
    pages: [{}, { projectId: 'project-a' }, { projectId: '   ' }],
    flows: [{ projectId: 'project-a' }],
    functions: [{ projectId: 'project-b' }],
    components: [],
    apis: [{ projectId: 'project-a' }, {}],
  }

  it('缺省与空白归属都算进默认项目', () => {
    const counts = countProjectAssets(lists, DEFAULT_PROJECT_ID)
    expect(counts).toEqual({ pages: 2, flows: 0, functions: 0, components: 0, apis: 1 })
  })

  it('按项目隔离计数', () => {
    expect(countProjectAssets(lists, 'project-a').flows).toBe(1)
    expect(countProjectAssets(lists, 'project-a').pages).toBe(1)
    expect(countProjectAssets(lists, 'project-a').apis).toBe(1)
    expect(countProjectAssets(lists, 'project-b').functions).toBe(1)
  })

  it('未知项目五类都是 0', () => {
    expect(countProjectAssets(lists, 'project-missing')).toEqual({
      pages: 0,
      flows: 0,
      functions: 0,
      components: 0,
      apis: 0,
    })
  })
})

describe('单条记录的归属校验', () => {
  interface ScopedRecord extends ProjectOwnedRecord {
    /** 记录自身的内容，与归属判断无关 */
    title: string
  }

  const record: ScopedRecord = { projectId: 'project-a', title: 'x' }
  const legacy: ScopedRecord = { title: '存量页面' }

  it('归属相符才返回记录', () => {
    expect(visibleInProject(record, 'project-a')).toBe(record)
  })

  it('缺省归属只在默认项目里可见', () => {
    expect(visibleInProject(legacy, DEFAULT_PROJECT_ID)).toBe(legacy)
    expect(visibleInProject(legacy, 'project-a')).toBeUndefined()
  })

  it('跨项目访问与记录不存在都是 undefined，编辑器共用同一条「不存在」分支', () => {
    expect(visibleInProject({ ...record, projectId: 'project-b' }, 'project-a')).toBeUndefined()
    expect(visibleInProject(undefined, 'project-a')).toBeUndefined()
  })
})
