import type {
  DataSourceSchemaDef,
  FunctionDescriptor,
  PageSchema,
  ValueTypeSchema,
} from '@lc/schema'
import { valueTypeFromSample } from '@lc/expression/editor'
import type { NamedTypeOption } from './type-node'

function sourceSample(source: DataSourceSchemaDef): unknown {
  if (source.sample !== undefined) return source.sample
  if (source.type === 'mock' && source.config.kind === 'mock') return source.config.data
  if (source.type === 'static' && source.config.kind === 'static') return source.config.data
  return undefined
}

/** 页面变量派生的类型候选；推不出类型的变量不进入候选，避免下拉里出现「未知类型」 */
function variableTypeOptions(schema: PageSchema): NamedTypeOption[] {
  const options: NamedTypeOption[] = []

  for (const variable of schema.variables ?? []) {
    const type = variable.type ?? valueTypeFromSample(variable.defaultValue)
    if (type.kind === 'unknown') continue

    options.push({
      id: `variable:${variable.name}`,
      label: `变量 · ${variable.name}`,
      type,
      sample: variable.defaultValue,
    })
  }

  return options
}

/**
 * 数据源结果派生的类型候选。
 *
 * 优先用显式声明的 `resultType`，缺省才按 sample 推导：接口未连通时 sample
 * 是唯一可用的结构来源，而推导结果一旦与实际返回不符，编辑器也只能照着它提示。
 */
function dataSourceTypeOptions(schema: PageSchema): NamedTypeOption[] {
  const options: NamedTypeOption[] = []

  for (const source of schema.datasources ?? []) {
    const sample = sourceSample(source)
    const type =
      source.resultType ??
      (sample === undefined
        ? ({ kind: 'unknown' } as ValueTypeSchema)
        : valueTypeFromSample(sample))

    if (type.kind === 'unknown') continue

    options.push({
      id: `datasource:${source.id}`,
      label: `接口 · ${source.id}`,
      type,
      sample,
    })
  }

  return options
}

/**
 * 页面里已定义的变量与接口结果，作为可复用类型候选。
 *
 * 变量在前、数据源在后：两者的 id 命名空间不同（`variable:` / `datasource:`），
 * 同名不会互相覆盖，顺序只影响下拉分组视觉。
 */
export function pageTypeOptions(schema: PageSchema): NamedTypeOption[] {
  return [...variableTypeOptions(schema), ...dataSourceTypeOptions(schema)]
}

/** 自定义函数形参与返回类型，作为可复用类型候选 */
export function functionTypeOptions(
  descriptors: readonly FunctionDescriptor[],
): NamedTypeOption[] {
  const options: NamedTypeOption[] = []

  for (const descriptor of descriptors) {
    if (descriptor.scope === 'builtin') continue

    for (const [paramName, type] of Object.entries(descriptor.paramTypes ?? {})) {
      if (type.kind === 'unknown') continue

      options.push({
        id: `param:${descriptor.name}:${paramName}`,
        label: `形参 · ${descriptor.name}(${paramName})`,
        type,
      })
    }

    if (descriptor.returns && descriptor.returns.kind !== 'unknown') {
      options.push({
        id: `return:${descriptor.name}`,
        label: `返回 · ${descriptor.name}`,
        type: descriptor.returns,
      })
    }
  }

  return options
}
