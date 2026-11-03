import { describe, expect, it } from 'vitest'
import type { FunctionDescriptor, PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import { createExpressionEngine } from '../src/index'
import {
  BUILTIN_DOCS,
  METHOD_DOCS,
  buildPageSymbols,
  completeExpression,
  diagnoseExpression,
  listHostMethods,
  scopeSymbolFromType,
  signatureHelp,
  symbolizeValue,
  valueTypeFromSample,
} from '../src/editor'
import type { HostReceiverType, ScopeSymbol } from '../src/editor'
import { BUILTIN_FUNCTIONS, methodReturnType } from '../src/host'

function engineWithFunctions(): {
  functions: readonly FunctionDescriptor[]
  engine: ReturnType<typeof createExpressionEngine>
} {
  const engine = createExpressionEngine()
  engine.functions.register(
    {
      name: 'progress',
      params: ['list'],
      paramTypes: {
        list: {
          kind: 'array',
          item: { kind: 'object', fields: { done: { kind: 'boolean' } } },
        },
      },
      body: 'list.filter(x => x.done).length',
      title: '进度',
      description: '统计完成比例',
    },
    'global',
  )
  engine.functions.register(
    { name: 'pageLabel', params: ['value'], body: "'label'", title: '页面标签' },
    'page',
  )
  engine.functions.register({ name: 'makeUser', body: "{ name: 'Alice', age: 18 }" }, 'page')
  return { engine, functions: engine.functions.describe() }
}

const listSymbol: ScopeSymbol = { name: 'list', kind: 'array', source: 'param' }

describe('函数描述：describe()', () => {
  it('包含内置函数与自定义函数，并标注来源', () => {
    const { functions } = engineWithFunctions()
    const round = functions.find((item) => item.name === 'round')

    expect(round?.scope).toBe('builtin')
    expect(round?.params).toEqual(['n'])
    expect(round?.description).toContain('四舍五入')

    const progress = functions.find((item) => item.name === 'progress')
    expect(progress).toMatchObject({
      scope: 'global',
      params: ['list'],
      title: '进度',
      description: '统计完成比例',
    })
    expect(progress?.paramTypes?.list).toMatchObject({ kind: 'array' })
    expect(progress?.returns).toEqual({ kind: 'number' })

    const makeUser = functions.find((item) => item.name === 'makeUser')
    expect(makeUser?.returns).toEqual({
      kind: 'object',
      fields: { name: { kind: 'string' }, age: { kind: 'number' } },
    })
  })

  it('每个宿主方法都有返回类型', () => {
    const types: readonly HostReceiverType[] = ['array', 'string', 'number']
    for (const type of types) {
      for (const name of listHostMethods(type)) {
        expect(methodReturnType(type, name)).toBeDefined()
      }
    }
  })

  it('同名只返回生效层级的条目，注销后回落', () => {
    const engine = createExpressionEngine()
    const global = engine.functions.register(
      { name: 'fmt', params: ['v'], body: "'global'", description: '全局版' },
      'global',
    )
    const page = engine.functions.register(
      { name: 'fmt', params: ['x'], body: "'page'", description: '页面版' },
      'page',
    )

    const find = (): FunctionDescriptor | undefined =>
      engine.functions.describe().find((item) => item.name === 'fmt')

    expect(find()).toMatchObject({ scope: 'page', params: ['x'], description: '页面版' })
    page.dispose()
    expect(find()).toMatchObject({ scope: 'global', params: ['v'], description: '全局版' })
    global.dispose()
    expect(find()).toBeUndefined()
  })

  it('内置函数文档与行为表一一对应', () => {
    const documented = new Set(BUILTIN_DOCS.map((doc) => doc.name))
    expect(documented).toEqual(new Set(BUILTIN_FUNCTIONS.keys()))
  })

  it('方法文档与行为表一一对应', () => {
    const types: readonly HostReceiverType[] = ['array', 'string', 'number']
    for (const type of types) {
      const documented = new Set(METHOD_DOCS[type].map((doc) => doc.name))
      expect(documented).toEqual(new Set(listHostMethods(type)))
    }
  })
})

describe('表达式补全', () => {
  it('标识符前缀提示形参、函数与字面量', () => {
    const { functions } = engineWithFunctions()
    const result = completeExpression({
      text: 'pro',
      offset: 3,
      functions,
      symbols: [listSymbol],
    })

    expect(result.from).toBe(0)
    expect(result.options).toContainEqual(
      expect.objectContaining({ label: 'progress', kind: 'function', insertText: 'progress(' }),
    )

    const pageResult = completeExpression({ text: 'pag', offset: 3, functions })
    expect(pageResult.options).toContainEqual(
      expect.objectContaining({ label: 'pageLabel', kind: 'function' }),
    )
  })

  it('形参名参与补全', () => {
    const { functions } = engineWithFunctions()
    const result = completeExpression({
      text: 'li',
      offset: 2,
      functions,
      symbols: [listSymbol],
    })

    expect(result.options[0]).toMatchObject({ label: 'list', kind: 'variable' })
  })

  it('点号之后只提示方法与属性', () => {
    const { functions } = engineWithFunctions()
    const result = completeExpression({
      text: 'list.',
      offset: 5,
      functions,
      symbols: [listSymbol],
    })

    expect(result.from).toBe(5)
    expect(
      result.options.some((item) => item.label === 'filter' && item.kind === 'method'),
    ).toBe(true)
    expect(
      result.options.some((item) => item.label === 'length' && item.kind === 'property'),
    ).toBe(true)
    expect(result.options.some((item) => item.kind === 'function')).toBe(false)
  })

  it('成员前缀从标识符起点开始替换，同名方法合并接收者', () => {
    const { functions } = engineWithFunctions()
    const result = completeExpression({
      text: 'list.sl',
      offset: 7,
      functions,
      symbols: [listSymbol],
    })

    expect(result.from).toBe(5)
    const slice = result.options.find((item) => item.label === 'slice')
    expect(slice?.kind).toBe('method')
    expect(slice?.detail).toContain('数组/字符串')
  })

  it('括号与运算符之后继续提示操作数', () => {
    const { functions } = engineWithFunctions()
    const result = completeExpression({
      text: 'abs(',
      offset: 4,
      functions,
      symbols: [listSymbol],
    })

    expect(result.from).toBe(4)
    expect(result.options.some((item) => item.label === 'list')).toBe(true)
    expect(result.options.some((item) => item.label === 'progress')).toBe(true)
  })

  it('成员前缀提供回调片段，普通方法项仍然保留', () => {
    const { functions } = engineWithFunctions()
    const result = completeExpression({
      text: 'list.fi',
      offset: 7,
      functions,
      symbols: [listSymbol],
    })

    expect(result.options).toContainEqual(
      expect.objectContaining({ label: 'filter', insertText: 'filter(' }),
    )
    expect(result.options).toContainEqual(
      expect.objectContaining({
        label: 'filter(x => …)',
        snippet: 'filter(${x} => ${})',
      }),
    )
  })

  it('三元片段只在输入前缀后出现', () => {
    const { functions } = engineWithFunctions()

    const typed = completeExpression({ text: 'ter', offset: 3, functions })
    expect(typed.options).toContainEqual(
      expect.objectContaining({
        label: 'ternary ? :',
        snippet: '${condition} ? ${whenTrue} : ${whenFalse}',
      }),
    )

    const empty = completeExpression({ text: '(', offset: 1, functions })
    expect(empty.options.some((item) => item.snippet !== undefined)).toBe(false)
  })

  it('模板模式只在 {{ }} 内补全，并把位置映射回原文', () => {
    const { functions } = engineWithFunctions()
    const symbols: ScopeSymbol[] = [
      {
        name: 'data',
        kind: 'object',
        source: 'page',
        children: [{ name: 'users', kind: 'array', source: 'datasource' }],
      },
    ]
    const text = '标题 {{ data.us'

    const result = completeExpression({
      text,
      offset: text.length,
      functions,
      symbols,
      mode: 'template',
    })

    expect(result.from).toBe(text.lastIndexOf('us'))
    expect(result.options.some((item) => item.label === 'users')).toBe(true)

    expect(
      completeExpression({ text: 'data.', offset: 5, functions, symbols, mode: 'template' })
        .options,
    ).toHaveLength(0)

    expect(
      completeExpression({
        text: '{{ data.user }} x',
        offset: 17,
        functions,
        symbols,
        mode: 'template',
      }).options,
    ).toHaveLength(0)
  })

  it('字符串内部与完整表达式之后不提示', () => {
    const { functions } = engineWithFunctions()

    expect(completeExpression({ text: '"abc', offset: 4, functions }).options).toHaveLength(0)
    expect(completeExpression({ text: 'abs(1)', offset: 6, functions }).options).toHaveLength(0)
  })
})

describe('调用签名提示', () => {
  it('定位最内层未闭合调用的参数下标', () => {
    const { functions } = engineWithFunctions()

    expect(signatureHelp({ text: 'progress(', offset: 9, functions })).toMatchObject({
      name: 'progress',
      params: ['list'],
      activeParameter: 0,
      kind: 'function',
    })

    expect(signatureHelp({ text: 'abs(min(1, ', offset: 11, functions })).toMatchObject({
      name: 'min',
      activeParameter: 1,
    })
  })

  it('方法调用也提供签名', () => {
    const { functions } = engineWithFunctions()

    expect(signatureHelp({ text: 'list.filter(', offset: 12, functions })).toMatchObject({
      name: 'filter',
      params: ['fn'],
      activeParameter: 0,
      kind: 'method',
    })
  })

  it('已闭合调用、数组字面量与非调用上下文不提示', () => {
    const { functions } = engineWithFunctions()

    expect(signatureHelp({ text: 'abs(1)', offset: 6, functions })).toBeNull()
    expect(signatureHelp({ text: '[1, ', offset: 4, functions })).toBeNull()
    expect(signatureHelp({ text: 'list.', offset: 5, functions })).toBeNull()
  })
})

describe('页面数据符号', () => {
  const schema: PageSchema = {
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
    variables: [
      { name: 'isEditing', defaultValue: false, description: '编辑态' },
      {
        name: 'profile',
        defaultValue: { nickname: 'Alice', tags: ['vip'] },
        description: '用户信息',
      },
    ],
    datasources: [
      {
        id: 'users',
        type: 'rest',
        description: '用户列表',
        sample: [{ name: 'Alice' }],
        config: { kind: 'rest', url: '/api/users' },
      },
    ],
    route: {
      params: [{ name: 'id', description: '用户 id' }],
      query: [{ name: 'tab', description: '当前页签' }],
    },
    metadata: { title: '详情页' },
  }

  it('buildPageSymbols 合并数据源、变量与路由', () => {
    const symbols = buildPageSymbols(schema, {
      params: { id: '42' },
      query: { tab: 'info', extra: '1' },
    })
    const data = symbols.find((symbol) => symbol.name === 'data')

    expect(data?.children?.map((child) => child.name)).toEqual([
      'users',
      'isEditing',
      'profile',
    ])
    const users = data?.children?.find((child) => child.name === 'users')
    expect(users).toMatchObject({
      kind: 'object',
      source: 'datasource',
      description: '用户列表',
    })
    expect(users?.children?.map((child) => child.name)).toEqual([
      'data',
      'loading',
      'loaded',
      'error',
    ])
    expect(users?.children?.find((child) => child.name === 'data')?.kind).toBe('array')
    expect(data?.children?.find((child) => child.name === 'isEditing')?.kind).toBe('boolean')

    const params = symbols.find((symbol) => symbol.name === '$params')
    expect(params?.children?.find((child) => child.name === 'id')).toMatchObject({
      kind: 'string',
      source: 'route',
      description: '用户 id',
    })

    const query = symbols.find((symbol) => symbol.name === '$query')
    expect(query?.children?.map((child) => child.name)).toEqual(['tab', 'extra'])
    expect(symbols.some((symbol) => symbol.name === '$route')).toBe(true)
  })

  it('data. 提示字段，数据源状态与结果分层收窄', () => {
    const { functions } = engineWithFunctions()
    const symbols = buildPageSymbols(schema)

    const data = completeExpression({ text: 'data.', offset: 5, functions, symbols })
    expect(data.options.some((item) => item.label === 'users')).toBe(true)
    expect(data.options.some((item) => item.label === 'isEditing')).toBe(true)
    expect(data.options.find((item) => item.label === 'isEditing')?.detail).toContain(
      '页面变量',
    )

    const state = completeExpression({ text: 'data.users.', offset: 11, functions, symbols })
    expect(state.options.map((item) => item.label)).toEqual([
      'data',
      'loading',
      'loaded',
      'error',
    ])

    const users = completeExpression({
      text: 'data.users.data.',
      offset: 16,
      functions,
      symbols,
    })
    expect(users.options.some((item) => item.label === 'filter')).toBe(true)
    expect(users.options.some((item) => item.label === 'length')).toBe(true)
    expect(users.options.some((item) => item.label === 'toUpperCase')).toBe(false)

    const item = completeExpression({
      text: 'data.users.data[0].',
      offset: 19,
      functions,
      symbols,
    })
    expect(item.options.map((entry) => entry.label)).toEqual(['name'])
  })

  it('对象字段继续展开，字符串字段只给字符串方法', () => {
    const { functions } = engineWithFunctions()
    const symbols = buildPageSymbols(schema)

    const profile = completeExpression({
      text: 'data.profile.',
      offset: 13,
      functions,
      symbols,
    })
    expect(profile.options.map((item) => item.label)).toEqual(['nickname', 'tags'])

    const nickname = completeExpression({
      text: 'data.profile.nickname.',
      offset: 22,
      functions,
      symbols,
    })
    expect(nickname.options.some((item) => item.label === 'toUpperCase')).toBe(true)
    expect(nickname.options.some((item) => item.label === 'filter')).toBe(false)
  })

  it('未知字段路径不退回“全部方法”', () => {
    const { functions } = engineWithFunctions()
    const symbols = buildPageSymbols(schema)

    expect(
      completeExpression({ text: 'data.missing.', offset: 13, functions, symbols }).options,
    ).toHaveLength(0)
  })

  it('示例对象按 JSON 类型生成符号树', () => {
    const symbol = symbolizeValue('user', { name: 'Alice', tags: ['vip'], age: 18 })

    expect(symbol.kind).toBe('object')
    expect(symbol.children?.find((child) => child.name === 'name')?.kind).toBe('string')
    expect(symbol.children?.find((child) => child.name === 'tags')?.kind).toBe('array')
    expect(symbol.children?.find((child) => child.name === 'age')?.kind).toBe('number')
  })

  it('数组合并所有元素，推导可选字段与可空字段', () => {
    const type = valueTypeFromSample([
      { id: 1, name: 'Alice' },
      { id: 2, age: 18 },
      { id: null, active: true },
    ])

    expect(type.kind).toBe('array')
    expect(type.item?.kind).toBe('object')
    expect(type.item?.fields?.id).toMatchObject({ kind: 'number', nullable: true })
    expect(type.item?.fields?.name).toMatchObject({ kind: 'string', optional: true })
    expect(type.item?.fields?.age).toMatchObject({ kind: 'number', optional: true })
    expect(type.item?.fields?.active).toMatchObject({ kind: 'boolean', optional: true })
  })

  it('混合基础类型与 null 元素保守退化', () => {
    expect(valueTypeFromSample([1, 'a']).item).toEqual({ kind: 'unknown' })

    const nullable = valueTypeFromSample([null, { id: 1 }])
    expect(nullable.item).toMatchObject({ kind: 'object', nullable: true })
    expect(nullable.item?.fields?.id).toEqual({ kind: 'number' })
  })

  it('补全详情标注可选与可空', () => {
    const { functions } = engineWithFunctions()
    const item = valueTypeFromSample([{ id: 1 }, { name: 'Alice' }]).item
    expect(item).toBeDefined()

    const symbol = scopeSymbolFromType('profile', item!, { source: 'variable' })
    const result = completeExpression({
      text: 'profile.',
      offset: 8,
      functions,
      symbols: [symbol],
    })

    expect(result.options.find((entry) => entry.label === 'id')?.detail).toContain('可选')
    expect(result.options.find((entry) => entry.label === 'name')?.detail).toContain('可选')

    const nullableItem = valueTypeFromSample([{ id: null }, { id: 2 }]).item
    const nullableSymbol = scopeSymbolFromType('row', nullableItem!, { source: 'variable' })
    const nullable = completeExpression({
      text: 'row.',
      offset: 4,
      functions,
      symbols: [nullableSymbol],
    })
    expect(nullable.options.find((entry) => entry.label === 'id')?.detail).toContain('可为空')
  })
})

describe('类型标注与推断', () => {
  const user = scopeSymbolFromType(
    'user',
    {
      kind: 'object',
      fields: {
        name: { kind: 'string' },
        tags: { kind: 'array', item: { kind: 'string' } },
      },
    },
    { source: 'param' },
  )

  const list = scopeSymbolFromType(
    'list',
    {
      kind: 'array',
      item: {
        kind: 'object',
        fields: {
          id: { kind: 'number' },
          name: { kind: 'string' },
          done: { kind: 'boolean' },
        },
      },
    },
    { source: 'param' },
  )

  it('形参标注类型驱动字段与方法收窄', () => {
    const { functions } = engineWithFunctions()

    const userFields = completeExpression({
      text: 'user.',
      offset: 5,
      functions,
      symbols: [user],
    })
    expect(userFields.options.map((item) => item.label)).toEqual(['name', 'tags'])

    const userName = completeExpression({
      text: 'user.name.',
      offset: 10,
      functions,
      symbols: [user],
    })
    expect(userName.options.some((item) => item.label === 'toUpperCase')).toBe(true)
    expect(userName.options.some((item) => item.label === 'filter')).toBe(false)

    const listMethods = completeExpression({
      text: 'list.',
      offset: 5,
      functions,
      symbols: [list],
    })
    expect(listMethods.options.some((item) => item.label === 'filter')).toBe(true)
    expect(listMethods.options.some((item) => item.label === 'toUpperCase')).toBe(false)
  })

  it('数组回调参数按元素对象提示字段', () => {
    const { functions } = engineWithFunctions()
    const objectList = scopeSymbolFromType(
      'list',
      {
        kind: 'array',
        item: {
          kind: 'object',
          fields: {
            id: { kind: 'number' },
            name: { kind: 'string' },
            done: { kind: 'boolean' },
          },
        },
      },
      { source: 'param' },
    )

    const read = (text: string): string[] =>
      completeExpression({
        text,
        offset: text.length,
        functions,
        symbols: [objectList],
      }).options.map((item) => item.label)

    expect(read('list.filter(x => x.')).toEqual(['id', 'name', 'done'])
    expect(read('list.map(x => x.')).toEqual(['id', 'name', 'done'])
    expect(read('list.find(x => x.')).toEqual(['id', 'name', 'done'])
    expect(read('list.sort((a, b) => a.')).toEqual(['id', 'name', 'done'])
    expect(read('list.reduce((acc, x) => x.')).toEqual(['id', 'name', 'done'])
  })

  it('回调索引按数字提示，箭头外不暴露局部参数', () => {
    const { functions } = engineWithFunctions()
    const objectList = scopeSymbolFromType(
      'list',
      {
        kind: 'array',
        item: { kind: 'object', fields: { id: { kind: 'number' } } },
      },
      { source: 'param' },
    )

    const indexText = 'list.filter((x, i) => i.'
    const index = completeExpression({
      text: indexText,
      offset: indexText.length,
      functions,
      symbols: [objectList],
    })
    expect(index.options.some((item) => item.label === 'toFixed')).toBe(true)
    expect(index.options.some((item) => item.label === 'id')).toBe(false)

    const root = completeExpression({
      text: 'list.filter(x => x',
      offset: 18,
      functions,
      symbols: [objectList],
    })
    expect(root.options.some((item) => item.label === 'x')).toBe(true)

    const outside = completeExpression({
      text: 'list.filter(x => x, ',
      offset: 20,
      functions,
      symbols: [objectList],
    })
    expect(outside.options.some((item) => item.label === 'x')).toBe(false)
  })

  it('方法调用、下标与函数调用结果按推断类型收窄', () => {
    const { functions } = engineWithFunctions()

    const filtered = completeExpression({
      text: 'list.filter(x => x.done).',
      offset: 25,
      functions,
      symbols: [list],
    })
    expect(filtered.options.some((item) => item.label === 'filter')).toBe(true)
    expect(filtered.options.some((item) => item.label === 'length')).toBe(true)

    const indexed = completeExpression({
      text: 'list[0].',
      offset: 8,
      functions,
      symbols: [list],
    })
    expect(indexed.options.map((item) => item.label)).toEqual(['id', 'name', 'done'])

    const numeric = completeExpression({ text: 'abs(1).', offset: 7, functions })
    expect(numeric.options.some((item) => item.label === 'toFixed')).toBe(true)
    expect(numeric.options.some((item) => item.label === 'filter')).toBe(false)

    const objectResult = completeExpression({ text: 'makeUser().', offset: 11, functions })
    expect(objectResult.options.map((item) => item.label)).toEqual(['name', 'age'])

    const fieldOfResult = completeExpression({
      text: 'makeUser().name.',
      offset: 16,
      functions,
    })
    expect(fieldOfResult.options.some((item) => item.label === 'toUpperCase')).toBe(true)
  })
})

describe('表达式诊断', () => {
  it('合法表达式无诊断', () => {
    expect(diagnoseExpression('list.filter(t => t.done).length > 0')).toEqual([])
    expect(diagnoseExpression('')).toEqual([])
  })

  it('语法错误带出可定位的位置', () => {
    const issues = diagnoseExpression('1 +')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('syntax')
    expect(issues[0]?.from).toBeGreaterThanOrEqual(0)
    expect(issues[0]?.to).toBeGreaterThan(issues[0]?.from ?? 0)
  })

  it('兼容 {{ }} 包裹的表达式', () => {
    expect(diagnoseExpression('{{ 1 + 2 }}')).toEqual([])
    expect(diagnoseExpression('{{ 1 + }}')).toHaveLength(1)
  })

  it('模板模式只诊断模板内部并映射位置', () => {
    expect(diagnoseExpression('纯文本 {{ data.user.name }} 文本', 'template')).toEqual([])

    const issues = diagnoseExpression('标题 {{ 1 + }} 文本', 'template')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.from).toBeGreaterThan(3)

    expect(diagnoseExpression('标题 {{ 1 +', 'template')).toHaveLength(1)
  })
})
