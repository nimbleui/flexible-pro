/** 平台判定：仅影响 `Mod` 解析为 ⌘ 还是 Ctrl */
export type Platform = 'mac' | 'other'

/** 匹配所需的最小键盘事件形状；KeyboardEvent 结构上满足它 */
export interface KeyInput {
  /** 原始按键值，`KeyboardEvent.key` 口径（如 `a`、`ArrowUp`、空格为 `' '`）；归一化由 `normalizeEventKey` 完成 */
  key: string
  /** Ctrl 是否按下；非 mac 平台 `Mod` 映射到本位，匹配要求与期望值精确一致（含 false） */
  ctrlKey: boolean
  /** Meta（⌘）是否按下；mac 平台 `Mod` 映射到本位 */
  metaKey: boolean
  /** Alt / Option 是否按下；规范里 alt 与 option 两个别名共用本位 */
  altKey: boolean
  /** Shift 是否按下；规范未含 Shift 时要求为 false，微调与快速修饰因此不会互触 */
  shiftKey: boolean
}

/** 检测当前平台；非浏览器环境按非 mac 处理，便于测试。 */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  const source = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
  return /mac|iphone|ipad/i.test(source) ? 'mac' : 'other'
}

/**
 * 判断键盘事件是否精确匹配组合键规范。
 *
 * 修饰键要求完全一致：`ArrowUp` 只匹配无修饰键，`Shift+ArrowUp` 只匹配
 * 恰好按住 Shift 的情况，避免微调与快速微调互相误触。
 */
export function matchesKeybinding(
  spec: string,
  event: KeyInput,
  platform: Platform = detectPlatform(),
): boolean {
  const tokens = spec
    .split('+')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  if (tokens.length === 0) return false

  const keyToken = tokens[tokens.length - 1] as string
  const modifiers = new Set(tokens.slice(0, -1))
  const isMac = platform === 'mac'

  const expectedCtrl = modifiers.has('ctrl') || (modifiers.has('mod') && !isMac)
  const expectedMeta = modifiers.has('meta') || (modifiers.has('mod') && isMac)
  const expectedAlt = modifiers.has('alt') || modifiers.has('option')
  const expectedShift = modifiers.has('shift')

  if (event.ctrlKey !== expectedCtrl) return false
  if (event.metaKey !== expectedMeta) return false
  if (event.altKey !== expectedAlt) return false
  if (event.shiftKey !== expectedShift) return false

  return normalizeEventKey(event.key) === keyToken
}

/** 把 `event.key` 归一化为规范里使用的 token（小写、空格变 space）。 */
export function normalizeEventKey(key: string): string {
  if (key === ' ') return 'space'
  return key.toLowerCase()
}
