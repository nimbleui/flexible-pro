import type { DataSourceConfig, DataSourceSchemaDef } from '@lc/schema'

export type EditableSourceType = 'rest' | 'mock' | 'static'

/**
 * 表单能整体编辑的数据源。
 *
 * graphql / localStorage 仍是合法 schema，但它们的配置字段不在本表单里，
 * 列表只读展示、不进入编辑态，避免保存时把没有渲染过的字段静默清掉。
 */
export type EditableSource = DataSourceSchemaDef & {
  /** 收窄后的类型判别；其余 DataSourceType 不在此列 */
  type: EditableSourceType
}

/** 类型选择器候选；顺序即下拉顺序，与 EditableSourceType 全集一致 */
export const SOURCE_TYPES: ReadonlyArray<{
  /** 写入 `DataSourceSchemaDef.type` 的值 */
  value: EditableSourceType
  /** 下拉展示名 */
  label: string
}> = [
  { value: 'rest', label: 'REST 接口' },
  { value: 'mock', label: 'Mock 数据' },
  { value: 'static', label: '静态数据' },
]

export function sourceTypeLabel(type: string): string {
  return SOURCE_TYPES.find((item) => item.value === type)?.label ?? type
}

export function isEditableSource(source: DataSourceSchemaDef): source is EditableSource {
  return source.type === 'rest' || source.type === 'mock' || source.type === 'static'
}

/** 样本值：显式 `sample` 优先，mock / static 的 config.data 本身就是样本 */
export function getSourceSample(source: DataSourceSchemaDef): unknown {
  if (source.sample !== undefined) return source.sample
  if (source.type === 'mock' && source.config.kind === 'mock') return source.config.data
  if (source.type === 'static' && source.config.kind === 'static') return source.config.data
  return undefined
}

/**
 * 组装数据源 config。
 *
 * 同类型编辑时先展开原 config，跨类型切换才重建：旧类型的字段对新类型没有意义。
 */
export function buildSourceConfig(
  existing: DataSourceSchemaDef | undefined,
  type: EditableSourceType,
  url: string,
  sample: unknown,
): DataSourceConfig {
  if (type === 'rest') {
    return existing?.type === 'rest' && existing.config.kind === 'rest'
      ? { ...existing.config, url }
      : { kind: 'rest', url }
  }

  if (type === 'mock') {
    return existing?.type === 'mock' && existing.config.kind === 'mock'
      ? { ...existing.config, data: sample ?? null }
      : { kind: 'mock', data: sample ?? null }
  }

  return existing?.type === 'static' && existing.config.kind === 'static'
    ? { ...existing.config, data: sample ?? null }
    : { kind: 'static', data: sample ?? null }
}
