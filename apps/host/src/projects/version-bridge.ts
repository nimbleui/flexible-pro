import type {
  Commit,
  MergeValidate,
  VersionService,
  VersionStore,
  WorkingTree,
} from '@lc/contracts'
import type { Disposable } from '@lc/kernel'
import {
  compareProjection,
  createVersionService,
  readTreeAt,
  shouldCompareProjection,
  shouldWriteVersion,
  toWorkingTree,
  type ProjectionMismatch,
  type VersionMode,
} from '@lc/service-version'
import type { ProjectReleaseAssets } from './release-model'
import { onVersionActivity, type VersionActivity } from './version-activity'
import { toVersionSnapshot } from './version-assets'

/**
 * 宿主资产 → 版本库的写入旁路。
 *
 * 依赖方向刻意单向：本模块只认识注入进来的 `readAssets` / `createStore`，不 import
 * 任何资产 store 或 Vue。这样它能在 node 环境单测，也符合 Core / Adapter 分层。
 *
 * 职责是「捕获提交 + shadow 双读比对」：
 * - `off` 完全不订阅、不创建服务，现有行为一字不改；
 * - `shadow` / `on` 在保存与发布后写一次 commit，`shadow` 额外比对对象存储读回的
 *   工作区与当前宿主资产投影，把不一致交给 `onMismatch`；
 * `readAssets` 在队列里的任务实际执行时才调用，所以同一批连续活动读到的是处理时刻
 * 的全量资产，而不是每次保存的瞬时快照：这是 checkpoint 语义，等价于把一串快速编辑
 * 合并成一次最终状态，不会漏内容，但也不会还原中间步骤。
 *
 * - **运行态读取仍走旧 `lc.*` 路径**。`writeWorkingTree` 只把检出结果交给版本视图，
 *   不回写五类资产：草稿是用户当前工作区，静默覆盖等于一次数据丢失；真正的资产
 *   替换需要各 store 提供替换 API 与冲突确认后才能启用。`shouldReadFromVersion('on')`
 *   因此暂不生效。
 * - 正因为写不回，会话以 `workingTreeReplaceable: false` 创建：内核把检出当只读查看，
 *   期间拒绝提交（否则草稿会被记到刚检出的分支上）、拒绝 `restoreDoc` 与 `merge`
 *   （合并结果写不回草稿，下一次保存就会把它撤销）。`capture` 因此在查看态会抛错，
 *   由 `onError` 收敛，不影响保存与发布本身。
 */

export interface VersionBridgeOptions {
  /** 灰度档位；由装配层从构建期变量解析，未知值一律回落 off */
  mode: VersionMode
  /** 读取某个项目当前五类资产；由装配层注入，本模块不认识任何 store */
  readAssets(projectId: string): Promise<ProjectReleaseAssets> | ProjectReleaseAssets
  /** 创建或复用版本对象存储；必须由装配层给出，Core 不自己碰浏览器 API */
  createStore(projectId: string): VersionStore
  /** 提交人缺省值 @default 'designer' */
  author?: string
  /** 时间源，便于测试；不参与 commit hash */
  now?(): string
  /** 每次捕获提交后触发；commit 为 undefined 表示内容未变、没有产生新提交 */
  onCommit?(projectId: string, commit: Commit | undefined): void
  /** shadow 比对结果；空数组表示版本库投影与旧路径一致 */
  onMismatch?(projectId: string, mismatches: ProjectionMismatch[]): void
  /** 检出结果；由只读版本视图消费它，当前只做投影 */
  onCheckout?(projectId: string, tree: WorkingTree): void
  /** 旁路失败回调；默认 console.error。版本库故障绝不抛回保存 / 发布路径 */
  onError?(projectId: string, error: unknown): void
  /** 合并校验器；由装配层包装既有 validateDocument / validateFlow 后注入 */
  validate?: MergeValidate
  /** 版本库 commit / ref / head 变化；面板与状态栏据此刷新，不参与写入链路 */
  onChange?(projectId: string): void
}

/** 单个项目的版本会话；按 projectId 懒创建并跨 Realm 共享。 */
export interface ProjectVersionSession {
  readonly projectId: string
  readonly service: VersionService
  /** 用当前宿主资产捕获一次提交；内容未变时返回 undefined */
  capture(message: string): Promise<Commit | undefined>
  /** 对象存储读回的 HEAD 工作区 vs 当前宿主资产投影 */
  compare(): Promise<ProjectionMismatch[]>
  /** 最近一次 checkout / restoreDoc 交给宿主的工作区；不回写资产 */
  checkedOutTree(): WorkingTree | undefined
}

export interface VersionBridge extends Disposable {
  readonly mode: VersionMode
  /** 按项目取会话；暴露给单测与版本面板 */
  session(projectId: string): Promise<ProjectVersionSession>
  /** 直接处理一次活动；信号订阅已自动串行化，测试可绕过信号单独调用 */
  handle(activity: VersionActivity): Promise<void>
}

