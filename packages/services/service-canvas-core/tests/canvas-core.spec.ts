import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@lc/kernel'
import type { Context } from '@lc/kernel'
import { installContextServices } from '@lc/contracts'
import type {
  CanvasService,
  DocumentService,
  SchemaPatch,
  SelectionService,
} from '@lc/contracts'
import type { PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import documentPlugin from '../../service-document/src/index'
import selectionPlugin from '../../service-selection/src/index'
import canvasCorePlugin from '../src/index'

const createdApps: Context[] = []

afterEach(() => {
  for (const app of createdApps) app.dispose()
  createdApps.length = 0
})

async function createCanvas(): Promise<{
  app: Context
  document: DocumentService
  selection: SelectionService
  canvas: CanvasService
}> {
  installContextServices()
  const app = createApp({
    grants: {
      'service-document': ['document'],
      'service-selection': ['selection'],
      'service-canvas-core': ['canvas'],
    },
  })
  createdApps.push(app)

  app.plugin(documentPlugin, { id: 'doc-1', schema: createSchema(), mode: 'edit' })
  await app.runtime.whenIdle()
  app.plugin(selectionPlugin)
  await app.runtime.whenIdle()
  app.plugin(canvasCorePlugin)
  await app.runtime.whenIdle()

  return {
    app,
    document: app.require<DocumentService>('document'),
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

function addChild(): readonly SchemaPatch[] {
  return [
    {
      op: 'add',
      path: '/nodes/child',
      value: { id: 'child', componentName: 'Box', layout: { mode: 'absolute' } },
    },
    { op: 'add', path: '/nodes/root/children', value: ['child'] },
  ]
}

describe('service-canvas-core：真实装配与文档同步', () => {
  it('装配后 scene 已按绘制顺序登记根节点，selection 与 EditorRealm 是同一实例', async () => {
    const { canvas, selection } = await createCanvas()

    expect(canvas.scene.list()).toEqual(['root'])
    expect(canvas.selection).toBe(selection)
    expect(canvas.transaction).toBeDefined()
    expect(canvas.viewport).toBeDefined()
    expect(canvas.hitTest).toBeDefined()
    expect(canvas.nodeFlags.root).toBe('root')
  })

  it('document 新增子节点后 syncScene 登记新几何；删除后显式注销', async () => {
    const { document, canvas } = await createCanvas()

    document.apply(addChild(), { record: false })
    expect(canvas.scene.list()).toEqual(['root', 'child'])

    document.apply(
      [
        { op: 'remove', path: '/nodes/child' },
        { op: 'remove', path: '/nodes/root/children' },
      ],
      { record: false },
    )
    expect(canvas.scene.list()).toEqual(['root'])
  })

  it('nodeFlags 随 hidden / locked 标记整体刷新（含子树继承）', async () => {
    const { document, canvas } = await createCanvas()

    expect(canvas.nodeFlags.hidden.size).toBe(0)
    expect(canvas.nodeFlags.locked.size).toBe(0)

    document.apply(
      [
        ...addChild(),
        { op: 'add', path: '/nodes/child/hidden', value: true },
        { op: 'add', path: '/nodes/child/locked', value: true },
      ],
      { record: false },
    )

    expect(canvas.nodeFlags.hidden.has('child')).toBe(true)
    expect(canvas.nodeFlags.locked.has('child')).toBe(true)
    expect(canvas.nodeFlags.hidden.has('root')).toBe(false)
  })

  it('父节点隐藏时子节点沿树继承 hidden，且隐藏子树不登记几何', async () => {
    const { document, canvas } = await createCanvas()

    document.apply([...addChild(), { op: 'add', path: '/nodes/root/hidden', value: true }], {
      record: false,
    })

    expect(canvas.nodeFlags.hidden.has('root')).toBe(true)
    expect(canvas.nodeFlags.hidden.has('child')).toBe(true)
    // paintOrder 跳过隐藏子树，场景不应保留其几何
    expect(canvas.scene.list()).toEqual([])
  })

  it('document.apply 的每次提交都触发一次场景同步，且不改变文档脏状态', async () => {
    const { document, canvas } = await createCanvas()
    let notifications = 0
    const subscription = canvas.scene.onDidChange(() => {
      notifications += 1
    })
    const before = notifications

    document.apply([{ op: 'replace', path: '/nodes/root/layout/rect/x', value: 42 }], {
      record: false,
    })

    expect(document.model.dirty).toBe(false)
    expect(document.model.schema.nodes.root?.layout?.rect?.x).toBe(42)
    expect(notifications).toBeGreaterThan(before)
    subscription.dispose()
  })
})
