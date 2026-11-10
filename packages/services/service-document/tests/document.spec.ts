import { describe, expect, it } from 'vitest'
import { createApp } from '@lc/kernel'
import type { Context, PluginRecord } from '@lc/kernel'
import { installContextServices } from '@lc/contracts'
import type { DocumentService, HistoryService, SchemaPatch } from '@lc/contracts'
import type { DocumentModel } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import type { PageSchema } from '@lc/schema'
import documentPlugin from '../src/index'
import historyPlugin from '../../service-history/src/index'

/**
 * 真实装配：把 document / history 两个插件装进同一个内核 Context。
 *
 * 与 packages/canvas/tests/transaction.spec.ts 的 createFakeDocument 不同，这里不伪造
 * 任何 document 行为——version、dirty、结构共享与历史接线都来自生产实现，因此
 * version 语义在本文件是可观测的。
 */
async function createRealm(
  options: { mode?: 'edit' | 'preview'; schema?: PageSchema } = {},
): Promise<{ app: Context; document: DocumentService; history: HistoryService }> {
  installContextServices()
  const app = createApp({
    grants: {
      'service-document': ['document'],
      'service-history': ['history'],
    },
  })

  // 先让 document 进入 active，再挂 history（history 的 inject 依赖 document）
  app.plugin(documentPlugin, {
    id: 'doc-1',
    schema: options.schema ?? createSchema(),
    title: '测试文档',
    mode: options.mode ?? 'edit',
  })
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
      other: {
        id: 'other',
        componentName: 'Box',
        layout: { mode: 'absolute', rect: { x: 5, y: 5, width: 20, height: 20 } },
      },
    },
    components: [],
  }
}

function moveX(value: number): SchemaPatch {
  return { op: 'replace', path: '/nodes/root/layout/rect/x', value }
}

