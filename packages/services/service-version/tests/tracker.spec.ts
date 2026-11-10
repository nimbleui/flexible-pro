import { describe, expect, it, vi } from 'vitest'
import {
  createSectionTracker,
  type DocumentChangeSource,
  type TrackedDocument,
} from '../src/tracker'

function source() {
  let listener: ((document: TrackedDocument) => void) | undefined
  const dispose = vi.fn()
  const changeSource: DocumentChangeSource = {
    onDidChange(next) {
      listener = next
      return { dispose }
    },
  }

  return {
    changeSource,
    emit: (document: TrackedDocument) => listener?.(document),
    dispose,
  }
}

// tracker 按引用判等（见 src/tracker.ts）：未改写的 section 必须复用同一引用，
// 否则测试构造数据本身就会把「只改了 nodes」写成「nodes/actions/route 全变」。
const SHARED_ACTIONS = { a1: 1 }
const SHARED_ROUTE = { path: '/home' }

const doc = (
  id: string,
  nodes: unknown,
  actions: unknown = SHARED_ACTIONS,
): TrackedDocument => ({
  id,
  schema: { nodes, actions, route: SHARED_ROUTE },
})

describe('section tracker', () => {
  it('首次观察只建立基线，不把打开文档算成编辑', () => {
    const { changeSource, emit } = source()
    const tracker = createSectionTracker(changeSource)

    emit(doc('p1', { n1: 1 }))
    expect(tracker.hasChanges()).toBe(false)
    expect(tracker.takeChanges()).toEqual({ sections: {} })
  })

  it('只记录引用变化的顶层 section', () => {
    const { changeSource, emit } = source()
    const tracker = createSectionTracker(changeSource)
    const before = doc('p1', { n1: 1 })
    const sharedActions = before.schema.actions
    const sharedRoute = before.schema.route

    emit(before)
    emit({
      id: 'p1',
      schema: { nodes: { n1: 2 }, actions: sharedActions, route: sharedRoute },
    })

    expect(tracker.hasChanges()).toBe(true)
    expect(tracker.peekChanges()).toEqual({ sections: { p1: ['nodes'] } })
  })

  it('新增与删除顶层字段也算变更', () => {
    const { changeSource, emit } = source()
    const tracker = createSectionTracker(changeSource)

    const nodes = {}
    emit({ id: 'p1', schema: { nodes } })
    emit({ id: 'p1', schema: { nodes, variables: [] } })
    expect(tracker.peekChanges()).toEqual({ sections: { p1: ['variables'] } })

    emit({ id: 'p1', schema: {} })
    expect(tracker.peekChanges().sections.p1).toEqual(['nodes', 'variables'])
  })

  it('多文档各自累积，takeChanges 后清空但保留基线', () => {
    const { changeSource, emit } = source()
    const tracker = createSectionTracker(changeSource)

    const p1After = { n1: 9 }
    const p2After = { n2: 9 }
    emit(doc('p1', { n1: 1 }))
    emit(doc('p2', { n2: 1 }))
    emit(doc('p1', p1After))
    emit(doc('p2', p2After))

    expect(tracker.takeChanges()).toEqual({ sections: { p1: ['nodes'], p2: ['nodes'] } })
    expect(tracker.hasChanges()).toBe(false)

    // 内容与上一次完全相同（含引用），不应被重新记成编辑
    emit(doc('p1', p1After))
    expect(tracker.hasChanges()).toBe(false)
  })

  it('reset 作废基线，dispose 注销订阅', () => {
    const { changeSource, emit, dispose } = source()
    const tracker = createSectionTracker(changeSource)

    emit(doc('p1', { n1: 1 }))
    emit(doc('p1', { n1: 2 }))
    expect(tracker.hasChanges()).toBe(true)

    tracker.reset()
    expect(tracker.hasChanges()).toBe(false)
    emit(doc('p2', { n2: 1 }))
    expect(tracker.hasChanges()).toBe(false)

    tracker.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
