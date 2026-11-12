import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROJECT_ID } from '../src/projects/project-model'
import { createBlankPageSchema } from '../src/pages/page-model'
import type { PageRecord } from '../src/pages/page-model'
import type { ProjectRelease } from '../src/projects/release-model'
import { stubFreshIndexedDB } from './support/idb'

/**
 * 发布快照 store 改成「启动前 hydrate + 写穿 IndexedDB」，因此这里用「先 stub、再动态
 * import + hydrate」，每个用例拿到一份干净的内存 IDB 与模块实例。纯逻辑（发布号、剪枝、
 * 闸门）已在 release-model.spec.ts 覆盖，本文件只测 store 这一层的三件事：
 * 生成快照、移动指针、读档收窄。
 */
const STAMP = '2026-11-05T00:00:00.000Z'

function project(publishedRevision?: number) {
  return {
    id: DEFAULT_PROJECT_ID,
    name: '默认项目',
    description: '',
    ...(publishedRevision === undefined ? {} : { publishedRevision }),
    createdAt: STAMP,
    updatedAt: STAMP,
  }
}

function page(id: string): PageRecord {
  return {
    id,
    projectId: DEFAULT_PROJECT_ID,
    title: id,
    schema: createBlankPageSchema(id),
    updatedAt: STAMP,
  }
}

function release(revision: number, overrides: Partial<ProjectRelease> = {}): ProjectRelease {
  return {
    projectId: DEFAULT_PROJECT_ID,
    revision,
    createdAt: STAMP,
    assets: { pages: [page(`page-v${revision}`)], flows: [], functions: [], components: [] },
    ...overrides,
  }
}

async function seed(
  publishedRevision?: number,
  releases: readonly ProjectRelease[] = [],
): Promise<void> {
  const idb = await import('../src/storage/idb')
  await idb.replaceAll(idb.STORE.projects, [project(publishedRevision)])
  await idb.replaceAll(idb.STORE.pages, [page('page-1')])
  await idb.replaceAll(idb.STORE.projectReleases, releases)
}

/**
 * 按依赖顺序灌入内存：快照与部署留痕读档要按 `projects.value` 剔孤儿，
 * 必须先 hydrate 项目；其余彼此独立的表随后并发读入。
 *
 * 流程表也要 hydrate：page-store 读档会补齐内置种子页（如「工单管理系统」），
 * 这些页连接引用了种子流程，发布校验要能在流程表里解析到它——与旧代码在模块加载时
 * 自动落种子图的行为一致。
 */
async function hydrateStores(): Promise<void> {
  const projectStore = await import('../src/projects/project-store')
  const pageStore = await import('../src/pages/page-store')
  const flowStore = await import('../src/workflows/flow-store')
  const releaseStore = await import('../src/projects/release-store')
  const deployLog = await import('../src/projects/release-deploy-log')
  const prefs = await import('../src/storage/app-preferences')

  await projectStore.hydrate()
  await prefs.hydratePreferences()
  await Promise.all([
    pageStore.hydrate(),
    flowStore.hydrate(),
    releaseStore.hydrate(),
    deployLog.hydrate(),
  ])
}

