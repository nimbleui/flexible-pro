import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@lc/kernel'
import type { Context } from '@lc/kernel'
import { installContextServices } from '@lc/contracts'
import type {
  CanvasService,
  DocumentService,
  HistoryService,
  SchemaPatch,
  SelectionService,
} from '@lc/contracts'
import type { PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import documentPlugin from '../../service-document/src/index'
import historyPlugin from '../../service-history/src/index'
import selectionPlugin from '../../service-selection/src/index'
import canvasCorePlugin from '../src/index'

/**
 * 集成闭环：四个真实插件装进同一个内核 Context，document / history / selection
 * / canvas.transaction 全部是生产实现，没有一份 fake。
 *
 * packages/canvas/tests/transaction.spec.ts 用 createFakeDocument 覆盖了事务语义，
 * 但那个假实现把 model.version 硬编码为 1、apply 从不变动 version，因此 version
 * 语义与真实历史接线在既有体系中不可观测。本文件把关键场景用真实装配重跑一遍。
 */
const createdApps: Context[] = []

afterEach(() => {
  // canvas-core 的 scheduler 会挂 16ms 兜底定时器；销毁 app 会级联 dispose 掉它
  for (const app of createdApps) app.dispose()
  createdApps.length = 0
})

async function createCanvasRealm(): Promise<{
  document: DocumentService
  history: HistoryService
  selection: SelectionService
  canvas: CanvasService
  app: Context
}> {
  installContextServices()
  const app = createApp({
    grants: {
      'service-document': ['document'],
      'service-history': ['history'],
      'service-selection': ['selection'],
      'service-canvas-core': ['canvas'],
    },
  })
  createdApps.push(app)

  app.plugin(documentPlugin, { id: 'doc-1', schema: createSchema(), mode: 'edit' })
  await app.runtime.whenIdle()
  app.plugin(historyPlugin)
  app.plugin(selectionPlugin)
  await app.runtime.whenIdle()
  app.plugin(canvasCorePlugin)
  await app.runtime.whenIdle()

  return {
    app,
    document: app.require<DocumentService>('document'),
    history: app.require<HistoryService>('history'),
    selection: app.require<SelectionService>('selection'),
    canvas: app.require<CanvasService>('canvas'),
  }
}

function createSchema(): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        componentName: 'Box',
        layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 100, height: 50 } },
      },
    },
    components: [],
  }
}

function moveX(value: number): SchemaPatch {
  return { op: 'replace', path: '/nodes/root/layout/rect/x', value }
}

function setWidth(value: number): SchemaPatch {
  return { op: 'replace', path: '/nodes/root/layout/rect/width', value }
}

function xOf(document: DocumentService): number | undefined {
  return document.model.schema.nodes.root?.layout?.rect?.x
}

function widthOf(document: DocumentService): number | undefined {
  return document.model.schema.nodes.root?.layout?.rect?.width
}

