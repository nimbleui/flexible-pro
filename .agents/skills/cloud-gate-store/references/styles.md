# 公共组件样式规范

本文件在任务涉及公共组件、基础组件、组件库样式、SCSS、Design Token、主题变量、交互状态或 BEM 命名空间时按需读取。

公共组件包括但不限于：Button、Input、Select、Checkbox、Radio、Switch、Tooltip、Popover、Dropdown、Dialog、Drawer、Tabs、Menu 等可复用基础组件。

## 核心目标

公共组件样式必须满足：

- 命名空间统一，不手写容易冲突的全局 class。
- 组件内部样式结构清晰，能够快速定位尺寸、语义、状态和子元素。
- 颜色、圆角、尺寸、间距、动效等优先来自 Design Token / CSS Variables。
- 组件级变量作为全局 Token 与具体样式之间的稳定适配层。
- 相同交互模式复用共享 mixin，不在每个组件重复实现 hover / active / focus 逻辑。
- 状态通过统一修饰符表达，不通过临时选择器堆叠隐式行为。
- 样式能够跟随主题切换，不绑定具体主题色值。
- 尊重可访问性和用户减少动效偏好。

## 文件入口

组件样式文件应优先通过统一样式入口加载公共 Token、函数和 mixin：

```scss
@use '../styles' as *;
```

不要在每个组件里重复 `@use` 大量内部样式文件，也不要绕过公共入口直接依赖深层实现，除非项目现有结构明确要求。

## 命名空间

公共组件 class 名必须优先通过项目统一命名空间 mixin 生成，例如：

```scss
@include b('button') {
}
@include e('content') {
}
@include m('primary') {
}
@include when('disabled') {
}
```

语义约定：

- `b(...)`：Block，组件根节点。
- `e(...)`：Element，组件内部稳定子元素。
- `m(...)`：Modifier，尺寸、类型、外观等互斥或可选变体。
- `when(...)`：State，disabled、loading、active、round、block 等状态。

如果项目已经提供命名空间工具，不要手写 `y-button`、`y-button--primary`、`is-disabled` 等完整 class 名。

## 组件级 CSS Variables

公共组件应建立自己的组件级变量层，不应让具体样式直接散落读取大量全局 Token。

推荐：

```scss
@include b('button') {
  @include set-component-css-var(
    'button',
    (
      'color': getCssVar('color-primary'),
      'hover-color': getCssVar('color-primary-hover'),
      'active-color': getCssVar('color-primary-active'),
      'radius': getCssVar('border-radius'),
    )
  );
}
```

推荐依赖方向：

```text
Design Token
  ↓
Global CSS Variables
  ↓
Component CSS Variables
  ↓
Component Style
```

组件样式优先读取：

```scss
getCssVar('button', 'color')
```

而不是在多个位置重复读取或硬编码：

```scss
// 不推荐
color: #1677ff;
background: var(--y-color-primary);
```

组件级变量用于表达“这个组件需要什么”，全局 Token 用于表达“设计系统提供什么”。这层隔离可以降低主题调整对组件实现的直接影响。

## 根节点基础样式

根节点只放所有变体共享的基础能力，例如：

- `display` / flex 对齐。
- `box-sizing`。
- 字体与行高。
- 基础 border。
- 基础圆角。
- cursor。
- `user-select`。
- transition。
- focus ring。

不要把某个特定 type 或 size 的行为混入根节点。

推荐结构：

```scss
@include b('button') {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  margin: 0;
  font-family: var(--y-font-family);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  border: 1px solid transparent;
  border-radius: getCssVar('button', 'radius');

  transition:
    background-color var(--y-motion-duration-mid),
    border-color var(--y-motion-duration-mid),
    color var(--y-motion-duration-mid),
    box-shadow var(--y-motion-duration-mid);

  @include focus-ring(getCssVar('button', 'color'));
}
```

## 样式文件组织顺序

公共组件样式建议按照以下固定顺序组织：

```text
1. 组件级 CSS Variables
2. 根节点基础样式
3. Focus / Accessibility
4. 尺寸变体
5. 语义 / 外观变体
6. 形状修饰符
7. 状态
8. 子元素
9. 动画 / Keyframes
10. Reduced Motion
```

当组件更复杂时可以增加分区，但不要无序穿插。

建议用简短分区注释帮助快速定位：

```scss
// ---------------------------------------------------------------------------
// 尺寸变体
// ---------------------------------------------------------------------------
```

注释应说明该分区的设计语义，不要逐行翻译 CSS。

## 尺寸变体

尺寸通过 `m(...)` 统一生成，并优先使用全局控制高度、间距、字号 Token：

