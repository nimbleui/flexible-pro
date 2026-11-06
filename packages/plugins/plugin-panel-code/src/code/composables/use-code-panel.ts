import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  DocumentService,
  LoaderService,
  MaterialService,
  SelectionService,
  ToastService,
} from '@lc/contracts'
import type { ExpressionEngine, NodeSchema, PageSchema } from '@lc/schema'
import { collectSubtree } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import { generatePageSfc } from '../codegen'

/** 出码范围 */
export type CodeScope = 'page' | 'node'

/**
 * 代码面板的状态编排。
 *
 * 面板只做「生成 + 展示 + 导出」，不写回文档：出码是单向出口，能改就变成第二条
 * 编辑路径，和画布争同一份 schema。
 */
export function useCodePanel() {
  const ctx = useAppContext()
  const doc = ctx.require<DocumentService>('document')
  const selection = ctx.require<SelectionService>('selection')
  const material = ctx.require<MaterialService>('material')
  const loader = ctx.require<LoaderService>('loader')
  const expression = ctx.require<ExpressionEngine>('expression')
  const toast = ctx.get<ToastService>('toast')

  const version = ref(0)
  const subscriptions: Array<{ dispose(): void }> = []
  const scope = ref<CodeScope>('page')

  function bump(): void {
    version.value += 1
  }

  onMounted(() => {
    subscriptions.push(doc.onDidChange(bump))
    subscriptions.push(selection.onDidChange(bump))
    subscriptions.push(material.onDidChange(bump))
    subscriptions.push(loader.onDidChange(bump))
  })

  onUnmounted(() => {
    for (const subscription of subscriptions) subscription.dispose()
    subscriptions.length = 0
  })

  const selectedNodeId = computed<string | undefined>(() => {
    version.value
    return selection.primary
  })

  const selectedLabel = computed<string>(() => {
    const id = selectedNodeId.value
    if (!id) return '未选中节点'

    const node = doc.model.schema.nodes[id]
    return node ? nodeLabel(node, id) : id
  })

  /**
   * 出码范围对应的 schema。
   *
   * 节点范围只裁掉节点表，页面级字段（变量 / 数据源 / 函数）原样带上：
   * 子树里的表达式照样读 `data.*`，裁掉声明会让产物一跑就报错。
   */
  const targetSchema = computed<PageSchema>(() => {
    const schema = doc.model.schema
    const id = scope.value === 'node' ? selectedNodeId.value : undefined
    if (!id) return schema

    const nodes: PageSchema['nodes'] = {}
    for (const nodeId of collectSubtree(schema, [id])) {
      const node = schema.nodes[nodeId]
      if (node) nodes[nodeId] = node
    }

    return { ...schema, nodeId: id, nodes }
  })

  /** 物料名 → 可导入包名：物料条目给插件名，插件包给 ESM 包名 */
  function resolveImport(componentName: string): string | undefined {
    version.value
    const entry = material.get(componentName)
    if (!entry) return undefined
    return loader.get(entry.plugin)?.importSource
  }

  const generated = computed(() =>
    generatePageSfc({
      schema: targetSchema.value,
      pageTitle: doc.model.title,
      resolveImport,
      // 出码只要语法树；引擎的编译缓存让同一串文本在反复生成里只解析一次
      compile: (source) => expression.compile(source).ast,
    }),
  )

  const code = computed(() => generated.value.code)
  const warnings = computed(() => generated.value.warnings)
  const lineCount = computed(() => code.value.split('\n').length)

  /** 选了「选中节点」但画布上没有主选中时给明确提示，而不是悄悄出整页 */
  const isNodeScopeAvailable = computed(() => selectedNodeId.value !== undefined)

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code.value)
      toast?.show('已复制出码结果', 'success')
    } catch {
      toast?.show('当前环境不允许写入剪贴板，请手动全选复制', 'warning')
    }
  }

  /**
   * 导出成 `.vue` 文件。
   *
   * 用 Blob + 临时 a 标签而不是 `window.open`：出码产物是文本，弹一个新窗口会把
   * 设计器挤到后台，而下载链接点一下就完事。
   */
  function download(): void {
    const fileName = `${sanitizeFileName(doc.model.title)}.vue`
    const url = URL.createObjectURL(
      new Blob([code.value], { type: 'text/plain;charset=utf-8' }),
    )
    const link = window.document.createElement('a')

    link.href = url
    link.download = fileName
    link.click()
    // 同步 revoke 会让部分浏览器拿不到内容，推到下一个宏任务
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    toast?.show(`已导出 ${fileName}`, 'success')
  }

  return {
    code,
    copy,
    download,
    isNodeScopeAvailable,
    lineCount,
    scope,
    selectedLabel,
    warnings,
  }
}

function nodeLabel(node: NodeSchema, id: string): string {
  return node.name || node.componentName || id
}

/** 文件名里的非法字符换成 `-`；标题可能带 `/` 与中文冒号 */
function sanitizeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/gu, '-').trim()
  return cleaned === '' ? 'page' : cleaned
}
