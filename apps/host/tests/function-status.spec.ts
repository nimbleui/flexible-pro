import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROJECT_ID } from '../src/projects/project-model'
import type { GlobalFunction } from '../src/functions/global-functions'
import { stubFreshIndexedDB } from './support/idb'

/**
 * 发布状态是「草稿 vs 当前线上快照」的实时派生，不落库。
 * 这里直接 seed 项目指针与快照表到 IndexedDB，再 hydrate 项目与快照两个 store，
 * 验证三种状态与「时间戳不算改动」的回归口径。
 */
const STAMP = '2026-11-08T00:00:00.000Z'

function fn(overrides: Partial<GlobalFunction> = {}): GlobalFunction {
  return {
    id: 'fn-1',
    name: 'progress',
    params: ['done', 'total'],
    body: 'done / total',
    updatedAt: STAMP,
    ...overrides,
  }
}

async function seed(liveFunctions: readonly GlobalFunction[] | undefined): Promise<void> {
  const idb = await import('../src/storage/idb')
  await idb.replaceAll(idb.STORE.projects, [
    {
      id: DEFAULT_PROJECT_ID,
      name: '默认项目',
      description: '',
      createdAt: STAMP,
      updatedAt: STAMP,
      ...(liveFunctions === undefined ? {} : { publishedRevision: 1 }),
    },
  ])

  if (liveFunctions !== undefined) {
    await idb.replaceAll(idb.STORE.projectReleases, [
      {
        projectId: DEFAULT_PROJECT_ID,
        revision: 1,
        createdAt: STAMP,
        assets: { pages: [], flows: [], functions: liveFunctions, components: [] },
      },
    ])
  }
}

/** 快照读档要按项目剔孤儿，必须先 hydrate 项目再 hydrate 快照 */
async function hydrateStores(): Promise<void> {
  const projectStore = await import('../src/projects/project-store')
  const releaseStore = await import('../src/projects/release-store')
  await projectStore.hydrate()
  await releaseStore.hydrate()
}

beforeEach(() => {
  vi.resetModules()
  stubFreshIndexedDB()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('函数发布状态派生', { timeout: 20_000 }, () => {
  it('没有线上版本或快照里没有这条函数时为未发布', async () => {
    await seed(undefined)
    await hydrateStores()
    const { functionPublishStatus } = await import('../src/functions/function-status')
    expect(functionPublishStatus(fn(), DEFAULT_PROJECT_ID)).toBe('draft')

    vi.resetModules()
    await seed([])
    await hydrateStores()
    const reloaded = await import('../src/functions/function-status')
    expect(reloaded.functionPublishStatus(fn(), DEFAULT_PROJECT_ID)).toBe('draft')
  })

  it('内容与线上一致为已发布，仅 updatedAt 不同不算改动', async () => {
    await seed([fn()])
    await hydrateStores()
    const { functionPublishStatus } = await import('../src/functions/function-status')

    expect(functionPublishStatus(fn(), DEFAULT_PROJECT_ID)).toBe('published')
    expect(
      functionPublishStatus(fn({ updatedAt: '2026-11-09T08:30:00.000Z' }), DEFAULT_PROJECT_ID),
    ).toBe('published')
  })

  it('函数体、分类或函数名改动后为待发布，按 id 而非名字匹配', async () => {
    await seed([fn()])
    await hydrateStores()
    const { functionPublishStatus } = await import('../src/functions/function-status')

    expect(functionPublishStatus(fn({ body: 'done / total * 100' }), DEFAULT_PROJECT_ID)).toBe(
      'modified',
    )
    expect(functionPublishStatus(fn({ scope: 'page' }), DEFAULT_PROJECT_ID)).toBe('modified')
    expect(functionPublishStatus(fn({ name: 'progressV2' }), DEFAULT_PROJECT_ID)).toBe(
      'modified',
    )
  })

  it('形参缺省与空集合等价，参数顺序变化算改动', async () => {
    await seed([fn({ params: undefined })])
    await hydrateStores()
    const { functionPublishStatus } = await import('../src/functions/function-status')

    expect(functionPublishStatus(fn({ params: [] }), DEFAULT_PROJECT_ID)).toBe('published')
    expect(functionPublishStatus(fn({ params: ['total', 'done'] }), DEFAULT_PROJECT_ID)).toBe(
      'modified',
    )
  })
})
