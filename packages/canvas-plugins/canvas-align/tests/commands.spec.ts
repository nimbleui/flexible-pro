import type { CanvasContext, CanvasTransaction, Command } from '@lc/contracts'
import type { Rect, SchemaPatch } from '@lc/schema'
import { describe, expect, it } from 'vitest'
import alignPlugin from '../src/index'

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height }
}

/** 只覆盖对齐命令所需的画布片段：选区、标记视图、场景几何与事务 */
function createContext(options: {
  selection: readonly string[]
  root: string
  bounds: ReadonlyMap<string, Rect>
}): {
  command: (id: string) => Command
  previews: SchemaPatch[]
} {
  const previews: SchemaPatch[] = []
  const commands = new Map<string, Command>()

  const transaction: CanvasTransaction = {
    closed: false,
    preview(patches) {
      previews.push(...patches)
    },
    commit() {},
    cancel() {},
  }

  const context = {
    canvas: {
      nodeFlags: {
        hidden: new Set<string>(),
        locked: new Set<string>(),
        root: options.root,
      },
      selection: { ids: options.selection },
      scene: {
        getBounds(nodeId: string) {
          return options.bounds.get(nodeId)
        },
      },
      transaction: {
        begin: () => transaction,
      },
    },
    command: {
      register(next: Command) {
        commands.set(next.id, next)
        return { dispose() {} }
      },
    },
    effect<T>(factory: () => T): T {
      return factory()
    },
  } as unknown as CanvasContext

  alignPlugin.apply(context, undefined)

  const command = (id: string): Command => {
    const registered = commands.get(id)
    if (!registered) throw new Error(`命令未注册：${id}`)
    return registered
  }

  return { command, previews }
}

describe('对齐命令的作用范围', () => {
  const bounds = new Map<string, Rect>([
    ['root', rect(0, 0, 1200, 800)],
    ['a', rect(100, 100, 200, 100)],
    ['b', rect(400, 300, 200, 100)],
  ])

  it('根节点加一个子节点不满足对齐数量', () => {
    const { command } = createContext({
      selection: ['root', 'a'],
      root: 'root',
      bounds,
    })

    expect(command('canvas.alignLeft').enabled?.()).toBe(false)
  })

  it('左对齐只移动子节点，画幅根不跟着平移', () => {
    const { command, previews } = createContext({
      selection: ['root', 'a', 'b'],
      root: 'root',
      bounds,
    })

    command('canvas.alignLeft').run({} as never)

    expect(previews.map((patch) => patch.path)).toEqual([
      '/nodes/a/layout/rect',
      '/nodes/b/layout/rect',
    ])
    expect(previews[0]?.value).toEqual(rect(100, 100, 200, 100))
    expect(previews[1]?.value).toEqual(rect(100, 300, 200, 100))
  })
})
