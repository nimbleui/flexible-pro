import { describe, expect, it, vi } from 'vitest'
import { createScheduler } from '../src/scheduler'

describe('调度器', () => {
  it('帧任务与帧监听在同一批执行', async () => {
    const scheduler = createScheduler()
    const order: string[] = []
    const offFrame = scheduler.onFrame(() => order.push('frame'))
    scheduler.nextFrame(() => order.push('task'))

    scheduler.invalidateViewport()
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(order).toEqual(['task', 'frame'])
    scheduler.dispose()
    offFrame.dispose()
  })

  it('dispose 后不再执行未提交的任务', async () => {
    const scheduler = createScheduler()
    const task = vi.fn()
    scheduler.nextFrame(task)
    scheduler.dispose()

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(task).not.toHaveBeenCalled()
  })

  it('nextFrame 返回的 disposable 可取消任务', async () => {
    const scheduler = createScheduler()
    const task = vi.fn()
    const handle = scheduler.nextFrame(task)
    handle.dispose()

    scheduler.invalidateViewport()
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(task).not.toHaveBeenCalled()
    scheduler.dispose()
  })
})
