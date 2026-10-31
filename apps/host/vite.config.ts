import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { federation } from '@module-federation/vite'
import { networkInterfaces } from 'node:os'

/**
 * 主应用（MF Host）。
 *
 * 画布来自远程 `designerCanvas`：dev 由 `pnpm dev` 并行拉起 5174，构建期用
 * `VITE_DESIGNER_ENTRY` 指向部署后的 remoteEntry。宿主只负责外壳、路由与文档 Realm，
 * 不认识任何画布能力插件。
 *
 * dev/preview 监听 0.0.0.0，因此远程地址不能写 localhost：非本机浏览器解析
 * localhost 会指向它自己。默认取本机第一个非回环 IPv4，多网卡时用 `LC_DEV_HOST` 指定。
 */
function lanIPv4(): string {
  const override = process.env.LC_DEV_HOST
  if (override) return override
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const net of interfaces ?? []) {
      if (!net.internal && net.family === 'IPv4') return net.address
    }
  }
  return 'localhost'
}

const DEV_HOST = lanIPv4()
const DESIGNER_ENTRY =
  process.env.VITE_DESIGNER_ENTRY ?? `http://${DEV_HOST}:5174/remoteEntry.js`

export default defineConfig({
  plugins: [
    vue(),
    federation({
      name: 'hostShell',
      remotes: {
        designerCanvas: {
          type: 'module',
          name: 'designerCanvas',
          entry: DESIGNER_ENTRY,
          shareScope: 'default',
        },
      },
      shared: {
        // 远程组件的 vnode 必须由同一个 Vue 实例渲染，否则挂载即失效
        vue: { singleton: true, requiredVersion: '^3.5.0', eager: true },
      },
      // 远程类型不自动生成（需要 per-app tsconfig），见 src/remotes.d.ts
      dts: false,
    }),
  ],
  resolve: {
    dedupe: ['vue'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
  },
})
