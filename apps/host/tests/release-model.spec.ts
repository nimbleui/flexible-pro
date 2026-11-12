import { describe, expect, it } from 'vitest'
import type { FlowDefinition, FlowNode, ProjectApi } from '@lc/schema'
import { DEFAULT_FLOW_SETTINGS, FLOW_TRIGGER, hasBlockingIssue } from '@lc/schema'
import type {
  ProjectRelease,
  ProjectReleaseAssets,
  ProjectReleaseSources,
} from '../src/projects/release-model'
import {
  RELEASE_RETENTION,
  collectProjectAssets,
  narrowRelease,
  nextRevision,
  pruneReleases,
  validateProjectRelease,
} from '../src/projects/release-model'
import { DEFAULT_PROJECT_ID } from '../src/projects/project-model'
import { createBlankPageSchema } from '../src/pages/page-model'
import type { PageRecord } from '../src/pages/page-model'

/**
 * 发布闸门的四条阻断规则与快照剪枝都在这份纯逻辑里。
 *
 * 它们决定「点发布会发生什么」：漏判一次就是把坏版本推到线上，误判一次就是
 * 用户看见一个永远点不动的按钮。两头都要钉住。
 */

function makePage(id: string, projectId?: string): PageRecord {
  return {
    id,
    projectId,
    title: `页面 ${id}`,
    schema: createBlankPageSchema(`页面 ${id}`),
    updatedAt: '2026-11-05T00:00:00.000Z',
  }
}

/**
 * 一条绑定了流程图的页面。
 *
 * 用页面级事件（`sourceNodeId: 'page'`）当宿主：节点级事件还得先在 nodes 表里造出那个节点，
 * 而这里要验的是 `flowId` 这条引用，与来源是不是真实节点无关。
 */
function makeBoundPage(id: string, flowId: string): PageRecord {
  const page = makePage(id)

  return {
    ...page,
    schema: {
      ...page.schema,
      connections: {
        'on-load': {
          id: 'on-load',
          sourceNodeId: 'page',
          eventName: 'pageLoad',
          actionIds: [],
          flowId,
          enabled: true,
        },
      },
    },
  }
}

function makeFlow(
  id: string,
  options: {
    projectId?: string
    status?: FlowDefinition['status']
  } = {},
): FlowDefinition {
  const node: FlowNode = {
    id: 'trigger',
    type: FLOW_TRIGGER,
    position: { x: 0, y: 0 },
    // 触发节点只声明来源类型；绑到哪个页面的哪个事件写在页面连接的 flowId 上
    config: { kind: 'pageEvent' },
  }

  return {
    id,
    name: id,
    status: options.status ?? 'published',
    version: '1.0.0',
    projectId: options.projectId,
    updatedAt: '2026-11-05T00:00:00.000Z',
    nodes: { [node.id]: node },
    edges: {},
    settings: { ...DEFAULT_FLOW_SETTINGS },
  }
}

function makeAssets(overrides: Partial<ProjectReleaseAssets> = {}): ProjectReleaseAssets {
  return {
    pages: [makePage('p1')],
    flows: [],
    functions: [],
    components: [],
    ...overrides,
  }
}

function makeRelease(revision: number, projectId = 'project-a'): ProjectRelease {
  return {
    projectId,
    revision,
    createdAt: '2026-11-05T00:00:00.000Z',
    assets: makeAssets(),
  }
}

describe('发布号推导', () => {
  it('第一次发布从 1 开始', () => {
    expect(nextRevision([], undefined)).toBe(1)
  })

  it('正常追加大号', () => {
    expect(nextRevision([1, 2], 2)).toBe(3)
  })

  it('回滚后再发布不跟已有快照撞号', () => {
    // 线上切回 v1、表里还留着 v2/v3：只看指针会算出 v2，两份内容同号
    expect(nextRevision([1, 2, 3], 1)).toBe(4)
  })

  it('指针领先于现存快照时也继续前进', () => {
    expect(nextRevision([2], 5)).toBe(6)
  })
})

describe('按项目收集资产', () => {
  // functions / components 走的是同一个 inProject 分支，这里用 pages 与 flows 两条真实类型即可覆盖
  const sources: ProjectReleaseSources = {
    pages: [makePage('p-a', 'project-a'), makePage('p-b', 'project-b'), makePage('p-legacy')],
    flows: [makeFlow('f-a', { projectId: 'project-a' }), makeFlow('f-legacy')],
    functions: [],
    components: [],
    apis: [],
  }

  it('缺省归属算默认项目', () => {
    const collected = collectProjectAssets(sources, DEFAULT_PROJECT_ID)
    expect(collected.pages.map((page) => page.id)).toEqual(['p-legacy'])
    expect(collected.flows.map((flow) => flow.id)).toEqual(['f-legacy'])
  })

  it('按项目分开收集，五类互不影响', () => {
    const collected = collectProjectAssets(sources, 'project-a')
    expect(collected.pages.map((page) => page.id)).toEqual(['p-a'])
    expect(collected.flows.map((flow) => flow.id)).toEqual(['f-a'])
    expect(collected.functions).toHaveLength(0)
    expect(collected.components).toHaveLength(0)
    expect(collected.apis).toHaveLength(0)
  })

  it('快照带的是记录本体而不是被抹平的引用', () => {
    const collected = collectProjectAssets(sources, 'project-b')
    expect(collected.pages[0]?.schema.nodeId).toBe('root')
  })
})

