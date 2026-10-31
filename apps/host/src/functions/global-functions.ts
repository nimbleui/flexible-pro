import { shallowRef } from 'vue'
import type { Disposable } from '@lc/kernel'
import type { ExpressionEngine } from '@lc/schema'

/**
 * 全局自定义函数。
 *
 * 与页面函数（`PageSchema.functions`）的区别是作用域：全局函数由函数管理页维护，
 * 未随任何文档持久化，而是随应用启动恢复并注册到表达式引擎，所有页面都能调用。
 * 目前没有后端，存储落在 localStorage；将来接服务端时只需替换本文件的读写实现。
 */
export interface GlobalFunction {
  /** 稳定 id，供编辑路由使用；改名不影响它 */
  id: string
  /** 函数名，表达式中按此名调用 */
  name: string
  /** 展示标题 */
  title?: string
  /** 形参名列表 */
  params?: string[]
  /** 函数体表达式 */
  body: string
  /** 说明 */
  description?: string
  /** 最后修改时间（ISO 字符串） */
  updatedAt: string
}

/** 新建或更新全局函数的输入；id 缺省表示新建 */
export interface GlobalFunctionInput {
  id?: string
  name: string
  title?: string
  params?: string[]
  body: string
  description?: string
}

const STORAGE_KEY = 'lc.global-functions.v1'
const listeners = new Set<() => void>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 存储内容来自用户可编辑的 localStorage，读入时必须逐字段收窄 */
function isGlobalFunction(value: unknown): value is GlobalFunction {
  if (!isRecord(value)) return false

  return (
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    typeof value.body === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.params === undefined || isStringArray(value.params))
  )
}

function readStorage(): GlobalFunction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    // id 与函数名都参与路由 / 注册表查找，重复条目会让前者指向错误的一行
    const ids = new Set<string>()
    const names = new Set<string>()
    return parsed.filter((item): item is GlobalFunction => {
      if (!isGlobalFunction(item)) return false
      if (ids.has(item.id) || names.has(item.name)) return false
      ids.add(item.id)
      names.add(item.name)
      return true
    })
  } catch (error) {
    console.error('[host] 读取全局函数失败，按空列表处理', error)
    return []
  }
}

function persist(entries: readonly GlobalFunction[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch (error) {
    // 隐私模式或配额不足时只丢持久化，当前会话里的函数仍然可用
    console.error('[host] 保存全局函数到 localStorage 失败', error)
  }
}

const state = shallowRef<readonly GlobalFunction[]>(readStorage())

/** 全局函数列表；只读约定由调用方遵守，修改必须走 saveGlobalFunction / removeGlobalFunction */
export const globalFunctions = state

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function commit(next: readonly GlobalFunction[]): void {
  state.value = next
  persist(next)
  notify()
}

/** 生成稳定 id；只要求跨刷新唯一，不参与表达式求值 */
function createFunctionId(): string {
  return `fn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeOptional(text: string | undefined): string | undefined {
  const value = text?.trim() ?? ''
  return value === '' ? undefined : value
}

/**
 * 新建或更新一条全局函数。
 *
 * @throws 函数名或函数体为空、函数名与其他全局函数重复、传入的 id 不存在时抛错
 */
export function saveGlobalFunction(input: GlobalFunctionInput): GlobalFunction {
  const name = input.name.trim()
  const body = input.body.trim()
  if (name === '' || body === '') {
    throw new Error('[host] 全局函数必须有名字和函数体')
  }

  const existing = input.id ? state.value.find((entry) => entry.id === input.id) : undefined
  if (input.id && !existing) {
    throw new Error(`[host] 待更新的全局函数不存在: ${input.id}`)
  }

  if (state.value.some((entry) => entry.name === name && entry.id !== existing?.id)) {
    throw new Error(`[host] 全局函数名重复: ${name}`)
  }

  const entry: GlobalFunction = {
    id: existing?.id ?? createFunctionId(),
    name,
    title: normalizeOptional(input.title),
    params: input.params && input.params.length > 0 ? [...input.params] : undefined,
    body,
    description: normalizeOptional(input.description),
    updatedAt: new Date().toISOString(),
  }

  const next = existing
    ? state.value.map((item) => (item.id === entry.id ? entry : item))
    : [...state.value, entry]
  commit(next)
  return entry
}

/** 删除一条全局函数；id 不存在时不做任何事 */
export function removeGlobalFunction(id: string): void {
  const next = state.value.filter((entry) => entry.id !== id)
  if (next.length === state.value.length) return
  commit(next)
}

/** 订阅全局函数变更；返回注销句柄 */
export function onGlobalFunctionsChange(listener: () => void): Disposable {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}

/**
 * 把全局函数接到表达式引擎上，并在列表变化时重新注册。
 *
 * 用独立的 `global` 层级注册：页面与物料函数可以覆盖同名全局函数，
 * 覆盖方注销后自动回落到这里的定义。
 *
 * @param engine 应用级表达式引擎
 * @returns 解除注册的句柄；应用销毁时由调用方释放
 */
export function installGlobalFunctions(engine: ExpressionEngine): Disposable {
  let registration = engine.functions.registerAll(state.value, 'global')

  const off = onGlobalFunctionsChange(() => {
    registration.dispose()
    registration = engine.functions.registerAll(state.value, 'global')
  })

  return {
    dispose: () => {
      off.dispose()
      registration.dispose()
    },
  }
}