```scss
@include m('small') {
  height: var(--y-control-height-sm);
  padding: 0 var(--y-padding-xs);
  font-size: var(--y-font-size);
}

@include m('middle') {
  height: var(--y-control-height);
  padding: 0 var(--y-padding);
  font-size: var(--y-font-size);
}

@include m('large') {
  height: var(--y-control-height-lg);
  padding: 0 var(--y-padding-lg);
  font-size: var(--y-font-size-lg);
}
```

不要为了一个组件重新发明一套 `small / default / large` 尺寸数值。优先与设计系统的 control-height、padding、font-size 保持一致。

## 语义与外观变体

组件不同语义类型通过 `m(...)` 表达，例如：

```text
primary
secondary
text
danger
success
warning
info
```

每种语义类型应尽量只负责：

- 文本颜色。
- 背景色。
- 边框色。
- 对应交互模式。

不要复制整套组件基础样式。

### 实心交互

主操作等实心类型优先复用统一交互 mixin：

```scss
@include m('primary') {
  color: getCssVar('button', 'primary-text');
  background: getCssVar('button', 'color');
  border-color: getCssVar('button', 'color');

  @include solid-interactions(
    getCssVar('button', 'hover-color'),
    getCssVar('button', 'active-color')
  );
}
```

### 浅色交互

次要操作和语义色按钮等浅色模式优先复用统一交互 mixin：

```scss
@include light-interactions(
  getCssVar('button', 'secondary-hover-bg'),
  getCssVar('button', 'secondary-active-bg')
);
```

如果多个语义类型只有 Token 名不同，应通过 `@each` 等简单数据驱动方式生成，避免复制四套几乎相同代码：

```scss
@each $type in ('danger', 'success', 'warning', 'info') {
  @include m($type) {
    color: getCssVar('button', '#{$type}-color');
    background: getCssVar('button', '#{$type}-bg');
    border-color: getCssVar('button', '#{$type}-border');

    @include light-interactions(
      getCssVar('button', '#{$type}-hover-bg'),
      getCssVar('button', '#{$type}-active-bg')
    );
  }
}
```

循环只用于真实重复结构。不要为了减少几行代码制造难理解的动态 Sass 抽象。

## 交互状态统一复用

Hover、Active、Focus、Disabled 等交互模式属于设计系统能力，应优先沉淀在共享样式工具中，例如：

```text
solid-interactions
light-interactions
focus-ring
reduced-motion
```

当两个及以上公共组件存在相同交互规律时，应优先复用共享 mixin，而不是在每个组件里复制选择器。

共享 mixin 应表达稳定的交互模式，不应耦合具体组件名称。

## 状态修饰符

运行时状态优先使用 `when(...)`：

```scss
@include when('round') {
}
@include when('block') {
}
@include when('disabled') {
}
@include when('loading') {
}
@include when('active') {
}
```

状态样式应集中，不要在多个 type / element 内重复散落同一 disabled / loading 规则。

禁用状态至少应考虑：

- 文本色。
- 背景色。
- 边框色。
- cursor。
- 是否允许 pointer events。
- opacity 是否真的需要。

如果设计系统已经提供明确 disabled Token，优先使用 disabled Token，不要简单通过 `opacity: 0.5` 模拟全部禁用视觉。

## 子元素

稳定的内部结构使用 `e(...)` 表达：

```scss
@include e('content') {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
```

Icon、loading、prefix、suffix 等视觉元素应保持职责明确，并避免影响文本收缩：

```scss
&__icon,
&__loading {
  display: inline-flex;
  flex: none;
  align-items: center;
}
```

若项目命名空间 mixin 能覆盖同一表达，优先继续使用 mixin；只有多个元素需要共享同一小段规则时，才直接合并选择器。

## 动画

组件局部动画可以定义在组件样式内，但名称必须避免全局冲突，优先绑定当前 block 命名空间：

```scss
@include e('spinner') {
  animation: #{$block}-spin 0.8s linear infinite;
}

@keyframes #{$block}-spin {
  to {
    transform: rotate(360deg);
  }
}
```

简单 loading 图形优先使用 `currentcolor` 跟随当前语义颜色：

```scss
border: 2px solid currentcolor;
border-top-color: transparent;
```

不要为同一语义额外维护一套 spinner 颜色变量，除非设计确实要求独立颜色。

## Reduced Motion

所有明显的旋转、位移、缩放、闪烁或较强 transition 都必须考虑 `prefers-reduced-motion`。

项目提供 `reduced-motion` mixin 时统一使用：

```scss
@include reduced-motion {
  transition: none;

  &__spinner {
    animation-duration: 2.4s;
  }
}
```

具体是禁用动画还是降低动画速度，应根据交互可理解性决定；不能因为关闭动画导致 loading、展开状态等反馈完全不可识别。

## Focus 与可访问性

可交互公共组件必须具有明确的键盘焦点反馈。

项目已有 `focus-ring(...)` 时必须优先使用统一实现：

```scss
@include focus-ring(getCssVar('button', 'color'));
```

