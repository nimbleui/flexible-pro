import { describe, expect, it } from 'vitest'
import type { DataSourceSchemaDef, PageSchema } from '../src/index'
import { SCHEMA_VERSION, buildPageData, resolveDataSourceValue } from '../src/index'

function schemaWith(
  sources: DataSourceSchemaDef[],
  variables: PageSchema['variables'],
): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        componentName: 'Box',
        layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 100, height: 100 } },
      },
    },
    components: [],
    datasources: sources,
    variables,
  }
}

describe('页面数据装配', () => {
  it('mock/static 数据源直接进入 data，REST 等待运行时', () => {
    const schema = schemaWith(
      [
        { id: 'mockList', type: 'mock', config: { kind: 'mock', data: [{ id: 1 }] } },
        {
          id: 'staticMap',
          type: 'static',
          config: { kind: 'static', data: { theme: 'dark' } },
        },
        {
          id: 'remote',
          type: 'rest',
          sample: { ignored: true },
          config: { kind: 'rest', url: '/api/list' },
        },
      ],
      [],
    )

    const data = buildPageData(schema)

    expect(data.mockList).toEqual({
      data: [{ id: 1 }],
      loading: false,
      loaded: true,
      error: null,
    })
    expect(data.staticMap).toEqual({
      data: { theme: 'dark' },
      loading: false,
      loaded: true,
      error: null,
    })
    expect(data.remote).toEqual({
      data: undefined,
      loading: false,
      loaded: false,
      error: null,
    })
  })

  it('运行时状态优先于静态兜底', () => {
    const schema = schemaWith(
      [{ id: 'remote', type: 'rest', config: { kind: 'rest', url: '/api/list' } }],
      [],
    )
    const state = {
      data: [{ id: 2 }],
      loading: false,
      loaded: true,
      error: null,
    }

    expect(buildPageData(schema, { remote: state }).remote).toBe(state)
  })

  it('变量默认值进入 data，并与数据源同名时覆盖', () => {
    const schema = schemaWith(
      [{ id: 'mode', type: 'static', config: { kind: 'static', data: 'from-source' } }],
      [
        { name: 'mode', defaultValue: 'from-variable' },
        { name: 'count', defaultValue: 3 },
      ],
    )

    const data = buildPageData(schema)

    expect(data.mode).toBe('from-variable')
    expect(data.count).toBe(3)
  })

  it('data 使用 null 原型，避免用户输入的键触发原型污染', () => {
    const schema = schemaWith([], [{ name: '__proto__', defaultValue: { polluted: true } }])
    const data = buildPageData(schema)

    expect(Object.getPrototypeOf(data)).toBeNull()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('resolveDataSourceValue 只处理 mock/static', () => {
    expect(
      resolveDataSourceValue({ id: 'a', type: 'mock', config: { kind: 'mock', data: 1 } }),
    ).toBe(1)
    expect(
      resolveDataSourceValue({ id: 'a', type: 'static', config: { kind: 'static', data: 2 } }),
    ).toBe(2)
    expect(
      resolveDataSourceValue({
        id: 'a',
        type: 'localStorage',
        config: { kind: 'localStorage', key: 'k' },
      }),
    ).toBeUndefined()
  })
})
