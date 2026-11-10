import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROJECT_ID } from '../src/projects/project-model'
import { createBlankPageSchema } from '../src/pages/page-model'
import type { PageRecord } from '../src/pages/page-model'
import type { ProjectRelease } from '../src/projects/release-model'

/**
 * 发布快照 store 的模块顶层就读 localStorage，因此这里用「先 stub、再动态 import」，
 * 每个用例拿到一份干净的模块实例。纯逻辑（发布号、剪枝、闸门）已在 release-model.spec.ts
 * 覆盖，本文件只测 store 这一层的三件事：生成快照、移动指针、读档收窄。
 */
const storage = vi.hoisted(() => ({ data: new Map<string, string>() }))

function fakeLocalStorage() {
  return {
    getItem: (key: string) => storage.data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.data.set(key, value)
    },
    removeItem: (key: string) => {
      storage.data.delete(key)
    },
    clear: () => storage.data.clear(),
    key: (index: number) => [...storage.data.keys()][index] ?? null,
    get length() {
      return storage.data.size
    },
  }
}

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

function seed(publishedRevision?: number, releases: readonly ProjectRelease[] = []): void {
  storage.data.set('lc.projects.v1', JSON.stringify([project(publishedRevision)]))
  storage.data.set('lc.pages.v1', JSON.stringify([page('page-1')]))
  storage.data.set('lc.releases.v1', JSON.stringify(releases))
}

beforeEach(() => {
  storage.data.clear()
  vi.resetModules()
  vi.stubGlobal('localStorage', fakeLocalStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// 每个用例都用 vi.resetModules() + 动态 import 重编译整条模块链；默认并行下
// 与其它 109 个文件争抢 CPU 时，首例可能超过 vitest 默认的 5000ms 而超时，并让
// 依赖它 seed 的后续用例级联失败（见 docs/13-version-control.md:1476 的既有登记）。
// 仅对本 suite 放宽超时，不改动任何用例、断言或模块加载方式，也不影响其它测试文件。
describe('发布快照存储', { timeout: 20_000 }, () => {
  it('发布生成递增版本并移动指针，快照里的页面是当前资产的副本', async () => {
    seed()
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
    seed()
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
    seed(1, [release(1)])
    const store = await import('../src/projects/release-store')

    expect(() => store.setCurrentRelease(DEFAULT_PROJECT_ID, 99)).toThrow(/不存在/)
    expect(store.currentReleaseOf(DEFAULT_PROJECT_ID)?.revision).toBe(1)
  })

  it('读档按项目与发布号去重，丢掉孤儿项目并按上限剪枝', async () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => release(n))
    seed(6, [...many, release(6), { ...release(1), projectId: 'ghost-project' }])
    const store = await import('../src/projects/release-store')

    expect(store.releases.value.map((item) => item.revision)).toEqual([2, 3, 4, 5, 6])
    expect(store.releases.value.every((item) => item.projectId === DEFAULT_PROJECT_ID)).toBe(
      true,
    )
  })
})