beforeEach(() => {
  vi.resetModules()
  stubFreshIndexedDB()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// 每个用例都用 vi.resetModules() + 动态 import 重编译整条模块链；默认并行下
// 与其它文件争抢 CPU 时，首例可能超过 vitest 默认的 5000ms 而超时，并让
// 依赖它 seed 的后续用例级联失败（见 docs/13-version-control.md:1476 的既有登记）。
// 仅对本 suite 放宽超时，不改动任何用例、断言或模块加载方式，也不影响其它测试文件。
describe('发布快照存储', { timeout: 20_000 }, () => {
  it('发布生成递增版本并移动指针，快照里的页面是当前资产的副本', async () => {
    await seed()
    await hydrateStores()
    const store = await import('../src/projects/release-store')
    const projectStore = await import('../src/projects/project-store')
    const pageStore = await import('../src/pages/page-store')

    const first = store.publishProject(DEFAULT_PROJECT_ID)
    const second = store.publishProject(DEFAULT_PROJECT_ID)

    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    expect(projectStore.getProject(DEFAULT_PROJECT_ID)?.publishedRevision).toBe(2)
    expect(store.currentReleaseOf(DEFAULT_PROJECT_ID)?.revision).toBe(2)
    expect(first.assets.pages[0]).not.toBe(pageStore.pages.value[0])
  })

  it('回滚只拨指针，不回写任何资产记录', async () => {
    await seed()
    await hydrateStores()
    const store = await import('../src/projects/release-store')
    const projectStore = await import('../src/projects/project-store')
    const pageStore = await import('../src/pages/page-store')

    store.publishProject(DEFAULT_PROJECT_ID)
    store.publishProject(DEFAULT_PROJECT_ID)
    const before = JSON.stringify(pageStore.pages.value)

    store.setCurrentRelease(DEFAULT_PROJECT_ID, 1)

    expect(projectStore.getProject(DEFAULT_PROJECT_ID)?.publishedRevision).toBe(1)
    expect(store.currentReleaseOf(DEFAULT_PROJECT_ID)?.revision).toBe(1)
    expect(JSON.stringify(pageStore.pages.value)).toBe(before)
  })

  it('回滚到不存在的版本抛错，不假装切换成功', async () => {
    await seed(1, [release(1)])
    await hydrateStores()
    const store = await import('../src/projects/release-store')

    expect(() => store.setCurrentRelease(DEFAULT_PROJECT_ID, 99)).toThrow(/不存在/)
    expect(store.currentReleaseOf(DEFAULT_PROJECT_ID)?.revision).toBe(1)
  })

  it('读档按项目与发布号去重，丢掉孤儿项目并按上限剪枝', async () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => release(n))
    await seed(6, [...many, release(6), { ...release(1), projectId: 'ghost-project' }])
    await hydrateStores()
    const store = await import('../src/projects/release-store')

    expect(store.releases.value.map((item) => item.revision)).toEqual([2, 3, 4, 5, 6])
    expect(store.releases.value.every((item) => item.projectId === DEFAULT_PROJECT_ID)).toBe(
      true,
    )
  })

  it('发布记下备注与发布人：备注去空白、空备注不落库，发布人取登录标记并兜底', async () => {
    await seed()
    const idb = await import('../src/storage/idb')
    await idb.putOne(idb.STORE.appKv, { key: 'auth-user', value: ' 陈宇 ' })
    await hydrateStores()
    const store = await import('../src/projects/release-store')
    const prefs = await import('../src/storage/app-preferences')

    const withNote = store.publishProject(DEFAULT_PROJECT_ID, { note: '  首次发布  ' })
    expect(withNote.note).toBe('首次发布')
    expect(withNote.publishedBy).toBe('陈宇')

    const blankNote = store.publishProject(DEFAULT_PROJECT_ID, { note: '   ' })
    expect(blankNote.note).toBeUndefined()

    prefs.setAuthUser('')
    const anonymous = store.publishProject(DEFAULT_PROJECT_ID)
    expect(anonymous.publishedBy).toBe('本地用户')
  })

  it('发布与回滚都留部署痕迹，按时间倒序返回；切到同一版本不重复留痕', async () => {
    await seed()
    await hydrateStores()
    const store = await import('../src/projects/release-store')
    const deployLog = await import('../src/projects/release-deploy-log')

    store.publishProject(DEFAULT_PROJECT_ID)
    store.publishProject(DEFAULT_PROJECT_ID)
    store.setCurrentRelease(DEFAULT_PROJECT_ID, 1)
    store.setCurrentRelease(DEFAULT_PROJECT_ID, 1)

    expect(
      deployLog.listDeployOf(DEFAULT_PROJECT_ID).map((item) => `${item.kind}:${item.revision}`),
    ).toEqual(['rollback:1', 'publish:2', 'publish:1'])
    expect(
      deployLog.listDeployOf(DEFAULT_PROJECT_ID).every((item) => item.by === '本地用户'),
    ).toBe(true)
  })

  it('部署留痕按项目保留最近 30 条，更旧的自动剪掉', async () => {
    await seed()
    await hydrateStores()
    const deployLog = await import('../src/projects/release-deploy-log')

    for (let revision = 1; revision <= 32; revision += 1) {
      deployLog.appendDeploy({
        projectId: DEFAULT_PROJECT_ID,
        kind: 'publish',
        revision,
        at: STAMP,
        by: '本地用户',
      })
    }

    const records = deployLog.listDeployOf(DEFAULT_PROJECT_ID)
    expect(records).toHaveLength(30)
    expect(records[0]?.revision).toBe(32)
    expect(records[29]?.revision).toBe(3)
  })
})
