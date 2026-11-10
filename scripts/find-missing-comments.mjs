// 只读检测：找出 packages/ 下「上方无注释」的导出符号与 interface/type 成员。
// 仅做启发式扫描，输出候选清单供人工补注，不修改任何文件。
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(process.cwd(), 'packages')
const results = []

function walk(dir, cb) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, cb)
    else if (/\.(ts|vue)$/.test(entry)) cb(full)
  }
}

function stripVue(src) {
  // 只取 <script lang="ts"> 块内容，替换其余为空白以保留行号
  return src
    .replace(/<template[\s\S]*?<\/template>/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<style[\s\S]*?<\/style>/g, (m) => m.replace(/[^\n]/g, ' '))
}

function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/**') || t.startsWith('/*')
}

function scan(file) {
  let raw = readFileSync(file, 'utf8')
  if (file.endsWith('.vue')) raw = stripVue(raw)
  const lines = raw.split('\n')
  let inTypeBlock = false // interface X { 或 type X = {
  let braceDepthOfType = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 跟踪 interface / type 对象字面量块，用于识别成员属性
    const typeStart = trimmed.match(/^(?:export\s+)?(?:interface\s+\w+|type\s+\w+\s*=)/)
    if (typeStart && trimmed.includes('{')) {
      inTypeBlock = true
      braceDepthOfType = 0
      for (const ch of trimmed)
        if (ch === '{') braceDepthOfType++
        else if (ch === '}') braceDepthOfType--
    } else if (inTypeBlock) {
      for (const ch of trimmed) {
        if (ch === '{') braceDepthOfType++
        else if (ch === '}') braceDepthOfType--
      }
      if (braceDepthOfType <= 0) inTypeBlock = false
    }

    // 跳过注释行与空行
    if (trimmed === '' || isCommentLine(trimmed)) continue

    // 找上一行（跳过空行）是否注释
    let prev = i - 1
    while (prev >= 0 && lines[prev].trim() === '') prev--
    const prevCommented = prev >= 0 && isCommentLine(lines[prev].trim())

    // 1) 导出声明
    const exp = trimmed.match(
      /^export\s+(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|const\s+(\w+)|let\s+(\w+)|interface\s+(\w+)|type\s+(\w+)|abstract\s+class\s+(\w+))/,
    )
    if (exp) {
      const name = exp[1] || exp[2] || exp[3] || exp[4] || exp[5] || exp[6] || exp[7]
      const kind = exp[1]
        ? 'func'
        : exp[2] || exp[7]
          ? 'class'
          : exp[5]
            ? 'interface'
            : exp[6]
              ? 'type'
              : 'const'
      if (!prevCommented)
        results.push({ file, line: i + 1, kind, name, text: trimmed.slice(0, 60) })
      continue
    }

    // 2) interface / type 成员属性（形如 `  name: T`），跳过方法签名 `name(...)` 与多行方法参数
    //    上一非空行以 `(` 或 `,` 结尾 → 本行仍是方法参数列表，跳过
    const prevEndsParam = prev >= 0 && /[,(]\s*$/.test(lines[prev].trim())
    if (inTypeBlock && braceDepthOfType > 0) {
      const isMethodSig = /^[A-Za-z_$][\w$]*\s*\(/.test(trimmed)
      if (!isMethodSig) {
        const member = trimmed.match(/^([A-Za-z_$][\w$]*)\s*\??:/)
        if (member && !prevCommented && !prevEndsParam) {
          results.push({
            file,
            line: i + 1,
            kind: 'member',
            name: member[1],
            text: trimmed.slice(0, 60),
          })
        }
      }
    }
  }
}

walk(ROOT, scan)

const grouped = {}
for (const r of results) {
  const key = r.file
  ;(grouped[key] ||= []).push(r)
}
let out = `总计候选缺口: ${results.length}\n\n`
for (const [file, items] of Object.entries(grouped)) {
  out += `${file} (${items.length})\n`
  for (const it of items) out += `  L${it.line} [${it.kind}] ${it.name}  ${it.text}\n`
  out += '\n'
}
writeFileSync(join(process.cwd(), 'scripts', 'missing-comments-report.txt'), out)
console.log(out)