describe('画布事务集成闭环（真实 document + history + canvas-core）', () => {
  it('装配接线成立：canvas.transaction / selection / scene 都来自真实实现', async () => {
    const { document, selection, canvas } = await createCanvasRealm()

    expect(canvas.transaction).toBeDefined()
    expect(canvas.selection).toBe(selection)
    expect(canvas.scene.list()).toContain('root')
    expect(document.model.version).toBe(1)
  })

  it('预览不进历史、不标脏，但 version 仍自增；cancel 回到手势前的原对象', async () => {
    const { document, history, canvas } = await createCanvasRealm()
    const base = document.model.schema
    const startVersion = document.model.version

    const tx = canvas.transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
    tx.preview([moveX(40)])

    expect(xOf(document)).toBe(40)
    expect(history.list()).toHaveLength(0)
    expect(history.canUndo).toBe(false)
    expect(document.model.dirty).toBe(false)
    // 真实 document：record:false 也自增 version（fake document 观测不到）
    expect(document.model.version).toBe(startVersion + 1)

    tx.cancel()

    expect(document.model.schema).toBe(base)
    expect(xOf(document)).toBe(0)
    expect(history.list()).toHaveLength(0)
    expect(document.model.dirty).toBe(false)
    expect(document.model.version).toBe(startVersion + 2)
    expect(tx.closed).toBe(true)
  })

  it('提交只产生一条历史，最终 patch 落在当前文档上', async () => {
    const { document, history, canvas } = await createCanvasRealm()

    const tx = canvas.transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
    tx.preview([moveX(20)])
    tx.preview([moveX(35)])
    tx.preview([moveX(60)])
    tx.commit()

    expect(xOf(document)).toBe(60)
    expect(history.list().map((entry) => entry.label)).toEqual(['移动节点'])
    expect(document.model.dirty).toBe(true)
    expect(tx.closed).toBe(true)
  })

  it('关键不变量：commit 不先 restore(base) 再重放，保留手势期间别处的写入', async () => {
    const { document, history, canvas } = await createCanvasRealm()
    const base = document.model.schema

    const tx = canvas.transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
    tx.preview([moveX(60)])
    // 属性面板在手势期间改了同一节点的宽度：先 restore(base) 会把它一起抹掉
    document.apply([setWidth(220)], { record: false })
    tx.commit()

    expect(document.model.schema.nodes.root?.layout?.rect).toMatchObject({
      x: 60,
      width: 220,
    })
    expect(history.list()).toHaveLength(1)

    // 历史的 before 仍是手势前快照：undo 回到 base（宽度回到 100，这是已登记的代价）
    history.undo()
    expect(document.model.schema).toBe(base)
    expect(xOf(document)).toBe(0)
    expect(widthOf(document)).toBe(100)

    // redo 回到提交后的最终态，其中也含并发写入
    history.redo()
    expect(xOf(document)).toBe(60)
    expect(widthOf(document)).toBe(220)
  })

  it('同一 path 上手势的最后一次预览胜出', async () => {
    const { document, history, canvas } = await createCanvasRealm()

    const tx = canvas.transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
    tx.preview([moveX(60)])
    document.apply([moveX(99)], { record: false })
    tx.preview([moveX(70)])
    tx.commit()

    expect(xOf(document)).toBe(70)
    expect(history.list()).toHaveLength(1)
  })

  it('没有预览写入时 commit 只回退、不产生历史', async () => {
    const { document, history, canvas } = await createCanvasRealm()

    const tx = canvas.transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
    document.apply([moveX(88)], { record: false })
    tx.commit()

    expect(xOf(document)).toBe(0)
    expect(history.list()).toHaveLength(0)
    expect(history.canUndo).toBe(false)
    expect(document.model.dirty).toBe(false)
  })

  it('同一时刻只允许一个活动事务；cancel/commit 通过 canvas:gestureEnd 广播', async () => {
    const { app, canvas } = await createCanvasRealm()
    const events: Array<{ owner: string; label: string; committed: boolean }> = []
    const subscription = app.on('canvas:gestureEnd', (info) =>
      events.push({ owner: info.owner, label: info.label, committed: info.committed }),
    )

    const tx = canvas.transaction.begin({ label: '框选', owner: 'canvas-selection' })
    expect(() => canvas.transaction.begin({ label: '缩放', owner: 'canvas-resize' })).toThrow(
      /活动事务/,
    )

    tx.cancel()
    expect(events).toEqual([{ owner: 'canvas-selection', label: '框选', committed: false }])
    expect(() =>
      canvas.transaction.begin({ label: '缩放', owner: 'canvas-resize' }),
    ).not.toThrow()

    subscription.dispose()
  })

  it('commit 广播 committed=true，且结束后可以立即开始下一次手势', async () => {
    const { app, document, history, canvas } = await createCanvasRealm()
    const events: Array<{ owner: string; label: string; committed: boolean }> = []
    const subscription = app.on('canvas:gestureEnd', (info) =>
      events.push({ owner: info.owner, label: info.label, committed: info.committed }),
    )

    const first = canvas.transaction.begin({ label: '第一次', owner: 'p' })
    first.preview([moveX(10)])
    first.commit()
    expect(events).toEqual([{ owner: 'p', label: '第一次', committed: true }])

    const second = canvas.transaction.begin({ label: '第二次', owner: 'p' })
    second.preview([moveX(20)])
    second.commit()

    expect(xOf(document)).toBe(20)
    expect(history.list().map((entry) => entry.label)).toEqual(['第一次', '第二次'])
    subscription.dispose()
  })

  it('version 在预览 / 提交 / 撤销 / 重做全链路中严格单调递增', async () => {
    const { document, history, canvas } = await createCanvasRealm()
    const versions: number[] = [document.model.version]
    const track = (): void => {
      versions.push(document.model.version)
    }

    const tx = canvas.transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
    tx.preview([moveX(30)])
    track()
    tx.preview([moveX(50)])
    track()
    tx.commit()
    track()
    history.undo()
    track()
    history.redo()
    track()

    for (let index = 1; index < versions.length; index += 1) {
      expect(versions[index]).toBeGreaterThan(versions[index - 1] as number)
    }
  })

  it('真实历史闭环：一次拖拽 = 一条历史，undo 回到手势开始前，redo 恢复', async () => {
    const { document, history, canvas } = await createCanvasRealm()
    const base = document.model.schema

    const tx = canvas.transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
    tx.preview([moveX(10)])
    tx.preview([moveX(20)])
    tx.preview([moveX(30)])
    tx.commit()

    expect(history.list()).toHaveLength(1)
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)

    history.undo()
    expect(document.model.schema).toBe(base)
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(true)

    history.redo()
    expect(xOf(document)).toBe(30)
    expect(history.canUndo).toBe(true)
  })

  it('迟到的事务句柄在关闭后静默失效，不再改文档也不再写历史', async () => {
    const { document, history, canvas } = await createCanvasRealm()

    const tx = canvas.transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
    tx.commit()
    const versionAfterClose = document.model.version

    tx.preview([moveX(999)])
    tx.commit()
    tx.cancel()

    expect(xOf(document)).toBe(0)
    expect(document.model.version).toBe(versionAfterClose)
    expect(history.list()).toHaveLength(0)
    expect(document.model.dirty).toBe(false)
  })
})
