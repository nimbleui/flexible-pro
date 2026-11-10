import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@lc/kernel'
import type { Context } from '@lc/kernel'
import { installContextServices } from '@lc/contracts'
import type { WorkspaceService } from '@lc/contracts'
import workspacePlugin from '../src/index'

/** 与宿主 bootstrap 的 GRANTS 一致：Realm 内装配的服务都是保留服务，需要预置授权 */
const GRANTS: Record<string, readonly string[]> = {
  'service-workspace': ['workspace'],
  'service-document': ['document'],
  'service-history': ['history'],
  'service-selection': ['selection'],
  'service-datasource': ['dataSource'],
  'service-state': ['pageState'],
  'service-action': ['action'],
  'service-canvas-core': ['canvas'],
}

async function createWorkspace(): Promise<{ app: Context; workspace: WorkspaceService }> {
  installContextServices()
  const app = createApp({ grants: GRANTS })
  app.plugin(workspacePlugin)
  await app.runtime.whenIdle()

  return { app, workspace: app.require<WorkspaceService>('workspace') }
}

describe('EditorRealm 生命周期', () => {
  it('同一 documentId 重复打开抛错，避免两个 Realm 写同一份文档', async () => {
    const { workspace } = await createWorkspace()

    workspace.createEditorRealm({ documentId: 'doc-1' })

    expect(() => workspace.createEditorRealm({ documentId: 'doc-1' })).toThrow(/文档已打开/)
    expect(workspace.listEditors()).toHaveLength(1)
  })

  it('多文档各自隔离，最近打开的成为 activeEditor', async () => {
    const { workspace } = await createWorkspace()

    const first = workspace.createEditorRealm({ documentId: 'a' })
    const second = workspace.createEditorRealm({ documentId: 'b' })

    expect(workspace.listEditors()).toEqual([first, second])
    expect(workspace.getEditor('a')).toBe(first)
    expect(workspace.activeEditor).toBe(second)
    expect(first.context).not.toBe(second.context)
  })

  it('一个文档可建多个画布视图，销毁其中一个不影响其余', async () => {
    const { workspace } = await createWorkspace()
    const realm = workspace.createEditorRealm({ documentId: 'c' })

    const first = realm.createCanvasRealm()
    const second = realm.createCanvasRealm()

    expect(first.id).not.toBe(second.id)
    expect(first.context).not.toBe(second.context)

    first.dispose()
    expect(() => second.dispose()).not.toThrow()
  })

  it('关闭文档幂等，且关闭 active 后不自动回退到上一篇', async () => {
    const { workspace } = await createWorkspace()
    const realm = workspace.createEditorRealm({ documentId: 'd' })

    realm.dispose()
    realm.dispose()

    expect(workspace.listEditors()).toHaveLength(0)
    expect(workspace.getEditor('d')).toBeUndefined()
    expect(workspace.activeEditor).toBeUndefined()
    expect(() => workspace.createEditorRealm({ documentId: 'd' })).not.toThrow()
  })

  it('onDidChange 在打开时通知，退订后不再收到', async () => {
    const { workspace } = await createWorkspace()
    const listener = vi.fn()
    const subscription = workspace.onDidChange(listener)

    workspace.createEditorRealm({ documentId: 'e' })
    expect(listener).toHaveBeenCalledTimes(1)

    subscription.dispose()
    workspace.createEditorRealm({ documentId: 'f' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('应用销毁时由 workspace 的 effect 级联关闭已打开的文档', async () => {
    const { app, workspace } = await createWorkspace()
    workspace.createEditorRealm({ documentId: 'g' })

    app.dispose()

    expect(workspace.listEditors()).toHaveLength(0)
  })
})
