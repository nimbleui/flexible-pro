import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_ID } from '../src/projects/project-model'
import { legacyPath, projectPath } from '../src/projects/project-path'

/**
 * 路由字符串是视图层与 `router.ts` 之间唯一的约定：拼掉一段就是 404，
 * 而 SPA 里的 404 表现成空白页，看不出哪一段错了。构造点集中在一个函数，
 * 所以它值得单独钉住——包括外壳用来算页签的那条「空相对段」形状。
 */
describe('项目内路径构造', () => {
  it('项目段与相对段拼成完整路径', () => {
    expect(projectPath('project-a', 'flows/flow-1/edit')).toBe(
      '/projects/project-a/flows/flow-1/edit',
    )
  })

  it('项目 id 按分量编码，结构性斜杠留在相对段里', () => {
    expect(projectPath('a/b', 'pages')).toBe('/projects/a%2Fb/pages')
  })

  it('空相对段得到带尾斜杠的项目根', () => {
    expect(projectPath('project-a', '')).toBe('/projects/project-a/')
  })

  it('旧路径一律回落默认项目', () => {
    expect(legacyPath('preview/event-doc')).toBe(
      `/projects/${DEFAULT_PROJECT_ID}/preview/event-doc`,
    )
  })
})
