import type { Context, ServiceScope } from '@lc/kernel'
import type { WorkspaceService } from '@lc/contracts'
import type { DevtoolsScope } from '../types'
import { ROOT_SCOPE_ID } from '../types'

/**
 * 向上找到第一个已登记的作用域层。
 *
 * 画布层由 Realm fork 而来，中间可能夹着宿主没传进来的层；认到最近的已知层，
 * 依赖解析链才不会在这里断掉，否则画布插件会显得「谁都提供不了它的依赖」。
 */
function findKnownAncestorId(
  scopes: readonly DevtoolsScope[],
  scope: ServiceScope,
): string | null {
  for (let current = scope.parent; current; current = current.parent) {
    for (const candidate of scopes) {
      if (candidate.context.scope === current) return candidate.id
    }
  }
  return null
}

/**
 * 作用域枚举：应用根 + 文档 Realm + 宿主传入的画布层。
 *
 * Realm 与画布是 `ctx.fork()` 出来的，不进入 `Context.children`，从根树走不到；
 * 因此文档 Realm 靠 `workspace.listEditors()` 补齐，画布层只能由宿主告知。
 *
 * @param root 应用根上下文
 * @param canvas 当前画布上下文；省略则没有画布层
 */
export function collectScopes(root: Context, canvas?: Context | null): DevtoolsScope[] {
  const scopes: DevtoolsScope[] = [
    { id: ROOT_SCOPE_ID, label: '应用根', context: root, parentId: null },
  ]

  const workspace = root.get<WorkspaceService>('workspace')
  if (workspace) {
    for (const realm of workspace.listEditors()) {
      scopes.push({
        id: realm.id,
        label: `文档 ${realm.documentId}`,
        context: realm.context,
        parentId: ROOT_SCOPE_ID,
      })
    }
  }

  if (canvas) {
    const parentId = findKnownAncestorId(scopes, canvas.scope)
    scopes.push({
      id: `${parentId ?? ROOT_SCOPE_ID}/canvas`,
      label: '画布视图',
      context: canvas,
      parentId,
    })
  }

  return scopes
}
