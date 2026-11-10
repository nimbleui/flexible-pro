import { canonicalJson } from './canonical'

/**
 * 内容地址计算。
 *
 * 不依赖 `crypto.subtle`：dev/preview 监听 `0.0.0.0`，用局域网 IPv4 打开设计器时
 * 页面运行在非安全上下文，`crypto.subtle` 与 `crypto.randomUUID` 都不可用。
 * 因此同步路径始终是纯 JS SHA-256；`crypto.subtle` 只作为可用的异步加速路径，
 * 且必须有测试断言两条路径同输入同输出，否则生产（HTTPS）与预览（HTTP）会算出两套地址。
 *
 * 地址取摘要前 160 bit（40 字符十六进制）：足够短可作 IndexedDB 的 key，
 * 碰撞概率又低到不需要处理；比较一律用完整字符串，不用前缀或数值比较。
 */

const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19,
]

const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]

/**
 * 对已经规范化的文本计算内容地址。
 *
 * 单独暴露是为了对象存储：`SectionObject` 存的是规范化 JSON 文本，对文本内容
 * 直接取 hash，不再经过一次 `canonicalJson`，避免把文本当成字符串值再包一层引号。
 *
 * @param text 规范化后的文本
 * @returns SHA-256 摘要前 160 bit 的 40 字符小写十六进制
 */
export function hashText(text: string): string {
  return toHex(sha256(new TextEncoder().encode(text))).slice(0, 40)
}

/**
 * 对任意 JSON 值计算内容地址：先规范化，再取 hash。
 *
 * @param value 待寻址的内容；键序差异不影响结果，数组顺序会影响
 * @returns 40 字符小写十六进制地址
 * @throws 见 `canonicalJson`，无法无损表达的值一律抛出而不是静默改写
 */
export function canonicalHash(value: unknown): string {
  return hashText(canonicalJson(value))
}

/**
 * `canonicalHash` 的异步版本，在 `crypto.subtle` 可用时走原生 SHA-256 提速。
 *
 * 不可用时（非安全上下文、旧运行时、测试里 stub 掉 `crypto`）回退到纯 JS，
 * 保证任何环境下都返回与 `canonicalHash` 完全相同的地址。
 *
 * @param value 待寻址的内容
 * @returns 与 `canonicalHash` 相同的 40 字符地址
 */
export async function canonicalHashAsync(value: unknown): Promise<string> {
  const text = canonicalJson(value)
  const subtle = globalThis.crypto?.subtle

  if (!subtle) return hashText(text)

  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toHex(new Uint8Array(digest)).slice(0, 40)
}

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

function sha256(bytes: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80

  const view = new DataView(padded.buffer)
  const bitLength = bytes.length * 8
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  const state = new Uint32Array(INITIAL_STATE)
  const words = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4)
    }

    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]
      const b = words[index - 2]
      const small0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3)
      const small1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10)
      words[index] = (words[index - 16] + small0 + words[index - 7] + small1) >>> 0
    }

    let a = state[0]
    let b = state[1]
    let c = state[2]
    let d = state[3]
    let e = state[4]
    let f = state[5]
    let g = state[6]
    let h = state[7]

    for (let index = 0; index < 64; index += 1) {
      const big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + big1 + choose + ROUND_CONSTANTS[index] + words[index]) >>> 0
      const big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (big0 + majority) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0
    state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0
    state[7] = (state[7] + h) >>> 0
  }

  const result = new Uint8Array(32)
  const resultView = new DataView(result.buffer)
  for (let index = 0; index < 8; index += 1) {
    resultView.setUint32(index * 4, state[index])
  }

  return result
}

function toHex(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0')
  return text
}
