# TypeScript 与通用编码规范

本文件在任务涉及 TypeScript 类型、公共 API、函数设计、命名、注释或依赖变更时按需读取。

## TypeScript 基线

- 保持 `strict` 语义，不主动削弱项目现有类型检查。
- 避免 `any`；只有真实边界场景才能使用，并应说明原因。
- 公共 API 必须有明确类型。
- 泛型必须解决真实复用或类型关联问题。
- 类型名称应表达领域语义。
- 避免无意义类型断言。
- 禁止使用 `as unknown as` 逃避类型问题，除非存在明确边界并有充分说明。
- 不使用 `@ts-ignore` 掩盖可以修复的类型错误。

## interface 与 type

根据语义选择，不因个人偏好统一强制一种写法。

对象结构通常优先使用 `interface`：

```ts
interface FloatingOptions {
  placement: Placement
  strategy: Strategy
}
```

联合类型、映射类型和工具组合更适合使用 `type`：

```ts
type Strategy = 'absolute' | 'fixed'
type PartialFloatingOptions = Partial<FloatingOptions>
```

## 公共类型注释

公共接口和关键字段需要解释含义、默认值和特殊语义：

```ts
/**
 * Floating 定位配置。
 */
export interface FloatingOptions {
  /**
   * Floating 元素相对于 reference 元素的位置。
   *
   * @default 'bottom'
   */
  placement?: Placement

  /**
   * CSS 定位策略。
   *
   * - `absolute`：相对于定位上下文。
   * - `fixed`：相对于 viewport。
   *
   * @default 'absolute'
   */
  strategy?: Strategy
}
```

注释应重点解释约束和设计意图，不要逐行翻译代码。

## 函数设计

函数应尽量满足：

- 单一职责。
- 输入明确。
- 输出明确。
- 能纯则纯。
- 避免隐藏副作用。
- 避免无必要全局状态依赖。
- 长度以可理解性为准，不机械追求行数。

## 代码空行与功能分隔

为了保持代码结构清晰，不同职责和不同功能之间必须使用 **一个空行** 进行视觉分隔。不要把多个独立逻辑块、函数或方法连续堆叠在一起。

必须遵守：

- 不同功能块之间空一行。
- 不同函数定义之间空一行。
- `class` 中不同方法之间空一行。
- 对象字面量、Composable、Store 等包含多个方法时，不同方法之间空一行。
- 同一函数内部存在明显不同阶段时，例如“参数校验 → 数据计算 → 状态提交”，各阶段之间空一行。
- import、类型声明、常量、状态、计算逻辑、事件方法等不同职责区域之间，应通过空行保持层次。
- 只空一行即可，不连续插入多个无意义空行。

推荐：

```ts
const DEFAULT_SIZE = 32

const state = reactive({
  loading: false,
})

function open(): void {
  state.loading = true
}

function close(): void {
  state.loading = false
}

class FloatingController {
  start(): void {
    // ...
  }

  stop(): void {
    // ...
  }
}
```

同一方法内部，不同功能阶段也应分隔：

```ts
function updatePosition(): void {
  if (!reference.value || !floating.value) return

  const snapshot = measure(reference.value, floating.value)
  const result = computePosition(snapshot)

  applyPosition(floating.value, result)
}
```

避免：

```ts
function open(): void {
  state.open = true
}
function close(): void {
  state.open = false
}
function toggle(): void {
  state.open = !state.open
}
```

空行用于表达职责边界，而不是单纯追求视觉稀疏。连续语义紧密、属于同一声明的数据可以保持在一起；一旦职责或执行阶段发生变化，应增加一个空行。

## 函数注释规范

函数注释的目标是解释 **函数为什么存在、调用者需要遵守什么约束，以及代码本身无法直接表达的行为**，而不是把函数名或实现逐句翻译成中文。

### 必须编写注释的函数

以下函数应使用 JSDoc 编写完整注释：

- 对外导出的公共函数。
- 公共 package 暴露的 API。
- 存在复杂业务规则、边界条件或隐式约束的函数。
- 存在副作用的函数，例如操作 DOM、注册事件、修改共享状态、读写缓存。
- 涉及性能优化、调度、缓存、批处理或特殊生命周期处理的函数。
- 算法意图无法通过函数名和类型直接理解的函数。

简单且语义明确的内部函数不要求为了“有注释”而添加无价值注释。

### 注释内容

根据函数实际行为按需说明：

