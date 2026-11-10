import { describe, expect, it } from 'vitest'
import type { PageSchema } from '../src/page'
import type { SchemaMigration } from '../src/migrate'
import { migrateDocument } from '../src/migrate'
import { SCHEMA_VERSION, compareSchemaVersion } from '../src/version'

function doc(version: string): PageSchema {
  return {
    version,
    nodeId: 'root',
    nodes: {},
    components: [],
    metadata: { title: 'migrate' },
  }
}

function step(from: string, to: string): SchemaMigration {
  return {
    from,
    to,
    migrate: (schema) => ({ ...schema, metadata: { title: `after-${to}` } }),
  }
}

describe('架构版本比较', () => {
  it('缺位补 0，数字段逐位比较', () => {
    expect(compareSchemaVersion('1.0', '1.0.0')).toBe(0)
    expect(compareSchemaVersion('1.9.0', '1.10.0')).toBeLessThan(0)
    expect(compareSchemaVersion('2.0.0', '1.9.9')).toBeGreaterThan(0)
  })
})

describe('migrateDocument 显式迁移链', () => {
  it('已是目标版本时原样返回，不执行迁移', () => {
    const input = doc(SCHEMA_VERSION)
    const result = migrateDocument(input, [step('0.9.0', SCHEMA_VERSION)])

    expect(result).toBe(input)
    expect(result.metadata?.title).toBe('migrate')
  })

  it('按 from 串起多步迁移，允许乱序声明', () => {
    const result = migrateDocument(
      doc('0.8.0'),
      [step('0.9.0', '1.0.0'), step('0.8.0', '0.9.0')],
      '1.0.0',
    )

    expect(result.version).toBe('1.0.0')
    expect(result.metadata?.title).toBe('after-1.0.0')
  })

  it('迁移函数不得原地修改输入', () => {
    const input = doc('0.9.0')
    migrateDocument(input, [step('0.9.0', '1.0.0')], '1.0.0')

    expect(input.version).toBe('0.9.0')
    expect(input.metadata?.title).toBe('migrate')
  })

  it('文档版本高于当前支持时 fail-closed', () => {
    expect(() => migrateDocument(doc('9.0.0'), [], '1.0.0')).toThrow(/高于当前支持/)
  })

  it('缺少迁移路径时抛错，不静默降级', () => {
    expect(() => migrateDocument(doc('0.8.0'), [], '1.0.0')).toThrow(/缺少 .* 的迁移路径/)
  })

  it('迁移链成环时抛错', () => {
    const cycle: SchemaMigration[] = [
      { from: '0.8.0', to: '0.9.0', migrate: (schema) => schema },
      { from: '0.9.0', to: '0.8.0', migrate: (schema) => schema },
    ]

    expect(() => migrateDocument(doc('0.8.0'), cycle, '1.0.0')).toThrow(/迁移链存在循环/)
  })
})
