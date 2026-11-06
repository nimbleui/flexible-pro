import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '@lc/schema'
import {
  createBlankPageSchema,
  isPageRecord,
  isPageSchemaSnapshot,
  normalizePageTitle,
} from '../src/pages/page-model'

/**
 * 页面记录是文档内容的唯一落盘形状：读档收窄决定「一条页面进不进列表」，
 * 空白文档决定新建页面进画布时有没有可选中对象。两者都在纯函数里，单独测。
 */
describe('空白页面文档', () => {
  const schema = createBlankPageSchema('订单列表')

  it('根节点 id 与文档入口一致，否则画布取不到根包围盒', () => {
    expect(schema.nodeId).toBe('root')
    expect(schema.nodes.root?.id).toBe('root')
  })

  it('版本跟随 SCHEMA_VERSION，标题写进 metadata', () => {
    expect(schema.version).toBe(SCHEMA_VERSION)
    expect(schema.metadata?.title).toBe('订单列表')
  })

  it('根容器有非零画幅，新页面不会缩成一条', () => {
    const rect = schema.nodes.root?.layout?.rect
    expect(rect).toBeDefined()
    expect(rect?.width).toBeGreaterThan(0)
    expect(rect?.height).toBeGreaterThan(0)
  })
})

describe('文档快照收窄', () => {
  it('四个顶层字段齐全即通过', () => {
    expect(isPageSchemaSnapshot(createBlankPageSchema('a'))).toBe(true)
  })

  it('缺 components 或 nodes 不是文档，拒收而不是带着半成品建模型', () => {
    const schema = createBlankPageSchema('a') as unknown as Record<string, unknown>
    expect(isPageSchemaSnapshot({ ...schema, components: undefined })).toBe(false)
    expect(isPageSchemaSnapshot({ ...schema, nodes: null })).toBe(false)
    expect(isPageSchemaSnapshot(null)).toBe(false)
  })
})

describe('页面记录收窄', () => {
  const valid = {
    id: 'page-a',
    title: '订单列表',
    schema: createBlankPageSchema('订单列表'),
    updatedAt: '2026-11-05T00:00:00.000Z',
  }

  it('最小可用条目被接受，归属字段可以缺省', () => {
    expect(isPageRecord(valid)).toBe(true)
    expect(isPageRecord({ ...valid, projectId: 'project-a' })).toBe(true)
  })

  it('空白标题或空白 id 被拒绝：列表与路由都靠它们定位一行', () => {
    expect(isPageRecord({ ...valid, title: '' })).toBe(false)
    expect(isPageRecord({ ...valid, id: '' })).toBe(false)
  })

  it('schema 形状不对时整条拒绝', () => {
    expect(isPageRecord({ ...valid, schema: { version: '1.0.0' } })).toBe(false)
  })

  it('归属写成非字符串时拒绝，避免坏值进计数', () => {
    expect(isPageRecord({ ...valid, projectId: 7 })).toBe(false)
  })
})

describe('页面标题归一化', () => {
  it('只裁首尾空白，空白标题留给调用方拒绝', () => {
    expect(normalizePageTitle('  订单列表  ')).toBe('订单列表')
    expect(normalizePageTitle('   ')).toBe('')
  })
})
