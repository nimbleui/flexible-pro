# 架构、Monorepo 与可扩展机制规范

本文件在任务涉及 Monorepo、Package 边界、插件系统、Core 设计、Module Federation、CSS Theme 或公共基础设施时按需读取。

## Monorepo 基线

推荐按应用、领域包和内部工程配置组织：

```text
root
├─ apps
│  ├─ main
│  └─ ...
├─ packages
│  ├─ ui
│  ├─ composables
│  ├─ floating
│  ├─ shared
│  ├─ utils
│  └─ types
├─ internal
│  ├─ eslint-config
│  ├─ tsconfig
│  └─ vite-config
└─ scripts
```

目录不是固定模板，应以真实项目边界为准；不要为了匹配示例强制搬迁现有结构。

## Package 边界

每个 package 必须具有清晰职责和依赖方向。

例如 `shared` 应只提供与业务无关的基础函数、类型、常量和通用算法，不应依赖组件、页面或应用层。

典型依赖方向：

```text
apps
  ↓
components / features
  ↓
composables / adapters
  ↓
基础 packages
  ↓
shared
```

禁止低层 package 反向依赖高层 UI 或业务模块。发现循环依赖时，应重新评估职责，并抽取真正共享的底层能力。

## 公共出口

Package 对外能力应通过稳定入口导出：

```ts
// index.ts
export * from './core'
export * from './types'
export * from './plugins'
```

消费者不应依赖内部路径：

```ts
// 不推荐
import { xxx } from '@repo/floating/src/core/internal/foo'

// 推荐
import { xxx } from '@repo/floating'
```

内部实现应允许未来调整而不破坏消费者。

## Core 与 Framework Adapter

Core 必须尽可能框架无关。

Core 中避免出现 Vue 生命周期或响应式 API：

```ts
ref()
reactive()
watch()
onMounted()
onUnmounted()
```

推荐职责边界：

```text
Core              -> 数据结构、算法、状态转换、稳定协议
Framework Adapter -> Vue 响应式与生命周期适配
Component         -> UI、交互、可访问性、样式
```

## DOM 与算法分离

涉及 DOM 的基础设施推荐：

```text
DOM Measurement
  ↓
Snapshot
  ↓
Pure Calculation
  ↓
Result
  ↓
DOM Commit
```

计算层尽量接收快照，不直接读取或写入 DOM，以便测试和复用。

## 插件系统

只有存在明确、可独立演进的扩展行为时才使用插件系统。

适合插件化的例子：

```text
Placement
Offset
Flip
Shift
Arrow
Hide
Size
```

插件 API 应保持稳定、简单。插件之间通过统一 Context、Snapshot 或明确协议协作，避免直接引用彼此实例形成强耦合。

如果普通函数或配置数组已经足够，不要引入 Registry、Manager、Factory、Builder、Pipeline 等额外层级。

## Module Federation

Remote 应保持明确边界。

不应暴露：

- 页面内部实现。
- 私有工具函数。
- 不稳定内部类型。

优先暴露：

```text
Components
Feature API
Stable Composables
Stable Types
```

`shared` 配置应谨慎。Vue 等核心运行时应避免在同一页面出现不必要的多实例。

修改 exposes、remotes 或 shared 时，应结合当前项目实际版本和运行模式验证，不假设配置行为。

## CSS 与 Theme

样式应：

- 避免不必要的全局污染。
- 保持组件作用域清晰。
- 避免大量硬编码颜色和尺寸。
- 能由 CSS 完成的逻辑不要交给 JavaScript。

主题能力优先采用：

```text
Design Token
  ↓
CSS Variables
  ↓
Component Variables
  ↓
Component Style
```

公共组件应消费语义化 Token，而不是直接绑定具体主题色值。

## 演进式架构

优先从以下形式开始：

```text
简单核心
+
稳定接口
+
少量真实扩展点
```

随着真实需求出现再增加能力，不提前为大量假设场景设计复杂框架。