describe('发布时把接口引用定版', () => {
  const api: ProjectApi = {
    id: 'api-users',
    projectId: 'project-a',
    name: '用户列表',
    method: 'GET',
    path: '/users',
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  }

  /** 只存绑定、不存地址的页面：线上版本的地址不该由快照再去猜当前配置 */
  function makeBoundPage(apiId: string): PageRecord {
    const schema = createBlankPageSchema('带引用的页面')
    schema.apis = [{ id: 'users', apiId }]

    return {
      id: 'p-bound',
      projectId: 'project-a',
      title: '带引用的页面',
      schema,
      updatedAt: '2026-11-05T00:00:00.000Z',
    }
  }

  function sourcesOf(page: PageRecord, apis: readonly ProjectApi[]): ProjectReleaseSources {
    return { pages: [page], flows: [], functions: [], components: [], apis }
  }

  it('快照记下展开出的配置与当时那套环境，之后改域名不影响已发布版本', () => {
    const environment = { id: 'env-test', name: '测试', baseUrl: 'https://api.test/svc' }

    const collected = collectProjectAssets(
      sourcesOf(makeBoundPage(api.id), [api]),
      'project-a',
      environment,
    )

    const bound = collected.pages[0]?.schema.datasources ?? []
    expect(bound.map((item) => item.id)).toEqual(['users'])
    // 路径原样进快照：域名由快照里的 environment 在发请求时拼，而不是靠当前配置
    expect(bound[0]?.config).toEqual({ kind: 'rest', url: '/users', method: 'GET' })
    expect(collected.apis).toEqual([api])
    expect(collected.environment).toEqual(environment)
  })

  it('读档时环境形状坏了就当这个版本没有环境，不整条拒收', () => {
    const broken: unknown = {
      projectId: 'project-a',
      revision: 1,
      createdAt: '2026-11-05T00:00:00.000Z',
      assets: {
        pages: [],
        flows: [],
        functions: [],
        components: [],
        environment: { id: 'env-1', name: '测试', baseUrl: 'api.test' },
      },
    }

    expect(narrowRelease(broken)?.assets.environment).toBeUndefined()
  })

  it('读档保住合法环境：运行页拿的就是这一份，而不是当前项目配置', () => {
    const environment = {
      id: 'env-1',
      name: '测试',
      baseUrl: 'https://api.test',
      headers: { Authorization: 'Bearer t' },
    }
    const stored: unknown = {
      projectId: 'project-a',
      revision: 1,
      createdAt: '2026-11-05T00:00:00.000Z',
      assets: { pages: [], flows: [], functions: [], components: [], environment },
    }

    expect(narrowRelease(stored)?.assets.environment).toEqual(environment)
  })

  it('引用的接口不存在时发布被阻断，而不是留下一个永远取不到数的数据项', () => {
    const assets = collectProjectAssets(sourcesOf(makeBoundPage('gone'), [api]), 'project-a')

    const issues = validateProjectRelease(assets)
    expect(hasBlockingIssue(issues)).toBe(true)
    expect(issues[0]?.message).toContain('已不存在')
  })

  it('没有绑定的页面原样进快照，不被一次无关展开换掉引用', () => {
    const page = makePage('p-plain')

    const collected = collectProjectAssets(sourcesOf(page, []), DEFAULT_PROJECT_ID)
    expect(collected.pages[0]).toBe(page)
  })
})

