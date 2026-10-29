# 前端性能与 Floating 类基础设施规范

本文件在任务涉及 DOM 测量、滚动、Resize、定位系统、动画、渲染性能或 Layout Thrashing 时按需读取。

## 性能关注顺序

优先检查：

1. DOM Layout / Reflow。
2. 重复 Render。
3. 高频事件和监听器数量。
4. 重复计算。
5. 网络请求。
6. 大列表。
7. Bundle Size。

不要在没有证据时进行复杂微优化；先定位实际瓶颈。

## 避免 Layout Thrashing

核心原则：

```text
统一读取
  ↓
完成计算
  ↓
统一写入
```

避免在循环或高频回调中交替读取布局信息和修改样式。

## Floating / Popover / Tooltip 定位

Floating 类模块需要严格区分：

```text
Measure
  ↓
Calculate
  ↓
Commit
```

推荐一次更新周期内：

1. 集中读取 reference、floating、arrow、viewport 等必要几何信息。
2. 将 DOM 信息转成 Snapshot。
3. 使用纯计算逻辑得出坐标、placement 和插件结果。
4. 批量提交样式或状态。

不要让插件在评估候选方向时反复直接读取 DOM。

## Scroll / Resize

定位模块通常需要考虑：

- window scroll。
- ancestor scroll。
- viewport resize。
- reference resize。
- floating resize。
- 必要时的布局环境变化。

高频事件优先通过“请求更新”合并，而不是每个事件立即完整重算：

```text
事件发生
  ↓
request update
  ↓
requestAnimationFrame 合并
  ↓
单次 DOM measurement
  ↓
计算
  ↓
批量 commit
```

## requestAnimationFrame

`requestAnimationFrame` 用于合并同一帧内的更新请求，而不是掩盖错误状态同步。

应确保：

- 同一帧重复请求不会创建大量任务。
- 组件销毁时取消未执行任务。
- 写 DOM 的阶段尽量集中。

## ResizeObserver 与 Observer

使用 Observer 时：

- 只观察真正需要的元素。
- 避免重复注册。
- 销毁时 disconnect / unobserve。
- 防止 ResizeObserver 回调触发自身尺寸变化形成更新循环。

## 动画

动画应避免导致布局抖动。优先使用不会触发布局的属性，例如 transform / opacity（具体仍以项目 CSS 和浏览器行为为准）。

关闭动画时，不要在状态切换瞬间直接移除 DOM，应该让组件生命周期与退出动画协议一致。

## 性能验证

优化后应验证真实效果，不仅凭代码感觉判断。可以结合项目现有测试、性能面板、渲染次数、事件频率或可复现的场景进行确认。