- **用途**：函数解决什么问题。
- **设计原因**：为什么需要这个函数或为什么采用当前实现。
- **参数语义**：参数代表什么，以及重要的取值约束。
- **返回值**：返回结果的含义，尤其是 `boolean`、状态对象、特殊值或 `Promise`。
- **副作用**：是否修改外部状态、DOM、缓存、事件监听或其他资源。
- **边界行为**：空值、异常输入、降级策略、重复调用等特殊情况。
- **异常**：函数可能主动抛出的异常以及触发条件。
- **性能约束**：仅在调用频率、复杂度或 DOM 读写顺序确实重要时说明。

### JSDoc 标签使用

优先利用 TypeScript 类型表达参数和返回值类型，JSDoc 不重复书写类型信息。标签按需使用：

- `@param`：补充参数的业务含义或约束，不能只是重复参数名。
- `@returns`：返回值含义不能从函数名直接判断时使用。
- `@throws`：函数可能主动抛出异常时使用。
- `@example`：公共 API 使用方式不直观时使用。
- `@deprecated`：API 已废弃时使用，并说明替代方案。
- `@internal`：仅在项目工具链确实识别该标记且有实际需要时使用。

不要为了凑齐标签而机械添加 `@param`、`@returns` 或 `@example`。

### 推荐写法

```ts
/**
 * 根据 reference 与 floating 的几何快照计算最终定位结果。
 *
 * 该函数保持纯计算，不读取或修改 DOM，确保同一输入始终得到同一结果，
 * 便于在不同框架适配层中复用并进行独立单元测试。
 *
 * @param snapshot 当前定位所需的完整几何快照。
 * @param options 定位配置，包含 placement、strategy 等计算参数。
 * @returns 可直接提交到渲染层的定位结果。
 */
export function computePosition(
  snapshot: FloatingSnapshot,
  options: FloatingOptions,
): FloatingResult {
  // ...
}
```

存在特殊边界时应明确说明：

```ts
/**
 * 将更新请求合并到下一帧执行，避免 scroll / resize 高频触发时重复测量 DOM。
 *
 * 同一帧内重复调用只会保留一次待执行任务。组件销毁后调用不会再触发更新。
 */
function scheduleUpdate(): void {
  // ...
}
```

### 不推荐写法

不要写只是在重复代码的信息：

```ts
/**
 * 获取用户。
 *
 * @param id 用户 ID。
 * @returns 用户。
 */
function getUser(id: string): User {
  // ...
}
```

如果函数名、参数名和类型已经完整表达语义，这类注释没有额外价值。只有存在业务约束时才补充，例如“未找到用户时抛出异常”或“结果来自本地缓存且最多缓存 5 分钟”。

### 行内注释

函数内部的行内注释只解释 **非显而易见的原因、约束和边界**：

```ts
// 先统一读取布局信息，再进入计算阶段，避免读写 DOM 交错导致强制同步布局。
const rect = reference.getBoundingClientRect()
```

避免：

```ts
// 获取矩形
const rect = reference.getBoundingClientRect()
```

当实现复杂到需要大量行内注释才能理解时，应优先检查函数是否承担了过多职责，必要时先拆分结构，而不是用注释掩盖设计问题。

## 命名

名称优先表达“它是什么”或“它做什么”。避免模糊命名：

```text
handleData
handleValue
process
manager
helper
util
doSomething
```

Boolean 优先使用 `is`、`has`、`can`、`should` 等前缀表达状态或能力。

有业务含义的 Magic Number 应提取为命名常量。

## 文件与目录

- 目录优先按领域组织，而不是无限按文件类型拆分。
- 普通模块通常保持在可快速理解的规模；复杂核心模块允许更大。
- 不为了满足固定行数机械拆文件。
- 拆分依据应是职责、复用边界和变更原因，而不是数字本身。

## 依赖与 package.json

新增依赖前判断：

1. 项目是否已经存在同类能力。
2. 浏览器或平台原生能力是否足够。
3. 现有 utility 是否可以复用。
4. 包体积和运行成本是否合理。
5. 项目维护状态是否可靠。
6. 是否值得承担长期升级和维护成本。

修改 `package.json` 时避免：

- 无关依赖升级。
- 无理由改变版本范围。
- 删除未知依赖。
- 改动与任务无关的 scripts。

## 第三方 API

使用第三方库前应确认当前项目版本和已有用法。不确定时查项目锁文件、类型定义或官方文档，不根据记忆猜 API。

## 完整代码输出

当任务要求完整代码时：

- 给出完整文件路径。
- 给出完整文件内容。
- 不使用 `...` 省略核心实现。
- 不用“其他代码不变”代替文件内容。
- 保证 import / export 和跨文件引用可以对应。
- 禁止留下 `Not implemented` 或无意义 TODO。
