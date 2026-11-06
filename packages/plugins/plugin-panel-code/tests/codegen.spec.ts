import { describe, expect, it } from 'vitest'
import type { NodeSchema, PageSchema } from '@lc/schema'
import { SCHEMA_VERSION, createExpression } from '@lc/schema'
import { createExpressionEngine } from '@lc/expression'
import { generatePageSfc } from '../src/code/codegen'
import type { GeneratedCode, MaterialImportResolver } from '../src/code/codegen'

const engine = createExpressionEngine()

/** 出码只吃语法树，测试直接借用引擎的编译缓存 */
function generate(
  schema: PageSchema,
  resolveImport: MaterialImportResolver = () => '@lc/plugin-materials-basic',
): GeneratedCode {
  return generatePageSfc({
    schema,
    pageTitle: '测试页',
    resolveImport,
    compile: (source) => engine.compile(source).ast,
  })
}

function page(nodes: Record<string, NodeSchema>, rest: Partial<PageSchema> = {}): PageSchema {
  return { version: SCHEMA_VERSION, nodeId: 'root', nodes, components: [], ...rest }
}

const ROOT: NodeSchema = {
  id: 'root',
  componentName: 'Box',
  children: ['a'],
  layout: { mode: 'absolute', rect: { x: 100, y: 50, width: 400, height: 200 } },
}

const CHILD: NodeSchema = {
  id: 'a',
  componentName: 'Text',
  layout: { mode: 'absolute', rect: { x: 120, y: 70, width: 200, height: 40 } },
}

describe('generatePageSfc 结构', () => {
  const { code } = generate(page({ root: ROOT, a: CHILD }))

  it('每个节点一个定位 wrapper，物料组件与之并列', () => {
    expect(code).toContain('<div class="lc-node node-root">')
    expect(code).toContain('<Box />')
    expect(code).toContain('<div class="lc-node node-a">')
    expect(code).toContain('<Text />')
  })

  it('几何按父节点矩形做补偿，与渲染层同一口径', () => {
    expect(code).toContain(
      '.node-root {\n  position: relative;\n  width: 400px;\n  height: 200px;\n}',
    )
    // 子节点世界矩形 (120, 70) 减去父 (100, 50)
    expect(code).toContain('left: 20px;')
    expect(code).toContain('top: 20px;')
  })

  it('条件、循环与指令翻成对应的指令属性', () => {
    const directivePage = page({
      root: ROOT,
      a: {
        ...CHILD,
        condition: createExpression('{{ data.visible }}'),
        loop: {
          dataSource: createExpression('{{ data.rows }}'),
          itemName: 'row',
          key: 'row.id',
        },
        directives: [
          { type: 'show', condition: createExpression('{{ data.on }}') },
          { type: 'disabled', condition: createExpression('{{ data.busy }}') },
        ],
      },
    })

    const out = generate(directivePage).code
    expect(out).toContain('v-if="data.visible"')
    expect(out).toContain('v-for="(row, $index) in data.rows"')
    expect(out).toContain(':key="row.id"')
    expect(out).toContain('v-show="data.on"')
    expect(out).toContain(':disabled="data.busy"')
  })

  it('设计态隐藏的节点整棵不进产物', () => {
    const out = generate(
      page({
        root: { ...ROOT, children: ['a', 'b'] },
        a: { ...CHILD, hidden: true },
        b: { ...CHILD, id: 'b' },
      }),
    ).code

    expect(out).not.toContain('node-a')
    expect(out).toContain('node-b')
  })

  it('具名插槽内容落到组件的 template 上', () => {
    const out = generate(
      page({
        root: { ...ROOT, slots: { header: ['h'] }, children: [] },
        h: { id: 'h', componentName: 'Text', layout: CHILD.layout },
      }),
    ).code

    expect(out).toContain('<template #header>')
  })
})

