import { shallowRef } from 'vue'
import type { ToastLevel, ToastService } from '@lc/contracts'

/** 一条在屏提示 */
export interface ToastItem {
  /** 自增序号；只用于 `key` 与手动关闭，不参与任何业务语义 */
  readonly id: number
  /** 提示文本 */
  readonly message: string
  /** 级别 */
  readonly level: ToastLevel
}

/** 提示在屏停留时长 */
const TOAST_DURATION_MS = 3000

/**
 * 同时在屏的提示条数上限。
 *
 * 必须有上限：一条失败后带 `onError: 'continue'` 的链可能连着弹十几条，
 * 没有上限时提示层会长出屏幕外，用户既读不完也关不掉。超限先丢最旧的一条。
 */
const TOAST_STACK_LIMIT = 5

/** 真正的存储；`shallowRef` 只在集合结构变化时整体替换，条目本身不需要深层响应 */
const list: ToastItem[] = []
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let sequence = 0

const items = shallowRef<readonly ToastItem[]>([])

function commit(): void {
  items.value = [...list]
}

function cancelTimer(id: number): void {
  const timer = timers.get(id)
  if (!timer) return

  clearTimeout(timer)
  timers.delete(id)
}

function remove(id: number): void {
  cancelTimer(id)

  const index = list.findIndex((item) => item.id === id)
  if (index >= 0) list.splice(index, 1)
}

/**
 * 在屏提示列表。
 *
 * 交给 `ToastHost.vue` 渲染；用 `shallowRef` 而不是 `ref`，因为条目是不可变的
 * ——改动总是增删整条，没有「改某条的字段」这种用法。
 */
export const toastItems = items

/**
 * 关掉一条提示。
 *
 * 手动关闭必须同时清掉它的自动消失定时器，否则用户点了关闭之后定时器还会在几秒后
 * 拿着同一个 id 再跑一次删除。
 */
export function dismissToast(id: number): void {
  remove(id)
  commit()
}

function show(message: string, level: ToastLevel = 'info'): void {
  const id = (sequence += 1)
  list.push({ id, message, level })

  // 循环条件已保证 `list` 非空，超限的那一条一定在最前面
  while (list.length > TOAST_STACK_LIMIT) remove(list[0].id)

  timers.set(
    id,
    setTimeout(() => removeAndCommit(id), TOAST_DURATION_MS),
  )
  commit()
}

function removeAndCommit(id: number): void {
  remove(id)
  commit()
}

/**
 * 宿主提供的提示服务实现。
 *
 * 只有一条 `show`：提示是说完就走的一次性输出，不承担确认、输入或状态回传。
 * 需要用户响应的场景应该用对话框，那是另一个动作类型。
 */
export const toastService: ToastService = { show }
