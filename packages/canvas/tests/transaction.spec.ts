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

function createFakeDocument(): DocumentService & { history: string[] } {
  let schema = createSchema()
  let dirty = false
  const listeners = new Set<(model: DocumentService['model']) => void>()
  const history: string[] = []

  const notify = (): void => {
    const model = { id: 'doc', title: 'doc', schema, version: 1, dirty }
    for (const listener of [...listeners]) listener(model)
  }

  return {
    history,

    get model() {
      return { id: 'doc', title: 'doc', schema, version: 1, dirty }
    },

    apply(patches: readonly SchemaPatch[], options = {}) {
      const record = options.record ?? true
      schema = applySchemaPatches(schema, patches)
      if (record) {
        dirty = true
        history.push(options.label ?? '')
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

  it('提交后只产生一条历史，并在恢复基线上重放最终 patch', () => {
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