不要通过 `outline: none` 删除焦点反馈后不提供替代方案。

Hover 不能成为表达状态的唯一方式，因为键盘和触摸设备可能没有 hover。

## CSS 与 JavaScript 边界

以下行为优先由 CSS 表达：

- hover / active / focus 视觉。
- 尺寸和间距变体。
- round / block 等纯视觉状态。
- 主题颜色映射。
- 简单 loading 动画。
- transition。

只有样式依赖真实测量、定位结果或复杂运行时状态时，才由 JavaScript 提供最小必要数据。

不要为了切换一个颜色或 class 在组件逻辑中写额外 watch / computed。

## 公共组件标准示例

Button 类公共组件的样式应接近以下组织方式：

```scss
@use '../styles' as *;

@include b('button') {
  @include set-component-css-var(
    'button',
    (
      'color': getCssVar('color-primary'),
      ...,
    )
  );

  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--y-padding-xs);
  box-sizing: border-box;
  margin: 0;
  font-family: var(--y-font-family);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
  border: 1px solid transparent;
  border-radius: getCssVar('button', 'radius');
  transition:
    background-color var(--y-motion-duration-mid),
    border-color var(--y-motion-duration-mid),
    color var(--y-motion-duration-mid),
    box-shadow var(--y-motion-duration-mid);

  @include focus-ring(getCssVar('button', 'color'));

  // ---------------------------------------------------------------------------
  // 尺寸变体
  // ---------------------------------------------------------------------------

  @include m('small') {
    height: var(--y-control-height-sm);
    padding: 0 var(--y-padding-xs);
    font-size: var(--y-font-size);
  }

  @include m('middle') {
    height: var(--y-control-height);
    padding: 0 var(--y-padding);
    font-size: var(--y-font-size);
  }

  @include m('large') {
    height: var(--y-control-height-lg);
    padding: 0 var(--y-padding-lg);
    font-size: var(--y-font-size-lg);
  }

  // ---------------------------------------------------------------------------
  // 语义类型
  // ---------------------------------------------------------------------------

  @include m('primary') {
    color: getCssVar('button', 'primary-text');
    background: getCssVar('button', 'color');
    border-color: getCssVar('button', 'color');

    @include solid-interactions(
      getCssVar('button', 'hover-color'),
      getCssVar('button', 'active-color')
    );
  }
  ...
  // ---------------------------------------------------------------------------
  // 状态与形状
  // ---------------------------------------------------------------------------

  @include when('round') {
    border-radius: 999px;
  }
  ...
  // ---------------------------------------------------------------------------
  // 子元素
  // ---------------------------------------------------------------------------

  @include e('content') {
    display: inline-flex;
    align-items: center;
    min-width: 0;
  }

  &__icon,
  &__loading {
    display: inline-flex;
    flex: none;
    align-items: center;
  }

  @include e('spinner') {
    box-sizing: border-box;
    width: 1em;
    height: 1em;
    border: 2px solid currentcolor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: #{$block}-spin 0.8s linear infinite;
  }

  @keyframes #{$block}-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @include reduced-motion {
    transition: none;

    &__spinner {
      animation-duration: 2.4s;
    }
  }
}
```

示例用于约束组织方式和设计原则，不要求所有组件机械复制 Button 的 Token 或状态。每个组件只定义自身真实需要的变量和变体。

## 禁止行为

公共组件样式禁止：

- 大量硬编码颜色、圆角、间距、字号和动效时长。
- 已有命名空间 mixin 时手写整套 BEM class。
- 已有共享交互 mixin 时重复实现相同 hover / active / focus 逻辑。
- 在组件逻辑中通过 JavaScript 完成本可由 CSS 处理的视觉状态。
- 通过深层级选择器依赖其他组件内部 DOM。
- 使用 `!important` 掩盖选择器或架构问题，除非存在明确第三方覆盖场景并说明原因。
- 删除 focus outline 却不提供可访问性替代。
- 只考虑 hover，不考虑键盘 focus、disabled 和触摸场景。
- 给每个组件复制一套相同 keyframes、交互函数或主题映射。
- 为减少少量重复代码创建难以理解的 Sass 元编程系统。

## 自检清单

完成公共组件样式后至少确认：

- 是否通过统一样式入口消费公共能力。
- Block / Element / Modifier / State 是否使用统一命名空间。
- 是否建立了必要的组件级 CSS Variables。
- 是否优先使用 Design Token，而不是硬编码视觉值。
- size / type / state / element 是否职责分开。
- 重复交互是否已经复用公共 mixin。
- disabled / loading / focus 等状态是否完整。
- 动画是否避免全局命名冲突。
- 是否处理 reduced motion。
- 是否有不必要的深层选择器、`!important` 或 JS 样式逻辑。
- 主题切换后组件是否仍然只依赖语义变量，而不是具体色值。
