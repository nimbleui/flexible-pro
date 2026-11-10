import type { DocumentApplyOptions, DocumentService, HistoryService } from '@lc/contracts'
import { defineEditorPlugin } from '@lc/contracts'
import type { ConfigSchema } from '@lc/kernel'
import type { DocumentModel, PageSchema, SchemaPatch } from '@lc/schema'
import { applySchemaPatches, createDocument, validateDocument } from '@lc/schema'

/** 文档插件配置 */
export interface DocumentPluginConfig {
  /** 文档 id */
  id: string
  /** 初始 schema；建模型时会整体克隆，宿主之后改原对象不影响文档内容 */
  schema: PageSchema
  /** 文档标题；缺省时回退到 schema.metadata.title，再回退到文档 id */
  title?: string

  /**
   * 编辑或只读模式 @default 'edit'
   *
   * 必填是 parse 之后的形态：宿主可以省略，由配置解析补成 'edit'。
   * 'preview' 只拦截 `apply` 写入，`restore` 与读取不受影响。
   */
  mode: 'edit' | 'preview'
}

const documentSchema: ConfigSchema<DocumentPluginConfig> = {
  /**
   * 校验并补齐配置。
   *
   * id 与 schema 缺一即抛错：文档没有初始 schema 时后续所有读取都会返回半成品，
   * 早失败比让空文档进入编辑更省事。
   */
  parse(input) {
    const raw = (input ?? {}) as Partial<DocumentPluginConfig>
    if (!raw.id) throw new Error('[document] 缺少文档 id')
    if (!raw.schema) throw new Error('[document] 缺少初始 schema')
    return {
      id: raw.id,
      schema: raw.schema,
      title: raw.title,
      mode: raw.mode ?? 'edit',
    }
  },
}

/**
 * 文档服务插件（Realm 级）。
 *
 * 文档是 schema 的唯一写入入口：
 * - `record: true`：正式提交，写入历史并标脏
 * - `record: false`：手势预览，只改 schema 供渲染
 */
export default defineEditorPlugin<DocumentPluginConfig>({
  name: 'service-document',
  schema: documentSchema,

  apply(ctx, config) {
    let model: DocumentModel = createDocument({
      id: config.id,
      schema: config.schema,
      title: config.title,
    })
    const listeners = new Set<(model: Readonly<DocumentModel>) => void>()

    function notify(): void {
      // 本地订阅者先收到，再向事件总线广播：同一轮里监听方早于事件消费者
      for (const listener of [...listeners]) listener(model)
      ctx.emit('document:change', { model })
    }

    /**
     * 提交一个新的 schema 引用并广播。
     *
     * version 每次提交都自增，包括 record=false 的手势预览：靠 version 做缓存失效
     * 的消费者因此每帧都会重来一次，这是预览期间保持画面跟手的必要代价。
     * dirty 只在正式提交时置 true，预览不会把文档标记成未保存。
     *
     * version 同时兼任两个角色：`apply` / `restore` 的提交版本号，以及渲染帧的失效信号。
     * notify() 先通知本地订阅者、再 emit('document:change') 广播到事件总线，覆盖层、
     * 大纲与属性面板都靠它重绘；宿主保存链路也用它对齐「已保存版本」。因此预览期每帧
     * 也必须自增，不要改成「按 record 决定是否自增」——那会让手势期间画面停在上一次提交。
     * 旧的 `versioned` 形参两处调用恒传 true，保留它只会误导后来者以为存在不自增的提交模式。
     */
    function commitSchema(next: PageSchema, dirty: boolean): void {
      model = {
        ...model,
        schema: next,
        version: model.version + 1,
        dirty,
      }
      notify()
    }

    const service: DocumentService = {
      get model() {
        return model
      },

      /**
       * 以 patch 更新文档。
       *
       * before 取的是当前 schema 引用，除非调用方显式传入更早的快照（手势事务用它
       * 记录「手势开始前」的状态）：patch 应用是拷贝式的，旧对象不会被改动，
       * 因此可以直接交给历史记录而不必深拷贝。
       * 只读模式下任何写入都抛错，包括 record=false 的预览。
       *
       * @throws 文档处于 preview 模式时抛错。
       */
      apply(patches: readonly SchemaPatch[], options: DocumentApplyOptions = {}): void {
        if (config.mode === 'preview') {
          throw new Error('[document] 只读文档不允许写入')
        }

        const record = options.record ?? true
        const current = model.schema
        const after = applySchemaPatches(current, patches)

        commitSchema(after, record ? true : model.dirty)

        if (record) {
          // 历史服务在 Realm 中晚于文档装载，这里按需解析避免循环依赖
          ctx.get<HistoryService>('history')?.record({
            label: options.label ?? '编辑文档',
            before: options.before ?? current,
            after,
          })
        }
      },

      /**
       * 恢复到指定 schema。
       *
       * 不写历史，也不动 dirty：撤销一次编辑后文档仍是「已修改」状态，
       * 是否符合预期由调用方判断，服务不做猜测。version 仍然自增，
       * 因此覆盖层与面板会照常重绘。
       */
      restore(next: PageSchema): void {
        commitSchema(next, model.dirty)
      },

      /** 校验当前 schema；结果只返回给调用方，不拦截任何已发生的写入 */
      validate() {
        return validateDocument(model.schema)
      },

      onDidChange(listener) {
        listeners.add(listener)

        // listeners 是 Set：同一函数重复注册只保留一份，任一 Disposable 释放即全部失效
        return { dispose: () => listeners.delete(listener) }
      },
    }

    ctx.effect(() => ctx.provide('document', service, { apiVersion: '1.0' }))
  },
})
