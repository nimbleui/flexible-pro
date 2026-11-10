import { shallowRef } from 'vue'
import type { Disposable } from '@lc/kernel'
import type { ValidationIssue } from '@lc/schema'
import { hasBlockingIssue } from '@lc/schema'
import type { ProjectRelease, ProjectReleaseAssets } from './release-model'
import {
  collectProjectAssets,
  narrowRelease,
  nextRevision,
  pruneReleases,
  validateProjectRelease,
} from './release-model'
import { currentAssetLists } from './project-assets'
import { getProject, projects, setPublishedRevision } from './project-store'
import { emitVersionActivity } from './version-activity'
import { activeEnvironmentOf } from '../apis/api-config'

/**
 * 项目发布快照存储。
 *
 * 目前没有后端，存储落在 localStorage；接服务端时只需替换本文件的读写实现，
 * 与 `workflows/flow-store.ts`、`projects/project-store.ts` 是同一种取舍。
 *
 * 「发布」在这里等于：汇总校验通过 → 把当前项目内容拷成一份不可变快照 → 把项目记录
 * 上的线上版本指针移到它。「回滚」只做最后一步的反向移动，不回写任何资产记录。
 */

const STORAGE_KEY = 'lc.releases.v1'
const listeners = new Set<() => void>()

/**
 * 快照内容的深拷贝。
 *
 * 各资产 store 都是「整对象替换」，理论上不会原地改旧对象，但快照声明的是不可变，
 * 就不能靠上游的自觉：一次别名共享会让「运行 v3 的内容」跟着草稿一起变，
 * 而这种事在界面上完全看不出来。
 */
function cloneAssets(assets: ProjectReleaseAssets): ProjectReleaseAssets {
  return JSON.parse(JSON.stringify(assets)) as ProjectReleaseAssets
}

/**
 * 读档。
 *
 * 两道额外处理：一是丢掉项目已经不存在的快照（删项目时只清资产，指针与快照归这里收，
 * 否则存储里会永久留着无法从任何界面到达的内容）；二是按 `projectId#revision` 去重，
 * 同一个号指向两份内容时运行态取到哪份是随机的。
 * 剪枝也在这里做一次，手改存储塞进第六份不会绕过上限。
 */
function readStorage(): ProjectRelease[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    const seen = new Set<string>()
    const entries: ProjectRelease[] = []

    for (const item of parsed) {
      const release = narrowRelease(item)
      if (!release) continue
      if (!projects.value.some((project) => project.id === release.projectId)) continue

      const key = `${release.projectId}#${release.revision}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(release)
    }

    return pruneReleases(entries)
  } catch (error) {
    console.error('[host] 读取发布快照失败，按空列表处理', error)
    return []
  }
}

function persist(entries: readonly ProjectRelease[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch (error) {
    // 隐私模式或配额不足时只丢持久化，当前会话里的版本指针仍然可用
    console.error('[host] 保存发布快照到 localStorage 失败', error)
  }
}

const state = shallowRef<readonly ProjectRelease[]>(readStorage())

/** 快照列表；只读约定由调用方遵守，写入必须走 publishProject / setCurrentRelease */
export const releases = state

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function commit(next: readonly ProjectRelease[]): void {
  state.value = next
  persist(next)
  notify()
}

/** 某个项目的快照，按发布号升序 */
export function listReleasesOf(projectId: string): ProjectRelease[] {
  return state.value
    .filter((release) => release.projectId === projectId)
    .sort((a, b) => a.revision - b.revision)
}

/** 按发布号取一份快照 */
export function getRelease(projectId: string, revision: number): ProjectRelease | undefined {
  return state.value.find(
    (release) => release.projectId === projectId && release.revision === revision,
  )
}

/**
 * 当前线上版本的快照。
 *
 * 指针存在而快照不存在只可能是快照被剪掉或存储被手改：这里返回 undefined 让运行态
 * 明确报「没有可运行的版本」，而不是悄悄退回到最新一份——那等于回滚没生效。
 */
export function currentReleaseOf(projectId: string): ProjectRelease | undefined {
  const revision = getProject(projectId)?.publishedRevision
  if (revision === undefined) return undefined

  return getRelease(projectId, revision)
}

/**
 * 发布校验的结果清单，不做任何写入。
 *
 * 发布页要先让用户看见「为什么按钮是灰的」：闸门只在校验失败时抛错的话，
 * 页面上就只剩一个不能点的按钮和一条 toast，问题清单没人看得见。
 */
export function checkProjectRelease(projectId: string): ValidationIssue[] {
  // 校验的对象就是即将进快照的那份内容：接口展开也在这一步定下来
  return validateProjectRelease(
    collectProjectAssets(currentAssetLists(), projectId, activeEnvironmentOf(projectId)),
  )
}

/**
 * 发布当前项目内容为一个新版本。
 *
 * 校验不通过直接抛错，不进快照表：带阻断问题发布的版本打开就是坏的，
 * 而「发布成功」的提示会让人以为已经交付了。错误文案取第一条阻断原因并带上总条数，
 * 完整清单由发布页从 `checkProjectRelease` 自己渲染。
 *
 * @throws 项目不存在、或存在阻断问题时抛错，文案可直接展示给用户
 */
export function publishProject(projectId: string): ProjectRelease {
  const project = getProject(projectId)
  if (!project) throw new Error(`[host] 待发布的项目不存在: ${projectId}`)

  const assets = collectProjectAssets(
    currentAssetLists(),
    projectId,
    activeEnvironmentOf(projectId),
  )
  const issues = validateProjectRelease(assets)
  if (hasBlockingIssue(issues)) {
    const blocking = issues.filter((issue) => issue.severity === 'error')
    const first = blocking[0]
    const more = blocking.length > 1 ? `（共 ${blocking.length} 处）` : ''
    throw new Error(`[host] 项目不能发布：${first?.message ?? '存在阻断问题'}${more}`)
  }

  const release: ProjectRelease = {
    projectId,
    revision: nextRevision(
      listReleasesOf(projectId).map((item) => item.revision),
      project.publishedRevision,
    ),
    createdAt: new Date().toISOString(),
    assets: cloneAssets(assets),
  }

  // 先落快照再移指针：反过来的话，指针更新失败会留下一个「线上指向不存在的版本」
  commit(pruneReleases([...state.value, release]))
  setPublishedRevision(projectId, release.revision)
  emitVersionActivity({ kind: 'publish', projectId, revision: release.revision })
  return release
}

/**
 * 把线上版本切到某个已发布的号（回滚）。
 *
 * 只动指针，不改资产记录：工作区里未发布的草稿被回滚盖掉是数据丢失，
 * 而「线上跑哪个版本」本来就该是一个可以随时拨回去的开关。
 *
 * @throws 快照不存在时抛错——被剪掉的旧版本要明说，而不是假装切换成功
 */
export function setCurrentRelease(projectId: string, revision: number): ProjectRelease {
  const release = getRelease(projectId, revision)
  if (!release) {
    throw new Error(`[host] v${revision} 不存在：可能已被剪掉，只能切到版本表里列出的版本`)
  }

  setPublishedRevision(projectId, revision)
  return release
}

/** 订阅快照列表变更；返回注销句柄 */
export function onReleasesChange(listener: () => void): Disposable {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}
