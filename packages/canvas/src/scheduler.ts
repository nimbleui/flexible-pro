import type { Disposable } from '@lc/kernel'
import type { SchedulerService } from '@lc/contracts'

/** 调度器句柄：契约之外额外提供销毁入口，由画布内核托管 */
export interface SchedulerHandle extends SchedulerService {
  /**
   * 取消未执行的帧任务并清空监听。
   *
   * 幂等；之后 `nextFrame` / `onFrame` 仍可调用但任务不会再执行，因为帧请求
   * 已在 disposed 处短路。销毁前已进入队列的监听不会再收到回调。
   */
  dispose(): void
}

/** 无 rAF 环境（Node 测试）下的近似帧间隔，按 60fps 取值 */
const FALLBACK_FRAME_MS = 16

/** rAF 兜底超时：后台标签页与无头环境会暂停 rAF，不能只依赖它 */
const RAF_GUARD_MS = 120

/**
 * 创建 rAF 调度器。
 *
 * 一帧最多执行一批任务与一次帧通知，避免 pointermove 期间多次写 DOM。
 * 浏览器暂停 rAF（后台标签、无头自动化）时由定时器兜底提交，
 * 保证视口矩阵与覆盖层即使在被节流的环境下也能收敛。
 */
export function createScheduler(): SchedulerHandle {
  const hasRaf = typeof requestAnimationFrame === 'function'
  const tasks = new Set<() => void>()
  const listeners = new Set<() => void>()

  let rafId: number | null = null

  // 浏览器返回 number，Node（测试环境）返回 Timeout，取两者并集
  let timerId: ReturnType<typeof setTimeout> | null = null

  // disposed 后不再接受任何帧请求，也不会有回调再进入用户代码
  let disposed = false

  /** 同时清掉 rAF 与兜底定时器，两者总是成对申请、成对取消。 */
  function clearScheduled(): void {
    if (rafId !== null && hasRaf) cancelAnimationFrame(rafId)
    if (timerId !== null) clearTimeout(timerId)
    rafId = null
    timerId = null
  }

  /**
   * 申请一次帧执行，同一帧内重复调用只保留一个待执行任务。
   *
   * 有 rAF 时同时挂一个 RAF_GUARD_MS 兜底定时器：谁先触发谁执行 tick，另一个
   * 立刻被取消，因此后台标签页被节流到 0 帧时状态仍会收敛，前台也不会重复执行。
   * 判空统一用 `!== null` 而不是真值判断：帧句柄是规范允许的非负数，取 0 时
   * 真值判断会误认为「尚未排队」而重复申请一帧。
   */
  function requestFrame(): void {
    if (disposed || rafId !== null || timerId !== null) return

    if (hasRaf) {
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (timerId !== null) {
          clearTimeout(timerId)
          timerId = null
        }
        tick()
      })
      timerId = setTimeout(() => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId)
          rafId = null
        }
        timerId = null
        tick()
      }, RAF_GUARD_MS)
      return
    }

    timerId = setTimeout(() => {
      timerId = null
      tick()
    }, FALLBACK_FRAME_MS)
  }

  /**
   * 执行一帧：先跑本轮排队的写任务，再通知帧监听。
   *
   * 任务集合在执行前已快照并清空，所以任务内部再 `nextFrame` 会排到下一帧，
   * 不会在同一帧自旋。单个任务或监听抛错只记录日志，同批其余回调与后续帧
   * 不受影响——一个覆盖层出错不应让整块画布停止刷新。
   */
  function tick(): void {
    if (disposed) return

    const currentTasks = [...tasks]
    tasks.clear()
    for (const task of currentTasks) {
      try {
        task()
      } catch (error) {
        console.error('[canvas] 帧任务执行失败', error)
      }
    }

    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[canvas] 帧监听执行失败', error)
      }
    }
  }

  return {
    invalidateViewport(): void {
      requestFrame()
    },

    invalidateLayer(): void {
      // 骨架阶段所有覆盖层共用一次帧通知；单层脏标记保留给后续按层重绘
      // 因此契约上的 id 在此被忽略，传任意 id 效果相同
      requestFrame()
    },

    /**
     * 追加一个本帧写任务。
     *
     * tasks 是 Set：同一函数重复登记只执行一次；返回的 Disposable 只撤销本次
     * 登记，撤销同一函数会影响其它登记方。销毁后登记的 task 永不执行。
     */
    nextFrame(task): Disposable {
      tasks.add(task)
      requestFrame()
      return { dispose: () => tasks.delete(task) }
    },

    /** 每帧回调；多次调用会累加，且在同一帧内按注册顺序执行。 */
    onFrame(listener): Disposable {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },

    dispose(): void {
      disposed = true
      clearScheduled()
      tasks.clear()
      listeners.clear()
    },
  }
}