describe('表达式直译', () => {
  function emit(expression: string): string {
    return generate(
      page({
        root: ROOT,
        a: { ...CHILD, props: { text: createExpression(expression) } },
      }),
    ).code
  }

  it('成员访问与方法调用原样直译', () => {
    expect(emit('data.users.data.map(item => item.done)')).toContain(
      ':text="data.users.data.map((item) => item.done)"',
    )
  })

  it('只在必要的地方加括号', () => {
    expect(emit('data.a - (data.b - data.c)')).toContain(':text="data.a - (data.b - data.c)"')
    expect(emit('data.a * data.b + data.c')).toContain(':text="data.a * data.b + data.c"')
    expect(emit('(data.a + data.b) * data.c')).toContain(':text="(data.a + data.b) * data.c"')
  })

  it('内置函数改写成 $rt 成员并带上依赖', () => {
    const out = emit('round(data.count / 2)')
    expect(out).toContain(':text="$rt.round(data.count / 2)"')
    expect(out).toContain('const $rt = {')
    expect(out).toContain('num: (value) => {')
    expect(out).toContain('round: (n) => Math.round($rt.num(n)),')
  })

  it('没用到的内置函数不进运行时', () => {
    const out = emit('data.count')
    expect(out).not.toContain('const $rt = {')
  })

  it('混排插值翻成模板字面量并走 $rt.str', () => {
    const out = generate(
      page({ root: ROOT, a: { ...CHILD, props: { text: '共 {{ data.total }} 项' } } }),
    ).code

    expect(out).toContain(':text="`共 ${$rt.str(data.total)} 项`"')
  })

  it('语法不合法的表达式退化成原文字符串并给出警告', () => {
    const result = generate(
      page({ root: ROOT, a: { ...CHILD, props: { text: createExpression('data.') } } }),
    )

    expect(result.code).toContain("'data.'")
    expect(result.warnings.join()).toContain('语法')
  })
})

describe('物料与数据源', () => {
  it('登记了导入来源的物料生成按名查表', () => {
    const out = generate(page({ root: ROOT, a: CHILD })).code
    expect(out).toContain(
      "import { components as LcPluginMaterialsBasicComponents } from '@lc/plugin-materials-basic'",
    )
    expect(out).toContain("const Box = LcPluginMaterialsBasicComponents['Box']")
  })

  it('未登记来源的物料降级成占位组件并警告', () => {
    const result = generate(page({ root: ROOT, a: CHILD }), () => undefined)

    expect(result.code).toContain("return h('div', { class: 'lc-unresolved' }, 'Box')")
    expect(result.warnings.join()).toContain('没有登记可导入的包')
  })

  it('REST 数据源生成取数函数并在挂载时自动请求', () => {
    const out = generate(
      page(
        { root: { ...ROOT, children: [] }, a: { ...CHILD } },
        {
          datasources: [
            {
              id: 'users',
              type: 'rest',
              config: { kind: 'rest', url: '/api/users', method: 'GET', params: { page: '2' } },
            },
          ],
        },
      ),
    ).code

    expect(out).toContain('async function loadUsers() {')
    expect(out).toContain("fetch('/api/users?page=2'")
    expect(out).toContain('onMounted(() => {')
    expect(out).toContain('  void loadUsers()')
  })

  it('轮询在挂载时登记、卸载时清理', () => {
    const out = generate(
      page(
        { root: { ...ROOT, children: [] }, a: { ...CHILD } },
        {
          datasources: [
            {
              id: 'pulse',
              type: 'rest',
              pollingInterval: 5000,
              config: { kind: 'rest', url: '/api/pulse' },
            },
          ],
        },
      ),
    ).code

    expect(out).toContain('timers.push(window.setInterval(() => void loadPulse(), 5000))')
    expect(out).toContain('onUnmounted(() => {')
  })

  it('数据转换管道翻成 $rt.apply 与箭头函数', () => {
    const out = generate(
      page(
        { root: { ...ROOT, children: [] }, a: { ...CHILD } },
        {
          datasources: [
            {
              id: 'todos',
              type: 'rest',
              config: { kind: 'rest', url: '/api/todos' },
              transform: [
                { kind: 'path', path: 'data.items' },
                { kind: 'filter', expression: '!item.done' },
                { kind: 'groupBy', by: 'owner' },
              ],
            },
          ],
        },
      ),
    ).code

    expect(out).toContain("$rt.apply(result, [{ kind: 'path', path: 'data.items' }")
    expect(out).toContain("{ kind: 'filter', fn: (item, index) => !item.done }")
    expect(out).toContain("{ kind: 'groupBy', by: 'owner' }")
    expect(out).toContain('groupBy: (value, by) =>')
  })

  it('页面函数按声明生成，与表达式里的调用同名', () => {
    const out = generate(
      page(
        {
          root: ROOT,
          a: { ...CHILD, props: { text: createExpression('progress(rows)') } },
        },
        {
          functions: [{ name: 'progress', params: ['rows'], body: 'rows.length' }],
        },
      ),
    ).code

    expect(out).toContain('function progress(rows) {')
    expect(out).toContain(':text="progress(rows)"')
  })

  it('data 装配与运行时同构：变量覆盖同名数据源', () => {
    const out = generate(page({ root: ROOT, a: CHILD })).code
    expect(out).toContain('const data = computed(() => ({ ...sources, ...state }))')
  })
})