describe('service-document：唯一写入口与 version/dirty 语义（真实装配）', () => {
  it('初始模型 version=1、dirty=false，且初始 schema 是入参的深拷贝', async () => {
    const input = createSchema()
    const { app, document } = await createRealm({ schema: input })

    expect(document.model.version).toBe(1)
    expect(document.model.dirty).toBe(false)
    expect(document.model.id).toBe('doc-1')
    expect(document.model.title).toBe('测试文档')

    // createDocument 会整体克隆：宿主之后改原对象不影响文档内容
    const rootRect = input.nodes.root?.layout?.rect
    if (rootRect) rootRect.x = 999
    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(0)
    expect(document.model.schema).not.toBe(input)

    app.dispose()
  })

  it('apply 是不可变更新：只克隆路径上的容器，未触及分支保持引用共享', async () => {
    const { app, document } = await createRealm()
    const before = document.model.schema
    const otherNode = before.nodes.other
    const components = before.components
    const otherRect = before.nodes.other?.layout?.rect

    document.apply([moveX(40)])

    const after = document.model.schema
    expect(after).not.toBe(before)
    expect(after.nodes.root?.layout?.rect?.x).toBe(40)
    // 原对象没有被就地改动：历史里存 before 引用才安全
    expect(before.nodes.root?.layout?.rect?.x).toBe(0)
    // patch.ts 的 applyAt 只展开路径容器，兄弟节点与顶层数组仍是同一引用
    expect(after.nodes.other).toBe(otherNode)
    expect(after.nodes.other?.layout?.rect).toBe(otherRect)
    expect(after.components).toBe(components)

    app.dispose()
  })

  it('record:false 仍自增 version 且 dirty 不变（干净文档）', async () => {
    const { app, document, history } = await createRealm()

    document.apply([moveX(10)], { record: false })

    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(10)
    expect(document.model.version).toBe(2)
    expect(document.model.dirty).toBe(false)
    expect(history.canUndo).toBe(false)
    expect(history.list()).toHaveLength(0)

    app.dispose()
  })

  it('record:false 不改已脏文档的 dirty；record:true 才置脏并写一条历史', async () => {
    const { app, document, history } = await createRealm()

    document.apply([moveX(10)], { record: true, label: '首次编辑' })
    expect(document.model.dirty).toBe(true)
    expect(history.list().map((entry) => entry.label)).toEqual(['首次编辑'])

    const versionBeforePreview = document.model.version
    document.apply([moveX(20)], { record: false })

    expect(document.model.version).toBe(versionBeforePreview + 1)
    expect(document.model.dirty).toBe(true)
    expect(history.list()).toHaveLength(1)

    app.dispose()
  })

  it('history 只存引用：undo/redo 把 before/after 原对象交回 document', async () => {
    const { app, document, history } = await createRealm()
    const before = document.model.schema

    document.apply([moveX(30)], { record: true, label: '移动节点' })
    const after = document.model.schema
    expect(after).not.toBe(before)

    history.undo()
    expect(document.model.schema).toBe(before)
    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(0)
    expect(document.model.dirty).toBe(true)

    history.redo()
    expect(document.model.schema).toBe(after)
    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(30)

    app.dispose()
  })

  it('preview 模式在写入口拦截：record:true 与 record:false 的 apply 都抛错', async () => {
    const { app, document, history } = await createRealm({ mode: 'preview' })

    expect(() => document.apply([moveX(10)])).toThrow(/只读文档不允许写入/)
    expect(() => document.apply([moveX(10)], { record: false })).toThrow(/只读文档不允许写入/)
    expect(document.model.version).toBe(1)
    expect(document.model.dirty).toBe(false)
    expect(history.canUndo).toBe(false)

    // 实现只拦截 apply：restore 与读取不受影响（DocumentPluginConfig.mode 注释已声明）
    document.restore(createSchema())
    expect(document.model.version).toBe(2)
    expect(history.canUndo).toBe(false)

    app.dispose()
  })

  it('restore 递增 version、不写历史、不动 dirty', async () => {
    const { app, document, history } = await createRealm()
    document.apply([moveX(10)], { record: true })
    const versionAfterCommit = document.model.version

    document.restore(createSchema())

    expect(document.model.version).toBe(versionAfterCommit + 1)
    expect(document.model.dirty).toBe(true)
    expect(history.list()).toHaveLength(1)
    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(0)

    app.dispose()
  })

  it('空 patch 数组仍产生一次提交（version 自增），但 schema 引用不变', async () => {
    const { app, document } = await createRealm()
    const before = document.model.schema

    document.apply([], { record: false })

    expect(document.model.version).toBe(2)
    expect(document.model.schema).toBe(before)
    expect(document.model.dirty).toBe(false)

    app.dispose()
  })

  it('version 在混合 apply / restore / undo 序列中严格单调递增', async () => {
    const { app, document, history } = await createRealm()
    const versions: number[] = [document.model.version]

    const track = (): void => {
      versions.push(document.model.version)
    }
    document.apply([moveX(1)], { record: false })
    track()
    document.apply([moveX(2)], { record: true })
    track()
    history.undo()
    track()
    history.redo()
    track()
    document.restore(createSchema())
    track()

    expect(versions).toEqual([1, 2, 3, 4, 5, 6])
    for (let index = 1; index < versions.length; index += 1) {
      expect(versions[index]).toBeGreaterThan(versions[index - 1] as number)
    }

    app.dispose()
  })

  it('onDidChange 与 document:change 事件在每次提交各通知一次，退订后停止', async () => {
    const { app, document } = await createRealm()
    const models: Readonly<DocumentModel>[] = []
    const payloads: Readonly<DocumentModel>[] = []

    const local = document.onDidChange((model) => models.push(model))
    const bus = app.on('document:change', (payload) => payloads.push(payload.model))

    document.apply([moveX(5)], { record: false })
    expect(models).toHaveLength(1)
    expect(payloads).toHaveLength(1)
    expect(models[0]?.schema.nodes.root?.layout?.rect?.x).toBe(5)

    local.dispose()
    bus.dispose()
    document.apply([moveX(6)], { record: false })
    expect(models).toHaveLength(1)
    expect(payloads).toHaveLength(1)

    app.dispose()
  })

  it('同一监听函数重复注册只保留一份，任一 Disposable 释放即失效', async () => {
    const { app, document } = await createRealm()
    let calls = 0
    const listener = (): void => {
      calls += 1
    }

    const first = document.onDidChange(listener)
    const second = document.onDidChange(listener)
    document.apply([moveX(7)], { record: false })
    expect(calls).toBe(1)

    first.dispose()
    document.apply([moveX(8)], { record: false })
    expect(calls).toBe(1)
    second.dispose()

    app.dispose()
  })

  it('validate() 是只读操作，不改变 version / dirty / schema 引用', async () => {
    const { app, document } = await createRealm()
    const before = document.model.schema
    const version = document.model.version

    const issues = document.validate()

    expect(Array.isArray(issues)).toBe(true)
    expect(document.model.version).toBe(version)
    expect(document.model.dirty).toBe(false)
    expect(document.model.schema).toBe(before)

    app.dispose()
  })

  it('配置缺 id / 缺 schema 时插件进入 failed，不提供 document 服务', async () => {
    installContextServices()
    const app = createApp({ grants: { 'service-document': ['document'] } })

    const missingId: PluginRecord = app.plugin(documentPlugin, { schema: createSchema() })
    const missingSchema: PluginRecord = app.plugin(documentPlugin, { id: 'doc-2' })
    await app.runtime.whenIdle()

    expect(missingId.state).toBe('failed')
    expect((missingId.error as Error).message).toMatch(/缺少文档 id/)
    expect(missingSchema.state).toBe('failed')
    expect((missingSchema.error as Error).message).toMatch(/缺少初始 schema/)
    expect(() => app.require<DocumentService>('document')).toThrow(/缺少服务/)

    app.dispose()
  })
})
