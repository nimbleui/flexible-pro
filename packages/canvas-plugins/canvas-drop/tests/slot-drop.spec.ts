import type { NodeSchema, PageSchema, SlotDefinition } from '@lc/schema'
import { SCHEMA_VERSION, applyPatches, childPath } from '@lc/schema'
import { describe, expect, it } from 'vitest'
import { resolveSlotTarget } from '../src/slot-target'

/** 卡片 200×120 分成上 1/4、中 1/2、下 1/4 三条，底部那条兼作 default */
const CARD_SLOTS: SlotDefinition[] = [
  { name: 'header', title: '头部', region: { y: 0, height: 0.25 } },
  { name: 'body', title: '主体', region: { y: 0.25, height: 0.5 } },
  { name: 'default', title: '整卡', region: { y: 0.75, height: 0.25 } },
]

/** 被拖进来的便签自己也声明了插槽，但它不该参与分格 */
const NOTE_SLOTS: SlotDefinition[] = [{ name: 'inner', title: '便签内部' }]

const CARD_BOUNDS = { x: 0, y: 0, width: 200, height: 120 }

const CARD: NodeSchema = { id: 'card', componentName: 'Card' }

function resolve(
  slots: SlotDefinition[] | undefined,
  x: number,
  y: number,
  extra: object = {},
) {
  return resolveSlotTarget({
    container: CARD,
    slotsOf: (componentName) => (componentName === 'Card' ? slots : NOTE_SLOTS),
    bounds: CARD_BOUNDS,
    world: { x, y },
    rotation: 0,
    materialName: 'Note',
    ...extra,
  })
}

describe('落点插槽判定', () => {
  it('物料没声明插槽时一律落 children', () => {
    expect(resolve(undefined, 100, 60)).toBeUndefined()
    expect(resolve([], 100, 60)).toBeUndefined()
  })

  it('分格取容器的插槽声明，不取被拖物料的', () => {
    // slotsOf 对非 Card 组件返回 NOTE_SLOTS（覆盖整块），命中它会把落点判成 'inner'
    expect(resolve(CARD_SLOTS, 100, 10)).toBe('header')
  })

  it('按容器矩形的比例分格命中', () => {
    expect(resolve(CARD_SLOTS, 100, 10)).toBe('header')
    expect(resolve(CARD_SLOTS, 100, 60)).toBe('body')
    expect(resolve(CARD_SLOTS, 100, 110)).toBe('default')
  })

  it('未声明 region 的插槽覆盖整块容器', () => {
    expect(resolve([{ name: 'only', title: '唯一' }], 5, 5)).toBe('only')
  })

  it('命中的插槽满了就降级到 default，而不是丢节点或硬塞', () => {
    const slots: SlotDefinition[] = [
      { name: 'header', title: '头部', maxChildren: 1, region: { y: 0, height: 0.25 } },
      CARD_SLOTS[2] as SlotDefinition,
    ]
    const occupied = { container: { ...CARD, slots: { header: ['existing'] } } }

    expect(resolve(slots, 100, 10, occupied)).toBe('default')
  })

  it('accepts 不含被拖物料时同样降级', () => {
    const slots: SlotDefinition[] = [
      { name: 'header', title: '头部', accepts: ['Button'], region: { y: 0, height: 0.25 } },
      CARD_SLOTS[2] as SlotDefinition,
    ]

    expect(resolve(slots, 100, 10)).toBe('default')
  })

  it('没有可降级的 default 时返回 undefined，由调用方落 children', () => {
    const slots: SlotDefinition[] = [
      { name: 'header', title: '头部', accepts: ['Button'], region: { y: 0, height: 0.25 } },
      { name: 'body', title: '主体', maxChildren: 1, region: { y: 0.25, height: 0.75 } },
    ]

    expect(
      resolve(slots, 100, 10, { container: { ...CARD, slots: { body: ['x'] } } }),
    ).toBeUndefined()
  })

  it('绕自身中心旋转的容器按旋转后的分格命中', () => {
    // 卡片顺时针转 90° 后，局部 (100,15) 的头部条带落在世界 (145,60)
    const world = { x: 145, y: 60 }
    expect(resolve(CARD_SLOTS, world.x, world.y, { rotation: Math.PI / 2 })).toBe('header')
    // 同一个点在不旋转的卡片上是右侧中部 → body；两条断言一起排除「绕左上角回转」的写法
    expect(resolve(CARD_SLOTS, world.x, world.y)).toBe('body')
  })

  it('角度非有限时按未旋转处理，与命中测试同一兜底', () => {
    expect(resolve(CARD_SLOTS, 100, 10, { rotation: Number.NaN })).toBe('header')
  })
})

/**
 * 父引用写入的接缝证明。
 *
 * 插件本体（`src/index.ts`）静态引入 Vue 覆盖层，node 环境的 vitest 跑不动它，
 * 因此这里锁住它依赖的两条外部事实：插槽路径的拼法，以及 `slots` 还不存在时
 * replace 能否凭空建出这一格。
 */
describe('插槽父引用落档', () => {
  function cardSchema(): PageSchema {
    return {
      version: SCHEMA_VERSION,
      nodeId: 'root',
      nodes: {
        root: {
          id: 'root',
          componentName: 'Group',
          children: ['card'],
          layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 600, height: 400 } },
        },
        card: {
          id: 'card',
          componentName: 'Card',
          layout: { mode: 'absolute', rect: CARD_BOUNDS },
        },
      },
      components: [],
    }
  }

  it('插槽路径与校验器、重排用的是同一个位置', () => {
    expect(childPath('card', 'header')).toBe('/nodes/card/slots/header')
    expect(childPath('card', undefined)).toBe('/nodes/card/children')
  })

  it('容器还没有 slots 对象时，replace 能直接建出该插槽', () => {
    const schema = cardSchema()
    const patches = [
      { op: 'add' as const, path: '/nodes/n1', value: { id: 'n1', componentName: 'Note' } },
      { op: 'replace' as const, path: childPath('card', 'header'), value: ['n1'] },
    ]

    const next = applyPatches(schema, patches)

    expect(next.nodes.card?.slots?.header).toEqual(['n1'])
    expect(next.nodes.card?.children).toBeUndefined()
    expect(next.nodes.n1).toBeTruthy()
  })
})
