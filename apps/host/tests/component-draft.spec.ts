import { describe, expect, it } from 'vitest'
import type { ComponentSchema } from '@lc/schema'
import type {
  CustomComponentDraft,
  EventDraft,
  PropDraft,
} from '../src/custom-components/component-draft'
import {
  definitionsFromDraft,
  draftFromDefinition,
  draftFromDefinitions,
  eventsFromDraft,
  jsonSchemaFromProps,
  metaFromDraft,
  parsePropDefault,
  validateComponentDraft,
} from '../src/custom-components/component-draft'

function propRow(overrides: Partial<PropDraft> = {}): PropDraft {
  return {
    name: 'label',
    title: '标题',
    type: 'string',
    defaultText: '评分',
    optionsText: '',
    ...overrides,
  }
}

function draftOf(overrides: Partial<CustomComponentDraft> = {}): CustomComponentDraft {
  return {
    name: 'ScoreCard',
    title: '评分卡',
    group: '自定义',
    icon: '',
    version: '1.0.0',
    description: '',
    props: [],
    events: [],
    ...overrides,
  }
}

function messages(
  overrides: Partial<CustomComponentDraft> = {},
  takenNames: readonly string[] = [],
): string[] {
  return validateComponentDraft(draftOf(overrides), takenNames).map((issue) => issue.message)
}

describe('组件定义草稿校验', () => {
  it('合法草稿不报错', () => {
    expect(validateComponentDraft(draftOf(), [])).toEqual([])
  })

  it('组件名要求标识符且不与已有物料重名', () => {
    expect(messages({ name: '2bad' })).toContain('组件名需要以字母开头，只含字母、数字和下划线')
    expect(messages({ name: 'Card' }, ['Card'])).toContain('已有同名物料：Card')
    // 正在编辑的这条不在 takenNames 里，改名绕一圈再改回来不会被自己的历史值挡住
    expect(validateComponentDraft(draftOf({ name: 'Card' }), ['Box'])).toEqual([])
  })

  it('必填文案与版本号格式', () => {
    expect(messages({ title: '' })).toContain('展示标题不能为空')
    expect(messages({ group: '  ' })).toContain('分组不能为空')
    expect(messages({ version: 'v1' })).toContain('版本号需要形如 1.0.0')
  })

  it('属性名重复与非法标识符', () => {
    expect(messages({ props: [propRow(), propRow({ name: 'label' })] })).toContain(
      '属性名重复：label',
    )
    expect(messages({ props: [propRow({ name: 'bad name' })] })).toContain(
      '属性名 bad name 不是合法标识符',
    )
    expect(messages({ props: [propRow({ name: '' })] })).toContain('属性名不能为空')
  })

  it('枚举缺选项要报错', () => {
    expect(messages({ props: [propRow({ type: 'enum', optionsText: '  ' })] })).toContain(
      '枚举属性 label 需要至少一个选项',
    )
    expect(
      validateComponentDraft(
        draftOf({ props: [propRow({ type: 'enum', optionsText: 'ok' })] }),
        [],
      ),
    ).toEqual([])
  })
})

describe('属性默认值解析口径', () => {
  it('按类型取值，区分未填写与填错', () => {
    expect(parsePropDefault('string', '')).toEqual({})
    expect(parsePropDefault('string', '评分')).toEqual({ value: '评分' })
    expect(parsePropDefault('number', '12')).toEqual({ value: 12 })
    expect(parsePropDefault('number', 'abc')).toEqual({ error: '默认值需要是数字' })
    expect(parsePropDefault('boolean', 'true')).toEqual({ value: true })
    expect(parsePropDefault('boolean', 'yes')).toEqual({ error: '默认值需要是 true 或 false' })
    expect(parsePropDefault('object', '{"a":1}')).toEqual({ value: { a: 1 } })
    expect(parsePropDefault('array', '[1,"2"]')).toEqual({ value: [1, '2'] })
    expect(parsePropDefault('json', 'nope')).toEqual({ error: '默认值需要是合法 JSON' })
  })

  it('表达式对象原样成为默认值', () => {
    expect(
      parsePropDefault('json', '{ "type": "expression", "raw": "{{ props.label }}" }').value,
    ).toEqual({ type: 'expression', raw: '{{ props.label }}' })
  })
})

describe('属性行与属性定义互转', () => {
  it('留空属性名的行被丢弃，枚举标签按 `值=标签` 解析', () => {
    const definitions = definitionsFromDraft([
      propRow(),
      propRow({ name: '' }),
      propRow({ name: 'tone', type: 'enum', defaultText: '', optionsText: 'ok=正常\nbad\n  ' }),
    ])

    expect(definitions.map((item) => item.name)).toEqual(['label', 'tone'])
    expect(definitions[0]).toEqual({
      name: 'label',
      title: '标题',
      type: 'string',
      defaultValue: '评分',
    })
    expect(definitions[1].options).toEqual([
      { label: '正常', value: 'ok' },
      { label: 'bad', value: 'bad' },
    ])
    expect(definitions[1].defaultValue).toBeUndefined()
  })

  it('不支持的类型回落成文本行，对象默认值以 JSON 文本承载', () => {
    const rows = draftFromDefinitions([
      { name: 'onClick', title: '点击', type: 'event' },
      { name: 'items', title: '列表', type: 'array', defaultValue: [1, 2] },
    ])

    expect(rows[0]?.type).toBe('string')
    expect(rows[1]?.defaultText).toBe('[\n  1,\n  2\n]')
  })
})