describe('发布闸门', () => {
  it('没有页面就阻断：发布后没有可打开的入口', () => {
    const issues = validateProjectRelease(makeAssets({ pages: [] }))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.path).toBe('/pages')
  })

  it('页面自身有阻断问题时带上页面名上浮', () => {
    const broken = makePage('p-bad')
    // 根 id 与 nodeId 不一致是文档校验里的阻断问题，直接构造出来比依赖校验细节更稳
    broken.schema = {
      ...broken.schema,
      nodes: { other: { id: 'other', componentName: 'Box' } },
    }
    const issues = validateProjectRelease(makeAssets({ pages: [broken] }))
    const blocking = issues.filter((issue) => issue.severity === 'error')
    expect(hasBlockingIssue(blocking)).toBe(true)
    expect(blocking.some((issue) => issue.message.includes('页面 p-bad'))).toBe(true)
  })

  it('草稿流程只给提示，不阻断发布', () => {
    const issues = validateProjectRelease(
      makeAssets({ flows: [makeFlow('f-draft', { status: 'draft' })] }),
    )
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true)
    expect(hasBlockingIssue(issues)).toBe(false)
  })

  it('页面绑定了不存在的图时阻断', () => {
    /** 图被删掉后页面里的 `flowId` 不会跟着动，这条绑定永远不会生效——发布前必须说。 */
    const issues = validateProjectRelease(
      makeAssets({ pages: [makeBoundPage('p1', 'ghost-flow')], flows: [makeFlow('f1')] }),
    )
    const blocking = issues.filter((issue) => issue.severity === 'error')
    expect(hasBlockingIssue(blocking)).toBe(true)
    expect(blocking.some((issue) => issue.message.includes('"ghost-flow" 不存在'))).toBe(true)
  })

  it('页面绑定了草稿图时只给提示，不阻断发布', () => {
    const issues = validateProjectRelease(
      makeAssets({
        pages: [makeBoundPage('p1', 'f-draft')],
        flows: [makeFlow('f-draft', { status: 'draft' })],
      }),
    )
    const flowIssue = issues.find((issue) => issue.message.includes('还是草稿'))
    expect(flowIssue?.severity).toBe('warning')
    expect(hasBlockingIssue(issues)).toBe(false)
  })

  it('两张图被两个事件分别绑定不算冲突；同一张图被多处绑定也不算', () => {
    // 抢键判定随三段事件键一起退役：绑定是页面上的一个字段，一个字段装得下一张图，
    // 而一张图被多少个事件引用都不产生歧义——跑的永远是同一份内容。
    const issues = validateProjectRelease(
      makeAssets({
        pages: [
          makeBoundPage('p1', 'f1'),
          makeBoundPage('p2', 'f1'),
          makeBoundPage('p3', 'f2'),
        ],
        flows: [makeFlow('f1'), makeFlow('f2')],
      }),
    )
    expect(hasBlockingIssue(issues)).toBe(false)
  })

  it('正常组合不产生任何阻断', () => {
    const issues = validateProjectRelease(
      makeAssets({ pages: [makePage('p1'), makePage('p2')], flows: [makeFlow('f1')] }),
    )
    expect(issues).toEqual([])
  })
})

describe('快照剪枝', () => {
  it('每个项目只保留最近 RELEASE_RETENTION 份', () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => makeRelease(n))
    const pruned = pruneReleases(many)
    expect(pruned.map((item) => item.revision)).toEqual([3, 4, 5, 6, 7])
    expect(pruned).toHaveLength(RELEASE_RETENTION)
  })

  it('跨项目互不挤占额度', () => {
    const mixed = [
      makeRelease(1, 'project-a'),
      makeRelease(2, 'project-a'),
      makeRelease(1, 'project-b'),
      makeRelease(9, 'project-b'),
    ]
    const pruned = pruneReleases(mixed, 2)
    expect(pruned.map((item) => `${item.projectId}#${item.revision}`)).toEqual([
      'project-a#1',
      'project-a#2',
      'project-b#1',
      'project-b#9',
    ])
  })

  it('输入乱序也按发布号升序输出', () => {
    const pruned = pruneReleases([makeRelease(5), makeRelease(1), makeRelease(3)], 5)
    expect(pruned.map((item) => item.revision)).toEqual([1, 3, 5])
  })
})

describe('快照读档收窄', () => {
  const valid = {
    projectId: 'project-a',
    revision: 3,
    createdAt: '2026-11-05T00:00:00.000Z',
    assets: { pages: [makePage('p1')], flows: [], functions: [], components: [] },
  }

  it('骨架完整即通过', () => {
    expect(narrowRelease(valid)?.revision).toBe(3)
  })

  it('发布号必须是从 1 开始的整数', () => {
    expect(narrowRelease({ ...valid, revision: 0 })).toBeUndefined()
    expect(narrowRelease({ ...valid, revision: 1.5 })).toBeUndefined()
    expect(narrowRelease({ ...valid, revision: '3' })).toBeUndefined()
  })

  it('缺项目 id 或缺 assets 骨架整体拒绝', () => {
    expect(narrowRelease({ ...valid, projectId: '' })).toBeUndefined()
    expect(
      narrowRelease({ ...valid, assets: { ...valid.assets, pages: null } }),
    ).toBeUndefined()
    expect(
      narrowRelease({ ...valid, assets: { ...valid.assets, functions: {} } }),
    ).toBeUndefined()
    expect(narrowRelease(null)).toBeUndefined()
  })

  it('坏一条页面只丢那条，不把整个版本抹掉', () => {
    const withBad = {
      ...valid,
      assets: {
        ...valid.assets,
        pages: [makePage('p1'), { id: 'p-bad' }, makePage('p2')],
      },
    }
    const kept = narrowRelease(withBad)?.assets.pages.map((page) => page.id)
    expect(kept).toEqual(['p1', 'p2'])
  })

  it('备注与发布人缺失或形状坏时只丢该字段，不影响整条快照', () => {
    expect(narrowRelease(valid)?.note).toBeUndefined()
    expect(narrowRelease(valid)?.publishedBy).toBeUndefined()
    expect(narrowRelease({ ...valid, note: '', publishedBy: 42 })?.note).toBeUndefined()
    expect(narrowRelease({ ...valid, note: '', publishedBy: 42 })?.publishedBy).toBeUndefined()

    const withMeta = narrowRelease({ ...valid, note: '首次发布', publishedBy: '陈宇' })
    expect(withMeta?.note).toBe('首次发布')
    expect(withMeta?.publishedBy).toBe('陈宇')
  })
})
