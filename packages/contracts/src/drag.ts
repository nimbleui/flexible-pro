/**
 * 物料拖拽的 MIME 前缀。
 *
 * 物料面板在 dragstart 时写入 `application/x-lc-material:<物料名>`；
 * 画布处于 dragover 阶段只能读取 `dataTransfer.types`，因此把物料名
 * 编码进 MIME，避免依赖全局变量或自定义事件。
 */
export const MATERIAL_DRAG_MIME_PREFIX = 'application/x-lc-material:'

/**
 * 把物料名编码为拖拽 MIME。
 *
 * 浏览器的 `dataTransfer.types` 会统一转小写，直接拼物料名会破坏大小写
 * （如 `Text` → `text`）；这里按 code point 转十六进制并用 `-` 连接，
 * 保证在 types 中可无损还原。
 */
export function toMaterialDragType(name: string): string {
  const encoded = Array.from(name)
    .map((char) => (char.codePointAt(0) as number).toString(16))
    .join('-')
  return `${MATERIAL_DRAG_MIME_PREFIX}${encoded}`
}

/** 从 drag types 中还原物料名；不是物料拖拽时返回 null。 */
export function materialNameFromDragTypes(types: readonly string[]): string | null {
  const type = types.find((item) => item.startsWith(MATERIAL_DRAG_MIME_PREFIX))
  if (!type) return null

  const encoded = type.slice(MATERIAL_DRAG_MIME_PREFIX.length)
  if (!encoded) return null

  try {
    return encoded
      .split('-')
      .map((hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .join('')
  } catch {
    return null
  }
}

/**
 * 拖入预览在画布设置中的 id。
 *
 * 画布宿主在 dragover 时写入 { materialName, world, screen }，
 * canvas-drop 覆盖层读取绘制幽灵框；宿主与插件必须使用同一常量。
 */
export const CANVAS_DROP_PREVIEW_SETTING = 'canvas-drop.preview'
