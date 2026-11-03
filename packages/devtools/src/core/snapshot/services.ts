import type { ServiceScope } from '@lc/kernel'
import { RESERVED_SERVICES } from '@lc/kernel'
import { summarizeValue } from '../format'
import type { DevtoolsScope, ServiceChainLink, ServiceRow } from '../types'

/**
 * 从本层向上收集同名服务。
 *
 * `filter`（isolate 层）的处理与 `Context.get` 保持一致：名单外的名字整层跳过，
 * 否则 devtools 会报出一个和实际取值不符的遮蔽链。
 */
function buildChain(
  scope: DevtoolsScope,
  name: string,
  known: Map<ServiceScope, DevtoolsScope>,
): ServiceChainLink[] {
  const chain: ServiceChainLink[] = []
  for (
    let current: ServiceScope | undefined = scope.context.scope;
    current;
    current = current.parent
  ) {
    if (current.filter && !current.filter.has(name)) continue
    const entry = current.services.get(name)
    if (!entry) continue

    const layer = known.get(current)
    chain.push({
      scopeId: layer?.id ?? null,
      scopeLabel: layer?.label ?? '隔离层',
      ownerId: entry.owner.id,
      ownerName: entry.owner.name,
      apiVersion: entry.apiVersion,
      active: chain.length === 0,
    })
  }
  return chain
}

/**
 * 服务表：逐层列出实际注册的服务，并给出遮蔽链。
 *
 * 只列「哪一层注册了什么」，同一个名字在多个层出现就是多行，
 * 每行的 `chain` 说明本层取值时实际命中哪个提供者。
 */
export function collectServices(scopes: readonly DevtoolsScope[]): ServiceRow[] {
  const known = new Map<ServiceScope, DevtoolsScope>()
  for (const scope of scopes) known.set(scope.context.scope, scope)

  const rows: ServiceRow[] = []
  for (const scope of scopes) {
    for (const [name, entry] of scope.context.scope.services) {
      rows.push({
        name,
        scopeId: scope.id,
        ownerId: entry.owner.id,
        ownerName: entry.owner.name,
        apiVersion: entry.apiVersion,
        reserved: RESERVED_SERVICES.has(name),
        summary: summarizeValue(entry.value),
        chain: buildChain(scope, name, known),
      })
    }
  }
  return rows
}
