import { describe, expect, it } from 'vitest'
import { DEFAULT_FLOW_SETTINGS, FLOW_INITIAL_VERSION } from '@lc/schema'
import type { FlowDefinition, ProjectApi } from '@lc/schema'
import type { CustomComponent } from '../src/custom-components/custom-components'
import type { GlobalFunction } from '../src/functions/global-functions'
import { createBlankPageSchema } from '../src/pages/page-model'
import type { PageRecord } from '../src/pages/page-model'
import { DEFAULT_PROJECT_ID } from '../src/projects/project-model'
import { assetSummary, diffReleaseAssets } from '../src/projects/release-diff'
import type { ProjectReleaseAssets } from '../src/projects/release-model'

/**
 * 快照差异是纯计算，不碰存储，静态 import 即可。
 * 夹具只凑齐各记录的必填字段：差异按整条记录序列化比较，字段多寡不影响结论。
 */
const STAMP = '2026-11-10T00:00:00.000Z'

function page(id: string, title = id): PageRecord {
  return {
    id,
    projectId: DEFAULT_PROJECT_ID,
    title,
    schema: createBlankPageSchema(title),
    updatedAt: STAMP,
  }
}

function flow(id: string, name = id): FlowDefinition {
  return {
    id,
    name,
    status: 'draft',
    version: FLOW_INITIAL_VERSION,
    updatedAt: STAMP,
    nodes: {},
    edges: {},
    settings: { ...DEFAULT_FLOW_SETTINGS },
  }
}

function fn(id: string, overrides: Partial<GlobalFunction> = {}): GlobalFunction {
  return { id, name: id, body: '1', updatedAt: STAMP, ...overrides }
}

function component(id: string, title: string): CustomComponent {
  const blank = createBlankPageSchema(title)
  return {
    id,
    definition: {
      meta: { name: id, title, group: '测试', version: '1.0.0' },
      nodeId: blank.nodeId,
      nodes: blank.nodes,
    },
    enabled: true,
    updatedAt: STAMP,
  }
}

function api(id: string, name = id): ProjectApi {
  return { id, name, method: 'GET', path: '/items', createdAt: STAMP, updatedAt: STAMP }
}

function assets(overrides: Partial<ProjectReleaseAssets> = {}): ProjectReleaseAssets {
  return { pages: [], flows: [], functions: [], components: [], ...overrides }
}

describe('快照资产差异', () => {
  it('空基线（首个版本）把五类资产全部记为新增，且按种类固定顺序输出', () => {
    const to = assets({
      pages: [page('p1', '首页')],
      flows: [flow('f1', '下单流程')],
      functions: [fn('fn1')],
      components: [component('c1', '卡片')],
      apis: [api('a1', '商品列表')],
    })

    const changes = diffReleaseAssets(undefined, to)

    expect(changes.map((item) => `${item.kind}:${item.change}`)).toEqual([
      'page:added',
      'flow:added',
      'function:added',
      'component:added',
      'api:added',
    ])
    expect(changes.map((item) => item.label)).toEqual([
      '首页',
      '下单流程',
      'fn1',
      '卡片',
      '商品列表',
    ])
  })

  it('内容完全相同的两份快照没有差异', () => {
    const snapshot = assets({ pages: [page('p1')], flows: [flow('f1')], apis: [api('a1')] })

    expect(diffReleaseAssets(snapshot, snapshot)).toEqual([])
  })

  it('只有 updatedAt 变化不算内容修改：种子补档会重写时间戳，不该误报', () => {
    const from = assets({ pages: [page('p1')], flows: [flow('f1')] })
    const to = assets({
      pages: [{ ...page('p1'), updatedAt: '2026-11-11T00:00:00.000Z' }],
      flows: [{ ...flow('f1'), updatedAt: '2026-11-11T00:00:00.000Z' }],
    })

    expect(diffReleaseAssets(from, to)).toEqual([])
  })

  it('同 id 页面内容变化记为修改，展示名取标题', () => {
    const from = assets({ pages: [page('p1', '首页')] })
    const to = assets({ pages: [{ ...page('p1', '首页'), title: '首页（改版）' }] })

    expect(diffReleaseAssets(from, to)).toEqual([
      { kind: 'page', change: 'modified', id: 'p1', label: '首页（改版）' },
    ])
  })

  it('基线里的流程被移除、目标新增接口，分别记为 removed 与 added', () => {
    const from = assets({ flows: [flow('f1', '旧流程')] })
    const to = assets({ apis: [api('a1', '新接口')] })

    expect(diffReleaseAssets(from, to)).toEqual([
      { kind: 'flow', change: 'removed', id: 'f1', label: '旧流程' },
      { kind: 'api', change: 'added', id: 'a1', label: '新接口' },
    ])
  })

  it('函数展示名优先取 title，缺省退回 name', () => {
    const to = assets({
      functions: [fn('fn1', { title: '格式化金额' }), fn('fn2')],
    })

    const labels = diffReleaseAssets(undefined, to).map((item) => item.label)

    expect(labels).toEqual(['格式化金额', 'fn2'])
  })

  it('组件展示名优先取 meta.title，空标题退回 meta.name', () => {
    const named = component('c1', '卡片')
    const untitled = component('c2', '')
    const to = assets({ components: [named, untitled] })

    const labels = diffReleaseAssets(undefined, to).map((item) => item.label)

    expect(labels).toEqual(['卡片', 'c2'])
  })

  it('同一份快照里不同 id 的资产互不影响，只有真正变化的那条被记录', () => {
    const shared = page('p1')
    const from = assets({ pages: [shared, page('p2')] })
    const to = assets({ pages: [shared, page('p3')] })

    expect(diffReleaseAssets(from, to)).toEqual([
      { kind: 'page', change: 'added', id: 'p3', label: 'p3' },
      { kind: 'page', change: 'removed', id: 'p2', label: 'p2' },
    ])
  })
})

describe('快照资产摘要', () => {
  it('按五类资产计数，旧快照缺 apis 字段按 0 个接口展示', () => {
    expect(assetSummary(assets({ pages: [page('p1')], flows: [flow('f1')] }))).toBe(
      '1 个页面 · 1 条流程 · 0 个函数 · 0 个组件 · 0 个接口',
    )
    expect(assetSummary(assets({ apis: [api('a1'), api('a2')] }))).toBe(
      '0 个页面 · 0 条流程 · 0 个函数 · 0 个组件 · 2 个接口',
    )
  })
})
