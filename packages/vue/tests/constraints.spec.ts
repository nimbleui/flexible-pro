import { describe, expect, it } from 'vitest'
import type { LayoutConstraints, NodeSchema, Rect } from '@lc/schema'
import { resolveRect, resolveRects } from '../src/render/constraints'
import type { LayoutNode } from '../src/render/constraints'

/** 设计盒 360×240 放大到 720×480：水平增减 360，垂直增减 240 */
const DESIGN: Rect = { x: 0, y: 0, width: 360, height: 240 }
const ACTUAL: Rect = { x: 0, y: 0, width: 720, height: 480 }

function node(
  x: number,
  y: number,
  width: number,
  height: number,
  constraints?: LayoutConstraints,
) {
  return {
    id: 'n',
    componentName: 'Box',
    layout: {
      mode: 'absolute',
      rect: { x, y, width, height },
      ...(constraints ? { constraints } : {}),
    },
  } as NodeSchema
}

function resolve(constraints?: LayoutConstraints): Rect {
  return resolveRect(node(60, 20, 240, 80, constraints), DESIGN, ACTUAL)
}

function item(
  key: string,
  schema: NodeSchema,
  children: readonly LayoutNode[] = [],
): LayoutNode {
  return { key, node: schema, rect: schema.layout?.rect ?? DESIGN, children }
}

describe('resolveRect', () => {
  it('没写约束时尺寸与距起点的位置都不变', () => {
    expect(resolve()).toEqual({ x: 60, y: 20, width: 240, height: 80 })
  })

  it('两端拉伸只改尺寸，起点不动', () => {
    expect(resolve({ horizontal: 'stretch', vertical: 'stretch' })).toEqual({
      x: 60,
      y: 20,
      width: 600,
      height: 320,
    })
  })

  it('固定右边/下边保持距容器边界的间距', () => {
    const rightBottom = resolve({ horizontal: 'right', vertical: 'bottom' })

    // 设计时右边距 360-(60+240)=60、下边距 240-(20+80)=140
    expect(rightBottom.x).toBe(720 - 60 - 240)
    expect(rightBottom.y).toBe(480 - 140 - 80)
    expect(rightBottom.width).toBe(240)
  })

  it('居中把增减量对半分', () => {
    expect(resolve({ horizontal: 'center', vertical: 'center' })).toEqual({
      x: 240,
      y: 140,
      width: 240,
      height: 80,
    })
  })

  it('按比例缩放会同时改变位置与尺寸', () => {
    expect(resolve({ horizontal: 'scale', vertical: 'scale' })).toEqual({
      x: 120,
      y: 40,
      width: 480,
      height: 160,
    })
  })

  it('容器偏移会带进结果，父子矩形用同一套世界坐标', () => {
    // 节点在设计盒内的局部偏移是 (60, 20)，与实际父盒 500,300 相加即得目标位置
    const shifted = resolveRect(
      node(160, 70, 240, 80),
      { x: 100, y: 50, width: 360, height: 240 },
      { x: 500, y: 300, width: 720, height: 480 },
    )

    expect(shifted).toEqual({ x: 560, y: 320, width: 240, height: 80 })
  })

  it('子节点落在父盒之外时保留负偏移，不被掰回容器内', () => {
    const outside = resolveRect(
      node(60, 20, 240, 80),
      { x: 100, y: 50, width: 360, height: 240 },
      { x: 500, y: 300, width: 720, height: 480 },
    )

    expect(outside).toEqual({ x: 460, y: 270, width: 240, height: 80 })
  })

  it('未知取值与零尺寸容器都退回安全默认', () => {
    expect(resolve({ horizontal: 'middle' as LayoutConstraints['horizontal'] }).x).toBe(60)

    const zeroWidth = resolveRect(node(60, 20, 240, 80, { horizontal: 'scale' }), DESIGN, {
      x: 0,
      y: 0,
      width: 0,
      height: 240,
    })
    expect(zeroWidth.width).toBe(240)
  })
})

describe('resolveRects', () => {
  it('根节点吃满目标容器，子节点以根为基准重排', () => {
    const child = node(60, 20, 240, 80, { horizontal: 'stretch' })
    child.id = 'child'
    const root = item('root', node(0, 0, 360, 240), [item('child', child)])

    const rects = resolveRects([root], DESIGN, ACTUAL, 'root')

    expect(rects.get('root')).toEqual(ACTUAL)
    // 子节点的设计父级是根的 360×240，实际父级是 720×480
    expect(rects.get('child')).toEqual({ x: 60, y: 20, width: 600, height: 80 })
  })

  it('顶层游离节点按自己的约束解析，不抢根的位置', () => {
    const root = item('root', node(0, 0, 360, 240))
    const orphanSchema = node(10, 10, 50, 50)
    orphanSchema.id = 'orphan'
    const orphan = item('orphan', orphanSchema)

    const rects = resolveRects([root, orphan], DESIGN, ACTUAL, 'root')

    expect(rects.get('root')).toEqual(ACTUAL)
    expect(rects.get('orphan')).toEqual({ x: 10, y: 10, width: 50, height: 50 })
  })
})
