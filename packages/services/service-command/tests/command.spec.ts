import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@lc/kernel'
import type { Context } from '@lc/kernel'
import type { Command, CommandService } from '@lc/contracts'
import commandPlugin from '../src/index'

async function createCommand(): Promise<{ app: Context; command: CommandService }> {
  const app = createApp({ grants: { 'service-command': ['command'] } })
  app.plugin(commandPlugin)
  await app.runtime.whenIdle()

  return { app, command: app.require<CommandService>('command') }
}

function makeCommand(
  id: string,
  run: Command['run'] = () => {},
  enabled?: () => boolean,
): Command {
  return { id, title: `命令 ${id}`, run, ...(enabled ? { enabled } : {}) }
}

// ctx.diagnostics.report 会 console.error；测试里静音，避免污染输出
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('service-command：命令注册与执行', () => {
  it('初始 version=0、注册表为空', async () => {
    const { app, command } = await createCommand()

    expect(command.version).toBe(0)
    expect(command.list()).toEqual([])
    expect(command.get('missing')).toBeUndefined()

    app.dispose()
  })

  it('register/get/list 按注册顺序暴露，version 随每次注册自增', async () => {
    const { app, command } = await createCommand()
    const first = makeCommand('a')
    const second = makeCommand('b')

    command.register(first)
    expect(command.version).toBe(1)
    command.register(second)
    expect(command.version).toBe(2)

    expect(command.get('a')).toBe(first)
    expect(command.list()).toEqual([first, second])

    app.dispose()
  })

  it('同名 id 重复注册抛错，且不覆盖已注册的命令', async () => {
    const { app, command } = await createCommand()
    const first = makeCommand('dup')
    const replacement = makeCommand('dup')

    command.register(first)
    expect(() => command.register(replacement)).toThrow(/命令 id 重复/)
    expect(command.get('dup')).toBe(first)
    expect(command.list()).toHaveLength(1)

    app.dispose()
  })

  it('dispose 注销本命令；迟到的 dispose 不会删掉后来重新注册的同名命令', async () => {
    const { app, command } = await createCommand()
    const first = makeCommand('reuse')
    const second = makeCommand('reuse')

    const registration = command.register(first)
    const versionAfterFirst = command.version
    registration.dispose()
    expect(command.get('reuse')).toBeUndefined()
    expect(command.version).toBe(versionAfterFirst + 1)

    command.register(second)
    // 旧句柄按实例引用比对，发现当前持有者已换人，直接空操作
    registration.dispose()
    expect(command.get('reuse')).toBe(second)

    app.dispose()
  })

  it('execute 调用 run 并透传 args；同步与异步命令都被 await', async () => {
    const { app, command } = await createCommand()
    const calls: unknown[] = []
    command.register(
      makeCommand('sync', (ctx) => {
        calls.push(['sync', ctx.args])
      }),
    )
    command.register(
      makeCommand('async', async (ctx) => {
        await Promise.resolve()
        calls.push(['async', ctx.args])
      }),
    )

    await command.execute('sync', { value: 1 })
    await command.execute('async', 'payload')

    expect(calls).toEqual([
      ['sync', { value: 1 }],
      ['async', 'payload'],
    ])

    app.dispose()
  })

  it('execute 未注册命令只记诊断、不向调用方抛错', async () => {
    const { app, command } = await createCommand()

    await expect(command.execute('nope')).resolves.toBeUndefined()
    const records = app.diagnostics.list().filter((record) => record.scope === 'command')
    expect(records).toHaveLength(1)
    expect(records[0]?.message).toMatch(/命令不存在/)

    app.dispose()
  })

  it('enabled 返回 false 时静默跳过，不执行也不记诊断', async () => {
    const { app, command } = await createCommand()
    const run = vi.fn()
    command.register(makeCommand('disabled', run, () => false))

    await command.execute('disabled')

    expect(run).not.toHaveBeenCalled()
    expect(app.diagnostics.list()).toHaveLength(0)

    app.dispose()
  })

  it('run 抛错被捕获并上报诊断，不向调用方抛出', async () => {
    const { app, command } = await createCommand()
    command.register(
      makeCommand('throws', () => {
        throw new Error('执行失败')
      }),
    )

    await expect(command.execute('throws')).resolves.toBeUndefined()
    const records = app.diagnostics.list().filter((record) => record.scope === 'command')
    expect(records).toHaveLength(1)
    expect(records[0]?.message).toBe('执行失败')

    app.dispose()
  })

  it('onDidChange 在注册/注销时通知，退订后停止', async () => {
    const { app, command } = await createCommand()
    const listener = vi.fn()
    const subscription = command.onDidChange(listener)

    const registration = command.register(makeCommand('a'))
    expect(listener).toHaveBeenCalledTimes(1)
    registration.dispose()
    expect(listener).toHaveBeenCalledTimes(2)

    subscription.dispose()
    command.register(makeCommand('b'))
    expect(listener).toHaveBeenCalledTimes(2)

    app.dispose()
  })
})
