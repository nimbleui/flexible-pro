import type { VersionMode, WorkingTree } from '@lc/contracts'
import { canonicalJson } from '@lc/shared'

// 档位类型是公共契约，面板与宿主都从 @lc/contracts 读取；这里保持原出口，
// 避免既有调用方因为类型上移而改 import 路径。
export type { VersionMode } from '@lc/contracts'

/**
 * 解析函数对未知值一律回落到 `off`：开关读错时必须是「什么都不变」，
 * 而不是误把版本库当成权威读取源。
 */

/** 读取 `VITE_LC_VERSION_MODE` 一类构建期变量；空值、拼错、未注入都视为 off。 */
export function parseVersionMode(value: string | undefined | null): VersionMode {
  if (value === 'shadow' || value === 'on') return value

  return 'off'
}

/** off 完全现状；shadow 与 on 都并行写版本库。 */
export function shouldWriteVersion(mode: VersionMode): boolean {
  return mode !== 'off'
}

/** 只有 on 把版本库作为读取与运行态的权威来源。 */
export function shouldReadFromVersion(mode: VersionMode): boolean {
  return mode === 'on'
}

/** shadow 是主要风险缓冲带：双读比对，不一致只报警，不自动修复。 */
export function shouldCompareProjection(mode: VersionMode): boolean {
  return mode === 'shadow'
}

/** 投影比对不一致的原因。 */
export type ProjectionMismatchReason =
  'missing-in-version' | 'missing-in-legacy' | 'content-different'

/**
 * 一次投影比对不一致的记录。
 */
export interface ProjectionMismatch {
  /** 不一致文档 id */
  docId: string
  /** 不一致原因 */
  reason: ProjectionMismatchReason
  /** 两侧规范化文本，供宿主写入诊断；内容可能较大，由调用方决定是否截断 */
  versionText?: string
  /** 旧 `lc.*` 侧规范化文本；与 `versionText` 同格式，便于并排比对 */
  legacyText?: string
}

/**
 * 比对「版本库投影」与「旧 `lc.*` 路径」的一致性。
 *
 * 用规范化文本比较而不是 `===`：两侧来自不同读写路径，对象键序可能不同但内容相同，
 * 那不算漂移。返回数组按 docId 排序，便于测试与诊断面板稳定展示。
 */
export function compareProjection(
  versionTree: WorkingTree,
  legacyTree: WorkingTree,
): ProjectionMismatch[] {
  const docIds = [...new Set([...Object.keys(versionTree), ...Object.keys(legacyTree)])].sort()
  const result: ProjectionMismatch[] = []

  for (const docId of docIds) {
    const versionDocument = versionTree[docId]
    const legacyDocument = legacyTree[docId]

    if (versionDocument === undefined) {
      result.push({
        docId,
        reason: 'missing-in-version',
        legacyText: canonicalJson(legacyDocument),
      })
      continue
    }

    if (legacyDocument === undefined) {
      result.push({
        docId,
        reason: 'missing-in-legacy',
        versionText: canonicalJson(versionDocument),
      })
      continue
    }

    const versionText = canonicalJson(versionDocument)
    const legacyText = canonicalJson(legacyDocument)

    if (versionText !== legacyText) {
      result.push({ docId, reason: 'content-different', versionText, legacyText })
    }
  }

  return result
}
