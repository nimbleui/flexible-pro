# Vue 组件与 Composables 规范

本文件在任务涉及 Vue 3 组件、Composition API、Composables、状态、生命周期或组件 API 时按需读取。

## 组件职责

组件应保持职责清晰，并能够区分：

```text
Props / Inputs
  ↓
内部逻辑与状态
  ↓
渲染
  ↓
Events / Outputs
```

UI 组件不应重新实现可以下沉到 Core 或通用模块的算法。

## Props

Props 应满足：

- 类型明确。
- 默认值明确。
- 命名稳定。
- 公共语义清晰。
- 避免大量 Boolean 组合导致 API 爆炸。

当多个 Boolean 实际表达互斥状态时，优先考虑联合类型或单一语义属性。

## Emits

所有公共事件应声明类型，并保持事件名和 payload 语义稳定。

变更事件 payload 或事件名时，需要判断是否构成 Breaking Change。

## Composables

Composables 主要负责：

- 状态组合。
- 生命周期协调。
- DOM 生命周期管理。
- Vue 响应式适配。
- 将框架无关基础模块桥接到 Vue。

Composables 不应重新实现底层算法。底层计算优先放入框架无关模块，再由 Composable 负责适配。

命名统一采用 `useXxx`。

返回值只暴露调用方真正需要的 API，隐藏内部实现和临时状态。

## 状态管理

局部状态优先使用 Vue 原生响应式能力：

```ts
ref()
reactive()
computed()
```

只有出现真实的跨模块、跨页面共享需求时，再考虑 Pinia 或项目既有状态方案。

不要为了“统一状态管理”把所有局部状态提升为全局状态。

## 生命周期与资源释放

涉及以下资源时必须考虑创建时机和销毁：

- `addEventListener`
- `ResizeObserver`
- `MutationObserver`
- `IntersectionObserver`
- `requestAnimationFrame`
- `setTimeout`
- `setInterval`

确保监听、Observer、定时器和动画帧在组件卸载或依赖变化时正确清理。

不要使用 `setTimeout` 掩盖响应式时序或生命周期问题。

## Watch 使用原则

使用 `watch` / `watchEffect` 前先判断：

- 是否可以使用 `computed` 表达纯派生状态。
- 是否真的存在副作用。
- 是否会因依赖变化重复注册资源。
- 是否需要 cleanup。
- 是否可能产生循环更新。

## 组件 API 稳定性

公共组件应优先保持：

- Props 命名稳定。
- 默认值稳定。
- Emits 语义稳定。
- Slots 和 expose 的能力边界明确。
- 内部实现可以调整，但消费者不需要依赖内部路径或私有状态。

## 样式职责

能由 CSS 完成的样式逻辑优先交给 CSS，不用 JavaScript 做无必要的样式计算。

主题和 Design Token 规则见 `architecture.md`。
