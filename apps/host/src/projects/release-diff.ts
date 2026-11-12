import type { ProjectReleaseAssets } from './release-model'

/**
 * 两份发布快照之间的资产级差异。
 *
 * 版本管理的「变更记录 / 对比记录」都消费这一份纯计算：按五类资产的 id 对齐，
 * 内容指纹用 JSON 序列化比较——快照本身就是 JSON 落盘的，序列化口径与存储一致，
 * 不引第二套深比较。只读不写，node 环境可直接单测。
 */

/** 参与比较的五类资产 */
export type ReleaseAssetKind = 'page' | 'flow' | 'function' | 'component' | 'api'

/** 差异类型：目标侧新增 / 修改 / 相对基线移除 */
export type ReleaseChangeKind = 'added' | 'modified' | 'removed'

/** 一条资产级差异 */
export interface ReleaseChange {
  /** 资产种类 */
  kind: ReleaseAssetKind
  /** 差异类型 */
  change: ReleaseChangeKind
  /** 资产 id */
  id: string
  /** 展示名，取各类资产的标题字段 */
  label: string
}

/** 种类展示名，列表与差异共用，避免两处文案漂移 */
export const ASSET_KIND_LABELS: Readonly<Record<ReleaseAssetKind, string>> = {
  page: '页面',
  flow: '流程',
  function: '函数',
  component: '组件',
  api: '接口',
}

const KIND_ORDER: readonly ReleaseAssetKind[] = ['page', 'flow', 'function', 'component', 'api']

interface AssetRow {
  id: string
  label: string
  fingerprint: string
}

/**
 * 内容指纹：除 `updatedAt` 外全量比较。
 *
 * 草稿时间戳不是内容：内置种子页不落盘，每次读档都按当前时间补回，两份内容完全
 * 相同的快照会因一次重载被误报成「修改」。变更记录要回答的是「改了什么东西」，
 * 不是「哪条记录被碰过」。
 */
function fingerprint(value: object): string {
  return JSON.stringify({ ...value, updatedAt: undefined })
}

/** 把五类资产拍平成「id → 展示名 + 内容指纹」的行；缺省快照视为空 */
function rowsOf(
  assets: ProjectReleaseAssets | undefined,
): Record<ReleaseAssetKind, AssetRow[]> {
  return {
    page: (assets?.pages ?? []).map((item) => ({
      id: item.id,
      label: item.title,
      fingerprint: fingerprint(item),
    })),
    flow: (assets?.flows ?? []).map((item) => ({
      id: item.id,
      label: item.name,
      fingerprint: fingerprint(item),
    })),
    function: (assets?.functions ?? []).map((item) => ({
      id: item.id,
      label: item.title ?? item.name,
      fingerprint: fingerprint(item),
    })),
    component: (assets?.components ?? []).map((item) => ({
      id: item.id,
      label: item.definition.meta.title || item.definition.meta.name,
      fingerprint: fingerprint(item),
    })),
    api: (assets?.apis ?? []).map((item) => ({
      id: item.id,
      label: item.name,
      fingerprint: fingerprint(item),
    })),
  }
}

/**
 * 基线 → 目标的资产级差异。
 *
 * `from` 为 undefined 表示空基线（首个版本），全部内容记为新增。
 * 输出按种类固定顺序，种类内按新增 / 修改 / 移除排列，UI 不必再排。
 */
export function diffReleaseAssets(
  from: ProjectReleaseAssets | undefined,
  to: ProjectReleaseAssets,
): ReleaseChange[] {
  const before = rowsOf(from)
  const after = rowsOf(to)
  const changes: ReleaseChange[] = []

  for (const kind of KIND_ORDER) {
    const beforeRows = new Map(before[kind].map((row) => [row.id, row]))
    const afterRows = new Map(after[kind].map((row) => [row.id, row]))

    for (const row of after[kind]) {
      const old = beforeRows.get(row.id)
      if (!old) changes.push({ kind, change: 'added', id: row.id, label: row.label })
      else if (old.fingerprint !== row.fingerprint) {
        changes.push({ kind, change: 'modified', id: row.id, label: row.label })
      }
    }

    for (const row of before[kind]) {
      if (!afterRows.has(row.id)) {
        changes.push({ kind, change: 'removed', id: row.id, label: row.label })
      }
    }
  }

  return changes
}

/** 快照资产数量摘要，供版本历史副标题与发布弹框展示 */
export function assetSummary(assets: ProjectReleaseAssets): string {
  return [
    `${assets.pages.length} 个页面`,
    `${assets.flows.length} 条流程`,
    `${assets.functions.length} 个函数`,
    `${assets.components.length} 个组件`,
    `${assets.apis?.length ?? 0} 个接口`,
  ].join(' · ')
}
