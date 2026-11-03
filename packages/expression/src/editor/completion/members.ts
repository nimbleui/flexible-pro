/**
 * 成员候选：宿主方法、属性、声明字段与回调片段。
 *
 * 接收者类型已知时只给对应方法（数组不提示 `startsWith`），类型来自符号树或推断；
 * 两者都拿不到时保留全部宿主方法，避免「什么都提示不出来」。
 */

import type { ValueTypeSchema } from '@lc/schema'
import type { InferredType } from '../../infer'
import type { MethodDoc } from '../catalog'
import { METHOD_DOCS, PROPERTY_DOCS, RECEIVER_LABELS } from '../catalog'
import type { HostReceiverType } from '../../host'
import type { ScopeSymbol, ScopeSymbolKind } from '../scope'
import { SYMBOL_KIND_LABELS } from '../scope'
import { matchesPrefix, symbolDetail } from './items'
import { resolveScopeSymbol } from './receiver'
import { METHOD_SNIPPETS } from './snippets'
import type { CompletionItem } from './types'

const RECEIVER_ORDER: readonly HostReceiverType[] = ['array', 'string', 'number']

interface MemberGroup {
  /** 方法名，同名跨接收者合并成一条候选 */
  readonly name: string
  /** 挂载了该方法的接收者类型；详情按「数组/字符串」拼接展示 */
  readonly receivers: HostReceiverType[]
  /** 各接收者对应的文档；签名取第一条，说明按序拼接 */
  readonly docs: MethodDoc[]
}

/** 按方法名合并接收者类型，`slice` 这类同名方法只出现一条 */
const MEMBER_GROUPS: readonly MemberGroup[] = buildMemberGroups()

function buildMemberGroups(): MemberGroup[] {
  /** 分组累积的中间态，与 MemberGroup 去掉 name 后的主体同形 */
  const groups = new Map<string, { receivers: HostReceiverType[]; docs: MethodDoc[] }>()

  for (const receiver of RECEIVER_ORDER) {
    for (const doc of METHOD_DOCS[receiver]) {
      const group = groups.get(doc.name)
      if (group) {
        group.receivers.push(receiver)
        group.docs.push(doc)
      } else {
        groups.set(doc.name, { receivers: [receiver], docs: [doc] })
      }
    }
  }

  return [...groups.entries()].map(([name, group]) => ({ name, ...group }))
}

/** 已知类型的接收者只保留对应方法；object/boolean 没有宿主方法 */
function receiversForKind(
  kind: ScopeSymbolKind | undefined,
): readonly HostReceiverType[] | undefined {
  switch (kind) {
    case 'array':
      return ['array']
    case 'string':
      return ['string']
    case 'number':
      return ['number']
    case 'object':
    case 'boolean':
      return []
    default:
      return undefined
  }
}

/** 方法、片段、属性与字段的统一装配；调用方负责先算好字段与接收者类型 */
function memberOptions(
  prefix: string,
  kind: ScopeSymbolKind | undefined,
  fields: readonly CompletionItem[],
): CompletionItem[] {
  const allowed = receiversForKind(kind)

  const methods: CompletionItem[] = MEMBER_GROUPS.filter(
    (group) =>
      matchesPrefix(group.name, prefix) &&
      (allowed === undefined || group.receivers.some((receiver) => allowed.includes(receiver))),
  ).map((group) => {
    const labels = group.receivers.map((receiver) => RECEIVER_LABELS[receiver]).join('/')
    return {
      label: group.name,
      kind: 'method',
      detail: `${labels} · ${group.docs[0]?.signature ?? group.name}`,
      documentation: group.docs.map((doc) => doc.description).join(' '),
      insertText: `${group.name}(`,
    }
  })

  // 空前缀时列表已经很长，片段只在用户开始输入方法名后进入候选
  const snippets: CompletionItem[] =
    prefix === '' || (allowed !== undefined && !allowed.includes('array'))
      ? []
      : METHOD_SNIPPETS.filter((item) => matchesPrefix(item.name, prefix)).map((item) => ({
          label: item.label,
          kind: 'method',
          detail: item.detail,
          documentation: '插入回调模板，占位符可依次 Tab 跳转。',
          snippet: item.snippet,
        }))

  const properties: CompletionItem[] = PROPERTY_DOCS.filter(
    (doc) =>
      matchesPrefix(doc.name, prefix) &&
      (allowed === undefined || doc.receivers.some((receiver) => allowed.includes(receiver))),
  ).map((doc) => ({
    label: doc.name,
    kind: 'property',
    detail: `${doc.receivers.map((receiver) => RECEIVER_LABELS[receiver]).join('/')} · 属性`,
    documentation: doc.description,
    insertText: doc.name,
  }))

  return [...fields, ...methods, ...snippets, ...properties]
}

function symbolFieldItems(
  fields: readonly ScopeSymbol[] | undefined,
  prefix: string,
): CompletionItem[] {
  return (
    fields
      ?.filter((child) => matchesPrefix(child.name, prefix))
      .map((child) => ({
        label: child.name,
        kind: 'property' as const,
        detail: symbolDetail(child),
        documentation: child.description,
        insertText: child.name,
      })) ?? []
  )
}

export function memberItems(
  prefix: string,
  symbols: readonly ScopeSymbol[] | undefined,
  segments: readonly string[],
): CompletionItem[] {
  const target = resolveScopeSymbol(symbols, segments)

  // 接收者路径写错了就什么都不提示，而不是退回“全部方法”造成误导
  if (segments.length > 0 && !target) return []

  return memberOptions(prefix, target?.kind, symbolFieldItems(target?.children, prefix))
}

/** 推断分支没有字段说明，只能展示类型；字段仍是补全主项 */
function inferredFieldItems(type: ValueTypeSchema, prefix: string): CompletionItem[] {
  if (type.kind !== 'object') return []

  return Object.entries(type.fields ?? {})
    .filter(([name]) => matchesPrefix(name, prefix))
    .map(([name, field]) => ({
      label: name,
      kind: 'property' as const,
      detail: `${SYMBOL_KIND_LABELS[field.kind]} · 推断${
        field.optional ? ' · 可选' : ''
      }${field.nullable ? ' · 可为空' : ''}`,
      documentation: field.description,
      insertText: name,
    }))
}

export function memberItemsFromInference(
  prefix: string,
  inferred: InferredType,
): CompletionItem[] {
  if (!inferred.resolved) return []
  return memberOptions(
    prefix,
    inferred.type.kind as ScopeSymbolKind,
    inferredFieldItems(inferred.type, prefix),
  )
}
