import type { PluginManifest } from '@lc/contracts'

/**
 * 基础物料插件 manifest（纯声明式）。
 *
 * 没有 `main` 与 `apply`：装载器只注册元数据，组件模块在首次渲染时懒加载。
 */
export const manifest: PluginManifest = {
  name: 'materials-basic',
  displayName: '基础物料',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    materials: [
      {
        name: 'Box',
        title: '矩形',
        category: '基础',
        icon: 'square',
        props: {
          type: 'object',
          properties: {
            fill: { type: 'string', title: '填充色' },
            radius: { type: 'number', title: '圆角' },
            label: { type: 'string', title: '文本' },
          },
        },
        module: './src/index.ts',
        container: true,
        priority: 10,
        snippet: {
          id: 'box-1',
          componentName: 'Box',
          layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 180, height: 120 } },
          props: { fill: '#eef2ff', label: '矩形' },
        },
      },
      {
        name: 'Text',
        title: '文本',
        category: '基础',
        icon: 'type',
        props: {
          type: 'object',
          properties: {
            text: { type: 'string', title: '内容' },
            fontSize: { type: 'number', title: '字号' },
            align: { type: 'string', title: '对齐' },
          },
        },
        module: './src/index.ts',
        snippet: {
          id: 'text-1',
          componentName: 'Text',
          layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 200, height: 40 } },
          props: { text: '标题文本', fontSize: 18, weight: '600' },
        },
      },
      {
        name: 'Circle',
        title: '圆形',
        category: '基础',
        icon: 'circle',
        props: {
          type: 'object',
          properties: {
            fill: { type: 'string', title: '填充色' },
          },
        },
        module: './src/index.ts',
        snippet: {
          id: 'circle-1',
          componentName: 'Circle',
          layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 96, height: 96 } },
          props: { fill: '#fef3c7' },
        },
      },
      {
        // 纯入口物料：不生成画布节点，点击命令打开页面函数弹框
        name: 'CustomFunction',
        title: '自定义函数',
        category: '功能',
        icon: 'function',
        props: { type: 'object', properties: {} },
        module: './src/index.ts',
        clickCommand: 'pageFunction.openDialog',
        priority: 10,
      },
      {
        // 组合命令产出的节点类型；同时提供空白分组，方便手工往里放节点
        name: 'Group',
        title: '分组',
        category: '布局',
        icon: 'group',
        props: { type: 'object', properties: {} },
        module: './src/index.ts',
        container: true,
        snippet: {
          id: 'group-1',
          componentName: 'Group',
          name: '分组',
          layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 240, height: 160 } },
        },
      },
    ],
  },
}
