import type { DocChangeSet } from '@lc/contracts'

/**
 * tracker 需要的最小文档形状。
 *
 * 不直接依赖 `@lc/schema` 的 `DocumentModel`：`document:change` 的载荷是 `{ model }`，
 * 其中 `model.schema` 的顶层字段就是版本库的 section。宿主适配器只需把
 * `DocumentModel` 摊成这个形状，内核因此不认识 Realm、Vue 或 kernel 的事件表。
 */
export interface TrackedDocument {
  /** 文档 id，与 `VersionDocument` 的键一致 */
  id: string
  /** 顶层字段名 → 值 */
  schema: Record<string, unknown>
}

/** 文档变更源；由宿主把 `onDidChange` / `ctx.on('document:change')` 适配进来。 */
export interface DocumentChangeSource {
  /** 订阅文档变更；返回带 `dispose` 的句柄，用于取消订阅 */
  onDidChange(listener: (document: TrackedDocument) => void): { dispose(): void }
}

/**
 * section 级变更索引。
 *
 * 它只是**提示**：`CommitInput.changes` 与 UI 的「改了哪些 section」用它，
 * 真正的脏判定和提交树仍由 Core 比较 working copy 与 HEAD 得出（见 `service.ts`）。
 * 这样即使漏记一次事件，也不会产生错误提交——只会少一个优化提示。
 */
export interface SectionTracker {
  /** index 是否非空，作为脏状态在宿主侧的展示提示 */
  hasChanges(): boolean
  /** 取出并清空 index；提交成功后调用 */
  takeChanges(): DocChangeSet
  /** 只读快照，不清空 */
  peekChanges(): DocChangeSet
  /** 检出 / 回滚后调用：工作区内容已被替换，旧基线必须作废 */
  reset(): void
  /** 注销订阅并清空 index 与基线 */
  dispose(): void
}

/**
 * 订阅文档变更并累积「哪个文档的哪些顶层字段变了」。
 *
 * 判等用 `===` 而不是深比较：`applyPatches` 只克隆 patch 路径上的容器，未命中分支
 * 保持引用共享（`packages/schema/src/patch.ts`），
 * 因此引用不等即该 section 确实被改写，无需再遍历一次 200 节点的字典。
 *
 * 首次观察只建立基线、不记变更：打开一个 Realm 不等于编辑了它。若草稿本身与 HEAD
 * 有差异，Core 的 working copy vs HEAD 比较仍会正确判脏。
 */
export function createSectionTracker(source: DocumentChangeSource): SectionTracker {
  const previous = new Map<string, Record<string, unknown>>()
  const index = new Map<string, Set<string>>()

  function observe(document: TrackedDocument): void {
    const before = previous.get(document.id)
    const after = document.schema
    previous.set(document.id, after)

    if (!before) return

    const sections = index.get(document.id) ?? new Set<string>()
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])

    for (const key of keys) {
      if (before[key] !== after[key]) sections.add(key)
    }

    if (sections.size > 0) index.set(document.id, sections)
  }

  function snapshot(): DocChangeSet {
    const sections: Record<string, string[]> = {}

    for (const docId of [...index.keys()].sort()) {
      const changed = index.get(docId)
      if (changed && changed.size > 0) sections[docId] = [...changed].sort()
    }

    return { sections }
  }

  const subscription = source.onDidChange(observe)

  return {
    hasChanges() {
      for (const changed of index.values()) {
        if (changed.size > 0) return true
      }

      return false
    },

    takeChanges() {
      const changes = snapshot()
      index.clear()

      return changes
    },

    peekChanges: snapshot,

    reset() {
      index.clear()
      previous.clear()
    },

    dispose() {
      subscription.dispose()
      index.clear()
      previous.clear()
    },
  }
}
