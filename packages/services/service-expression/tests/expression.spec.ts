import { describe, expect, it } from 'vitest'
import { createApp } from '@lc/kernel'
import type { ExpressionEngine } from '@lc/schema'
import expressionPlugin from '../src/index'

async function createEngine(config?: unknown): Promise<ExpressionEngine> {
  const app = createApp({ grants: {} })
  app.plugin(expressionPlugin, config)
  await app.runtime.whenIdle()
  return app.require<ExpressionEngine>('expression')
}

describe('表达式服务', () => {
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
    const engine = app.require<ExpressionEngine>('expression')

    expect(engine.evaluate('foo.bar.baz', {})).toBeUndefined()
    expect(app.diagnostics.list().length).toBeGreaterThan(0)
  })

  it('isExpression 识别 ExpressionString', async () => {
    const engine = await createEngine()
    expect(engine.isExpression({ type: 'expression', raw: '{{ a }}' })).toBe(true)
    expect(engine.isExpression('{{ a }}')).toBe(false)
  })

  it('白名单表达式之外不再使用 JS 原生语法', async () => {
    const engine = await createEngine()
    // `new Function` 版本曾经允许这三类写法；换成白名单解释器后它们都不再合法
    expect(engine.evaluate('(() => 1)()', {})).toBeUndefined()
    expect(engine.evaluate('String(1)', {})).toBeUndefined()
    expect(engine.evaluate('this', {})).toBeUndefined()
    expect(engine.evaluate('1 .toFixed(2)', {})).toBe('1.00')
  })

  it('默认拒绝 JsExpression，开启开关后按受信代码执行', async () => {
    const strict = await createEngine()
    expect(strict.resolveValue({ type: 'js', code: 'count + 1' }, { count: 1 })).toBeUndefined()

    const permissive = await createEngine({ allowUnsafeJs: true })
    expect(permissive.resolveValue({ type: 'js', code: 'count + 1' }, { count: 1 })).toBe(2)
  })

  it('递归解析 schema 值，供渲染树与动作配置共用', async () => {
    const engine = await createEngine()
    const resolved = engine.resolveValue(
      {
        label: '共 {{ n }} 项',
        count: { type: 'expression', raw: '{{ n * 2 }}' },
        items: ['{{ name }}'],
        plain: 5,
      },
      { n: 2, name: 'A' },
    )

    expect(resolved).toEqual({ label: '共 2 项', count: 4, items: ['A'], plain: 5 })
  })

  it('页面声明的自定义函数经由服务注册后可被表达式调用', async () => {
    const engine = await createEngine()
    const registration = engine.functions.registerAll(
      [
        {
          name: 'progress',
          params: ['list'],
          body: "list.filter(t => t.done).length + ' / ' + list.length",
        },
      ],
      'page',
    )

    const todos = [{ done: true }, { done: false }]
    expect(engine.evaluate('progress(todos)', { todos })).toBe('1 / 2')

    registration.dispose()
    expect(engine.evaluate('progress(todos)', { todos })).toBeUndefined()
  })

  it('compile 暴露语法树供设计器校验与编辑器补全使用', async () => {
    const engine = await createEngine()
    const compiled = engine.compile('a > 1 && b')

    expect(compiled.ast.kind).toBe('logical')
    expect(compiled.evaluate({ a: 2, b: true })).toBe(true)
    expect(() => engine.compile('1 +')).toThrowError()
  })

  it('timeBudgetMs 透传到引擎，Infinity 表示关闭', async () => {
    const engine = await createEngine({ timeBudgetMs: Number.POSITIVE_INFINITY })
    const list = Array.from({ length: 2000 }, (unused, index) => index)

    expect(engine.evaluate('list.filter(n => n > 1000).length', { list })).toBe(999)
  })

  it('非法 timeBudgetMs 在配置阶段失败，不会带着坏配置启动', async () => {
    const app = createApp({ grants: {} })
    const record = app.plugin(expressionPlugin, { timeBudgetMs: -1 })
    await app.runtime.whenIdle()

    expect(record.state).toBe('failed')
    expect(record.error).toBeInstanceOf(TypeError)
  })
})
