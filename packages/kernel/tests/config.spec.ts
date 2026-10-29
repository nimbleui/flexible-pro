import { describe, expect, it } from 'vitest'
import { createApp, definePlugin } from '../src'

interface DemoConfig {
  size: number
  tags: string[]
}

function parseDemoConfig(input: unknown): DemoConfig {
  const raw = (input ?? {}) as Partial<DemoConfig>
  return {
    size: typeof raw.size === 'number' ? raw.size : 10,
    tags: Array.isArray(raw.tags) ? [...raw.tags] : [],
  }
}

describe('配置流水线', () => {
  it('schema.parse 补默认值', async () => {
    const app = createApp()
    const record = app.plugin(
      definePlugin<DemoConfig>({
        name: 'configurable',
        schema: { parse: parseDemoConfig },
        apply() {},
      }),
    )

    await app.runtime.whenIdle()

    expect(record.config).toEqual({ size: 10, tags: [] })
  })

  it('实例配置先于 intercept 合并，数组整体替换', async () => {
    const app = createApp()
    app.intercept('configurable', { size: 20, tags: ['intercept'] })

    const record = app.plugin(
      definePlugin<DemoConfig>({
        name: 'configurable',
        schema: { parse: parseDemoConfig },
        apply() {},
      }),
      { size: 5, tags: ['instance'] },
    )

    await app.runtime.whenIdle()

    expect(record.config).toEqual({ size: 20, tags: ['intercept'] })
  })

  it('无 schema 时返回合并后的配置对象', async () => {
    const app = createApp()
    const record = app.plugin(
      definePlugin({
        name: 'passthrough',
        apply() {},
      }),
      { a: 1 },
    )

    await app.runtime.whenIdle()
    expect(record.config).toEqual({ a: 1 })
  })

  it('配置校验失败进入 failed', async () => {
    const app = createApp()
    const record = app.plugin(
      definePlugin({
        name: 'invalid-config',
        schema: {
          parse() {
            throw new Error('校验失败')
          },
        },
        apply() {},
      }),
    )

    await app.runtime.whenIdle()

    expect(record.state).toBe('failed')
    expect(record.attempts).toBe(0)
  })
})