/**
 * 创建版本旁路并订阅宿主活动信号。
 *
 * 订阅回调把工作排进一条 Promise 链：连续 `Ctrl+S` / 快速发布会让 `casRef` 撞到
 * 同一个旧 HEAD 而报 conflict，串行化后后一次提交自然接在前一次之后。链上任何
 * 失败都被 `onError` 消费，不会让队列永久卡在 rejected 状态。
 *
 * @returns 含 `dispose()` 的句柄；HMR 或测试卸载时必须调用，否则会重复订阅
 */
export function createVersionBridge(options: VersionBridgeOptions): VersionBridge {
  const mode = options.mode
  const sessions = new Map<string, Promise<ProjectVersionSession>>()
  const sessionDisposables: Disposable[] = []
  let queue: Promise<void> = Promise.resolve()

  // 一次 commit() 会同步连发 commit / ref / head 三个事件，merge() 与 checkout 同样。
  // 面板那侧有 Vue watcher 自己去重，状态栏却是直接在监听器里读 head，不合并就跑三遍。
  // 用微任务而不是 rAF：三个事件本来就是同步连发，微任务足够收敛，且 node 环境可测。
  const pendingChange = new Set<string>()
  let changeScheduled = false

  function scheduleChange(projectId: string): void {
    pendingChange.add(projectId)
    if (changeScheduled) return
    changeScheduled = true

    queueMicrotask(() => {
      changeScheduled = false
      for (const id of [...pendingChange]) {
        pendingChange.delete(id)
        options.onChange?.(id)
      }
    })
  }

  function report(projectId: string, error: unknown): void {
    if (options.onError) options.onError(projectId, error)
    else console.error(`[host] 版本库旁路失败 (${projectId})`, error)
  }

  function workingTreeOf(projectId: string): Promise<WorkingTree> {
    return Promise.resolve(options.readAssets(projectId)).then((assets) =>
      toWorkingTree(toVersionSnapshot(assets)),
    )
  }

  function createSession(projectId: string): Promise<ProjectVersionSession> {
    const store = options.createStore(projectId)
    let checkedOut: WorkingTree | undefined

    return createVersionService(store, {
      repoId: projectId,
      author: options.author ?? 'designer',
      now: options.now,
      validate: options.validate,
      // 宿主的 writeWorkingTree 只把树交给只读版本视图，草稿资产原封不动。声明为 false
      // 后内核会把检出当作只读查看：不持久化 HEAD、拒绝 restoreDoc / merge，并在查看态
      // 下拒绝提交——否则一次保存就会把切出前的草稿记到刚检出的分支上。
      workingTreeReplaceable: false,
      readWorkingTree: () => workingTreeOf(projectId),
      writeWorkingTree: (tree) => {
        checkedOut = tree
        options.onCheckout?.(projectId, tree)
      },
    }).then((service): ProjectVersionSession => {
      // 服务事件是 UI 刷新的唯一来源：提交、ref 移动、检出都会触发。
      // 订阅挂在 bridge 级数组上，dispose 时与活动信号一起回收。
      sessionDisposables.push(service.onDidChange(() => scheduleChange(projectId)))

      return {
        projectId,
        service,

        capture(message: string) {
          return service.commit({ message })
        },

        async compare() {
          const legacy = await workingTreeOf(projectId)
          const head = service.head.commit
          if (head === '') return compareProjection({}, legacy)

          const commit = await store.getCommit(projectId, head)
          if (!commit) throw new Error(`[host] HEAD 提交不存在: ${head}`)

          return compareProjection(await readTreeAt(store, projectId, commit.tree), legacy)
        },

        checkedOutTree: () => checkedOut,
      }
    })
  }

  function session(projectId: string): Promise<ProjectVersionSession> {
    let found = sessions.get(projectId)
    if (!found) {
      found = createSession(projectId)
      sessions.set(projectId, found)
      // 创建失败时清掉缓存，否则后续永远拿到同一个 rejected promise
      void found.catch(() => sessions.delete(projectId))
    }

    return found
  }

  async function handle(activity: VersionActivity): Promise<void> {
    if (!shouldWriteVersion(mode)) return

    const current = await session(activity.projectId)
    const message =
      activity.kind === 'save' ? `保存页面 ${activity.docId}` : `发布 v${activity.revision}`
    const commit = await current.capture(message)
    options.onCommit?.(activity.projectId, commit)

    if (shouldCompareProjection(mode)) {
      options.onMismatch?.(activity.projectId, await current.compare())
    }
  }

  const subscription = onVersionActivity((activity) => {
    queue = queue
      .then(() => handle(activity))
      .catch((error: unknown) => report(activity.projectId, error))
    void queue
  })

  return {
    mode,
    session,
    handle,

    dispose() {
      subscription.dispose()
      for (const disposable of sessionDisposables.splice(0)) disposable.dispose()
      sessions.clear()
      // 已排队的微任务会照常跑，但集合已空，不会通知到已卸载的订阅者
      pendingChange.clear()
    },
  }
}
