import { describe, expect, it } from 'vitest'
import type { FlowDefinition, FlowNode, ProjectApi } from '@lc/schema'
import { DEFAULT_FLOW_SETTINGS, FLOW_TRIGGER } from '@lc/schema'
import { canonicalJson } from '@lc/shared'
import { toWorkingTree } from '@lc/service-version'
import type { GlobalFunction } from '../src/functions/global-functions'
import { createBlankPageSchema } from '../src/pages/page-model'
import type { PageRecord } from '../src/pages/page-model'
import type { ProjectReleaseAssets } from '../src/projects/release-model'
import {
  parseVersionDocId,
  toVersionSnapshot,
  versionDocId,
} from '../src/projects/version-assets'

/**
 * 适配器决定「什么进版本库」。这里钉住三件会影响历史正确性的事：
 * 跨类别 id 不互相覆盖、时间元数据不进内容地址、页面按 schema 顶层字段摊平。
 */

const STAMP = '2026-11-09T00:00:00.000Z'

function makePage(id: string): PageRecord {
  return { id, title: `页面 ${id}`, schema: createBlankPageSchema(id), updatedAt: STAMP }
}

function makeFlow(id: string): FlowDefinition {
  const trigger: FlowNode = {
    id: 'trigger',
    type: FLOW_TRIGGER,
    position: { x: 0, y: 0 },
    config: { kind: 'pageEvent' },
  }

  return {
    id,
    name: id,
    status: 'published',
    version: '1.0.0',
    updatedAt: STAMP,
    nodes: { trigger },
    edges: {},
    settings: { ...DEFAULT_FLOW_SETTINGS },
  }
}

function makeFunction(id: string): GlobalFunction {
  return { id, name: id, body: '1 + 1', updatedAt: STAMP }
}

function makeApi(id: string): ProjectApi {
  return { id, name: id, method: 'GET', path: '/users', createdAt: STAMP, updatedAt: STAMP }
}

/** 四类资产故意共用同一个原始 id，用来证明命名空间前缀确实必要。 */
function makeAssets(overrides: Partial<ProjectReleaseAssets> = {}): ProjectReleaseAssets {
  return {
    pages: [makePage('shared')],
    flows: [makeFlow('shared')],
    functions: [makeFunction('shared')],
    components: [],
    apis: [makeApi('shared')],
    ...overrides,
  }
}

describe('版本库文档 id', () => {
  it('按类别加前缀并能反解，原始 id 含冒号也不丢后缀', () => {
    expect(versionDocId('page', 'p1')).toBe('page:p1')
    expect(parseVersionDocId('page:p1')).toEqual({ kind: 'page', id: 'p1' })
    expect(parseVersionDocId('api:group:users')).toEqual({ kind: 'api', id: 'group:users' })
  })

  it('格式不合法或类别未知时返回 undefined', () => {
    for (const value of ['', 'page', ':p1', 'page:', 'unknown:p1']) {
      expect(parseVersionDocId(value)).toBeUndefined()
    }
  })
})

describe('五类资产 → 版本库快照', () => {
  it('同类 id 跨类别复用时四条记录各自独立，工作区不会静默少一条', () => {
    const snapshot = toVersionSnapshot(makeAssets())

    expect(snapshot.records).toHaveLength(4)
    expect(new Set(snapshot.records.map((record) => record.id)).size).toBe(4)
    expect(Object.keys(toWorkingTree(snapshot))).toEqual([
      'api:shared',
      'flow:shared',
      'function:shared',
      'page:shared',
    ])
  })

  it('页面按 PageSchema 顶层字段摊平，不把 PageRecord 外壳当成 section', () => {
    const snapshot = toVersionSnapshot(makeAssets())
    const page = snapshot.records.find((record) => record.id === 'page:shared')

    expect(page?.docSchemaVersion).toBe(makePage('shared').schema.version)
    expect(Object.keys(page?.content ?? {})).toContain('nodes')
    expect(Object.keys(page?.content ?? {})).toContain('version')
    expect(page?.content).not.toHaveProperty('title')
    expect(page?.content).not.toHaveProperty('updatedAt')
  })

  it('本地写入时刻不进内容地址，其余字段保留', () => {
    const snapshot = toVersionSnapshot(makeAssets())
    const api = snapshot.records.find((record) => record.id === 'api:shared')

    expect(api?.content).not.toHaveProperty('createdAt')
    expect(api?.content).not.toHaveProperty('updatedAt')
    expect(api?.content).toMatchObject({ id: 'shared', method: 'GET', path: '/users' })
  })

  it('environment 属于发布凭据，不进文档', () => {
    const assets = makeAssets({
      environment: { id: 'env-1', name: '生产', baseUrl: 'https://example.com' },
    })
    const snapshot = toVersionSnapshot(assets)

    expect(snapshot.records.map((record) => record.kind)).toEqual([
      'page',
      'flow',
      'function',
      'api',
    ])
    expect(canonicalJson(snapshot)).not.toContain('baseUrl')
  })

  it('同一输入恒得同一工作区，内容变化则地址变化', () => {
    const first = canonicalJson(toWorkingTree(toVersionSnapshot(makeAssets())))
    const same = canonicalJson(toWorkingTree(toVersionSnapshot(makeAssets())))
    const changed = canonicalJson(
      toWorkingTree(toVersionSnapshot(makeAssets({ pages: [makePage('another')] }))),
    )

    expect(same).toBe(first)
    expect(changed).not.toBe(first)
  })

  it('同类重复 id 直接抛错，不让 toWorkingTree 静默覆盖', () => {
    expect(() =>
      toVersionSnapshot(makeAssets({ pages: [makePage('dup'), makePage('dup')] })),
    ).toThrow(/版本库文档 id 冲突/)
  })
})