describe('物料 props 生成', () => {
  it('对齐属性面板的 toPropType 口径', () => {
    expect(
      jsonSchemaFromProps([
        { name: 'fill', title: '填充色', type: 'color', defaultValue: '#fff' },
        { name: 'size', title: '字号', type: 'number', defaultValue: 12 },
        {
          name: 'tone',
          title: '色调',
          type: 'enum',
          options: [
            { label: '正常', value: 'ok' },
            { label: '异常', value: 'bad' },
          ],
        },
        { name: 'items', title: '列表', type: 'array' },
      ]),
    ).toEqual({
      type: 'object',
      properties: {
        fill: { title: '填充色', type: 'string', format: 'color', default: '#fff' },
        size: { title: '字号', type: 'number', default: 12 },
        tone: { title: '色调', type: 'string', enum: ['ok', 'bad'] },
        items: { title: '列表', type: 'array' },
      },
    })
  })

  it('标题留空时回落到属性名', () => {
    expect(jsonSchemaFromProps([{ name: 'label', title: '  ', type: 'string' }])).toEqual({
      type: 'object',
      properties: { label: { title: 'label', type: 'string' } },
    })
  })
})

describe('元信息合成', () => {
  it('裁空白、补默认分组，并省略未填写字段', () => {
    expect(metaFromDraft(draftOf({ group: '', version: '', icon: '  ', title: '' }))).toEqual({
      name: 'ScoreCard',
      title: 'ScoreCard',
      group: '自定义',
      version: '1.0.0',
    })
  })

  it('定义 → 草稿保留图标与说明，属性行可直接编辑', () => {
    const definition: ComponentSchema = {
      meta: {
        name: 'ScoreCard',
        title: '评分卡',
        group: '自定义',
        version: '2.1.0',
        icon: 'card',
        description: '带进度的评分卡',
      },
      nodeId: 'root',
      nodes: {},
      props: [{ name: 'label', title: '标题', type: 'string', defaultValue: '评分' }],
    }

    const draft = draftFromDefinition(definition, 'cc-1')
    expect(draft).toEqual({
      id: 'cc-1',
      name: 'ScoreCard',
      title: '评分卡',
      group: '自定义',
      icon: 'card',
      version: '2.1.0',
      description: '带进度的评分卡',
      props: [
        { name: 'label', title: '标题', type: 'string', defaultText: '评分', optionsText: '' },
      ],
      events: [],
    })
  })

  it('事件定义还原成可编辑行，参数拼回 `名称=类型`', () => {
    const draft = draftFromDefinition({
      meta: { name: 'Card', title: '卡片', group: '自定义', version: '1.0.0' },
      nodeId: 'root',
      nodes: {},
      events: [
        {
          name: 'click',
          title: '点击',
          parameters: [{ name: 'id', type: 'string' }],
          description: '点击卡片',
        },
      ],
    })

    expect(draft.events).toEqual([
      { name: 'click', title: '点击', description: '点击卡片', paramsText: 'id=string' },
    ])
  })
})

describe('事件行 → 事件声明', () => {
  it('留空事件名的行丢弃，标题缺省回落事件名', () => {
    const rows: readonly EventDraft[] = [
      { name: '', title: '', description: '', paramsText: '' },
      { name: 'change', title: '  ', description: '', paramsText: 'value=number\nindex' },
    ]

    expect(eventsFromDraft(rows)).toEqual([
      {
        name: 'change',
        title: 'change',
        parameters: [
          { name: 'value', type: 'number' },
          { name: 'index', type: 'unknown' },
        ],
      },
    ])
  })

  it('事件名可空、可重复，但标题必填', () => {
    expect(
      messages({ events: [{ name: '', title: 'x', description: '', paramsText: '' }] }),
    ).toContain('事件名不能为空')
    expect(
      messages({
        events: [
          { name: 'click', title: '点击', description: '', paramsText: '' },
          { name: 'click', title: '又点击', description: '', paramsText: '' },
        ],
      }),
    ).toContain('事件名重复：click')
    expect(
      messages({ events: [{ name: 'onConfirm', title: '', description: '', paramsText: '' }] }),
    ).toContain('事件 onConfirm 需要填写显示标题')
    expect(validateComponentDraft(draftOf(), [])).toEqual([])
  })
})
