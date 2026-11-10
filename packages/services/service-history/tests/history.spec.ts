import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@lc/kernel'
import type { Context } from '@lc/kernel'
import { installContextServices } from '@lc/contracts'
import type { DocumentService, HistoryService, SchemaPatch } from '@lc/contracts'
import type { PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import documentPlugin from '../../service-document/src/index'
import historyPlugin from '../src/index'

/**
 * 真实 document + 真实 history 的装配。
 *
 * 这里刻意不 mock document：撤销/重做是否真的把「历史里存的那份 schema 引用」
 * 交回文档，只有用生产 document 才能观测到。
 */
async function createRealm(): Promise<{
  app: Context
  document: DocumentService
  history: HistoryService
}> {
  installContextServices()
  const app = createApp({
    grants: {
      'service-document': ['document'],
      'service-history': ['history'],
    },
  })

  app.plugin(documentPlugin, { id: 'doc-1', schema: createSchema(), mode: 'edit' })
  await app.runtime.whenIdle()
  app.plugin(historyPlugin)
  await app.runtime.whenIdle()

  return {
    app,
    document: app.require<DocumentService>('document'),
    history: app.require<HistoryService>('history'),
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

function xOf(document: DocumentService): number | undefined {
  return document.model.schema.nodes.root?.layout?.rect?.x
}

describe('service-history：撤销/重做栈（真实 document + history）', () => {
  it('空栈：canUndo/canRedo 为 false，undo/redo 静默返回且不改动文档', async () => {
    const { app, document, history } = await createRealm()
    const before = document.model.schema
    const version = document.model.version

    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    expect(history.list()).toEqual([])

    history.undo()
    history.redo()

    expect(document.model.schema).toBe(before)
    expect(document.model.version).toBe(version)
    expect(document.model.dirty).toBe(false)

    app.dispose()
  })

  it('record 只存引用：undo/redo 交回的正是写入时的 before/after 对象', async () => {
    const { app, document, history } = await createRealm()
    const base = document.model.schema

    document.apply([moveX(10)], { record: true, label: 'A' })
    const afterA = document.model.schema
    document.apply([moveX(20)], { record: true, label: 'B' })
    const afterB = document.model.schema

    history.undo()
    expect(document.model.schema).toBe(afterA)
    expect(xOf(document)).toBe(10)

    history.undo()
    expect(document.model.schema).toBe(base)
    expect(xOf(document)).toBe(0)

    history.redo()
    expect(document.model.schema).toBe(afterA)

    history.redo()
    expect(document.model.schema).toBe(afterB)

    app.dispose()
  })

  it('list() 按旧→新列出可撤销条目，不含 redo 分支', async () => {
    const { app, document, history } = await createRealm()

    document.apply([moveX(1)], { record: true, label: 'A' })
    document.apply([moveX(2)], { record: true, label: 'B' })
    expect(history.list().map((entry) => entry.label)).toEqual(['A', 'B'])
    expect(history.canRedo).toBe(false)

    history.undo()
    expect(history.list().map((entry) => entry.label)).toEqual(['A'])
    expect(history.canRedo).toBe(true)

    // redo 分支不进 list()
    expect(history.list()).toHaveLength(1)

    app.dispose()
  })

  it('历史元信息包含唯一 id、label 与毫秒时间戳', async () => {
    const { app, document, history } = await createRealm()

    document.apply([moveX(1)], { record: true, label: '第一条' })
    document.apply([moveX(2)], { record: true, label: '第二条' })

    const entries = history.list()
    expect(entries).toHaveLength(2)
    expect(entries[0]?.id).not.toBe(entries[1]?.id)
    expect(entries.map((entry) => entry.label)).toEqual(['第一条', '第二条'])
    for (const entry of entries) {
      expect(typeof entry.timestamp).toBe('number')
    }

    app.dispose()
  })

  it('撤销后再写入会截断 redo 分支，redo() 变成空操作', async () => {
    const { app, document, history } = await createRealm()

    document.apply([moveX(1)], { record: true, label: 'A' })
    document.apply([moveX(2)], { record: true, label: 'B' })
    history.undo()
    expect(history.canRedo).toBe(true)

    document.apply([moveX(30)], { record: true, label: 'C' })

    expect(history.canRedo).toBe(false)
    expect(history.list().map((entry) => entry.label)).toEqual(['A', 'C'])
    const current = document.model.schema
    history.redo()
    expect(document.model.schema).toBe(current)
    expect(xOf(document)).toBe(30)

    app.dispose()
  })

  it('当前实现不设栈深上限：连续 60 条记录全部保留且不抛错', async () => {
    const { app, document, history } = await createRealm()

    // 评审共识里提到的「栈深上限」在当前实现中并不存在（见 docs/07-services.md:229
    // 「不设栈深上限」与 service-history/src/index.ts:53 注释）。本用例钉住这一现状：
    // 若未来引入上限，这条断言会失败，提醒同步修订文档与内存治理策略。
    for (let index = 0; index < 60; index += 1) {
      document.apply([moveX(index)], { record: true, label: `edit-${index}` })
    }

    expect(history.list()).toHaveLength(60)
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
    expect(xOf(document)).toBe(59)

    app.dispose()
  })

  it('onDidChange 在 record / undo / redo 各通知一次；空栈操作不通知', async () => {
    const { app, document, history } = await createRealm()
    const listener = vi.fn()
    const subscription = history.onDidChange(listener)

    history.undo()
    expect(listener).not.toHaveBeenCalled()

    document.apply([moveX(1)], { record: true })
    expect(listener).toHaveBeenCalledTimes(1)

    history.undo()
    expect(listener).toHaveBeenCalledTimes(2)

    history.redo()
    expect(listener).toHaveBeenCalledTimes(3)

    subscription.dispose()
    document.apply([moveX(2)], { record: true })
    expect(listener).toHaveBeenCalledTimes(3)

    app.dispose()
  })

  it('撤销/重做不改变 dirty，且 version 依然自增', async () => {
    const { app, document, history } = await createRealm()

    document.apply([moveX(1)], { record: true })
    expect(document.model.dirty).toBe(true)
    const versionAfterCommit = document.model.version

    history.undo()
    expect(document.model.dirty).toBe(true)
    expect(document.model.version).toBe(versionAfterCommit + 1)

    history.redo()
    expect(document.model.dirty).toBe(true)
    expect(document.model.version).toBe(versionAfterCommit + 2)

    app.dispose()
  })
})
