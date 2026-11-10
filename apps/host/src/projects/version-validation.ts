import type { WorkingTree } from '@lc/contracts'
import type { FlowDefinition, PageSchema, ValidationIssue } from '@lc/schema'
import { validateDocument, validateFlow } from '@lc/schema'

/**
 * 合并产物校验：把版本库的中立工作区接到既有 schema 校验器上。
 *
 * 版本内核刻意不认识 `PageSchema` / `FlowDefinition`，只留 `VersionServiceOptions.validate`
 * 注入点；宿主在这里补上，避免另写一套会与发布页漂移的规则。
 *
 * 注意校验对象是 `tree`（合并后的候选树），不是宿主当前资产：合并预览必须先回答
 * 「合并产物能不能用」，用当前工作区代替它等于没校验。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 工作区投影 → 类型化文档的唯一边界。
 *
 * `sections` 声明为 `Record<string, unknown>`：合并产物可能缺字段，字段也可能被人工
 * 裁决写坏，而这些正是校验器要报出来的问题。守卫只确认「是普通对象」，不承诺字段
 * 完整；校验器对缺字段按各自规则产出 `ValidationIssue`，不会静默跳过。
 */
function isPageSchema(value: unknown): value is PageSchema {
  return isRecord(value)
}

/** 同 `isPageSchema`：流程图的字段完整性由 `validateFlow` 判定。 */
function isFlowDefinition(value: unknown): value is FlowDefinition {
  return isRecord(value)
}

/** 把校验器抛出的异常转成一条阻断问题，避免一次合并预览把面板带崩。 */
function guarded(prefix: string, run: () => ValidationIssue[]): ValidationIssue[] {
  try {
    return run().map((issue) => ({ ...issue, path: `${prefix}${issue.path}` }))
  } catch (cause) {
    return [
      {
        path: prefix,
        message: `结构无法校验：${cause instanceof Error ? cause.message : String(cause)}`,
        severity: 'error',
      },
    ]
  }
}

/**
 * 校验一棵候选工作区的页面与流程图结构。
 *
 * 先把全部 flow 文档收集成清单再校验页面：`validateDocument` 靠它区分「引用了草稿图」
 * （warning）与「引用了不存在的图」（error），只传当前这一张页面会让所有跨文档引用
 * 被误报成不存在。问题路径统一带上版本库的 `docId` 前缀，便于面板定位到具体文档。
 *
 * 只覆盖 page / flow 两类：函数、组件、接口文档目前没有独立的结构校验器，
 * 而它们对合并产物的影响由内核自带的 `dangling-ref` 检查兜底。
 */
export function validateWorkingTree(tree: WorkingTree): ValidationIssue[] {
  const pages: Array<{ docId: string; schema: PageSchema }> = []
  const flows: Array<{ docId: string; flow: FlowDefinition }> = []

  for (const [docId, document] of Object.entries(tree)) {
    if (document.kind === 'page' && isPageSchema(document.sections)) {
      pages.push({ docId, schema: document.sections })
    }
    if (document.kind === 'flow' && isFlowDefinition(document.sections)) {
      flows.push({ docId, flow: document.sections })
    }
  }

  const flowList = flows.map((item) => item.flow)
  const issues: ValidationIssue[] = []

  for (const { docId, schema } of pages) {
    issues.push(...guarded(`/${docId}`, () => validateDocument(schema, { flows: flowList })))
  }
  for (const { docId, flow } of flows) {
    issues.push(...guarded(`/${docId}`, () => validateFlow(flow)))
  }

  return issues
}
