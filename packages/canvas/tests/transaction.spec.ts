import { describe, expect, it } from 'vitest'
import type { DocumentService, SchemaPatch } from '@lc/contracts'
import { applySchemaPatches } from '@lc/schema'
import type { PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import { createTransactionService } from '../src/transaction'

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

function createFakeDocument(): DocumentService & {
  history: string[]
  records: Array<{ label: string; before: PageSchema; after: PageSchema }>
} {
  let schema = createSchema()
  let dirty = false
  const listeners = new Set<(model: DocumentService['model']) => void>()
  const history: string[] = []
  const records: Array<{ label: string; before: PageSchema; after: PageSchema }> = []

  const notify = (): void => {
    const model = { id: 'doc', title: 'doc', schema, version: 1, dirty }
    for (const listener of [...listeners]) listener(model)
  }

  return {
    history,
    records,

    get model() {
      return { id: 'doc', title: 'doc', schema, version: 1, dirty }
    },

    apply(patches: readonly SchemaPatch[], options = {}) {
      const record = options.record ?? true
      const current = schema
      schema = applySchemaPatches(current, patches)
      if (record) {
        const label = options.label ?? ''
        dirty = true
        history.push(label)
        records.push({ label, before: options.before ?? current, after: schema })
      }
      notify()
    },

    restore(next: PageSchema) {
      schema = next
      notify()
    },

    validate() {
      return []
    },

    onDidChange(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
}

function moveX(value: number): SchemaPatch {
  return { op: 'replace', path: '/nodes/root/layout/rect/x', value }
}

function setWidth(value: number): SchemaPatch {
  return { op: 'replace', path: '/nodes/root/layout/rect/width', value }
}

describe('画布事务', () => {
  it('预览不产生历史，取消后恢复原状', () => {
    const document = createFakeDocument()
    const transaction = createTransactionService({ document })

    const tx = transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
    tx.preview([moveX(40)])

    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(40)
    expect(document.history).toHaveLength(0)
    expect(document.model.dirty).toBe(false)

    tx.cancel()

    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(0)
    expect(document.history).toHaveLength(0)
    expect(tx.closed).toBe(true)
  })

  it('提交后只产生一条历史，并把最终 patch 落在当前文档上', () => {
    const document = createFakeDocument()
    const transaction = createTransactionService({ document })

    const tx = transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
    tx.preview([moveX(20)])
    tx.preview([moveX(35)])
    tx.preview([moveX(60)])
    tx.commit()

    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(60)
    expect(document.history).toEqual(['移动节点'])
    expect(document.model.dirty).toBe(true)
    expect(tx.closed).toBe(true)
  })

  it('提交保留手势期间别处的写入，历史的 before 仍是手势前的快照', () => {
    const document = createFakeDocument()
    const service = createTransactionService({ document })
    const tx = service.begin({ label: '移动节点', owner: 'canvas-drag' })

    tx.preview([moveX(60)])
    // 属性面板在手势期间改了同一节点的宽度：先 restore(base) 会把它一起抹掉
    document.apply([setWidth(220)], { record: false })
    tx.commit()

    expect(document.model.schema.nodes.root?.layout?.rect).toMatchObject({ x: 60, width: 220 })
    expect(document.records[0]?.before.nodes.root?.layout?.rect?.x).toBe(0)
    expect(document.records[0]?.after.nodes.root?.layout?.rect?.x).toBe(60)
  })

  it('同一路径上手势的最后一次预览胜出', () => {
    const document = createFakeDocument()
    const service = createTransactionService({ document })
    const tx = service.begin({ label: '移动节点', owner: 'canvas-drag' })

    tx.preview([moveX(60)])
    document.apply([moveX(99)], { record: false })
    tx.preview([moveX(70)])
    tx.commit()

    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(70)
  })

  it('没有预览写入时提交只回退，不产生历史', () => {
    const document = createFakeDocument()
    const service = createTransactionService({ document })
    const tx = service.begin({ label: '移动节点', owner: 'canvas-drag' })

    document.apply([moveX(88)], { record: false })
    tx.commit()

    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(0)
    expect(document.history).toEqual([])
  })

  it('同一时刻只允许一个活动事务', () => {
    const document = createFakeDocument()
    const transaction = createTransactionService({ document })

    const tx = transaction.begin({ label: '拖拽', owner: 'canvas-drag' })
    expect(() => transaction.begin({ label: '缩放', owner: 'canvas-resize' })).toThrow(
      /活动事务/,
    )

    tx.cancel()
    expect(() => transaction.begin({ label: '缩放', owner: 'canvas-resize' })).not.toThrow()
  })

  it('结束回调带上 owner/label/committed', () => {
    const document = createFakeDocument()
    const events: Array<{ owner: string; label: string; committed: boolean }> = []
    const transaction = createTransactionService({
      document,
      onEnd: (info) => events.push(info),
    })

    transaction.begin({ label: '框选', owner: 'canvas-selection' }).cancel()

    expect(events).toEqual([{ owner: 'canvas-selection', label: '框选', committed: false }])
  })
})
