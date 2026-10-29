# Agent 反模式与 Code Review 清单

本文件用于实现完成前自检，或在 Code Review、架构评审任务中按需读取。

## 禁止行为

Agent 不应：

- 未理解现有代码就直接重构。
- 为简单需求创建复杂框架。
- 随意重写整个模块。
- 未经需求修改稳定公共 API。
- 修改与任务无关的代码。
- 引入不必要依赖。
- 复制已有 utility 或已有能力。
- 随意升级依赖。
- 创建没有真实价值的 Manager / Factory / Service / Builder / Registry。
- 制造循环依赖。
- 只实现 Happy Path。
- 使用 `any`、`@ts-ignore`、危险断言或大量 `eslint-disable` 逃避问题。
- 删除失败测试以使 CI 通过。
- 用 `setTimeout` 掩盖生命周期或状态同步问题。
- 用注释掩盖错误设计。
- 根据记忆猜第三方 API。
- 输出无法运行的伪代码冒充生产实现。
- 留下无意义 TODO 或 `Not implemented`。
- 虚构测试、Lint、Type Check 或 Build 已通过。

## Architecture Review

检查：

- 是否破坏 package 边界？
- 是否新增循环依赖？
- 是否存在反向依赖？
- 是否创建了不必要抽象？
- 是否可以复用现有能力？
- Core、Adapter、Component 职责是否混杂？
- 公共出口是否稳定？

## TypeScript Review

检查：

- 是否存在不必要 `any`？
- 是否存在危险类型断言？
- 是否使用 `@ts-ignore` 掩盖问题？
- 公共类型是否表达真实语义？
- 泛型是否有实际价值？

## Vue Review

检查：

- 生命周期是否正确？
- 监听器和 Observer 是否释放？
- `watch` 是否可能重复执行或重复注册资源？
- 是否存在不必要响应式状态？
- Composable 是否重新实现了底层算法？
- Props / Emits 是否发生非预期 Breaking Change？

## Performance Review

检查：

- 是否重复读取 DOM？
- 是否存在读写交错导致 Layout Thrashing？
- 是否创建大量无意义监听？
- 高频更新是否可以合并？
- 是否存在重复计算或重复 Render？

## API Review

检查：

- 是否破坏原公共 API？
- 命名是否准确？
- 默认值是否合理？
- 是否泄漏内部实现？
- 是否为了未来假设暴露过多扩展点？

## Test Review

检查：

- 新增逻辑是否有必要测试？
- Bug 是否有回归测试？
- 是否覆盖关键边界和状态切换？
- 是否通过删除或跳过测试掩盖问题？

## 最终自检

提交结果前确认：

```text
需求真实完成
+
修改范围可控
+
架构边界未被破坏
+
TypeScript 未被绕过
+
公共 API 稳定
+
没有无意义复杂度
+
必要测试已覆盖
+
项目实际质量检查已执行或明确说明未执行
+
没有隐藏错误与无意义 TODO
```
