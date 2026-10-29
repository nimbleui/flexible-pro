import { describe, expect, it } from 'vitest'
import { createApp } from '@lc/kernel'
import expressionPlugin from '../src/index'

async function createEngine() {
  const app = createApp({ grants: {} })
  app.plugin(expressionPlugin)
  await app.runtime.whenIdle()
  return app.require<import('@lc/schema').ExpressionEngine>('expression')
}

describe('表达式引擎', () => {
  it('在作用域内求值并保留原始类型', async () => {
    const engine = await createEngine()
    expect(engine.evaluate('{{ count + 1 }}', { count: 2 })).toBe(3)
    expect(engine.evaluate('active', { active: true })).toBe(true)
  })

  it('模板插值把多段表达式拼成字符串', async () => {
    const engine = await createEngine()
    expect(
      engine.interpolate('共 {{ list.length }} 项，首项 {{ list[0] }}', { list: ['A', 2] }),
    ).toBe('共 2 项，首项 A')
  })

  it('表达式异常返回 undefined 并上报诊断', async () => {
    const app = createApp({ grants: {} })
    app.plugin(expressionPlugin)
    await app.runtime.whenIdle()
    const engine = app.require<import('@lc/schema').ExpressionEngine>('expression')
    const consoleError = console.error
    console.error = () => {}

    expect(engine.evaluate('foo.bar.baz', {})).toBeUndefined()
    expect(app.diagnostics.list().length).toBeGreaterThan(0)

    console.error = consoleError
  })

  it('isExpression 识别 ExpressionString', async () => {
    const engine = await createEngine()
    expect(engine.isExpression({ type: 'expression', raw: '{{ a }}' })).toBe(true)
    expect(engine.isExpression('{{ a }}')).toBe(false)
  })
})
