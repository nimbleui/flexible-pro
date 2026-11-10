import type { VersionDocument, WorkingTree } from '@lc/contracts'
import { describe, expect, it } from 'vitest'
import {
  compareProjection,
  parseVersionMode,
  shouldCompareProjection,
  shouldReadFromVersion,
  shouldWriteVersion,
} from '../src/version-mode'

const doc = (x: number): VersionDocument => ({
  kind: 'page',
  docSchemaVersion: '1.0.0',
  sections: { nodes: { n1: { x } }, metadata: { title: 'p' } },
})

describe('灰度开关', () => {
  it('未知、空、拼错的环境变量一律回落到 off', () => {
    expect(parseVersionMode(undefined)).toBe('off')
    expect(parseVersionMode(null)).toBe('off')
    expect(parseVersionMode('')).toBe('off')
    expect(parseVersionMode('ON')).toBe('off')
    expect(parseVersionMode('shadow')).toBe('shadow')
    expect(parseVersionMode('on')).toBe('on')
  })

  it('三档的读写语义：off 不写不读，shadow 双写旧读，on 以版本库为准', () => {
    expect([
      shouldWriteVersion('off'),
      shouldReadFromVersion('off'),
      shouldCompareProjection('off'),
    ]).toEqual([false, false, false])
    expect([
      shouldWriteVersion('shadow'),
      shouldReadFromVersion('shadow'),
      shouldCompareProjection('shadow'),
    ]).toEqual([true, false, true])
    expect([
      shouldWriteVersion('on'),
      shouldReadFromVersion('on'),
      shouldCompareProjection('on'),
    ]).toEqual([true, true, false])
  })

  it('内容相同但键序不同不算漂移', () => {
    const versionTree: WorkingTree = {
      p1: { kind: 'page', docSchemaVersion: '1.0.0', sections: { nodes: { a: 1, b: 2 } } },
    }
    const legacyTree: WorkingTree = {
      p1: { kind: 'page', docSchemaVersion: '1.0.0', sections: { nodes: { b: 2, a: 1 } } },
    }

    expect(compareProjection(versionTree, legacyTree)).toEqual([])
  })

  it('缺失与内容差异分别归类，按 docId 排序', () => {
    const versionTree: WorkingTree = { p1: doc(1), p2: doc(2) }
    const legacyTree: WorkingTree = { p1: doc(9), p3: doc(3) }
    const mismatches = compareProjection(versionTree, legacyTree)

    expect(mismatches.map((item) => [item.docId, item.reason])).toEqual([
      ['p1', 'content-different'],
      ['p2', 'missing-in-legacy'],
      ['p3', 'missing-in-version'],
    ])
    expect(mismatches[0].versionText).toContain('"x":1')
    expect(mismatches[0].legacyText).toContain('"x":9')
  })
})
